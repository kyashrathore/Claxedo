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
/**
 * Clock seam for tests. The handle is whatever the injected `setInterval`
 * returns — a real timer handle in the browser, a counter in tests — and the
 * governor only ever hands the same value straight back to `clearInterval`,
 * so threading it as a type parameter keeps both ends exact.
 */
export type MountIdleClock<Handle> = {
  now: () => number
  setInterval: (handler: () => void, ms: number) => Handle
  clearInterval: (id: Handle) => void
}

export type MountIdleGovernorInput<Handle> = {
  baseLimit: number
  idleAfterMs?: number
  backfillStepMs?: number
  /** Input-event source; tests inject a bare EventTarget. `null` means "no
   * target available" (SSR), yielding a constant full budget. */
  target?: EventTarget | null
  clock?: MountIdleClock<Handle>
}

const wallClock: MountIdleClock<ReturnType<typeof setInterval>> = {
  now: () => performance.now(),
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (id) => clearInterval(id),
}

export function createMountIdleGovernor<Handle>(input: MountIdleGovernorInput<Handle>): Accessor<number> {
  const target = input.target === null
    ? undefined
    : input.target ?? (typeof window === "undefined" ? undefined : window)
  if (!target) return () => input.baseLimit
  // Resolved here, not inside `runGovernor`, so the injected and default clocks
  // each keep their own handle type instead of meeting at `unknown`.
  return input.clock ? runGovernor(input, target, input.clock) : runGovernor(input, target, wallClock)
}

function runGovernor<Handle>(
  input: { baseLimit: number; idleAfterMs?: number; backfillStepMs?: number },
  target: EventTarget,
  clock: MountIdleClock<Handle>,
): Accessor<number> {
  const idleAfterMs = input.idleAfterMs ?? 180_000
  const backfillStepMs = input.backfillStepMs ?? 300

  const [limit, setLimit] = createSignal(input.baseLimit)
  let lastActivityAt = clock.now()
  let backfillTimer: Handle | undefined

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
  const idlePoll = clock.setInterval(() => {
    if (clock.now() - lastActivityAt < idleAfterMs) return
    stopBackfill()
    setLimit(0)
  }, Math.max(1_000, Math.floor(idleAfterMs / 6)))

  onCleanup(() => {
    for (const name of events) target.removeEventListener(name, onActivity)
    clock.clearInterval(idlePoll)
    stopBackfill()
  })

  return limit
}
