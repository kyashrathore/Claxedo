import { For, Show } from "solid-js"
import { MARK_COLOR, MARK_TEXT_COLOR } from "@/lib/image-mark-badge"
import type { ImageMark } from "../model"
import { badgeCenter, isPin, markStyle, type Size } from "./marks"

export function ImageMarkLayer(props: {
  size: Size
  marks: ImageMark[]
  firstNumber: number
  onMarkDown?: (index: number, event: PointerEvent) => void
}) {
  const style = () => markStyle(props.size)
  return (
    <For each={props.marks}>
      {(mark, index) => {
        const center = () => badgeCenter(mark, props.size)
        return (
          <g
            data-mark-number={props.firstNumber + index()}
            class={props.onMarkDown ? "cursor-pointer" : undefined}
            onPointerDown={(event) => props.onMarkDown?.(index(), event)}
          >
            <Show when={!isPin(mark)}>
              <rect
                x={mark.x}
                y={mark.y}
                width={mark.width}
                height={mark.height}
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
              {props.firstNumber + index()}
            </text>
          </g>
        )
      }}
    </For>
  )
}
