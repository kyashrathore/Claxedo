import { createComputed, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import { afterNextPaint, type AfterPaint } from "@/lib/after-paint"

export function createDeferredUnmount(wanted: Accessor<boolean>, afterPaint: AfterPaint = afterNextPaint): Accessor<boolean> {
  const [mounted, setMounted] = createSignal(untrack(wanted))
  let cancel: (() => void) | undefined
  const settle = () => {
    cancel?.()
    cancel = undefined
  }
  createComputed(() => {
    const want = wanted()
    settle()
    if (want) setMounted(true)
    else if (untrack(mounted)) {
      cancel = afterPaint(() => {
        cancel = undefined
        setMounted(false)
      })
    }
  })
  onCleanup(settle)
  return mounted
}
