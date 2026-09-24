import { machine } from "@/lib/machine"
import { asAppError } from "@/composer"
import type { DockActionEvent, DockActionState } from "./model"
import { dockActionTransition } from "./model"

export function createDockAction<Action extends string>() {
  const state = machine<DockActionState<Action>, DockActionEvent<Action>>({ kind: "idle" }, dockActionTransition<Action>())
  const run = async (action: Action, work: () => Promise<void>) => {
    if (state.state().kind === "running") return false
    state.send({ type: "started", action })
    try {
      await work()
      state.send({ type: "finished" })
      return true
    } catch (error) {
      state.send({ type: "failed", action, error: asAppError(error) })
      return false
    }
  }
  return {
    state: state.state,
    running: () => state.state().kind === "running",
    runningAction: () => {
      const current = state.state()
      return current.kind === "running" ? current.action : undefined
    },
    error: () => {
      const current = state.state()
      return current.kind === "failed" ? current.error : undefined
    },
    run,
  }
}

export type DockAction<Action extends string> = ReturnType<typeof createDockAction<Action>>
