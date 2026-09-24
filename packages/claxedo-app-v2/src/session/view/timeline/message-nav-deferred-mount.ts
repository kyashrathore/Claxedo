import { createResource, onCleanup, type Accessor } from "solid-js"

export function createMessageNavDeferredMount(
  active: Accessor<boolean>,
  revealed: Accessor<boolean>,
  visible: Accessor<boolean>,
) {
  let mounted = false
  let cancelWait: (() => void) | undefined
  const waitForIdle = () => new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      if (cancelWait === cancel) cancelWait = undefined
      resolve(ready)
    }
    const mount = () => finish(true)
    const idle = typeof requestIdleCallback === "function" ? requestIdleCallback(mount, { timeout: 500 }) : undefined
    const timer = idle === undefined ? window.setTimeout(mount, 0) : undefined
    const cancel = () => {
      if (idle !== undefined && typeof cancelIdleCallback === "function") cancelIdleCallback(idle)
      if (timer !== undefined) window.clearTimeout(timer)
      finish(false)
    }
    cancelWait = cancel
  })
  onCleanup(() => cancelWait?.())

  const [ready] = createResource(
    () => active() && revealed() && visible() ? "eligible" : "inactive",
    async (state) => {
      if (mounted) return true
      cancelWait?.()
      if (state === "inactive" || !await waitForIdle() || !active()) return false
      mounted = true
      return true
    },
    { initialValue: false },
  )
  // Idle readiness is optional presentation state. Keep its latest value
  // reactive without enrolling the pending idle promise in the pane Suspense.
  return () => ready.latest
}
