import type { Plugin } from "@opencode-ai/plugin"
import { connectFirstPartyMcp, type FirstPartyMcpProvider } from "@claxedo/agent-sdk-runtime/mcp-resolver"
import type { OpenCodeHost } from "./host"

type Connection = Awaited<ReturnType<typeof connectFirstPartyMcp>>
type Tools = Awaited<ReturnType<Connection["tools"]>>

export class OpenCodeFirstPartyMcp {
  private sessions = new Map<string, { connection: Connection; tools: Tools }>()
  private install?: Promise<void>
  private reload?: () => Promise<void>

  constructor(private host: OpenCodeHost, private workspaceId: string, private directory: string) {}

  async connect(sessionId: string, provider: FirstPartyMcpProvider) {
    const connection = await connectFirstPartyMcp(provider.server(sessionId))
    try {
      const tools = await connection.tools()
      this.sessions.set(sessionId, { connection, tools })
      this.install ??= this.installPlugin().catch((error) => {
        this.install = undefined
        throw error
      })
      await this.install
      await this.reload?.()
    } catch (error) {
      this.sessions.delete(sessionId)
      await connection.close()
      throw error
    }
    return async () => {
      this.sessions.delete(sessionId)
      await connection.close()
    }
  }

  private async installPlugin() {
    const plugin: Plugin.Plugin = {
      id: `claxedo-mcp-${this.workspaceId}`,
      setup: async (context) => {
        if (context.location.directory !== this.directory) return
        await context.tool.transform((draft) => {
          const tools = new Map([...this.sessions.values()].flatMap((session) => session.tools.map((tool) => [tool.name, tool] as const)))
          for (const tool of tools.values()) {
            draft.add({
              name: `mcp__claxedo__${tool.name}`,
              options: { codemode: false },
              description: tool.description ?? tool.name,
              input: tool.inputSchema,
              execute: async (args, call) => {
                const session = this.sessions.get(String(call.sessionID))
                if (!session?.tools.some((candidate) => candidate.name === tool.name)) throw new Error("Claxedo tool is unavailable to this session")
                const result = await session.connection.call(tool.name, args as Record<string, unknown>)
                const content = result.content.map((block) => block.type === "text" ? String(block.text) : JSON.stringify(block)).join("\n")
                if (result.isError) throw new Error(content)
                return { content }
              },
            })
          }
        })
        await context.session.hook("context", (input) => {
          const allowed = new Set(this.sessions.get(String(input.sessionID))?.tools.map((tool) => `mcp__claxedo__${tool.name}`))
          for (const name of Object.keys(input.tools)) if (name.startsWith("mcp__claxedo__") && !allowed.has(name)) delete input.tools[name]
        })
        this.reload = context.tool.reload
      },
    }
    const client = await this.host.client()
    await client.plugin(plugin)
    await client.model.list({ location: { directory: this.directory } })
    if (!this.reload) throw new Error("OpenCode did not install its Claxedo MCP tools")
  }
}
