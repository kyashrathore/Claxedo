import { For, Show } from "solid-js"
import { MARK_COLOR, MARK_TEXT_COLOR } from "@/lib/image-mark-badge"
import type { ImageMark } from "../model"
import { badgeCenter, isPin, markStyle, type Size } from "./marks"

type MarkDownHandler = (index: number, event: PointerEvent) => void

export function ImageMarkLayer(props: {
  size: Size
  marks: ImageMark[]
  firstNumber: number
  onMarkDown?: MarkDownHandler
}) {
  return (
    <For each={props.marks}>
      {(mark, index) => (
        <ImageMarkGlyph
          mark={mark}
          index={index()}
          size={props.size}
          firstNumber={props.firstNumber}
          onMarkDown={props.onMarkDown}
        />
      )}
    </For>
  )
}

function ImageMarkGlyph(props: {
  mark: ImageMark
  index: number
  size: Size
  firstNumber: number
  onMarkDown?: MarkDownHandler
}) {
  const style = () => markStyle(props.size)
  const center = () => badgeCenter(props.mark, props.size)
  return (
    <g
      data-mark-number={props.firstNumber + props.index}
      class={props.onMarkDown ? "cursor-pointer" : undefined}
      onPointerDown={(event) => props.onMarkDown?.(props.index, event)}
    >
      <Show when={!isPin(props.mark)}>
        <rect
          x={props.mark.x}
          y={props.mark.y}
          width={props.mark.width}
          height={props.mark.height}
          fill="transparent"
          stroke={MARK_COLOR}
          stroke-width={style().stroke}
        />
      </Show>
      <circle
        cx={center().x}
        cy={center().y}
        r={style().radius}
        fill={MARK_COLOR}
        stroke={MARK_TEXT_COLOR}
        stroke-width={Math.max(1, style().stroke / 2)}
      />
      <text
        x={center().x}
        y={center().y + style().fontSize * 0.05}
        fill={MARK_TEXT_COLOR}
        font-size={String(style().fontSize)}
        font-weight="600"
        font-family="system-ui, sans-serif"
        text-anchor="middle"
        dominant-baseline="central"
      >
        {props.firstNumber + props.index}
      </text>
    </g>
  )
}
