/**
 * The runtime-events lane's projection into OpenCode-shaped events.
 *
 * `GlobalSdkProvider` (./provider.tsx) owns the CONNECTIONS — which stream is
 * open, for which session, and when it reconnects. This module owns what a
 * frame off that stream MEANS: the compat envelope it unwraps to, the
 * OpenCode-shaped events a runtime frame projects into, which lane may project
 * them, and what a replay gap invalidates. Every function here is pure of the
 * provider's reactive state, so the decisions can be read and tested as
 * decisions rather than through a mounted provider.
 */
import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2/client"
import {
  createOpencodeCompatProjection,
  runtimeOwnsOpencodeCompatProjection,
  type CompatEvent,
  type OpencodeCompatProjection,
} from "@claxedo/agent-event-runtime/opencode-compat"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import type { SubagentRegistry } from "@/features/session/subagents/subagent-registry"
import type { LiveSession } from "../global-sdk-event-fetch"
import { record, type RuntimeEventEnvelope } from "./runtime-envelope"
import { eventDirectoryForLiveSession } from "./live-session"
import { invalidateSessionGoalData } from "./goal-events"

export type RuntimeProjectionCache = Map<string, OpencodeCompatProjection>
export type RuntimeCoveredSessions = Set<string>

export type GlobalSdkEvent = OpenCodeEvent | CompatEvent
type Event = GlobalSdkEvent
type EventDirectory = string
const claxedoExtensionEventTypes = new Set<string>(["message.completed", "session.agent", "session.config", "session.usage", "runtime.diagnostic"])
export function isOpenCodeSdkEvent(event: GlobalSdkEvent): event is OpenCodeEvent {
  return !claxedoExtensionEventTypes.has(event.type)
}

export function compatEventEnvelope(input: unknown): { directory?: string; payload: Event } | undefined {
  const row = record(input)
  if (!row || row.type === "heartbeat") return
  const payload = record(row.payload) ?? row
  if (typeof payload.type !== "string" || payload.type === "server.heartbeat") return
  return {
    ...(typeof row.directory === "string" ? { directory: row.directory } : {}),
    payload: payload as Event,
  }
}

export function projectRuntimeEventEnvelope(
  input: RuntimeEventEnvelope,
  projections: RuntimeProjectionCache = new Map(),
): Array<{ directory: EventDirectory; payload: Event }> {
  const assistantMessageId = input.assistantMessageId
  const key = `${input.sessionId}:${assistantMessageId ?? ""}`
  const projection = projections.get(key) ?? createOpencodeCompatProjection({
    sessionId: input.sessionId,
    // A frame that names no reply belongs to the session, not to a turn
    // (a goal update, a diagnostic, a status). It has no reply row to hang
    // anything from, so the session's own id stands in for the message id and
    // nothing is announced — naming a reply the runtime never minted would
    // invent a turn.
    assistantMessageId: assistantMessageId ?? input.sessionId,
    directory: input.directory,
    // Nothing else produces OpenCode-shaped events for this turn here. The
    // runtime-events lane carries the turn's parts and names the message they
    // belong to, but never a row for that message, and the transcript store
    // files a part against an existing row. A turn this client did not start —
    // anyone attached to a session another client is driving — has no row until
    // this projection announces one.
    announcesAssistantMessage: assistantMessageId !== undefined,
  })
  projections.set(key, projection)
  return projection.ingest(input.payload).map((event) => ({
    directory: input.directory,
    payload: event.payload as Event,
  }))
}

function eventSessionId(payload: Event): string | undefined {
  const properties = record((payload as { properties?: unknown }).properties)
  if (typeof properties?.sessionID === "string") return properties.sessionID
  if (typeof properties?.sessionId === "string") return properties.sessionId
  const part = record(properties?.part)
  if (typeof part?.sessionID === "string") return part.sessionID
  const info = record(properties?.info)
  if (typeof info?.sessionID === "string") return info.sessionID
  return undefined
}

function runtimeSessionKey(sessionID: string) {
  return sessionID
}

