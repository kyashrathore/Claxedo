import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { scrollTopFromThumbPointer } from "@opencode-ai/ui/scroll-view"

export type ScrollViewThumbVisibility = "hover" | "scroll"

export type ThumbRevealSource = "wheel" | "touch" | "pen" | "keyboard"

const trackPadding = 8
const minThumbHeight = 32
const scrollIdleMs = 800

type ThumbInput = { viewport: () => HTMLDivElement | undefined; track: () => HTMLElement | undefined }

function thumbGeometry(viewport: HTMLDivElement, track: HTMLElement | undefined) {
  const { scrollTop, scrollHeight, clientHeight } = viewport
  if (scrollHeight - clientHeight <= 1 || scrollHeight === 0) return undefined
  const trackHeight = (track?.clientHeight || clientHeight) - trackPadding * 2
  const height = Math.max((clientHeight / scrollHeight) * trackHeight, minThumbHeight)
  const maxScrollTop = scrollHeight - clientHeight
  const maxThumbTop = trackHeight - height
  const top = maxScrollTop > 0 ? (scrollTop / maxScrollTop) * maxThumbTop : 0
  return { height, top: trackPadding + Math.max(0, Math.min(top, maxThumbTop)) }
}

function dragThumb(input: ThumbInput, thumb: HTMLDivElement, event: PointerEvent, height: () => number, setDragging: (dragging: boolean) => void) {
  const viewport = input.viewport()
  if (!viewport) return
  event.preventDefault()
  event.stopPropagation()
  setDragging(true)
  const grabOffset = event.clientY - thumb.getBoundingClientRect().top
  const track = input.track() ?? viewport
  thumb.setPointerCapture(event.pointerId)
  const onMove = (move: PointerEvent) => {
    viewport.scrollTop = scrollTopFromThumbPointer({
      pointer: move.clientY,
      viewportTop: track.getBoundingClientRect().top,
      grabOffset,
      clientHeight: track.clientHeight,
      scrollClientHeight: viewport.clientHeight,
      scrollHeight: viewport.scrollHeight,
      thumbHeight: height(),
    })
  }
  const done = (end: PointerEvent) => {
    setDragging(false)
    thumb.releasePointerCapture(end.pointerId)
    thumb.removeEventListener("pointermove", onMove)
    thumb.removeEventListener("pointerup", done)
    thumb.removeEventListener("pointercancel", done)
  }
  thumb.addEventListener("pointermove", onMove)
  thumb.addEventListener("pointerup", done)
  thumb.addEventListener("pointercancel", done)
}

export function createScrollThumb(input: ThumbInput) {
  const [state, setState] = createStore({ hovered: false, dragging: false, scrolling: false, height: 0, top: 0, shown: false })
  const timers = { idle: undefined as ReturnType<typeof setTimeout> | undefined, frame: undefined as number | undefined }
  onCleanup(() => {
    if (timers.idle !== undefined) clearTimeout(timers.idle)
    if (timers.frame !== undefined) cancelAnimationFrame(timers.frame)
  })
  const measure = () => {
    const viewport = input.viewport()
    if (!viewport) return
    const geometry = thumbGeometry(viewport, input.track())
    setState(geometry ? { shown: true, ...geometry } : { shown: false })
  }
  return {
    state,
    setHovered: (hovered: boolean) => setState("hovered", hovered),
    visible: (visibility: ScrollViewThumbVisibility) => state.dragging || state.scrolling || (visibility === "hover" && state.hovered),
    reveal: (_source: ThumbRevealSource) => {
      setState("scrolling", true)
      if (timers.idle !== undefined) clearTimeout(timers.idle)
      timers.idle = setTimeout(() => setState("scrolling", false), scrollIdleMs)
    },
    measure,
    schedule: () => {
      if (timers.frame !== undefined) return
      timers.frame = requestAnimationFrame(() => {
        timers.frame = undefined
        measure()
      })
    },
    drag: (thumb: HTMLDivElement, event: PointerEvent) => dragThumb(input, thumb, event, () => state.height, (dragging) => setState("dragging", dragging)),
  }
}
