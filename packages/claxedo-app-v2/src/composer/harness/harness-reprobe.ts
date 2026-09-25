import { createEffect, onCleanup } from "solid-js"
import {
  startHarnessReprobeLoop,
  type ReprobeScheduler,
} from "./reprobe"

export function watchHarnessReprobe(input: {
  active: () => boolean
  reprobe: () => void
  onExhausted: () => void
  intervalMs?: number
  maxAttempts?: number
  schedule?: ReprobeScheduler
}) {
  createEffect(() => {
    if (!input.active()) return
    const loop = startHarnessReprobeLoop({
      onReprobe: () => input.reprobe(),
      onExhausted: () => input.onExhausted(),
      intervalMs: input.intervalMs,
      maxAttempts: input.maxAttempts,
      schedule: input.schedule,
    })
    onCleanup(() => loop.cancel())
  })
}
