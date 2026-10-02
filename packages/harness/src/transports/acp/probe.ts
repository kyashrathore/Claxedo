import { prefixedRandomId } from "@claxedo/helpers"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { draftProbeKey, DraftProbeCache, type DraftLaunch, type HarnessServices, type StartInput } from "../../contract"
import { connectAcp, type AcpConnectionOptions } from "./connection"
import type { AcpMcpFilter } from "./index"
import type { AcpPeerOwnership } from "./ownership"
import { AcpTransportError } from "./errors"
import { claudeOptionsMeta } from "./extensions/claude-options"
import { acpMcp } from "./protocol"
import { AcpStartupDeadline } from "./deadline"
import { acpAgentList } from "./extensions/agents"
import { acpGroups } from "./extensions/groups"
import type { AgentAgent } from "@claxedo/agent-runtime-contract"
import { acpMcpProjection } from "./projection"
import { acpAgents, acpModeState, type AcpCatalog } from "./options"

type Commands = Extract<SessionNotification["update"], { sessionUpdate: "available_commands_update" }>["availableCommands"]
type ProbeResult = { catalog: AcpCatalog; commands: Commands; agents: AgentAgent[] }

export const ACP_DRAFT_PROBE_MAX_AGE_MS = 30_000

export class AcpDraftProbes {
  private readonly cache: DraftProbeCache<ProbeResult>
  private readonly disposeAbort = new AbortController()

  constructor(private readonly services: HarnessServices, private readonly connection: AcpConnectionOptions,
    private readonly filterMcp: AcpMcpFilter, private readonly peers: AcpPeerOwnership) {
    this.cache = new DraftProbeCache()
  }

  catalog(draft: DraftLaunch, mode: "probe" | "peek"): Promise<AcpCatalog> {
    return this.result(draft, mode, false, false).then((result) => result.catalog)
  }

  commands(draft: DraftLaunch): Promise<Commands> {
    return this.result(draft, "probe", true, false).then((result) => result.commands)
  }

  agents(draft: DraftLaunch): Promise<AgentAgent[]> {
    return this.result(draft, "probe", false, true).then((result) => result.agents)
  }

  private result(draft: DraftLaunch, mode: "probe" | "peek", needCommands: boolean, needAgents: boolean): Promise<ProbeResult> {
    if (this.disposeAbort.signal.aborted) throw new AcpTransportError("connection", "ACP transport disposed")
    const key = draftProbeKey(draft, needCommands, needAgents)
    const inputs = { files: [], maxAge: { ms: ACP_DRAFT_PROBE_MAX_AGE_MS, clock: this.services.clock } }
    if (mode === "peek") {
      return this.cache.peek(key, inputs).then((result) => result ?? { catalog: { options: [], modes: [] }, commands: [], agents: [] })
    }
    return this.cache.read(key, inputs, () => this.run(draft, needCommands, needAgents))
  }

  private async run(draft: DraftLaunch, needCommands: boolean, needAgents: boolean): Promise<ProbeResult> {
    const input: StartInput = { ...draft, sessionId: prefixedRandomId("probe", "-") }
    let resolveCommands!: (commands: Commands) => void
    const commands = new Promise<Commands>((resolve) => { resolveCommands = resolve })
    const peer = await connectAcp(input, this.connection, this.services, {
      permission: async () => ({ outcome: { outcome: "cancelled" } }),
      elicitation: async () => ({ action: "cancel" }),
      complete: () => {}, update: (notification) => {
        if (notification.update.sessionUpdate === "available_commands_update") resolveCommands(notification.update.availableCommands)
      }, extension: () => {}, unknown: () => {},
    }, { role: "probe", signal: this.disposeAbort.signal, owner: this.peers })
    if (this.disposeAbort.signal.aborted) { await this.peers.retire(peer); throw new AcpTransportError("connection", "ACP transport disposed during probe") }
    try {
      const { servers } = acpMcpProjection({ start: input, peer }, this.services, this.connection, this.filterMcp)
      const { meta } = claudeOptionsMeta(peer.handshake, input)
      const deadline = new AcpStartupDeadline(this.services.clock, this.connection.startupTimeoutMs, "draft probe")
      const result = await deadline.run(peer.agent.newSession({ cwd: input.directory, mcpServers: servers.map(acpMcp),
        ...(meta ? { _meta: meta } : {}) }))
      const catalog: AcpCatalog = { options: result.configOptions ?? [], ...acpModeState(result.modes) }
      const agents = !needAgents ? [] : acpGroups(peer.handshake).agents
        ? await new AcpStartupDeadline(this.services.clock, this.connection.startupTimeoutMs, "draft agents")
          .run(acpAgentList(peer.agent, result.sessionId)) : acpAgents(catalog)
      if (!needCommands) return { catalog, commands: [], agents }
      const commandUpdate = new AcpStartupDeadline(this.services.clock, this.connection.startupTimeoutMs, "draft commands")
      return { catalog, commands: await commandUpdate.run(commands), agents }
    } finally {
      await this.peers.retire(peer)
    }
  }

  dispose(): void {
    this.disposeAbort.abort()
  }
}
