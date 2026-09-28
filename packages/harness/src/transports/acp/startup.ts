import type { CreateElicitationRequest, CreateElicitationResponse, RequestPermissionRequest } from "@agentclientprotocol/sdk"
import { createKeyedSerializer } from "@claxedo/helpers"
import type { AttachInput, HarnessServices, HarnessSession, McpServerSpec, SessionBroker, StartInput } from "../../contract"
import { connectAcp, type AcpConnectionOptions, type AcpPeer } from "./connection"
import type { AcpConnectionHealth } from "./health"
import { AcpStartupDeadline } from "./deadline"
import { AcpTransportError } from "./errors"
import { acpFlushUpdates, acpObserveSubagent, acpUnknown, acpUpdate } from "./events"
import { ACP_PLUGINS_NOT_APPLIED, claudeOptionsMeta } from "./extensions/claude-options"
import type { AcpEntry, AcpMcpFilter } from "./index"
import { acpModeState } from "./options"
import { acpElicitation, acpMcp, acpPermission } from "./protocol"
import { restoreAcp, type AcpRestored, type MissingSessionContext } from "./restore"

export type AcpHost = {
  readonly health: AcpConnectionHealth
  readonly services: HarnessServices
  readonly connection: AcpConnectionOptions
  readonly filterMcp: AcpMcpFilter
  readonly missingContext: MissingSessionContext
  readonly entries: Map<string, AcpEntry>
  readonly starting: Set<AcpEntry>
  readonly startingAborts: Set<AbortController>
  idle(entry: AcpEntry): void
  disposed(): boolean
  mcp(entry: Pick<AcpEntry, "start" | "peer">): McpServerSpec[]
}

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

export async function openAcpEntry(host: AcpHost, input: StartInput, broker: SessionBroker): Promise<AcpEntry> {
  if (host.disposed()) throw new AcpTransportError("connection", "ACP transport disposed")
  const observation = host.health.begin(input.sessionId, input.directory)
  let entry: AcpEntry | undefined
  const notifications = createKeyedSerializer()
  const inOrder = (deliver: () => Promise<void>) => notifications.run(input.sessionId, deliver)
  const startupAbort = new AbortController()
  host.startingAborts.add(startupAbort)
  let peer: AcpPeer
  try { peer = await connectAcp(input, host.connection, host.services, {
    permission: (request) => acpSidePermission(entry, broker, request, startupAbort.signal),
    elicitation: (request) => acpSideElicitation(entry, broker, request, startupAbort.signal),
    complete: (notification) => (entry?.turnBroker ?? broker).completeElicitation(notification.elicitationId),
    update: (notification) => inOrder(() => acpUpdate(entry, notification, (update) => acpObserveSubagent(entry, update))),
    extension: (_sessionId, update) => inOrder(() => acpObserveSubagent(entry, update)),
    unknown: (sessionId, method, payload) => inOrder(() => acpUnknown(entry, sessionId, method, payload)),
  }, { role: "harness", signal: startupAbort.signal }) } catch (error) { observation.failed(error); startupAbort.abort(); host.startingAborts.delete(startupAbort); throw error }
  if (host.disposed()) { host.startingAborts.delete(startupAbort); await peer.retire(); throw new AcpTransportError("connection", "ACP transport disposed during startup") }
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
  host.starting.add(entry)
  return entry
}

async function adopt(host: AcpHost, entry: AcpEntry, restored: AcpRestored, what: string): Promise<HarnessSession> {
  entry.startup = undefined
  if (restored.configOptions != null) entry.options = restored.configOptions
  if (restored.modes !== undefined) Object.assign(entry, { currentModeId: undefined }, acpModeState(restored.modes))
  entry.session = { ...entry.session, binding: await entry.broker.rebind(restored.upstreamSessionId) }
  await acpFlushUpdates(entry, (update) => acpObserveSubagent(entry, update))
  if (host.disposed()) throw new AcpTransportError("connection", `ACP transport disposed during ${what}`)
  if (entry.peer.agent.signal.aborted) throw new AcpTransportError("connection", `ACP peer disconnected during ${what}`)
  host.starting.delete(entry)
  host.startingAborts.delete(entry.startupAbort)
  entry.observation.ready()
  host.entries.set(entry.session.binding.sessionId, entry)
  return entry.session
}

async function abandon(host: AcpHost, entry: AcpEntry, error: unknown): Promise<never> {
  entry.observation.failed(error)
  entry.startupAbort.abort()
  host.starting.delete(entry)
  host.startingAborts.delete(entry.startupAbort)
  await entry.peer.retire()
  throw error
}

function acpStartupDeadline(host: AcpHost, operation: string): AcpStartupDeadline {
  return new AcpStartupDeadline(host.services.clock, host.connection.startupTimeoutMs ?? 10_000, operation)
}

export async function startAcpEntry(host: AcpHost, input: StartInput, broker: SessionBroker): Promise<HarnessSession> {
  const entry = await openAcpEntry(host, input, broker)
  try {
    const { meta, notApplied } = claudeOptionsMeta(entry.peer.handshake, input)
    entry.startup = acpStartupDeadline(host, "session/new")
    const result = await entry.startup.run(entry.peer.agent.newSession({ cwd: input.directory, mcpServers: host.mcp(entry).map(acpMcp),
      ...(meta ? { _meta: meta } : {}) }))
    const session = await adopt(host, entry, { upstreamSessionId: result.sessionId, modes: result.modes, configOptions: result.configOptions }, "startup")
    if (notApplied.length) await broker.publish({ type: "harness-notice", code: "acp.plugins.not-applied", severity: "warn",
      message: `${notApplied.length === 1 ? "Plugin" : "Plugins"} ${notApplied.map((item) => item.item).join(", ")} not applied: ${ACP_PLUGINS_NOT_APPLIED}`,
      details: { notApplied } })
    return session
  } catch (error) { return abandon(host, entry, error) }
}

export async function attachAcpEntry(host: AcpHost, input: AttachInput, broker: SessionBroker): Promise<HarnessSession> {
  const entry = await openAcpEntry(host, input, broker)
  try {
    entry.startup = acpStartupDeadline(host, "session restore")
    const restored = await entry.startup.run(restoreAcp(entry.peer, input, host.mcp(entry).map(acpMcp), broker, host.missingContext,
      claudeOptionsMeta(entry.peer.handshake, input).meta))
    return await adopt(host, entry, restored, "attach")
  } catch (error) { return abandon(host, entry, error) }
}

export async function restartAcpEntry(host: AcpHost, entry: AcpEntry): Promise<void> {
  entry.pendingRestart = false
  entry.startupAbort.abort()
  await entry.peer.retire()
  host.entries.delete(entry.session.binding.sessionId)
  const next = await openAcpEntry(host, entry.start, entry.broker)
  try {
    next.startup = acpStartupDeadline(host, "session restore")
    const restored = await next.startup.run(restoreAcp(next.peer, { ...entry.start, binding: entry.session.binding },
      host.mcp(next).map(acpMcp), entry.broker, host.missingContext, claudeOptionsMeta(next.peer.handshake, entry.start).meta))
    next.options = entry.options
    next.commands = entry.commands
    next.modes = entry.modes
    next.currentModeId = entry.currentModeId
    next.context = entry.context
    await adopt(host, next, restored, "restart")
  } catch (error) { await abandon(host, next, error) }
}
