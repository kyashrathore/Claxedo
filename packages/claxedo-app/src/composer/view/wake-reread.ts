import { createEffect, createSignal, untrack, type Accessor } from "solid-js"

type WakeRereadInput = {
  readonly asleep: Accessor<boolean>
  readonly active: Accessor<boolean | undefined>
  readonly reread: () => Promise<unknown>
}

export function createWakeReread(input: WakeRereadInput): Accessor<boolean> {
  const [readAsleep, setReadAsleep] = createSignal(untrack(input.asleep))
  const [rereading, setRereading] = createSignal(false)
  let sleptDuringReread = false
  createEffect(() => {
    if (input.asleep()) {
      setReadAsleep(true)
      if (untrack(rereading)) sleptDuringReread = true
      return
    }
    if (input.active() === false || rereading() || !untrack(readAsleep)) return
    setRereading(true)
    sleptDuringReread = false
    void input.reread()
      .catch((error: unknown) => console.warn("The harness could not be read again after its workspace woke", { error }))
      .finally(() => {
        if (!sleptDuringReread) setReadAsleep(false)
        setRereading(false)
      })
  })
  return readAsleep
}
