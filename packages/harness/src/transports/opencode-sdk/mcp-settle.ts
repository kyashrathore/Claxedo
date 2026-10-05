import type { Plugin } from "@opencode-ai/plugin"
import { watchPluginEvents, type PluginEventWatch } from "./plugin-events.js"

export type McpSettle = Readonly<{ ready: Promise<readonly string[]>; close(): Promise<void> }>

const MCP_SETTLE_MS = 10_000

const isSettleEvent = (type: string) => type === "mcp.status.changed" || type === "command.updated"

function toolNamespace(server: string): string {
  return server.replace(/[^a-zA-Z0-9_-]/g, "_")
}

class McpSettleWatch {
  private readonly statuses = new Map<string, string>()
  private readonly connectedAt = new Map<string, number>()
  private readonly promptsListed = new Map<string, boolean>()
  private readonly done = Promise.withResolvers<readonly string[]>()
  private readonly timer: ReturnType<typeof setTimeout>
  private reloads = 0
  private namespaces = new Set<string>()
  private complete = false
  events?: PluginEventWatch

  constructor(private readonly context: Plugin.Context, private readonly servers: readonly string[]) {
    this.timer = setTimeout(() => this.finish(servers.filter((server) => !this.settled(server))), MCP_SETTLE_MS)
    this.check()
  }

  get ready(): Promise<readonly string[]> { return this.done.promise }

  get finished(): boolean { return this.complete }

  observeTools(namespaces: readonly (string | undefined)[]): void {
    if (this.complete) return
    this.reloads += 1
    this.namespaces = new Set(namespaces.filter((namespace) => namespace !== undefined))
    this.check()
    if (!this.complete) void this.refresh().catch((error: unknown) => console.error("OpenCode MCP status read failed", error))
  }

  async observe(event: { type: string }): Promise<void> {
    if (event.type === "mcp.status.changed") return this.refresh()
    const waiting = [...this.promptsListed].find(([, listed]) => !listed)
    if (waiting) this.promptsListed.set(waiting[0], true)
    this.check()
  }

  async refresh(): Promise<void> {
    if (this.complete) return
    const listed = await this.context.mcp.list({ location: this.context.location })
    for (const { name, status } of listed.data) {
      if (status.status === "connected" && this.statuses.get(name) !== "connected") this.connectedAt.set(name, this.reloads)
      if (status.status === "connected" && this.servers.includes(name) && !this.promptsListed.has(name)) this.promptsListed.set(name, false)
      this.statuses.set(name, status.status)
    }
    this.check()
  }

  private settled(server: string): boolean {
    const status = this.statuses.get(server)
    if (status === undefined || status === "pending") return false
    if (status !== "connected") return true
    if (this.promptsListed.get(server) !== true) return false
    return this.reloads > (this.connectedAt.get(server) ?? this.reloads) || this.namespaces.has(toolNamespace(server))
  }

  private check(): void {
    if (this.servers.every((server) => this.settled(server))) this.finish([])
  }

  finish(unsettled: readonly string[]): void {
    if (this.complete) return
    this.complete = true
    clearTimeout(this.timer)
    this.done.resolve(unsettled)
    void this.events?.close()
  }
}

export async function watchMcpSettle(context: Plugin.Context, servers: readonly string[]): Promise<McpSettle> {
  const watch = new McpSettleWatch(context, servers)
  await context.tool.transform((draft) => { watch.observeTools(draft.list().map((tool) => tool.options?.namespace)) })
  if (!watch.finished) watch.events = watchPluginEvents(context, isSettleEvent, (event) => watch.observe(event), "OpenCode MCP settle watch failed")
  return { ready: watch.ready, close: async () => { watch.finish([]); await watch.events?.close() } }
}
