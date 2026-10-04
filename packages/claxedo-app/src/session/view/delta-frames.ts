import { createComputed, createEffect, on, onCleanup, type Accessor } from "solid-js"
import type { SessionView } from "@/session"

export function commitDeltasWhileShown(view: Accessor<SessionView>): void {
  createComputed(on(view, (shown) => shown.commitDeltas()))
  createEffect(() => {
    const shown = view()
    if (!shown.pendingDeltas()) return
    const frame = requestAnimationFrame(() => shown.commitDeltas())
    onCleanup(() => cancelAnimationFrame(frame))
  })
}
