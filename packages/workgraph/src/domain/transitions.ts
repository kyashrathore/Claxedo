import type {
  AttemptState,
  DecisionState,
  OutcomeState,
  StreamLifecycleState,
  StreamVisibility,
  WorkItemState,
} from "../contracts/lifecycle"

export type LifecycleEntity = "stream" | "stream_visibility" | "outcome" | "work_item" | "attempt" | "decision"

export type TransitionResult<State extends string> =
  | { readonly ok: true; readonly state: State }
  | {
      readonly ok: false
      readonly error: {
        readonly code: "invalid_transition"
        readonly entity: LifecycleEntity
        readonly from: State
        readonly to: State
      }
    }

const streamTransitions = {
  active: ["paused", "closed"],
  paused: ["active", "closed"],
  closed: ["reopened"],
  reopened: ["active"],
} as const satisfies Record<StreamLifecycleState, readonly StreamLifecycleState[]>

const outcomeTransitions = {
  pending: ["active", "blocked"],
  active: ["ready_to_close", "blocked"],
  ready_to_close: ["blocked"],
  completed: [],
  blocked: ["active"],
  reopened: ["active"],
} as const satisfies Record<OutcomeState, readonly OutcomeState[]>

const workItemTransitions = {
  pending_approval: ["pending", "abandoned"],
  pending: ["pending_approval", "active", "blocked", "abandoned"],
  active: [
    "result_ready",
    "review_needed",
    "integration_needed",
    "blocked",
    "verification_failed",
    "failed",
    "abandoned",
  ],
  result_ready: ["review_needed", "integration_needed", "verification_failed", "active", "abandoned"],
  review_needed: ["result_ready", "integration_needed", "verification_failed", "active", "abandoned"],
  integration_needed: ["result_ready", "verification_failed", "active", "abandoned"],
  blocked: ["active", "abandoned"],
  verification_failed: ["active", "abandoned"],
  completed: [],
  failed: ["pending", "abandoned"],
  abandoned: [],
} as const satisfies Record<WorkItemState, readonly WorkItemState[]>

const attemptTransitions = {
  admitted: ["placing", "cancelled"],
  placing: ["running", "failed", "cancelled"],
  running: ["result", "attention", "failed", "cancelled"],
  result: [],
  attention: ["running", "result", "failed", "cancelled"],
  failed: [],
  cancelled: [],
} as const satisfies Record<AttemptState, readonly AttemptState[]>

const decisionTransitions = {
  proposed: ["pending"],
  pending: ["answered", "dismissed"],
  answered: [],
  dismissed: [],
} as const satisfies Record<DecisionState, readonly DecisionState[]>

const streamVisibilityTransitions = {
  visible: ["archived"],
  archived: ["visible"],
} as const satisfies Record<StreamVisibility, readonly StreamVisibility[]>

export function transitionStream(from: StreamLifecycleState, to: StreamLifecycleState) {
  return transition("stream", streamTransitions, from, to)
}

export function transitionStreamVisibility(from: StreamVisibility, to: StreamVisibility) {
  return transition("stream_visibility", streamVisibilityTransitions, from, to)
}

export function transitionOutcome(from: OutcomeState, to: OutcomeState) {
  return transition("outcome", outcomeTransitions, from, to)
}

export function transitionWorkItem(from: WorkItemState, to: WorkItemState) {
  return transition("work_item", workItemTransitions, from, to)
}

export function transitionAttempt(from: AttemptState, to: AttemptState) {
  return transition("attempt", attemptTransitions, from, to)
}

export function transitionDecision(from: DecisionState, to: DecisionState) {
  return transition("decision", decisionTransitions, from, to)
}

function transition<State extends string>(
  entity: LifecycleEntity,
  transitions: Record<State, readonly State[]>,
  from: State,
  to: State,
): TransitionResult<State> {
  if (transitions[from].includes(to)) return { ok: true, state: to }
  return { ok: false, error: { code: "invalid_transition", entity, from, to } }
}
