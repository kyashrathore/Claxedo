import type { StreamLifecycleState, StreamVisibility, WorkItemState } from "../contracts/lifecycle"

/**
 * Reasons a `pending` Work Item cannot launch right now. Consumed by the drain
 * (launch), the snapshot projector (Waiting/Ready display), and the attention
 * projector (Needs-you reasons). The SQLite adapter ships a single shared SQL
 * fragment that mirrors this predicate; this pure function is its oracle.
 */
export type WorkItemLaunchabilityReason =
  | "not_approved"
  | "not_pending"
  | "stream_not_active"
  | "replacement_barrier"
  | "stream_held"
  | "workspace_busy"
  | "deps_incomplete"
  | "blocking_decision"
  | "attempt_in_flight"
  | "capability_invalid"

export type WorkItemLaunchability =
  | Readonly<{ launchable: true }>
  | Readonly<{ launchable: false; reason: WorkItemLaunchabilityReason }>

export interface WorkItemLaunchabilityInput {
  /** The Work Item lifecycle. Only `pending` (approved) items can launch. */
  readonly state: WorkItemState
  readonly stream: Readonly<{
    lifecycle: StreamLifecycleState
    visibility: StreamVisibility
    /** Stream replacement cleanup is still pending. */
    replacementBarrier?: boolean
    /**
     * Derived per pass (never persisted): the Stream holds new launches while
     * any Attempt is in `attention` or any Work Item is `failed`, exactly as
     * autonomous mode halted before. Resolve/retry clears the hold.
     */
    held?: boolean
    /** A live Attempt already owns the Stream's shared workspace. */
    hasRunningAttempt?: boolean
  }>
  /** Lifecycle of every direct blocker; `completed` and `abandoned` both satisfy. */
  readonly blockerStates: readonly WorkItemState[]
  /** A `proposed`/`pending` Decision affects this item (directly or via a dependency). */
  readonly blockingDecision?: boolean
  /** A live Attempt (`admitted`/`placing`/`running`) already exists for the item. */
  readonly attemptInFlight?: boolean
  /** The resolved execution profile passed capability validation. Defaults to true. */
  readonly capabilityValid?: boolean
}

const DEPENDENCY_SATISFIED: ReadonlySet<WorkItemState> = new Set<WorkItemState>(["completed", "abandoned"])

export function evaluateWorkItemLaunchability(input: WorkItemLaunchabilityInput): WorkItemLaunchability {
  if (input.state === "pending_approval") return unlaunchable("not_approved")
  if (input.state !== "pending") return unlaunchable("not_pending")
  if (input.stream.lifecycle !== "active" || input.stream.visibility === "archived")
    return unlaunchable("stream_not_active")
  if (input.stream.replacementBarrier) return unlaunchable("replacement_barrier")
  if (input.stream.held) return unlaunchable("stream_held")
  if (input.stream.hasRunningAttempt) return unlaunchable("workspace_busy")
  if (input.blockerStates.some((state) => !DEPENDENCY_SATISFIED.has(state))) return unlaunchable("deps_incomplete")
  if (input.blockingDecision) return unlaunchable("blocking_decision")
  if (input.attemptInFlight) return unlaunchable("attempt_in_flight")
  if (input.capabilityValid === false) return unlaunchable("capability_invalid")
  return { launchable: true }
}

function unlaunchable(reason: WorkItemLaunchabilityReason): WorkItemLaunchability {
  return { launchable: false, reason }
}
