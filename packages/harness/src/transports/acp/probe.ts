import { prefixedRandomId } from "@claxedo/helpers"
import type { SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk"
import type { DraftLaunch, HarnessServices, StartInput } from "../../contract"
import { connectAcp, type AcpConnectionOptions, type AcpPeer } from "./connection"
import type { AcpMcpFilter } from "./index"
import { AcpTransportError } from "./errors"
import { claudeOptionsMeta } from "./extensions/claude-options"
import { acpMcp } from "./protocol"
import { AcpStartupDeadline } from "./deadline"
import { acpAgentList } from "./extensions/agents"
import { acpGroups } from "./extensions/groups"
import type { AgentAgent } from "@claxedo/agent-runtime-contract"
import { draftProbeKey, DraftProbeCache, sessionMcpServers } from "../../contract"

type Commands = Extract<SessionNotification["update"], { sessionUpdate: "available_commands_update" }>["availableCommands"]
type ProbeResult = { options: SessionConfigOption[]; commands: Commands; agents: AgentAgent[] }

export class AcpDraftProbes {
  private readonly peers = new Set<AcpPeer>()
  private readonly cache: DraftProbeCache<ProbeResult>
  private readonly disposeAbort = new AbortController()
  private disposed = false

  constructor(private readonly services: HarnessServices, private readonly connection: AcpConnectionOptions,
    private readonly filterMcp: AcpMcpFilter) {
    this.cache = new DraftProbeCache(services.clock)
  }

  options(draft: DraftLaunch, mode: "probe" | "peek"): Promise<SessionConfigOption[]> {
    return this.result(draft, mode, false, false).then((result) => result.options)
  }

  commands(draft: DraftLaunch): Promise<Commands> {
    return this.result(draft, "probe", true, false).then((result) => result.commands)
  }

  agents(draft: DraftLaunch): Promise<AgentAgent[]> {
    return this.result(draft, "probe", false, true).then((result) => result.agents)
  }

  private result(draft: DraftLaunch, mode: "probe" | "peek", needCommands: boolean, needAgents: boolean): Promise<ProbeResult> {
    if (this.disposed) throw new AcpTransportError("connection", "ACP transport disposed")
    const key = draftProbeKey(draft, needCommands, needAgents)
    const cached = this.cache.get(key)
    if (cached) return cached
    if (mode === "peek") return Promise.resolve({ options: [], commands: [], agents: [] })
    return this.cache.set(key, this.run(draft, needCommands, needAgents))
  }

  private async run(draft: DraftLaunch, needCommands: boolean, needAgents: boolean) {
    const input: StartInput = { ...draft, sessionId: prefixedRandomId("probe", "-") }
    let resolveCommands!: (commands: Commands) => void
    const commands = new Promise<Commands>((resolve) => { resolveCommands = resolve })
    const peer = await connectAcp(input, this.connection, this.services, {
      permission: async () => ({ outcome: { outcome: "cancelled" } }),
      elicitation: async () => ({ action: "cancel" }),
      complete: () => {}, update: (notification) => {
        if (notification.update.sessionUpdate === "available_commands_update") resolveCommands(notification.update.availableCommands)
      }, extension: () => {}, unknown: () => {},
    }, { role: "probe", signal: this.disposeAbort.signal })
    if (this.disposed) { await peer.retire(); throw new AcpTransportError("connection", "ACP transport disposed during probe") }
    this.peers.add(peer)
    try {
      const projected = sessionMcpServers(input, this.services, { includeFirstParty: true,
        duplicate: (name) => new AcpTransportError("configuration", `Duplicate ACP MCP server ${name}`) })
      const servers = this.filterMcp({ servers: projected, locality: input.locality,
        mcpCapabilities: peer.handshake.agentCapabilities?.mcpCapabilities,
        supportsMcpServers: this.connection.supportsMcpServers }).servers
      const meta = claudeOptionsMeta(peer.handshake, input)
      const deadline = new AcpStartupDeadline(this.services.clock, this.connection.startupTimeoutMs ?? 10_000, "draft probe")
      const result = await deadline.run(peer.agent.newSession({ cwd: input.directory, mcpServers: servers.map(acpMcp),
        ...(meta ? { _meta: meta } : {}) }))
      const agents = needAgents && acpGroups(peer.handshake).agents
        ? await new AcpStartupDeadline(this.services.clock, this.connection.startupTimeoutMs ?? 10_000, "draft agents")
          .run(acpAgentList(peer.agent, result.sessionId)) : []
      if (!needCommands) return { options: result.configOptions ?? [], commands: [], agents }
      const commandUpdate = new AcpStartupDeadline(this.services.clock, this.connection.startupTimeoutMs ?? 10_000, "draft commands")
      return { options: result.configOptions ?? [], commands: await commandUpdate.run(commands), agents }
    } finally {
      this.peers.delete(peer)
      await peer.retire()
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.disposeAbort.abort()
    await Promise.all([...this.peers].map((peer) => peer.retire()))
  }
}
