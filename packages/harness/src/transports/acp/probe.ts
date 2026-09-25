import { randomUUID } from "node:crypto"
import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import type { DraftLaunch, HarnessServices, StartInput } from "../../contract"
import { connectAcp, type AcpConnectionOptions, type AcpPeer } from "./connection"
import type { AcpMcpFilter } from "./index"
import { AcpTransportError } from "./errors"
import { claudeOptionsMeta } from "./extensions/claude-options"
import { acpMcp } from "./protocol"
import { AcpStartupDeadline } from "./deadline"

export class AcpDraftProbes {
  private readonly peers = new Set<AcpPeer>()
  private readonly cache = new Map<string, Promise<SessionConfigOption[]>>()
  private disposed = false

  constructor(private readonly services: HarnessServices, private readonly connection: AcpConnectionOptions,
    private readonly filterMcp: AcpMcpFilter) {}

  options(draft: DraftLaunch, mode: "probe" | "peek"): Promise<SessionConfigOption[]> {
    if (this.disposed) throw new AcpTransportError("connection", "ACP transport disposed")
    const key = JSON.stringify(draft)
    const cached = this.cache.get(key)
    if (cached) return cached
    if (mode === "peek") return Promise.resolve([])
    const probe = this.run(draft)
    this.cache.set(key, probe)
    void probe.then(undefined, () => this.cache.delete(key))
    return probe
  }

  private async run(draft: DraftLaunch): Promise<SessionConfigOption[]> {
    const input: StartInput = { ...draft, sessionId: `probe-${randomUUID()}` }
    const peer = await connectAcp(input, this.connection, this.services, {
      permission: async () => ({ outcome: { outcome: "cancelled" } }),
      elicitation: async () => ({ action: "cancel" }),
      complete: () => {}, update: () => {}, extension: () => {}, unknown: () => {},
    }, "probe")
    if (this.disposed) { await peer.retire(); throw new AcpTransportError("connection", "ACP transport disposed during probe") }
    this.peers.add(peer)
    try {
      const first = this.services.firstPartyMcp(input.sessionId, input.locality)
      const projected = [...input.projection.mcpServers, ...(first ? [{ ...first, origin: "first-party" as const }] : [])]
      const servers = this.filterMcp({ servers: projected, locality: input.locality,
        mcpCapabilities: peer.handshake.agentCapabilities?.mcpCapabilities,
        supportsMcpServers: this.connection.supportsMcpServers }).servers
      const meta = claudeOptionsMeta(peer.handshake, input)
      const deadline = new AcpStartupDeadline(this.services.clock, this.connection.startupTimeoutMs ?? 10_000, "draft probe")
      const result = await deadline.run(peer.agent.newSession({ cwd: input.directory, mcpServers: servers.map(acpMcp),
        ...(meta ? { _meta: meta } : {}) }))
      return result.configOptions ?? []
    } finally {
      this.peers.delete(peer)
      await peer.retire()
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.peers].map((peer) => peer.retire()))
  }
}
