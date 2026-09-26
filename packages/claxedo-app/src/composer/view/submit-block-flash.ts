import { type Accessor, type JSX, createEffect, createSignal, onCleanup } from "solid-js"
import type { SubmitBlock } from "../submit-block-reason"

const flashDuration = 3200

export function createSubmitBlockFlash(block: Accessor<SubmitBlock | null>, chooseModel: VoidFunction) {
  const [flash, setFlash] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const explain: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (event) => {
    const current = block()
    if (!current?.actionable) return
    event.preventDefault()
    if (current.reason === "no-model") {
      chooseModel()
      return
    }
    setFlash(true)
    clearTimer()
    timer = setTimeout(() => setFlash(false), flashDuration)
  }
  createEffect(() => {
    if (!block()) {
      clearTimer()
      setFlash(false)
    }
  })
  onCleanup(clearTimer)

  return { flash, explain, dismiss: () => setFlash(false) }
}
