import { createEffect } from "solid-js"
import { startHarnessReprobeLoop, type ReprobeScheduler } from "./reprobe"

/**
 * Reactive glue that runs a bounded harness re-probe loop
 * (`startHarnessReprobeLoop`) ONLY while `active()` is true (i.e. the selected
 * harness readiness is "polling"). The moment `active()` flips false — the
 * harness settled to "ready"/"error", the scope/route changed, or the owner is
 * disposed — the effect phase re-runs and its returned cleanup cancels the
 * in-flight loop, so a settled harness is never re-probed and a scope change
 * restarts with a fresh cap.
 *
 * The tracked phase returns a plain boolean, so the loop is only cancelled and
 * restarted when polling actually toggles: an unrelated store write during a
 * re-probe re-runs the compute, sees the same `true`, and leaves the attempt
 * counter alone. See `agent-harness-selector.tsx`.
 */
export function watchHarnessReprobe(input: {
  active: () => boolean
  reprobe: () => void
  onExhausted: () => void
  intervalMs?: number
  maxAttempts?: number
  schedule?: ReprobeScheduler
}) {
  createEffect(
    () => input.active(),
    (active) => {
      if (!active) return
      const loop = startHarnessReprobeLoop({
        onReprobe: () => input.reprobe(),
        onExhausted: () => input.onExhausted(),
        intervalMs: input.intervalMs,
        maxAttempts: input.maxAttempts,
        schedule: input.schedule,
      })
      return () => loop.cancel()
    },
  )
}
