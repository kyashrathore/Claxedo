import { createEffect, createMemo, createSignal } from "solid-js"
import type { ValidComponent } from "@solidjs/web"
import { Dynamic } from "@solidjs/web"
import "./text-shimmer-v2.css"

export const TextShimmerV2 = <T extends ValidComponent = "span">(props: {
  text: string
  class?: string
  as?: T
  active?: boolean
  offset?: number
}) => {
  const text = createMemo(() => props.text ?? "")
  const active = createMemo(() => props.active ?? true)
  const offset = createMemo(() => props.offset ?? 0)
  const [run, setRun] = createSignal(active())
  const swap = 220

  // The returned cleanup replaces the hand-rolled `timer` handle: it already
  // cancels a pending swap-out before the next run and on disposal.
  createEffect(active, (isActive) => {
    if (isActive) {
      setRun(true)
      return
    }

    const timer = setTimeout(() => setRun(false), swap)
    return () => clearTimeout(timer)
  })

  return (
    <Dynamic
      component={props.as ?? "span"}
      data-component="text-shimmer-v2"
      data-active={active() ? "true" : "false"}
      class={props.class}
      aria-label={text()}
      style={{
        "--_swap": `${swap}ms`,
        "--_index": `${offset()}`,
      }}
    >
      <span data-slot="text-shimmer-v2-char">
        <span data-slot="text-shimmer-v2-base" class="ui-text-shimmer-v2-base" aria-hidden="true">
          {text()}
        </span>
        <span data-slot="text-shimmer-v2-shimmer" class="ui-text-shimmer-v2-shimmer" data-run={run() ? "true" : "false"} aria-hidden="true">
          {text()}
        </span>
      </span>
    </Dynamic>
  )
}
