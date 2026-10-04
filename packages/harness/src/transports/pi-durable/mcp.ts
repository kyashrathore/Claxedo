import { errorMessage } from "@claxedo/helpers"
import { isJsonValue } from "@earendil-works/chord"
import { Type } from "@earendil-works/pi-ai"
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { McpClient, toLlmContent, type McpTransport } from "@earendil-works/pi-mcp"
import type { ProjectedMcpServer } from "../../contract"
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
  cached(key: string): Promise<McpToolLists>
  record(key: string, lists: McpToolLists): Promise<void>
}

export class PiMcpTools {
  private readonly clients = new Map<string, Promise<McpClient>>()
  private listed: { key: string; tools: ToolRegistration[] } | undefined

  constructor(private readonly host: PiMcpHost) {}

  async tools(servers: readonly ProjectedMcpServer[], key: string): Promise<ToolRegistration[]> {
    if (this.listed?.key === key) return this.listed.tools
    await this.close()
    const cached = await this.host.cached(key)
    const fresh = await this.list(servers.filter((server) => !Object.hasOwn(cached, server.name)))
    if (Object.keys(fresh).length > 0) await this.host.record(key, { ...cached, ...fresh })
    const lists = { ...cached, ...fresh }
    const tools = servers.flatMap((server) => (lists[server.name] ?? []).map((tool) => this.tool(server, tool)))
    this.listed = { key, tools }
    return tools
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()]
    this.clients.clear()
    this.listed = undefined
    await Promise.all(clients.map(async (client) => (await client).close()))
  }

  private async list(servers: readonly ProjectedMcpServer[]): Promise<McpToolLists> {
    const listed = await Promise.all(servers.map(async (server): Promise<[string, McpListedTool[]][]> => {
      try {
        const tools = await (await this.client(server)).listTools()
        return [[server.name, tools.flatMap(({ name, description, inputSchema }) =>
          isJsonValue(inputSchema) ? [{ name, ...(description ? { description } : {}), inputSchema }] : [])]]
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
      const client = new McpClient({ name: "claxedo-pi", version: "1.0.0" })
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
        const client = await this.client(server).catch((error: unknown) => {
          this.clients.delete(server.name)
          throw new Error(`MCP server ${server.name} is unavailable: ${errorMessage(error)}`, { cause: error })
        })
        const result = await client.callTool(tool.name, args, context.abortSignal ? { signal: context.abortSignal } : {})
        return { content: toLlmContent(result), isError: result.isError === true }
      },
    })
  }
}
