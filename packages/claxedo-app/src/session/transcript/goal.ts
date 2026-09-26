import { createSignal, type Accessor } from "solid-js"
import { toAppError, type GoalAction, type Server, type SessionGoal, type SessionGoalState, type SessionRef } from "@/server"

export type GoalFacts = { readonly goal: SessionGoal | undefined; readonly removedCreatedAt: number }

export type SessionGoalStore = {
  readonly goal: Accessor<SessionGoal | undefined>
  readonly actions: Accessor<readonly GoalAction[]>
  readonly available: Accessor<boolean | undefined>
  readonly read: (state: SessionGoalState) => void
  readonly changed: (goal: SessionGoal | undefined) => void
  readonly control: (action: GoalAction) => Promise<void>
}

const NO_ACTIONS: readonly GoalAction[] = []

const NO_GOAL: GoalFacts = { goal: undefined, removedCreatedAt: Number.NEGATIVE_INFINITY }

function isStale(facts: GoalFacts, incoming: SessionGoal): boolean {
  if (incoming.createdAt <= facts.removedCreatedAt) return true
  const current = facts.goal
  if (!current) return false
  if (incoming.createdAt !== current.createdAt) return incoming.createdAt < current.createdAt
  return incoming.updatedAt < current.updatedAt
}

export function goalChanged(facts: GoalFacts, incoming: SessionGoal | undefined): GoalFacts {
  if (incoming) return isStale(facts, incoming) ? facts : { ...facts, goal: incoming }
  const current = facts.goal
  if (!current) return facts
  return { goal: undefined, removedCreatedAt: Math.max(facts.removedCreatedAt, current.createdAt) }
}

export function createSessionGoal(server: Server, ref: SessionRef): SessionGoalStore {
  const [facts, setFacts] = createSignal<GoalFacts>(NO_GOAL)
  const [actions, setActions] = createSignal<readonly GoalAction[]>(NO_ACTIONS)
  const [available, setAvailable] = createSignal<boolean>()
  const changed = (incoming: SessionGoal | undefined) => setFacts((current) => goalChanged(current, incoming))
  return {
    goal: () => facts().goal,
    actions,
    available,
    read: (state) => {
      changed(state.goal)
      setActions(state.actions)
      setAvailable(state.available)
    },
    changed,
    control: async (action) => {
      try {
        changed(await server.sessions.controlGoal(ref, action))
      } catch (cause) {
        throw toAppError(cause)
      }
    },
  }
}
