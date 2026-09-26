import { createMemo, createSignal } from "solid-js"
import type { ImageMark } from "../model"
import { markFromDrag, type Point, type Size } from "./marks"

const PIN_BELOW_SCREEN_PX = 4

type Drag = { start: Point; current: Point }

function createDragGesture(size: () => Size | undefined) {
  const [drag, setDrag] = createSignal<Drag>()
  const preview = createMemo(() => {
    const current = drag()
    const imageSize = size()
    if (!current || !imageSize) return undefined
    return markFromDrag(current.start, current.current, imageSize, 0)
  })
  const begin = (point: Point) => setDrag({ start: point, current: point })
  const moveTo = (point: Point) => {
    const current = drag()
    if (current) setDrag({ ...current, current: point })
  }
  const end = () => {
    const current = drag()
    setDrag(undefined)
    return current
  }
  return { current: drag, preview, begin, moveTo, end, cancel: () => setDrag(undefined) }
}

function pointerToImage(surface: SVGSVGElement | undefined, size: Size | undefined, event: PointerEvent): Point | undefined {
  if (!surface || !size) return undefined
  const rect = surface.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return undefined
  return {
    x: ((event.clientX - rect.left) * size.width) / rect.width,
    y: ((event.clientY - rect.top) * size.height) / rect.height,
  }
}

export function createSurfaceDrag(options: {
  size: () => Size | undefined
  surface: () => SVGSVGElement | undefined
  onStart: () => void
  onDrawn: (mark: ImageMark) => void
}) {
  const gesture = createDragGesture(options.size)
  const toImage = (event: PointerEvent) => pointerToImage(options.surface(), options.size(), event)

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    const point = toImage(event)
    if (!point) return
    event.preventDefault()
    options.onStart()
    options.surface()?.setPointerCapture(event.pointerId)
    gesture.begin(point)
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!gesture.current()) return
    const point = toImage(event)
    if (point) gesture.moveTo(point)
  }

  const onPointerUp = (event: PointerEvent) => {
    const imageSize = options.size()
    const surface = options.surface()
    const current = gesture.end()
    if (!current || !imageSize || !surface) return
    const point = toImage(event) ?? current.current
    const scale = imageSize.width / surface.getBoundingClientRect().width
    options.onDrawn(markFromDrag(current.start, point, imageSize, PIN_BELOW_SCREEN_PX * scale))
  }

  return { preview: gesture.preview, onPointerDown, onPointerMove, onPointerUp, cancel: gesture.cancel }
}
