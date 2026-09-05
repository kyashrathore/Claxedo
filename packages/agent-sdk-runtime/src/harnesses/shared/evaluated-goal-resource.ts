import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { AgentGoalResource } from "../../adapter-contract"
import { goalCapabilities, GOAL_ACTIONS } from "../../capabilities"
import type { SdkRuntimeDriverHost, SdkRuntimeTurnInput } from "./sdk-runtime-driver"
import { goalInitialPrompt, goalContinuationPrompt, goalEvaluationProgress, type GoalEvaluation } from "./goal-protocol"

/** First-party goal policy over the shared turn owner; the evaluator never performs the work. */
export function createEvaluatedGoalResource(input: {
  host: SdkRuntimeDriverHost
  runIteration(turn: SdkRuntimeTurnInput, prompt: string, objective: string): Promise<GoalEvaluation>
}) {
  const { host } = input
  const runs = new Map<string, { abort: AbortController; done: Promise<void> }>()
  const publish = (sessionId: string, directory: string, goal: RuntimeGoalSnapshot | null) =>
    host.publishGoal({ sessionId, directory, goal })
  const read = (sessionId: string, directory: string) => {
    const goal = host.getGoal(sessionId)
    if (goal?.status === "active" && !runs.has(sessionId)) {
      const blocked: RuntimeGoalSnapshot = {
        ...goal,
        status: "blocked",
        updatedAt: Date.now(),
        lastReason: "Goal execution was interrupted; resume explicitly",
      }
      publish(sessionId, directory, blocked)
      return blocked
    }
    return goal
  }
  const launch = (sessionId: string, directory: string) => {
    const run = { abort: new AbortController(), done: Promise.resolve() }
    runs.set(sessionId, run)
    run.done = (async () => {
      while (!run.abort.signal.aborted) {
        const goal = host.getGoal(sessionId)
        if (!goal || goal.status !== "active") break
        const prompt = goal.iteration
          ? goalContinuationPrompt({ objective: goal.objective, reason: goal.lastReason })
          : goalInitialPrompt(goal.objective)
        let evaluation: GoalEvaluation | undefined
        let failure: unknown
        const admitted = await host.runProviderTurn({ sessionId, directory }, async (turn) => {
          try {
            evaluation = await input.runIteration(turn, prompt, goal.objective)
          } catch (error) {
            failure = error
            throw error
          }
        })
        if (run.abort.signal.aborted) break
        if (failure) throw failure
        if (!admitted || !evaluation) throw new Error("Goal iteration did not complete")
        const next = { ...goal, ...goalEvaluationProgress({ evaluation, iteration: (goal.iteration ?? 0) + 1 }) }
        publish(sessionId, directory, next)
        if (next.status === "complete") break
      }
    })()
      .catch((error) => {
        if (run.abort.signal.aborted) return
        const goal = host.getGoal(sessionId)
        if (goal)
          publish(sessionId, directory, {
            ...goal,
            status: "blocked",
            updatedAt: Date.now(),
            lastReason: error instanceof Error ? error.message : String(error),
          })
      })
      .finally(() => {
        if (runs.get(sessionId) === run) runs.delete(sessionId)
      })
  }
  const pause = async (sessionId: string, directory: string) => {
    const run = runs.get(sessionId)
    run?.abort.abort()
    if (host.lifecycle().abort(sessionId)) await host.lifecycle().whenIdle(sessionId)
    await run?.done
    const goal = host.getGoal(sessionId)
    if (!goal) return { ok: false as const, status: "not_found" as const, message: "Goal not found" }
    if (goal.status === "complete")
      return { ok: false as const, status: "conflict" as const, message: "Completed goals cannot pause" }
    const next: RuntimeGoalSnapshot = { ...goal, status: "paused", updatedAt: Date.now() }
    publish(sessionId, directory, next)
    return { ok: true as const, goal: next }
  }
  const resource: AgentGoalResource = {
    readCapabilities: (sessionId) =>
      goalCapabilities({
        implemented: true,
        available: !!host.getSessionConfig(sessionId)?.model,
        unavailableReason: host.getSessionConfig(sessionId)?.model ? undefined : "Select a native model first",
        actions: GOAL_ACTIONS,
        recovery: "blocked",
        optionalFields: ["iteration", "lastReason"],
      }),
    read: async (sessionId, directory) => read(sessionId, directory ?? ""),
    start: async (sessionId, request, directory) => {
      if (!directory) return { ok: false, status: "unavailable", message: "A machine directory is required" }
      if (!host.getSessionConfig(sessionId)?.model)
        return { ok: false, status: "unavailable", message: "Select a native model first" }
      const current = read(sessionId, directory)
      if (current && current.status !== "complete")
        return { ok: false, status: "conflict", message: "A Goal already exists" }
      if (host.lifecycle().get(sessionId))
        return { ok: false, status: "conflict", message: "Session has an active turn" }
      const now = Date.now()
      const goal: RuntimeGoalSnapshot = {
        sessionId,
        objective: request.objective,
        status: "active",
        createdAt: now,
        updatedAt: now,
        iteration: 0,
      }
      publish(sessionId, directory, goal)
      launch(sessionId, directory)
      return { ok: true, goal }
    },
    pause: (sessionId, directory) => pause(sessionId, directory ?? ""),
    stop: (sessionId, directory) => pause(sessionId, directory ?? ""),
    resume: async (sessionId, directory) => {
      if (!directory) return { ok: false, status: "unavailable", message: "A machine directory is required" }
      const goal = read(sessionId, directory)
      if (!goal) return { ok: false, status: "not_found", message: "Goal not found" }
      if (goal.status === "complete") return { ok: false, status: "conflict", message: "Completed goals cannot resume" }
      if (runs.has(sessionId) || host.lifecycle().get(sessionId))
        return { ok: false, status: "conflict", message: "Session has an active turn" }
      const next: RuntimeGoalSnapshot = { ...goal, status: "active", updatedAt: Date.now() }
      publish(sessionId, directory, next)
      launch(sessionId, directory)
      return { ok: true, goal: next }
    },
    delete: async (sessionId, directory) => {
      await pause(sessionId, directory ?? "")
      publish(sessionId, directory ?? "", null)
      return { ok: true, goal: null }
    },
  }
  return {
    resource,
    dispose: async () => {
      await Promise.all(
        [...runs].map(async ([sessionId, run]) => {
          run.abort.abort()
          host.lifecycle().abort(sessionId)
          await run.done
        }),
      )
    },
  }
}
