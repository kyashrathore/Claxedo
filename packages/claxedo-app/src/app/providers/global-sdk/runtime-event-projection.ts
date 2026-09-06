/** Decodes presentation envelopes and projects the canonical runtime lane. */
import type { AgentPresentationEvent } from "@claxedo/agent-runtime-contract"
import type { ClaxedoWorkspaceEvent } from "@/platform/api/claxedo-api-types"
import {
  createClientPresentationProjection,
  type ClientPresentationProjection,
} from "@claxedo/agent-event-runtime/client-presentation"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import type { SubagentRegistry } from "@/features/session/subagents/subagent-registry"
import type { LiveSession } from "../global-sdk-event-fetch"
import { record, type RuntimeEventEnvelope } from "./runtime-envelope"
import { eventDirectoryForLiveSession } from "./live-session"
import { invalidateSessionGoalData } from "./goal-events"

export type RuntimeProjectionCache = Map<string, ClientPresentationProjection>

export type GlobalSdkEvent = AgentPresentationEvent | ClaxedoWorkspaceEvent
type Event = GlobalSdkEvent
type EventDirectory = string
export function compatEventEnvelope(input: unknown): { directory?: string; payload: Event } | undefined {
  const row = record(input)
  if (!row || row.type === "heartbeat") return undefined
  const payload = record(row.payload) ?? row
  if (typeof payload.type !== "string" || payload.type === "server.heartbeat") return undefined
  const properties = record(payload.properties)
  // Flat control-plane lifecycle frames are consumed by ClaxedoEventsProvider.
  if (!properties) return undefined
  const info = record(properties.info)
  const sessionId = typeof properties.sessionID === "string"
    ? properties.sessionID
    : payload.type.startsWith("session.") && typeof info?.id === "string"
      ? info.id
      : undefined
  const directory = row.directory === "" ? sessionId : row.directory
  return {
    ...(typeof directory === "string" ? { directory } : {}),
    payload: payload as Event,
  }
}

export function projectRuntimeEventEnvelope(
  input: RuntimeEventEnvelope,
  projections: RuntimeProjectionCache = new Map(),
): Array<{ directory: EventDirectory; payload: Event }> {
  const assistantMessageId = input.assistantMessageId
  const key = `${input.sessionId}:${assistantMessageId ?? ""}`
  const projection = projections.get(key) ?? createClientPresentationProjection({
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
  const events = projection.ingest(input.payload)
  if (input.payload.type === "finish" || input.payload.type === "error") {
    projections.delete(key)
  } else if (input.payload.type === "session-agent" || events.some((event) => event.payload.type.startsWith("message."))) {
    // Message parts/steps and the announced agent need state across frames.
    // Late metadata can project independently without retaining a completed turn.
    projections.set(key, projection)
  }
  return events.map((event) => ({
    directory: input.directory,
    payload: event.payload as Event,
  }))
}

export function runtimeReplayGap(input: RuntimeEventEnvelope) {
  const payload = input.payload
  return payload.type === "harness-notice" &&
    payload.code === "runtime.sse_replay_gap"
}

export function resetRuntimeReplayGapState(input: {
  envelope: RuntimeEventEnvelope
  projections?: RuntimeProjectionCache
  baseUrl?: string
  liveSession?: LiveSession
  subagents?: SubagentRegistry
  goalScope?: Parameters<typeof invalidateSessionGoalData>[0]
}) {
  input.projections?.clear()
  input.subagents?.replayGap()
  const directory = eventDirectoryForLiveSession({
    directory: input.envelope.directory,
    sessionId: input.envelope.sessionId,
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

export function partUpdateSupersedesDeltas(payload: Event) {
  if (payload.type !== "message.part.updated") return false
  const part = record((payload.properties as { part?: unknown }).part)
  return typeof part?.text === "string" && part.text.length > 0
}
