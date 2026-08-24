import { createTrackedEffect, onCleanup } from "solid-js"
import { startHarnessReprobeLoop, type ReprobeScheduler } from "./reprobe"

/**
 * Reactive glue that runs a bounded harness re-probe loop
 * (`startHarnessReprobeLoop`) ONLY while `active()` is true (i.e. the selected
 * harness readiness is "polling"). The moment `active()` flips false — the
 * harness settled to "ready"/"error", the scope/route changed, or the owner is
 * disposed — the effect re-runs and `onCleanup` cancels the in-flight loop, so a
 * settled harness is never re-probed and a scope change restarts with a fresh cap.
 *
 * `active` MUST be backed by a coarse memo (a boolean that only notifies when
 * polling toggles), not a raw readiness read: otherwise every unrelated store
 * write during a re-probe would re-run this effect, cancel the loop, and reset
 * the attempt counter — defeating the cap. See `agent-harness-selector.tsx`.
 */
export function watchHarnessReprobe(input: {
  active: () => boolean
  reprobe: () => void
  onExhausted: () => void
  intervalMs?: number
  maxAttempts?: number
  schedule?: ReprobeScheduler
}) {
  createTrackedEffect(() => {
    if (!input.active()) return
    const loop = startHarnessReprobeLoop({
      onReprobe: () => input.reprobe(),
      onExhausted: () => input.onExhausted(),
      intervalMs: input.intervalMs,
      maxAttempts: input.maxAttempts,
      schedule: input.schedule,
    })
    return () => loop.cancel()
  })
}
