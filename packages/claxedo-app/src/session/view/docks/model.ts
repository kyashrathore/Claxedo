import type { AppError, GoalAction } from "@/server"
import type { RequestState } from "@/session"
import type { Transition } from "@/lib/machine"
import { unreachable } from "@/lib/machine"

export const replyError = (state: RequestState): AppError | undefined => (state.kind === "failed" ? state.error : undefined)

export type DockActionState<Action extends string> =
  | { kind: "idle" }
  | { kind: "running"; action: Action }
  | { kind: "failed"; action: Action; error: AppError }

export type DockActionEvent<Action extends string> =
  | { type: "started"; action: Action }
  | { type: "finished" }
  | { type: "failed"; action: Action; error: AppError }

export function dockActionTransition<Action extends string>(): Transition<DockActionState<Action>, DockActionEvent<Action>> {
  return (state, event) => {
    switch (event.type) {
      case "started":
        return state.kind === "running" ? state : { kind: "running", action: event.action }
      case "finished":
        return { kind: "idle" }
      case "failed":
        return { kind: "failed", action: event.action, error: event.error }
      default:
        return unreachable(event)
    }
  }
}

export type GoalStatus = "active" | "paused" | "blocked" | "limited" | "complete"

export type GoalSnapshot = {
  readonly status: GoalStatus
  readonly objective: string
  readonly lastReason?: string
  readonly iteration?: number
  readonly tokensUsed?: number
  readonly tokenBudget?: number
  readonly timeUsedSeconds?: number
}

export type GoalControl = Exclude<GoalAction, "stop">

export type GoalActions = Partial<Record<GoalControl, () => Promise<void>>>

export function goalControls(goal: GoalSnapshot, actions: GoalActions) {
  return {
    pause: !!actions.pause && goal.status === "active",
    resume: !!actions.resume && goal.status === "paused",
    remove: !!actions.remove,
  }
}

export function todoDockOpen(input: { count: number; done: boolean; live: boolean }): boolean {
  return input.count > 0 && !input.done && input.live
}
