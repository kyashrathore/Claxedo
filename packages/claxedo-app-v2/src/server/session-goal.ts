import { ServerError } from "./errors"
import { sessionPath } from "./session-context"
import { jsonInit, type RuntimeRoute, type Transport } from "./transport"
import type { GoalAction, SessionGoal, SessionGoalState, SessionRef } from "./types"
import { GOAL_ACTION_ROUTES, GOAL_UNAVAILABLE, goalMutationFromWire, goalStateFromWire } from "./wire/goal"

const NO_GOAL: SessionGoalState = { goal: undefined, actions: [], available: false }

export async function readGoalState(transport: Transport, where: RuntimeRoute, ref: SessionRef): Promise<SessionGoalState> {
  try {
    return goalStateFromWire(await transport.runtimeJson<unknown>(where, sessionPath(ref, "/goal/state")))
  } catch (error) {
    if (error instanceof ServerError && error.code === GOAL_UNAVAILABLE) return NO_GOAL
    throw error
  }
}

export async function startGoal(transport: Transport, where: RuntimeRoute, ref: SessionRef, objective: string): Promise<SessionGoal> {
  const goal = goalMutationFromWire(await transport.runtimeJson<unknown>(where, sessionPath(ref, "/goal"), jsonInit("POST", { objective })))
  if (!goal) throw new ServerError({ class: "internal", message: "The goal start answered without a goal" })
  return goal
}

export async function controlGoal(transport: Transport, where: RuntimeRoute, ref: SessionRef, action: GoalAction): Promise<SessionGoal | undefined> {
  const route = GOAL_ACTION_ROUTES[action]
  const init = route.method === "POST" ? jsonInit("POST", {}) : { method: route.method }
  return goalMutationFromWire(await transport.runtimeJson<unknown>(where, sessionPath(ref, route.suffix), init))
}
