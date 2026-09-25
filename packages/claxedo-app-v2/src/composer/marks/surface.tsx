import { Show, createMemo } from "solid-js"
import { MARK_COLOR } from "@/lib/image-mark-badge"
import type { ImageMark } from "../model"
import { ImageMarkLayer } from "./layer"
import { markStyle, type Size } from "./marks"

export function ImageMarkSurface(props: {
  size: Size
  marks: ImageMark[]
  firstNumber: number
  preview: ImageMark | undefined
  surfaceRef: (el: SVGSVGElement) => void
  onPointerDown: (event: PointerEvent) => void
  onPointerMove: (event: PointerEvent) => void
  onPointerUp: (event: PointerEvent) => void
  onPointerCancel: () => void
  onMarkDown: (index: number, event: PointerEvent) => void
}) {
  const style = createMemo(() => markStyle(props.size))
  return (
    <svg
      ref={(el) => props.surfaceRef(el)}
      class="absolute inset-0 size-full cursor-crosshair touch-none"
      viewBox={`0 0 ${props.size.width} ${props.size.height}`}
      onPointerDown={(event) => props.onPointerDown(event)}
      onPointerMove={(event) => props.onPointerMove(event)}
      onPointerUp={(event) => props.onPointerUp(event)}
      onPointerCancel={() => props.onPointerCancel()}
    >
      <ImageMarkLayer size={props.size} marks={props.marks} firstNumber={props.firstNumber} onMarkDown={props.onMarkDown} />
      <Show when={props.preview}>
        {(mark) => (
          <rect
            x={mark().x}
            y={mark().y}
            width={mark().width}
            height={mark().height}
            fill="transparent"
            stroke={MARK_COLOR}
            stroke-width={style().stroke}
            stroke-dasharray={`${style().stroke * 3}`}
          />
        )}
      </Show>
    </svg>
  )
}
