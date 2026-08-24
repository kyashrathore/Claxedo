import { For, omit } from "solid-js"
import type { ComponentProps } from "@solidjs/web"
import "./session-progress-indicator-v2.css"

const grid = 5
const dot = 2
const gap = 1
const origin = 1.5
const dots = Array.from({ length: grid * grid }, (_, index) => ({
  index,
  x: origin + (index % grid) * (dot + gap),
  y: origin + Math.floor(index / grid) * (dot + gap),
}))

export function SessionProgressIndicatorV2(props: ComponentProps<"svg">) {
  const local = props,
    rest = omit(props, "class", "width", "height")
  return (
    <svg
      {...rest}
      class={local.class}

      width={local.width ?? 16}
      height={local.height ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-component="session-progress-indicator-v2"
      aria-hidden={
        (rest["aria-hidden"] ?? "true") == null ? undefined : (rest["aria-hidden"] ?? "true") ? "true" : "false"
      }
    >
      <For each={dots}>{(cell) => <rect data-dot={cell.index} x={cell.x} y={cell.y} width={dot} height={dot} />}</For>
    </svg>
  )
}
