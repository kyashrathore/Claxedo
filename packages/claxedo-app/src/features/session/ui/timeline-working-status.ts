import { createComputed, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
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
  let previousWorking = false

  createComputed(() => {
    if (!input.active()) return
    const next = working()
    const previous = previousWorking
    previousWorking = next
    if (next) {
      setHiding(false)
      return
    }
    if (previous) setHiding(true)
  })

  const status = createMemo<TimelineWorkingStatus>(() => {
    if (working()) return "showing"
    return hiding() ? "hiding" : "hidden"
  })

  createComputed(() => {
    if (!input.active()) return
    if (!hiding()) return

    const cancel = (input.schedule ?? scheduleTimeout)(() => setHiding(false), input.hideDelay ?? 260)
    onCleanup(cancel)
  })

  return status
}
