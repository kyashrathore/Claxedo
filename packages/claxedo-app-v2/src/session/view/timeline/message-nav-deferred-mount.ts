import { createResource, onCleanup, type Accessor } from "solid-js"
import { waitForIdle, type IdleWait } from "@/lib/idle"

export function createMessageNavDeferredMount(
  active: Accessor<boolean>,
  revealed: Accessor<boolean>,
  visible: Accessor<boolean>,
) {
  let mounted = false
  let wait: IdleWait | undefined
  onCleanup(() => wait?.cancel())

  const [ready] = createResource(
    () => active() && revealed() && visible() ? "eligible" : "inactive",
    async (state) => {
      if (mounted) return true
      wait?.cancel()
      if (state === "inactive") return false
      wait = waitForIdle(500)
      if (!(await wait.done) || !active()) return false
      mounted = true
      return true
    },
    { initialValue: false },
  )
  return () => ready.latest
}
