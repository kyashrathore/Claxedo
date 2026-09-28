import { createSignal } from "solid-js"
import { createFlow, runFlow } from "@/lib/flow"
import { toAppError, type AppError } from "@/server"
import { openable, type Created, type Openable } from "./model"

export type FinishSteps = {
  readonly create: (created: Created | undefined) => Promise<Created>
  readonly open: (created: Openable) => Promise<void>
  readonly describe: (error: unknown, created: Created | undefined) => string
}

function createResumableTarget(create: FinishSteps["create"]) {
  const [created, setCreated] = createSignal<Created>()
  const reach = async (): Promise<Openable> => {
    let current = created()
    while (!openable(current)) {
      current = await create(current)
      setCreated(current)
    }
    return current
  }
  return { created, reach }
}

function finishError(steps: FinishSteps, cause: unknown, created: Created | undefined): AppError {
  const error = toAppError(cause)
  return { class: error.class, retryable: error.retryable, message: steps.describe(cause, created) }
}

export function createFinish(steps: FinishSteps) {
  const flow = createFlow<"creating" | "opening", Openable>()
  const target = createResumableTarget(steps.create)
  const reachAndOpen = async (step: (next: "opening") => void) => {
    const reached = await target.reach()
    step("opening")
    await steps.open(reached)
    return reached
  }
  const run = async () => {
    const kind = flow.state().kind
    if (kind === "running" || kind === "done") return
    await runFlow(flow, "creating", reachAndOpen, (cause) => finishError(steps, cause, target.created()))
  }
  return {
    created: target.created,
    working: () => flow.state().kind === "running",
    finished: () => flow.state().kind === "done",
    failure: () => {
      const state = flow.state()
      return state.kind === "failed" ? state.error.message : undefined
    },
    run,
    moved: () => {
      if (flow.state().kind === "failed" && !target.created()) flow.send({ type: "reset" })
    },
  }
}
