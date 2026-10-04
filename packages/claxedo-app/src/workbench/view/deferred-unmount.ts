import { createComputed, createSignal, onCleanup, untrack, type Accessor } from "solid-js"

export type AfterPaint = (run: () => void) => () => void

export const afterNextPaint: AfterPaint = (run) => {
  const channel = new MessageChannel()
  channel.port1.onmessage = () => {
    channel.port1.close()
    run()
  }
  const frame = requestAnimationFrame(() => channel.port2.postMessage(undefined))
  return () => {
    cancelAnimationFrame(frame)
    channel.port1.close()
  }
}

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
