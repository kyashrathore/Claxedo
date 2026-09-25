import { createEffect, onCleanup, type Accessor } from "solid-js"
import type { HarnessScopeInput, HarnessSelectionController } from "./controller"
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

export function watchScopeHarnessReprobe(input: {
  active: Accessor<boolean | undefined>
  scope: Accessor<string>
  scopeInput: Accessor<HarnessScopeInput>
  placementId: Accessor<HarnessScopeInput["placementId"]>
  sessionId: Accessor<HarnessScopeInput["sessionId"]>
  polling: Accessor<boolean>
  controller: Accessor<HarnessSelectionController>
}) {
  watchHarnessReprobe({
    active: () => {
      if (input.active() === false) return false
      const nextScope = input.scope()
      const nextPlacement = input.placementId()
      input.sessionId()
      return !!nextScope && !!nextPlacement && input.polling()
    },
    reprobe: () => {
      if (!input.placementId()) return
      void input.controller().reprobe(input.scope(), input.scopeInput())
    },
    onExhausted: () => input.controller().markUnavailable(input.scope()),
  })
}
