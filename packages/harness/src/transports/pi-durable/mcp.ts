import { mcpAppResourceUri, mcpToolVisibleTo } from "@claxedo/agent-runtime-contract"
import { errorMessage } from "@claxedo/helpers"
import { asRecord } from "@claxedo/helpers/guards"
import { copyJson, isJsonValue, type JsonValue } from "@earendil-works/chord"
import { Type } from "@earendil-works/pi-ai"
import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable"
import { McpAuthRequiredError, McpClient, McpSessionExpiredError, toLlmContent, type CallToolResult, type McpRequestOptions, type McpTransport,
  type Tool } from "@earendil-works/pi-mcp"
import type { McpCallToolResult, McpOperationRefusal, McpReadResourceResult, McpResourceRead, McpToolCall, McpToolInfo, ProjectedMcpServer } from "../../contract"
import { mcpAppSnapshot, PI_MCP_CAPABILITIES, type McpAppSnapshot } from "./mcp-app"
import type { McpListedTool, McpToolLists } from "./mcp-cache"

const NAME_LIMIT = 64

function nameHash(value: string): string {
  let hash = 0x811c9dc5
  for (const char of value) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0
  return hash.toString(16).padStart(8, "0")
}

export function piMcpToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`
  const clean = raw.replace(/[^A-Za-z0-9_]/g, "_")
  return clean === raw && raw.length <= NAME_LIMIT ? raw : `${clean.slice(0, NAME_LIMIT - 9)}_${nameHash(raw)}`
}

export type PiMcpHost = {
  connect(server: ProjectedMcpServer): Promise<McpTransport>
  failed(server: string, error: unknown): void
  appUnavailable(server: string, tool: string, reason: string): void
  cached(key: string): Promise<McpToolLists>
  record(key: string, lists: McpToolLists): Promise<void>
}

function mcpJsonObject(value: unknown): JsonObject | undefined {
  const record = asRecord(value)
  return record && isJsonValue(record) ? record : undefined
}

function listedTool({ name, description, inputSchema, annotations, _meta }: Tool): McpListedTool[] {
  const schema = mcpJsonObject(inputSchema)
  if (!schema) return []
  const kept = { annotations: mcpJsonObject(annotations), _meta: mcpJsonObject(_meta) }
  return [{
    name, ...(description ? { description } : {}), inputSchema: schema,
    ...(kept.annotations ? { annotations: kept.annotations } : {}),
    ...(kept._meta ? { _meta: kept._meta } : {}),
  }]
}

function toolInfo({ name, description, annotations, _meta }: Tool): McpToolInfo {
  const record = asRecord(annotations)
  return { name, ...(description ? { description } : {}), ...(record ? { annotations: record } : {}), ...(_meta ? { _meta } : {}) }
}

function resultDetails(server: string, tool: string, result: CallToolResult, snapshot: McpAppSnapshot | undefined): JsonValue {
  const facts = {
    server, tool,
    ...(result._meta ? { resultMeta: result._meta } : {}),
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    ...(snapshot ? { app: snapshot.app } : {}),
  }
  return copyJson({ mcp: facts, ...(snapshot ? { appDocument: snapshot.document } : {}) }, { omitUndefinedProperties: true })
}

const mcpNotFound = (message: string): McpOperationRefusal => ({ ok: false, status: "not_found", message })

export class PiMcpTools {
  private readonly clients = new Map<string, Promise<McpClient>>()
  private readonly servers = new Map<string, ProjectedMcpServer>()
  private listed: { key: string; tools: ToolRegistration[] } | undefined

  constructor(private readonly host: PiMcpHost) {}

  async tools(servers: readonly ProjectedMcpServer[], key: string): Promise<ToolRegistration[]> {
    if (this.listed?.key === key) return this.listed.tools
    await this.close()
    for (const server of servers) this.servers.set(server.name, server)
    const cached = await this.host.cached(key)
    const fresh = await this.list(servers.filter((server) => !Object.hasOwn(cached, server.name)))
    if (Object.keys(fresh).length > 0) await this.host.record(key, { ...cached, ...fresh })
    const lists = { ...cached, ...fresh }
    const tools = servers.flatMap((server) => (lists[server.name] ?? [])
      .filter((tool) => mcpToolVisibleTo(tool._meta, "model")).map((tool) => this.tool(server, tool)))
    if (servers.every((server) => Object.hasOwn(lists, server.name))) this.listed = { key, tools }
    return tools
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()]
    this.clients.clear()
    this.servers.clear()
    this.listed = undefined
    await Promise.all(clients.map(async (client) => (await client).close()))
  }

  listTools(server: string): Promise<{ ok: true; tools: readonly McpToolInfo[] } | McpOperationRefusal> {
    return this.operate(server, async (projected) => ({ ok: true, tools: (await this.request(projected, (client) => client.listTools())).value.map(toolInfo) }))
  }

  callTool(call: McpToolCall): Promise<{ ok: true; result: McpCallToolResult } | McpOperationRefusal> {
    return this.operate(call.server, async (projected) => {
      const tool = (await this.request(projected, (client) => client.listTools())).value.find((listed) => listed.name === call.tool)
      if (!tool) return mcpNotFound(`MCP server ${call.server} has no tool ${call.tool}`)
      if (!mcpToolVisibleTo(tool._meta, "app")) return { ok: false, status: "refused", message: `MCP tool ${call.tool} is not offered to apps` }
      return { ok: true, result: (await this.request(projected, (client) => client.callTool(call.tool, { ...call.arguments }))).value }
    })
  }

  readResource(read: McpResourceRead): Promise<{ ok: true; result: McpReadResourceResult } | McpOperationRefusal> {
    return this.operate(read.server, async (projected) => ({ ok: true, result: (await this.request(projected, (client) => client.readResource(read.uri))).value }))
  }

  private async operate<T>(server: string, run: (projected: ProjectedMcpServer) => Promise<T | McpOperationRefusal>): Promise<T | McpOperationRefusal> {
    const projected = this.servers.get(server)
    if (!projected) return mcpNotFound(`The session has no MCP server ${server}`)
    try {
      return await run(projected)
    } catch (error) {
      return { ok: false, status: "unavailable", message: errorMessage(error) }
    }
  }

  private async list(servers: readonly ProjectedMcpServer[]): Promise<McpToolLists> {
    const listed = await Promise.all(servers.map(async (server): Promise<[string, McpListedTool[]][]> => {
      try {
        return [[server.name, (await (await this.client(server)).listTools()).flatMap(listedTool)]]
      } catch (error) {
        this.clients.delete(server.name)
        this.host.failed(server.name, error)
        return []
      }
    }))
    return Object.fromEntries(listed.flat())
  }

  private client(server: ProjectedMcpServer): Promise<McpClient> {
    const existing = this.clients.get(server.name)
    if (existing) return existing
    const connecting = (async () => {
      const client = new McpClient({ name: "claxedo-pi", version: "1.0.0", capabilities: PI_MCP_CAPABILITIES })
      client.onClose(() => { if (this.clients.get(server.name) === connecting) this.clients.delete(server.name) })
      await client.connect(await this.host.connect(server))
      return client
    })()
    this.clients.set(server.name, connecting)
    return connecting
  }

  private tool(server: ProjectedMcpServer, tool: McpListedTool): ToolRegistration {
    return defineTool({
      name: piMcpToolName(server.name, tool.name),
      description: tool.description ?? `${tool.name} from MCP server ${server.name}`,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      execute: async (args, _api, context) => {
        const options = context.abortSignal ? { signal: context.abortSignal } : {}
        const { client, value: result } = await this.request(server, (client) => client.callTool(tool.name, args, options))
        const uri = result.isError === true ? undefined : mcpAppResourceUri(tool._meta)
        const snapshot = uri ? await this.snapshot(server.name, tool.name, client, uri, options) : undefined
        return { content: toLlmContent(result), isError: result.isError === true, details: resultDetails(server.name, tool.name, result, snapshot) }
      },
    })
  }

  private async snapshot(server: string, tool: string, client: McpClient, uri: string, options: McpRequestOptions): Promise<McpAppSnapshot | undefined> {
    try {
      const captured = mcpAppSnapshot(uri, await client.readResource(uri, options))
      if (captured.ok) return captured.snapshot
      this.host.appUnavailable(server, tool, captured.reason)
    } catch (error) {
      this.host.appUnavailable(server, tool, errorMessage(error))
    }
    return undefined
  }

  private async request<T>(server: ProjectedMcpServer, send: (client: McpClient) => Promise<T>): Promise<{ client: McpClient; value: T }> {
    const client = await this.connected(server)
    try {
      return { client, value: await send(client) }
    } catch (error) {
      if (!(error instanceof McpSessionExpiredError || error instanceof McpAuthRequiredError)) throw error
      await client.close()
      const renewed = await this.connected(server)
      return { client: renewed, value: await send(renewed) }
    }
  }

  private connected(server: ProjectedMcpServer): Promise<McpClient> {
    return this.client(server).catch((error: unknown) => {
      this.clients.delete(server.name)
      throw new Error(`MCP server ${server.name} is unavailable: ${errorMessage(error)}`, { cause: error })
    })
  }
}
