import { createAsyncState } from "@/lib/async-state"
import { latest, onCleanup, type Accessor } from "solid-js"
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
    // Everything before the first `await` is the tracked source read — the same
    // dependency set Solid 1's `createResource` source accessor carried. The
    // re-check after the wait is deliberately untracked, as the fetcher's was.
    async () => {
      const eligible = session.active() && revealed() && visible()
      if (mounted) return true
      cancelWait?.()
      if (!eligible || !(await waitForIdle())) return false
      // The idle wait spans a flush boundary. A re-run triggered by `active`
      // flipping is an async transition, so a bare read here would resolve to
      // the pre-transition value that this very run is holding uncommitted —
      // `latest` asks for the value the run was started for.
      if (!latest(() => session.active())) return false
      markRendererPhase("timeline.messageNav.idleMount")
      mounted = true
      return true
    },
    { initialValue: false },
  )
  // Idle readiness is optional presentation state. `latest` stays reactive
  // without throwing the pending idle promise, so it never enrolls in the pane
  // Loading boundary.
  return () => latest(ready.data) ?? false
}
