import { ServerError } from "./errors"
import { sessionEndpoint } from "./session-context"
import { jsonInit, type RuntimeRoute, type Transport } from "./transport"
import type { GoalAction, SessionGoal, SessionGoalState, SessionLocation } from "./types"
import { GOAL_ACTION_ROUTES, goalMutationFromWire } from "./wire/goal"

export const NO_GOAL: SessionGoalState = { goal: undefined, actions: [], available: false }

export async function startGoal(transport: Transport, where: RuntimeRoute, ref: SessionLocation, objective: string): Promise<SessionGoal> {
  const goal = goalMutationFromWire(await transport.runtimeJson(where, sessionEndpoint(ref, "/goal"), jsonInit("POST", { objective })))
  if (!goal) throw new ServerError({ class: "internal", message: "The goal start answered without a goal" })
  return goal
}

export async function controlGoal(transport: Transport, where: RuntimeRoute, ref: SessionLocation, action: GoalAction): Promise<SessionGoal | undefined> {
  const route = GOAL_ACTION_ROUTES[action]
  const init = route.method === "POST" ? jsonInit("POST", {}) : { method: route.method }
  return goalMutationFromWire(await transport.runtimeJson(where, sessionEndpoint(ref, route.suffix), init))
}
