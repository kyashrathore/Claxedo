import { onCleanup } from "solid-js"
import { machine, unreachable } from "@/lib/machine"
import type { WhereNew } from "@/projects"
import { ServerError, toAppError, type AppError, type PlacementId } from "@/server"

export type FirstSendState =
  | { readonly kind: "idle" }
  | { readonly kind: "creating"; readonly choice: WhereNew }
  | { readonly kind: "sending"; readonly placementId: PlacementId }
  | { readonly kind: "failed"; readonly error: AppError }

export type FirstSendEvent =
  | { readonly type: "createStarted"; readonly choice: WhereNew }
  | { readonly type: "placementResolved"; readonly placementId: PlacementId }
  | { readonly type: "sendFailed"; readonly error: AppError }
  | { readonly type: "editRequested" }

export function firstSendTransition(_state: FirstSendState, event: FirstSendEvent): FirstSendState {
  switch (event.type) {
    case "createStarted":
      return { kind: "creating", choice: event.choice }
    case "placementResolved":
      return { kind: "sending", placementId: event.placementId }
    case "sendFailed":
      return { kind: "failed", error: event.error }
    case "editRequested":
      return { kind: "idle" }
    default:
      return unreachable(event)
  }
}

export type FirstSendAttempt<Result> = (report: (event: FirstSendEvent) => void) => Promise<Result>

export type FirstSendHooks = { readonly failed?: () => void; readonly retried?: () => void }

type Decision = "retry" | "edit"

type Waiting = { readonly decide: (decision: Decision) => void; readonly abandon: (error: ServerError) => void }

export function createFirstSend() {
  const state = machine<FirstSendState, FirstSendEvent>({ kind: "idle" }, firstSendTransition)
  let waiting: Waiting | undefined
  const decided = () => new Promise<Decision>((decide, abandon) => (waiting = { decide, abandon }))
  const run = async <Result>(attempt: FirstSendAttempt<Result>, hooks: FirstSendHooks = {}): Promise<Result | undefined> => {
    try {
      return await attempt(state.send)
    } catch (error) {
      state.send({ type: "sendFailed", error: toAppError(error) })
      hooks.failed?.()
      if ((await decided()) === "edit") {
        state.send({ type: "editRequested" })
        return undefined
      }
      hooks.retried?.()
      return run(attempt, hooks)
    }
  }
  const take = () => {
    const current = waiting
    waiting = undefined
    return current
  }
  onCleanup(() => take()?.abandon(new ServerError({ class: "conflict", code: "first_send_abandoned", message: "The draft closed before its first message was sent" })))
  return { state: state.state, run, retry: () => take()?.decide("retry"), edit: () => take()?.decide("edit") }
}
