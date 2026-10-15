import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js"
import type { SubmitBlock } from "./submit-block-reason"

const flashDuration = 3200

export type SubmitBlockFlash = {
  readonly flash: Accessor<boolean>
  readonly explain: () => boolean
  readonly dismiss: VoidFunction
}

export function createSubmitBlockFlash(block: Accessor<SubmitBlock | null>, chooseModel: VoidFunction): SubmitBlockFlash {
  const [flash, setFlash] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const explain = () => {
    const current = block()
    if (!current) return false
    if (current.action === "choose-model") {
      chooseModel()
      return true
    }
    setFlash(true)
    clearTimer()
    timer = setTimeout(() => setFlash(false), flashDuration)
    return true
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
