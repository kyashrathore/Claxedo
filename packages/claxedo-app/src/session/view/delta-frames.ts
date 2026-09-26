import { createEffect, onCleanup, type Accessor } from "solid-js"
import type { SessionView } from "@/session"

export function commitDeltasEachFrame(view: Accessor<SessionView>): void {
  createEffect(() => {
    const shown = view()
    if (!shown.pendingDeltas()) return
    const frame = requestAnimationFrame(() => shown.commitDeltas())
    onCleanup(() => cancelAnimationFrame(frame))
  })
}
