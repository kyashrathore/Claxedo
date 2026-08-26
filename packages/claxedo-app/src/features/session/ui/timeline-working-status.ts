import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import { createActivePaneProjection } from "../store/active-pane-projection"

export type TimelineWorkingStatus = "hidden" | "showing" | "hiding"

type Schedule = (task: () => void, delay: number) => () => void

const scheduleTimeout: Schedule = (task, delay) => {
  const timer = setTimeout(task, delay)
  return () => clearTimeout(timer)
}

/** Own the transient working-indicator timer only while its pane is visible. */
export function createTimelineWorkingStatus(input: {
  active: Accessor<boolean>
  working: Accessor<boolean>
  hideDelay?: number
  schedule?: Schedule
}): Accessor<TimelineWorkingStatus> {
  const working = createActivePaneProjection({
    active: input.active,
    read: input.working,
    initial: false,
  })
  const [hiding, setHiding] = createSignal(false)

  // Edge-detector: hiding latches on a working -> idle transition and clears the
  // moment work resumes. Solid 2 has no `createComputed`, so this is the
  // two-phase split: the compute tracks the pane's activity and its projected
  // working flag and returns a fresh tuple (so the apply phase runs on every
  // invalidation, as the old computed did), and the apply phase's `previous`
  // carries what the manual `previousWorking` used to hold — undefined on the
  // first run. It stays equivalent because the projection freezes `working()`
  // while the pane is inactive, which is exactly when the old `let` stopped
  // being written.
  createEffect(
    () => [input.active(), working()] as const,
    ([active, next], previous) => {
      if (!active) return
      if (next) {
        setHiding(false)
        return
      }
      if (previous?.[1]) setHiding(true)
    },
  )

  const status = createMemo<TimelineWorkingStatus>(() => {
    if (working()) return "showing"
    return hiding() ? "hiding" : "hidden"
  })

  // The pane owns the hide timer only while it is visible: the compute tracks
  // both gates, and the apply phase returns the schedule's canceller as its
  // cleanup, so losing either gate cancels an armed timer instead of letting it
  // fire against a hidden pane.
  createEffect(
    () => input.active() && hiding(),
    (arm) => {
      if (!arm) return
      return (input.schedule ?? scheduleTimeout)(() => setHiding(false), input.hideDelay ?? 260)
    },
  )

  return status
}
