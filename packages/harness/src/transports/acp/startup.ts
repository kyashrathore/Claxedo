import type { CreateElicitationRequest, CreateElicitationResponse, McpServer, NewSessionResponse, RequestPermissionRequest } from "@agentclientprotocol/sdk"
import { createKeyedSerializer } from "@claxedo/helpers"
import { asRecord } from "@claxedo/helpers/guards"
import type { AttachInput, HarnessServices, HarnessSession, McpServerSpec, SessionBroker, StartInput } from "../../contract"
import { connectAcp, type AcpConnectionOptions, type AcpPeer } from "./connection"
import type { AcpConnectionHealth } from "./health"
import { AcpStartupDeadline } from "./deadline"
import { AcpTransportError } from "./errors"
import { acpFlushUpdates, acpObserveSubagent, acpUnknown, acpUpdate } from "./events"
import { ACP_PLUGINS_NOT_APPLIED, claudeOptionsMeta } from "./extensions/claude-options"
import type { AcpEntry, AcpMcpFilter } from "./index"
import { acpModeState } from "./options"
import type { AcpPeerOwnership } from "./ownership"
import { acpElicitation, acpMcp, acpPermission } from "./protocol"
import { acpMcpProjection } from "./projection"

export type AcpHost = {
  readonly health: AcpConnectionHealth
  readonly services: HarnessServices
  readonly connection: AcpConnectionOptions
  readonly filterMcp: AcpMcpFilter
  readonly entries: Map<string, AcpEntry>
  readonly startingAborts: Set<AbortController>
  readonly peers: AcpPeerOwnership
  idle(entry: AcpEntry): void
  disposed(): boolean
  mcp(entry: Pick<AcpEntry, "start" | "peer">): McpServerSpec[]
}

type AcpResumeInput = Omit<AttachInput, "upstreamHasTurns">

type AcpSessionOpened = Pick<NewSessionResponse, "modes" | "configOptions">

async function acpSidePermission(entry: AcpEntry | undefined, broker: SessionBroker, request: RequestPermissionRequest, startupSignal: AbortSignal) {
  if (!ownsRequest(entry, request.sessionId)) return { outcome: { outcome: "cancelled" as const } }
  const release = entry?.startup?.hold() ?? entry?.quiet?.hold()
  try {
    const response = await acpPermission(request, entry?.turnBroker ?? broker, broker.sessionId, entry?.turnBroker ? undefined : { signal: startupSignal })
    return entry?.cancelled ? { outcome: { outcome: "cancelled" as const } } : response
  } finally { release?.() }
}

function ownsRequest(entry: AcpEntry | undefined, sessionId: string | undefined): boolean {
  if (sessionId && entry?.sideSessions.has(sessionId)) return false
  const upstream = entry?.session.binding.upstreamSessionId
  return !upstream || upstream === sessionId
}

export async function acpSideElicitation(entry: AcpEntry | undefined, broker: SessionBroker, request: CreateElicitationRequest,
  startupSignal: AbortSignal): Promise<CreateElicitationResponse> {
  const sessionId = "sessionId" in request && typeof request.sessionId === "string" ? request.sessionId : undefined
  if (!ownsRequest(entry, sessionId)) return { action: "cancel" }
  const release = entry?.startup?.hold() ?? entry?.quiet?.hold()
  try { return await acpElicitation(request, entry?.turnBroker ?? broker, entry?.turnBroker ? undefined : { signal: startupSignal }) }
  finally { release?.() }
}

async function openAcpEntry(host: AcpHost, input: StartInput, broker: SessionBroker, signal?: AbortSignal): Promise<AcpEntry> {
  if (host.disposed()) throw new AcpTransportError("connection", "ACP transport disposed")
  const observation = host.health.begin(input.sessionId, input.directory)
  let entry: AcpEntry | undefined
  const notifications = createKeyedSerializer()
  const inOrder = (deliver: () => Promise<void>) => notifications.run(input.sessionId, deliver)
  const startupAbort = new AbortController()
  if (signal?.aborted) startupAbort.abort()
  else signal?.addEventListener("abort", () => startupAbort.abort(), { once: true })
  host.startingAborts.add(startupAbort)
  let peer: AcpPeer
  try { peer = await connectAcp(input, host.connection, host.services, {
    permission: (request) => acpSidePermission(entry, broker, request, startupAbort.signal),
    elicitation: (request) => acpSideElicitation(entry, broker, request, startupAbort.signal),
    complete: (notification) => (entry?.turnBroker ?? broker).completeElicitation(notification.elicitationId),
    update: (notification) => inOrder(() => acpUpdate(entry, notification)),
    extension: (_sessionId, update) => inOrder(() => acpObserveSubagent(entry, update)),
    unknown: (sessionId, method, payload) => inOrder(() => acpUnknown(entry, sessionId, method, payload)),
  }, { role: "harness", signal: startupAbort.signal, owner: host.peers }) } catch (error) { observation.failed(error); startupAbort.abort(); host.startingAborts.delete(startupAbort); throw error }
  if (host.disposed()) { host.startingAborts.delete(startupAbort); await host.peers.retire(peer); throw new AcpTransportError("connection", "ACP transport disposed during startup") }
  entry = { onIdle: () => host.idle(opened), updatesDelivered: () => inOrder(async () => {}), observation, start: input, broker, peer, phase: "ready", cancelled: false, pendingRestart: false, commands: [], options: [], modes: [], modeUpdates: 0, startupAbort,
    pendingUpdates: [], sideSessions: new Map(),
    session: { binding: { sessionId: input.sessionId, workspaceId: input.workspaceId, directory: input.directory,
      connectionId: input.config.harness.id, upstreamSessionId: "" }, directory: input.directory, locality: input.locality } }
  const opened = entry
  peer.agent.signal.addEventListener("abort", () => {
    observation.disconnected()
    opened.providerTurn?.queue.fail(new AcpTransportError("connection", "ACP peer disconnected"))
  }, { once: true })
  if (peer.agent.signal.aborted) observation.disconnected()
  return entry
}

