import { createMemo, createSignal, type Accessor } from "solid-js"
import type { ImageMark } from "../model"
import { markFromDrag, markStyle, type Point, type Size } from "./marks"

const PIN_BELOW_SCREEN_PX = 4

type Drag = { start: Point; current: Point }

function toImage(surface: SVGSVGElement | undefined, size: Size | undefined, event: PointerEvent): Point | undefined {
  if (!surface || !size) return undefined
  const rect = surface.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return undefined
  return { x: ((event.clientX - rect.left) * size.width) / rect.width, y: ((event.clientY - rect.top) * size.height) / rect.height }
}

export function createMarkSurface(input: { readonly size: Accessor<Size | undefined>; readonly settle: () => void; readonly add: (mark: ImageMark) => void }) {
  const [drag, setDrag] = createSignal<Drag>()
  let surface: SVGSVGElement | undefined
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return
    const point = toImage(surface, input.size(), event)
    if (!point) return
    event.preventDefault()
    input.settle()
    surface?.setPointerCapture(event.pointerId)
    setDrag({ start: point, current: point })
  }
  const move = (event: PointerEvent) => {
    const current = drag()
    const point = current ? toImage(surface, input.size(), event) : undefined
    if (current && point) setDrag({ ...current, current: point })
  }
  const up = (event: PointerEvent) => {
    const current = drag()
    const size = input.size()
    setDrag(undefined)
    if (!current || !size || !surface) return
    const point = toImage(surface, size, event) ?? current.current
    const scale = size.width / surface.getBoundingClientRect().width
    input.add(markFromDrag(current.start, point, size, PIN_BELOW_SCREEN_PX * scale))
  }
  const preview = createMemo(() => {
    const current = drag()
    const size = input.size()
    return current && size ? markFromDrag(current.start, current.current, size, 0) : undefined
  })
  const style = createMemo(() => {
    const size = input.size()
    return size ? markStyle(size) : undefined
  })
  return { setSurface: (element: SVGSVGElement) => (surface = element), down, move, up, cancel: () => setDrag(undefined), preview, style }
}

export type MarkSurface = ReturnType<typeof createMarkSurface>
