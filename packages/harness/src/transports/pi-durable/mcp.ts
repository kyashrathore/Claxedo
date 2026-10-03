import { errorMessage } from "@claxedo/helpers"
import type { TSchema } from "@earendil-works/pi-ai"
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { McpClient, toLlmContent, type McpTransport, type Tool } from "@earendil-works/pi-mcp"
import type { ProjectedMcpServer } from "../../contract"

const NAME_LIMIT = 64

function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (const char of value) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0
  return hash.toString(16).padStart(8, "0")
}

export function piMcpToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`
  const clean = raw.replace(/[^A-Za-z0-9_]/g, "_")
  return clean === raw && raw.length <= NAME_LIMIT ? raw : `${clean.slice(0, NAME_LIMIT - 9)}_${fnv1a(raw)}`
}

export type PiMcpHost = {
  connect(server: ProjectedMcpServer): Promise<McpTransport>
  failed(server: string, error: unknown): void
}

export class PiMcpTools {
  private readonly clients = new Map<string, Promise<McpClient>>()
  private listed: { key: string; tools: ToolRegistration[] } | undefined

  constructor(private readonly host: PiMcpHost) {}

  async tools(servers: readonly ProjectedMcpServer[], key: string): Promise<ToolRegistration[]> {
    if (this.listed?.key === key) return this.listed.tools
    await this.close()
    const tools = (await Promise.all(servers.map((server) => this.serverTools(server)))).flat()
    this.listed = { key, tools }
    return tools
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()]
    this.clients.clear()
    this.listed = undefined
    await Promise.all(clients.map(async (client) => (await client).close()))
  }

  private async serverTools(server: ProjectedMcpServer): Promise<ToolRegistration[]> {
    try {
      const listed = await (await this.client(server)).listTools()
      return listed.map((tool) => this.tool(server, tool))
    } catch (error) {
      this.clients.delete(server.name)
      this.host.failed(server.name, error)
      return []
    }
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

  private tool(server: ProjectedMcpServer, tool: Tool): ToolRegistration {
    return defineTool({
      name: piMcpToolName(server.name, tool.name),
      description: tool.description ?? `${tool.name} from MCP server ${server.name}`,
      parameters: tool.inputSchema as unknown as TSchema,
      execute: async (args, _api, context) => {
        const client = await this.client(server).catch((error: unknown) => {
          this.clients.delete(server.name)
          throw new Error(`MCP server ${server.name} is unavailable: ${errorMessage(error)}`, { cause: error })
        })
        const result = await client.callTool(tool.name, args as Record<string, unknown>, context.abortSignal ? { signal: context.abortSignal } : {})
        return { content: toLlmContent(result), isError: result.isError === true }
      },
    })
  }
}
