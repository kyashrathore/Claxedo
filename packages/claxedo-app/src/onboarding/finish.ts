import { machine } from "@/lib/machine"
import { createdOf, finishTransition, openable, type Created, type FinishEvent, type FinishState, type Openable } from "./model"

export type FinishSteps = {
  readonly create: (created: Created | undefined) => Promise<Created>
  readonly open: (created: Openable) => Promise<void>
  readonly describe: (error: unknown, created: Created | undefined) => string
}

export function createFinish(steps: FinishSteps) {
  const finish = machine<FinishState, FinishEvent>({ kind: "ready" }, finishTransition)
  const created = () => createdOf(finish.state())
  const reach = async (): Promise<Openable> => {
    let current = created()
    while (!openable(current)) {
      current = await steps.create(current)
      finish.send({ type: "created", created: current })
    }
    return current
  }
  const run = async () => {
    const kind = finish.state().kind
    if (kind === "working" || kind === "finished") return
    finish.send({ type: "started" })
    try {
      await steps.open(await reach())
      finish.send({ type: "opened" })
    } catch (error) {
      finish.send({ type: "failed", error: steps.describe(error, created()) })
    }
  }
  return {
    state: finish.state,
    created,
    working: () => finish.state().kind === "working",
    finished: () => finish.state().kind === "finished",
    failure: () => {
      const state = finish.state()
      return state.kind === "failed" ? state.error : undefined
    },
    run,
    moved: () => finish.send({ type: "moved" }),
  }
}

export type Finish = ReturnType<typeof createFinish>
