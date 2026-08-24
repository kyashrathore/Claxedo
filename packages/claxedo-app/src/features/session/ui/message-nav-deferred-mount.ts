import { createAsyncState } from "@/lib/async-state"
import { onCleanup, type Accessor } from "solid-js"
import { useSessionParams } from "@/features/session/providers/session-params"
import { markRendererPhase } from "@/platform/performance/renderer-trace"

export function createMessageNavDeferredMount(revealed: Accessor<boolean>, visible: Accessor<boolean>) {
  const session = useSessionParams()
  let mounted = false
  let cancelWait: (() => void) | undefined
  const waitForIdle = () =>
    new Promise<boolean>((resolve) => {
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

  const ready = createAsyncState(
    async () => {
      const source = (() => (session.active() && revealed() && visible() ? "eligible" : "inactive"))()
      if (!source) return undefined
      return (async (state) => {
        if (mounted) return true
        cancelWait?.()
        if (state === "inactive" || !(await waitForIdle()) || !session.active()) return false
        markRendererPhase("timeline.messageNav.idleMount")
        mounted = true
        return true
      })(source)
    },
    { initialValue: false },
  )
  return () => ready.data() ?? false
}
