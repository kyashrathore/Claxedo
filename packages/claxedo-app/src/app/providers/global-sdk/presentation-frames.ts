/** Admits the presentation frames the two streams carry for a session. */
import { isAgentPresentationEventType, type AgentPresentationEvent } from "@claxedo/agent-runtime-contract"
import type { ClaxedoWorkspaceEvent } from "@/platform/api/claxedo-api-types"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { shellDataKeys } from "@/platform/sync/keys"
import type { SubagentRegistry } from "@/features/session/subagents/subagent-registry"
import { asRecord, readString } from "@/lib/record"
import { invalidateSessionGoalData } from "./goal-events"
import { scheduleSessionProjectionPull, sessionProjectionWorkspaceBacking } from "@/platform/runtime/agent/session-projection"
import { invalidateSessionShareQueries } from "@/features/session/data/query/session-list"

export type GlobalSdkEvent = AgentPresentationEvent | ClaxedoWorkspaceEvent
type Event = GlobalSdkEvent

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
  "session.deleted": true,
  "session.share.changed": true,
  "pty.created": true,
  "pty.updated": true,
  "pty.exited": true,
  "pty.deleted": true,
} satisfies Record<ClaxedoWorkspaceEvent["type"], true>

/**
 * A frame whose `type` names an event of one of the two contracts this app
 * speaks. Both registries are `satisfies Record<…, true>` over their unions,
 * so a `type` that passes is a real arm name rather than any string, and the
 * fields readers go on to touch are the ones that arm declares.
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
  // A frame with no `properties` is not presentation-shaped: a pty, process,
  // agent or session lifecycle control frame off `wr/events`, or a
  // control-plane notice off `cp/events`, both applied by ClaxedoEventsProvider
  // itself. Only presentation-shaped frames reach the conversation ingress.
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
 * A stream reported a hole. The reader has already asked the session
 * controller to re-read history and todo; what is left is every read model
 * the frames behind the hole would have advanced on their own — and, for a
 * session the control plane projects, a repair pull, since the checkpoints
 * the lost frames would have triggered never fired.
 */
export function resetStreamGapState(input: {
  baseUrl?: string
  directory: string
  sessionId: string
  subagents?: SubagentRegistry
  goalScope?: Parameters<typeof invalidateSessionGoalData>[0]
  projection?: Parameters<typeof sessionProjectionWorkspaceBacking>[0]
}) {
  input.subagents?.replayGap()
  const backing = input.projection ? sessionProjectionWorkspaceBacking(input.projection) : undefined
  if (backing) {
    void scheduleSessionProjectionPull({
      action: "repair",
      reason: "sse-gap",
      workspaceId: backing.workspaceId,
      sessionId: input.sessionId,
      idempotencyKey: `sse-gap:${backing.workspaceId}:${input.sessionId}:${Date.now()}`,
    })
  }
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.session.row(input.baseUrl, input.directory, input.sessionId) }),
    queryClient.invalidateQueries({ queryKey: shellDataKeys.sessionId(input.sessionId, "diff") }),
    queryClient.invalidateQueries({ queryKey: queryKeys.shell.sessionInventory(input.baseUrl) }),
    ...(input.goalScope ? [invalidateSessionGoalData(input.goalScope)] : []),
  ]).then(() => {})
}

/**
 * `cp/events` reported a hole. Every notice the control plane could have sent
 * in it is a doorbell for something read from the control plane, so the reads
 * those doorbells nudge are invalidated: the project catalog (a worktree
 * landing) and the session lists (a share granted or revoked, a workspace's
 * inventory changed).
 * The documents index revalidates off the same gap frame on its own port,
 * and provision steps are re-read by the connection authority's own resolve.
 */
export function resetControlPlaneGapState(baseUrl?: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.controlPlane.projects(baseUrl) }),
    invalidateSessionShareQueries({ baseUrl }),
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
