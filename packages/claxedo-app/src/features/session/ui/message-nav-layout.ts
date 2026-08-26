import { createSignal, onCleanup, onSettled, type Accessor } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { BP_2XL } from "@/ui/controls/breakpoints"

const COMPACT_NAV_SAFE_GUTTER = 60
const TIMELINE_COLUMN_WIDTH = 768
const TIMELINE_COLUMN_WIDTH_2XL = 880

export const messageNavFits = (paneWidth: number, viewportWidth: number) => {
  const columnWidth = viewportWidth >= BP_2XL ? TIMELINE_COLUMN_WIDTH_2XL : TIMELINE_COLUMN_WIDTH
  return paneWidth >= columnWidth + 2 * COMPACT_NAV_SAFE_GUTTER
}

export function createMessageNavRoom(root: Accessor<HTMLElement | undefined>) {
  const [hasRoom, setHasRoom] = createSignal(false)
  const update = () => {
    const element = root()
    if (element) setHasRoom(messageNavFits(element.clientWidth, window.innerWidth))
  }
  createResizeObserver(root, update)
  onSettled(() => {
    // Decide the gutter BEFORE first paint: the observer's initial callback
    // lands a frame late, and a late flip mounts the rail and reserves the
    // gutter after the transcript laid out — shifting the whole column and
    // restarting every pending paint-stability wait.
    update()
    window.addEventListener("resize", update)
    return () => window.removeEventListener("resize", update)
  })
  return hasRoom
}
