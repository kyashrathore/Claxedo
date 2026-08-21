import type { DecisionState, StreamLifecycleState, StreamVisibility } from "../contracts/lifecycle"

// Only the machines the stores actually consult live here; Run/WorkItem/Outcome
// motion is enforced by the stores' own guarded writes and the completion gate.
export type LifecycleEntity = "stream" | "stream_visibility" | "decision"

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
