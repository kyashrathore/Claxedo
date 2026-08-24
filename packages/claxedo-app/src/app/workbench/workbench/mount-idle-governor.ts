import { createSignal, onCleanup, type Accessor } from "solid-js"

/**
 * Governs how many HIDDEN surfaces the workbench keeps mounted, by user
 * presence: while the user is active the full retention budget applies; after
 * `idleAfterMs` without any input the budget drops to zero, so every hidden
 * surface unmounts and its DOM memory is reclaimed (visible panes are not
 * part of the retained-hidden set and never unmount; terminals are exempted
 * upstream via `mountCapCandidate`, so PTY connections never drop). When the
 * user returns, the budget refills ONE SLOT PER `backfillStepMs` instead of
 * snapping back — a burst of a dozen simultaneous remounts on the first
 * keystroke is exactly the jank this exists to avoid, and the surface the
 * user actually activates mounts immediately anyway by becoming visible.
 *
 * An app hidden behind other windows produces no input, so backgrounding the
 * app reaches the same unloaded state through the same single rule.
 */
export function createMountIdleGovernor(input: {
  baseLimit: number
  idleAfterMs?: number
  backfillStepMs?: number
  /** Input-event source; tests inject a bare EventTarget. `null` means "no
   * target available" (SSR), yielding a constant full budget. */
  target?: EventTarget | null
  /** Clock seam for tests; timer ids are opaque to the governor. */
  clock?: {
    now: () => number
    setInterval: (handler: () => void, ms: number) => unknown
    clearInterval: (id: unknown) => void
  }
}): Accessor<number> {
  const target =
    input.target === null ? undefined : (input.target ?? (typeof window === "undefined" ? undefined : window))
  if (!target) return () => input.baseLimit
  const idleAfterMs = input.idleAfterMs ?? 180_000
  const backfillStepMs = input.backfillStepMs ?? 300
  const clock = input.clock ?? {
    now: () => performance.now(),
    setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
    clearInterval: (id: unknown) => clearInterval(id as Parameters<typeof clearInterval>[0]),
  }

  const [limit, setLimit] = createSignal(input.baseLimit)
  let lastActivityAt = clock.now()
  let backfillTimer: unknown

  const stopBackfill = () => {
    if (backfillTimer === undefined) return
    clock.clearInterval(backfillTimer)
    backfillTimer = undefined
  }

  const startBackfill = () => {
    if (backfillTimer !== undefined) return
    backfillTimer = clock.setInterval(() => {
      setLimit((current) => {
        const next = Math.min(input.baseLimit, current + 1)
        if (next === input.baseLimit) stopBackfill()
        return next
      })
    }, backfillStepMs)
  }

  const onActivity = () => {
    lastActivityAt = clock.now()
    if (limit() < input.baseLimit) startBackfill()
  }

  const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const
  for (const name of events) target.addEventListener(name, onActivity, { passive: true })

  // The poll only ever DROPS the budget; refills are activity-driven. A check
  // interval well under the threshold keeps the trigger latency bounded
  // without waking often enough to matter.
  const idlePoll = clock.setInterval(
    () => {
      if (clock.now() - lastActivityAt < idleAfterMs) return
      stopBackfill()
      setLimit(0)
    },
    Math.max(1_000, Math.floor(idleAfterMs / 6)),
  )

  onCleanup(() => {
    for (const name of events) target.removeEventListener(name, onActivity)
    clock.clearInterval(idlePoll)
    stopBackfill()
  })

  return limit
}
