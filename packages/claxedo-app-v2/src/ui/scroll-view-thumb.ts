import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { scrollTopFromThumbPointer } from "@opencode-ai/ui/scroll-view"

export type ScrollViewThumbVisibility = "hover" | "scroll"

export type ThumbRevealSource = "wheel" | "touch" | "pen" | "keyboard"

const trackPadding = 8
const minThumbHeight = 32
const scrollIdleMs = 800

type ThumbInput = {
  viewport: () => HTMLDivElement | undefined
  track: () => HTMLElement | undefined
  visibility: () => ScrollViewThumbVisibility
}

type Extent = { scrollHeight: number; clientHeight: number; trackHeight: number }

function readExtent(viewport: HTMLDivElement, track: HTMLElement | undefined): Extent {
  return { scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight, trackHeight: track?.clientHeight || viewport.clientHeight }
}

function thumbGeometry(extent: Extent, scrollTop: number) {
  const { scrollHeight, clientHeight } = extent
  if (scrollHeight - clientHeight <= 1 || scrollHeight === 0) return undefined
  const trackHeight = extent.trackHeight - trackPadding * 2
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
  const visible = createMemo(() => state.dragging || state.scrolling || (input.visibility() === "hover" && state.hovered))
  let extent: Extent | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => idle !== undefined && clearTimeout(idle))
  const place = (viewport: HTMLDivElement) => {
    const geometry = extent && thumbGeometry(extent, viewport.scrollTop)
    setState(geometry ? { shown: true, ...geometry } : { shown: false })
  }
  const measure = () => {
    const viewport = input.viewport()
    if (!viewport) return
    extent = readExtent(viewport, input.track())
    place(viewport)
  }
  createEffect(() => {
    if (visible()) measure()
    else extent = undefined
  })
  return {
    state,
    visible,
    setHovered: (hovered: boolean) => setState("hovered", hovered),
    reveal: (_source: ThumbRevealSource) => {
      setState("scrolling", true)
      if (idle !== undefined) clearTimeout(idle)
      idle = setTimeout(() => setState("scrolling", false), scrollIdleMs)
    },
    resized: () => {
      if (visible()) measure()
    },
    scrolled: () => {
      const viewport = input.viewport()
      if (viewport && extent) place(viewport)
    },
    drag: (thumb: HTMLDivElement, event: PointerEvent) => dragThumb(input, thumb, event, () => state.height, (dragging) => setState("dragging", dragging)),
  }
}
