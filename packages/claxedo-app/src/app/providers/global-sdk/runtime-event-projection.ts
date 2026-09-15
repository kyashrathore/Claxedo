/** Admits canonical presentation events and runtime-only diagnostics. */
import { isAgentPresentationEventType, type AgentPresentationEvent } from "@claxedo/agent-runtime-contract"
import type { ClaxedoWorkspaceEvent } from "@/platform/api/claxedo-api-types"
import {
  createClientPresentationProjection,
} from "@claxedo/agent-event-runtime/client-presentation"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import type { SubagentRegistry } from "@/features/session/subagents/subagent-registry"
import type { LiveSession } from "../global-sdk-event-fetch"
import { type RuntimeEventEnvelope } from "./runtime-envelope"
import { asRecord, readString } from "@/lib/record"
import { eventDirectoryForLiveSession } from "./live-session"
import { invalidateSessionGoalData } from "./goal-events"

export type GlobalSdkEvent = AgentPresentationEvent | ClaxedoWorkspaceEvent
type Event = GlobalSdkEvent
type EventDirectory = string

/**
 * The workspace half of {@link GlobalSdkEvent} as a value, so the frames this
 * app admits can be checked against the union rather than claimed to match it.
 *
 * `satisfies Record<…, true>` makes the compiler fail HERE when the union in
 * `claxedo-api-types.ts` gains an arm, so the admission test cannot fall behind
 * the type it admits. It sits beside the composed union instead of beside the
 * union it enumerates because `claxedo-api-types.ts` is a type-only module and
 * every product's dependency closure is measured in modules that carry code.
 */
const CLAXEDO_WORKSPACE_EVENT_TYPES = {
  "file.watcher.updated": true,
  "project.updated": true,
  "vcs.branch.updated": true,
  "global.disposed": true,
  "session.created": true,
  "session.deleted": true,
  "session.share.changed": true,
  "pty.created": true,
  "pty.updated": true,
  "pty.exited": true,
  "pty.deleted": true,
} satisfies Record<ClaxedoWorkspaceEvent["type"], true>

/**
 * A frame whose `type` names an event of one of the two contracts this app
 * speaks — the same admission test `isAgentRuntimeEvent` applies to the runtime
 * lane in `runtime-envelope.ts`, for the same reason: both registries are
 * `satisfies Record<…, true>` over their unions, so a `type` that passes is a
 * real arm name rather than any string, and the fields readers go on to touch
 * are the ones that arm declares.
 *
 * A frame naming neither contract is dropped here. Nothing could consume it
 * anyway: subscribers are keyed by `GlobalSdkEvent["type"]`, so an unrecognized
 * frame previously travelled the whole enqueue path to match no subscriber.
 */
function isGlobalSdkEvent(value: unknown): value is Event {
  const payload = asRecord(value)
  if (typeof payload?.type !== "string") return false
  return isAgentPresentationEventType(payload.type) || Object.hasOwn(CLAXEDO_WORKSPACE_EVENT_TYPES, payload.type)
}

export function compatEventEnvelope(input: unknown): { directory?: string; payload: Event } | undefined {
  const row = asRecord(input)
  if (!row || row.type === "heartbeat") return undefined
  const payload = asRecord(row.payload) ?? row
  if (typeof payload.type !== "string" || payload.type === "server.heartbeat") return undefined
  const properties = asRecord(payload.properties)
  // Flat control-plane lifecycle frames are consumed by ClaxedoEventsProvider.
  if (!properties) return undefined
  if (!isGlobalSdkEvent(payload)) return undefined
  const info = asRecord(properties.info)
  const sessionId = typeof properties.sessionID === "string"
    ? properties.sessionID
    : payload.type.startsWith("session.") && typeof info?.id === "string"
      ? info.id
      : undefined
  const directory = row.directory === "" ? sessionId : row.directory
  return {
    ...(typeof directory === "string" ? { directory } : {}),
    payload,
  }
}

/**
 * Transcript rows and parts arrive on the server's presentation bus. Replaying
 * raw deltas here would create a second accumulator with different part IDs
 * whenever this client attaches after the beginning of a turn.
 *
 * Routing diagnostics can originate outside a turn projector, so the runtime
 * lane still admits those through the shared diagnostic formatter. It never
 * creates a message or retains transcript projection state.
 */
export function projectRuntimeDiagnosticEnvelope(input: RuntimeEventEnvelope): Array<{ directory: EventDirectory; payload: Event }> {
  if (input.payload.type !== "diagnostic") return []
  return createClientPresentationProjection({
    sessionId: input.sessionId,
    assistantMessageId: input.assistantMessageId ?? input.sessionId,
    directory: input.directory,
  }).ingest(input.payload).map((event) => ({ directory: input.directory, payload: event.payload as Event }))
}

export function runtimeReplayGap(input: RuntimeEventEnvelope) {
  const payload = input.payload
  return payload.type === "harness-notice" &&
    payload.code === "runtime.sse_replay_gap"
}

export function resetRuntimeReplayGapState(input: {
  envelope: RuntimeEventEnvelope
  baseUrl?: string
  liveSession?: LiveSession
  subagents?: SubagentRegistry
  goalScope?: Parameters<typeof invalidateSessionGoalData>[0]
}) {
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

/** A `message.part.updated` frame, once the discriminant has been read. */
export type PartUpdatedEvent = Extract<GlobalSdkEvent, { type: "message.part.updated" }>

/**
 * A predicate rather than a boolean: the caller's next move is to read
 * `properties.part`, and only the narrowing carries that. Returning a bare
 * `boolean` left the one caller re-asserting the payload it had just tested.
 */
export function partUpdateSupersedesDeltas(payload: Event): payload is PartUpdatedEvent {
  if (payload.type !== "message.part.updated") return false
  const text = readString(payload.properties.part, "text")
  return text !== undefined && text.length > 0
}