export function rememberRuntimeEventEnvelope(input: RuntimeEventEnvelope, covered: RuntimeCoveredSessions) {
  covered.add(runtimeSessionKey(input.sessionId))
}

/**
 * Whether THIS lane must project the frame into OpenCode-compatible events.
 *
 * `runtimeOwnsOpencodeCompatProjection` answers that for a runtime sharing a
 * process with the surface: a `ses_`-prefixed session is an OpenCode-legacy one
 * whose compat frames ALSO arrive on this app's `/global/event` loop, so
 * projecting them here as well would apply every delta twice.
 *
 * A relay-backed workspace has no such second lane. Its engine publishes onto
 * the HOST's own global bus, which this app never reads — its `/global/event` is
 * its own control plane's — so `soleCompatLane` says the runtime-events stream
 * is the only carrier this session has. Deferring to a lane that does not exist
 * is what made an attached pane render a host-started turn as one finished block
 * at the settle refetch instead of text that grows: the ids the app mints for a
 * managed private session are `ses_`-prefixed (`reservePrivateSession`), so the
 * prefix rule dropped every frame of every user-hosted turn.
 */
export function runtimeProjectionOwnsCompat(
  input: RuntimeEventEnvelope,
  options?: { soleCompatLane?: boolean },
) {
  return options?.soleCompatLane === true || runtimeOwnsOpencodeCompatProjection(input)
}

export function runtimeReplayGap(input: RuntimeEventEnvelope) {
  const payload = input.payload
  return payload.type === "harness-notice" &&
    payload.code === "runtime.sse_replay_gap"
}

export function resetRuntimeReplayGapState(input: {
  envelope: RuntimeEventEnvelope
  projections?: RuntimeProjectionCache
  covered?: RuntimeCoveredSessions
  baseUrl?: string
  liveSession?: LiveSession
  subagents?: SubagentRegistry
  goalScope?: Parameters<typeof invalidateSessionGoalData>[0]
}) {
  input.projections?.clear()
  input.covered?.clear()
  input.subagents?.replayGap()
  const directory = eventDirectoryForLiveSession({
    directory: input.envelope.directory,
    liveSession: input.liveSession,
  })
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.session.row(input.baseUrl, directory, input.envelope.sessionId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.session.messages(input.baseUrl, directory, input.envelope.sessionId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.session.todo(input.baseUrl, directory, input.envelope.sessionId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.session.diff(input.baseUrl, directory, input.envelope.sessionId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.shell.sessionInventory(input.baseUrl) }),
    ...(input.goalScope ? [invalidateSessionGoalData(input.goalScope)] : []),
  ]).then(() => {})
}

function mirroredByRuntimeProjection(payload: Event) {
  // Defensive: keepalive frames (`{"type":"heartbeat"}`) and other envelopes
  // carry no event payload, so callers can hand us `undefined` — never read
  // `.type` off it or the whole event loop throws and the bus dies.
  if (!payload || typeof payload !== "object") return false
  const type = payload.type as string
  return type === "message.updated" ||
    type === "message.part.updated" ||
    type === "message.part.delta" ||
    type === "message.completed" ||
    type === "session.idle" ||
    type === "session.error" ||
    type === "session.status" ||
    type === "session.updated" ||
    type === "session.agent" ||
    type === "todo.updated" ||
    type === "permission.asked" ||
    type === "permission.replied" ||
    type === "question.asked" ||
    type === "question.replied" ||
    type === "question.rejected" ||
    type === "session.diff" ||
    type === "session.compacted"
}

export function shouldAcceptCompatEvent(payload: Event, covered: RuntimeCoveredSessions) {
  if (!mirroredByRuntimeProjection(payload)) return true
  const sessionID = eventSessionId(payload)
  if (!sessionID) return true
  if (runtimeOwnsOpencodeCompatProjection({ sessionId: sessionID })) return false
  return !covered.has(runtimeSessionKey(sessionID))
}

export function partUpdateSupersedesDeltas(payload: Event) {
  if (payload.type !== "message.part.updated") return false
  const part = record((payload.properties as { part?: unknown }).part)
  return typeof part?.text === "string" && part.text.length > 0
}
