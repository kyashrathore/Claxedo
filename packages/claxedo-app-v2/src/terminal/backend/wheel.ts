import type { ModeTracker } from "./modes"

const STEP_PX = 40
const MAX_BURST = 12
const MAX_PAGE_BURST = 6

function arrow(direction: 1 | -1, applicationCursorKeys: boolean): string {
  if (direction < 0) return applicationCursorKeys ? "\x1bOA" : "\x1b[A"
  return applicationCursorKeys ? "\x1bOB" : "\x1b[B"
}

function page(direction: 1 | -1): string {
  return direction < 0 ? "\x1b[5~" : "\x1b[6~"
}

function deltaUnit(mode: number): number {
  if (mode === 1) return 12
  if (mode === 2) return 96
  return 1
}

export function setupWheel(container: HTMLElement, tracker: ModeTracker, write: (data: string) => void): () => void {
  let accumulated = 0
  const onWheel = (event: WheelEvent) => {
    const modes = tracker.modes()
    if (!modes.alternateScroll && !modes.alternateScreen) return
    event.preventDefault()
    if (modes.mouseTracking) return
    const dy = event.deltaY
    if (!Number.isFinite(dy) || dy === 0) return
    accumulated += dy * deltaUnit(event.deltaMode)
    const count = Math.min(MAX_BURST, Math.floor(Math.abs(accumulated) / STEP_PX))
    if (count <= 0) return
    const direction = accumulated < 0 ? -1 : 1
    accumulated -= direction * count * STEP_PX
    if (modes.alternateScroll) {
      write(arrow(direction, modes.applicationCursorKeys).repeat(count))
      return
    }
    write(page(direction).repeat(Math.min(MAX_PAGE_BURST, count)))
  }
  container.addEventListener("wheel", onWheel, { passive: false, capture: true })
  return () => container.removeEventListener("wheel", onWheel, { capture: true })
}