async function resumeAcpSession(peer: AcpPeer, input: AcpResumeInput, mcpServers: McpServer[]): Promise<AcpSessionOpened> {
  const upstream = input.binding.upstreamSessionId
  const capabilities = peer.handshake.agentCapabilities
  try {
    if (capabilities?.sessionCapabilities?.resume) return await peer.agent.resumeSession({ sessionId: upstream, cwd: input.directory, mcpServers })
    if (capabilities?.loadSession) return await peer.agent.loadSession({ sessionId: upstream, cwd: input.directory, mcpServers })
    throw new AcpTransportError("protocol", "ACP agent declares neither load nor resume")
  } catch (error) {
    if (!lostAttachedSession(error, upstream)) throw error
    throw new AcpTransportError("session", `ACP agent no longer has session ${upstream}; it is not replaced`, error)
  }
}

function lostAttachedSession(error: unknown, sessionId: string): boolean {
  const failure = asRecord(error)
  const data = asRecord(failure?.data)
  return failure?.code === -32002 && (data?.uri === sessionId || data?.sessionId === sessionId)
}

async function adopt(host: AcpHost, entry: AcpEntry, upstreamSessionId: string, opened: AcpSessionOpened, what: string): Promise<HarnessSession> {
  if (entry.startupAbort.signal.aborted) throw new AcpTransportError("connection", "ACP startup was abandoned")
  entry.startup = undefined
  if (opened.configOptions != null) entry.options = opened.configOptions
  if (opened.modes !== undefined) Object.assign(entry, { currentModeId: undefined }, acpModeState(opened.modes))
  entry.session = { ...entry.session, binding: await entry.broker.rebind(upstreamSessionId) }
  await acpFlushUpdates(entry)
  if (host.disposed() || entry.startupAbort.signal.aborted) throw new AcpTransportError("connection", `ACP transport closed during ${what}`)
  if (entry.peer.agent.signal.aborted) throw new AcpTransportError("connection", `ACP peer disconnected during ${what}`)
  host.startingAborts.delete(entry.startupAbort)
  entry.observation.ready()
  host.entries.set(entry.session.binding.sessionId, entry)
  return entry.session
}

async function abandon(host: AcpHost, entry: AcpEntry, error: unknown): Promise<never> {
  entry.observation.failed(error)
  entry.startupAbort.abort()
  host.startingAborts.delete(entry.startupAbort)
  await host.peers.retire(entry.peer)
  throw error
}

export async function startAcpEntry(host: AcpHost, input: StartInput, broker: SessionBroker): Promise<HarnessSession> {
  const entry = await openAcpEntry(host, input, broker)
  try {
    const { meta, notApplied } = claudeOptionsMeta(entry.peer.handshake, input)
    const mcp = acpMcpProjection(entry, host.services, host.connection, host.filterMcp)
    entry.startup = new AcpStartupDeadline(host.services.clock, host.connection.startupTimeoutMs, "session/new")
    const result = await entry.startup.run(entry.peer.agent.newSession({ cwd: input.directory, mcpServers: mcp.servers.map(acpMcp),
      ...(meta ? { _meta: meta } : {}) }))
    const session = await adopt(host, entry, result.sessionId, result, "startup")
    if (mcp.notApplied.length) await broker.publish({ type: "harness-notice", code: "acp.mcp.not-applied", severity: "warn",
      message: `MCP servers not applied: ${mcp.notApplied.map((item) => `${item.item} (${item.reason})`).join(", ")}`,
      details: { notApplied: mcp.notApplied } })
    if (notApplied.length) await broker.publish({ type: "harness-notice", code: "acp.plugins.not-applied", severity: "warn",
      message: `${notApplied.length === 1 ? "Plugin" : "Plugins"} ${notApplied.map((item) => item.item).join(", ")} not applied: ${ACP_PLUGINS_NOT_APPLIED}`,
      details: { notApplied } })
    return session
  } catch (error) { return abandon(host, entry, error) }
}

export async function attachAcpEntry(host: AcpHost, input: AcpResumeInput, broker: SessionBroker, prior?: AcpEntry, signal?: AbortSignal): Promise<HarnessSession> {
  const entry = await openAcpEntry(host, input, broker, signal)
  if (prior) {
    entry.options = prior.options
    entry.commands = prior.commands
    entry.modes = prior.modes
    entry.currentModeId = prior.currentModeId
    entry.context = prior.context
  }
  try {
    entry.startup = new AcpStartupDeadline(host.services.clock, host.connection.startupTimeoutMs, "session restore")
    const opened = await entry.startup.run(resumeAcpSession(entry.peer, input, host.mcp(entry).map(acpMcp)), entry.startupAbort.signal)
    return await adopt(host, entry, input.binding.upstreamSessionId, opened, "attach")
  } catch (error) { return abandon(host, entry, error) }
}

export async function restartAcpEntry(host: AcpHost, entry: AcpEntry, signal: AbortSignal): Promise<void> {
  entry.pendingRestart = false
  entry.startupAbort.abort()
  await host.peers.retire(entry.peer)
  host.entries.delete(entry.session.binding.sessionId)
  if (signal.aborted || host.disposed()) return
  await attachAcpEntry(host, { ...entry.start, binding: entry.session.binding }, entry.broker, entry, signal)
}
