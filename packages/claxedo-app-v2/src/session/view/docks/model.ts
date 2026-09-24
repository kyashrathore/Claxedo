import type { AppError } from "@/server"
import type { Transition } from "@/lib/machine"
import { unreachable } from "@/lib/machine"

export type RequestReplyState = { kind: "open" } | { kind: "answering" } | { kind: "failed"; error: AppError }

export type RequestReplyEvent = { type: "replyStarted" } | { type: "replyRejected"; error: AppError } | { type: "edited" }

export const requestReplyTransition: Transition<RequestReplyState, RequestReplyEvent> = (state, event) => {
  switch (event.type) {
    case "replyStarted":
      return state.kind === "answering" ? state : { kind: "answering" }
    case "replyRejected":
      return { kind: "failed", error: event.error }
    case "edited":
      return state.kind === "answering" ? state : { kind: "open" }
    default:
      return unreachable(event)
  }
}

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

export type GoalAction = "pause" | "resume" | "remove"

export type GoalActions = Partial<Record<GoalAction, () => Promise<void>>>

export function goalControls(goal: GoalSnapshot, actions: GoalActions) {
  return {
    pause: !!actions.pause && goal.status === "active",
    resume: !!actions.resume && goal.status === "paused",
    remove: !!actions.remove,
  }
}

export function todoDockOpen(input: { count: number; done: boolean; live: boolean }): boolean {
  if (input.count === 0) return false
  return input.done || input.live
}
