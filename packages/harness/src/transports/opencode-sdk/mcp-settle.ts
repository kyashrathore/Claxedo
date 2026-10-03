import type { Plugin } from "@opencode-ai/plugin"
import { watchPluginEvents } from "./plugin-events.js"

export type McpSettle = Readonly<{ ready: Promise<void>; close(): Promise<void> }>

const statusEvent = (type: string) => type === "mcp.status.changed"

function toolPrefix(server: string): string {
  return `${server.replace(/[^a-zA-Z0-9_-]/g, "_")}_`
}

class McpSettleWatch {
  private readonly statuses = new Map<string, string>()
  private readonly connectedAt = new Map<string, number>()
  private readonly done = Promise.withResolvers<void>()
  private reloads = 0
  private tools: readonly string[] = []
  private complete = false

  constructor(private readonly context: Plugin.Context, private readonly servers: readonly string[]) {
    this.check()
  }

  get ready(): Promise<void> { return this.done.promise }

  observeTools(ids: readonly string[]): void {
    this.reloads += 1
    this.tools = ids
    this.check()
    if (!this.complete) void this.refresh().catch((error: unknown) => console.error("OpenCode MCP status read failed", error))
  }

  async refresh(): Promise<void> {
    const listed = await this.context.mcp.list({ location: this.context.location })
    for (const server of listed.data) {
      if (server.status.status === "connected" && this.statuses.get(server.name) !== "connected") this.connectedAt.set(server.name, this.reloads)
      this.statuses.set(server.name, server.status.status)
    }
    this.check()
  }

  private settled(server: string): boolean {
    const status = this.statuses.get(server)
    if (status === undefined || status === "pending") return false
    if (status !== "connected") return true
    return this.reloads > (this.connectedAt.get(server) ?? this.reloads) || this.tools.some((id) => id.startsWith(toolPrefix(server)))
  }

  private check(): void {
    if (this.complete || !this.servers.every((server) => this.settled(server))) return
    this.complete = true
    this.done.resolve()
  }
}

export async function watchMcpSettle(context: Plugin.Context, servers: readonly string[]): Promise<McpSettle> {
  const watch = new McpSettleWatch(context, servers)
  await context.tool.transform((draft) => { watch.observeTools(draft.list().map((tool) => tool.id)) })
  const events = watchPluginEvents(context, statusEvent, () => watch.refresh(), "OpenCode MCP status watch failed")
  return { ready: watch.ready, close: () => events.close() }
}
