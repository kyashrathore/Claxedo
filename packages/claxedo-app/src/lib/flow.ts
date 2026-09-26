import type { AppError } from "@/server"
import { machine, unreachable, type Machine } from "./machine"

export type Flow<Step extends string, Result> =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly step: Step }
  | { readonly kind: "done"; readonly result: Result }
  | { readonly kind: "failed"; readonly error: AppError }

export type FlowEvent<Step extends string, Result> =
  | { readonly type: "start"; readonly step: Step }
  | { readonly type: "step"; readonly step: Step }
  | { readonly type: "done"; readonly result: Result }
  | { readonly type: "failed"; readonly error: AppError }
  | { readonly type: "reset" }

export function flowTransition<Step extends string, Result>(
  state: Flow<Step, Result>,
  event: FlowEvent<Step, Result>,
): Flow<Step, Result> {
  switch (event.type) {
    case "start":
      return { kind: "running", step: event.step }
    case "step":
      return state.kind === "running" ? { kind: "running", step: event.step } : state
    case "done":
      return state.kind === "running" ? { kind: "done", result: event.result } : state
    case "failed":
      return state.kind === "running" ? { kind: "failed", error: event.error } : state
    case "reset":
      return { kind: "idle" }
    default:
      return unreachable(event)
  }
}

export type FlowMachine<Step extends string, Result> = Machine<Flow<Step, Result>, FlowEvent<Step, Result>>

export function createFlow<Step extends string, Result>(): FlowMachine<Step, Result> {
  return machine<Flow<Step, Result>, FlowEvent<Step, Result>>({ kind: "idle" }, flowTransition)
}

export async function runFlow<Step extends string, Result>(
  flow: FlowMachine<Step, Result>,
  first: Step,
  run: (step: (next: Step) => void) => Promise<Result>,
  toError: (cause: unknown) => AppError,
): Promise<void> {
  flow.send({ type: "start", step: first })
  try {
    const result = await run((next) => flow.send({ type: "step", step: next }))
    flow.send({ type: "done", result })
  } catch (cause) {
    flow.send({ type: "failed", error: toError(cause) })
  }
}
