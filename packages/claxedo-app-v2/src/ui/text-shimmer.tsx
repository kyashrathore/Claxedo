import { createEffect, createMemo, createSignal, onCleanup, type ValidComponent } from "solid-js"
import { Dynamic } from "solid-js/web"
import "./text-shimmer.css"

export const TextShimmer = (props: {
  text: string
  class?: string
  as?: ValidComponent
  active?: boolean
  offset?: number
}) => {
  const text = createMemo(() => props.text ?? "")
  const active = createMemo(() => props.active ?? true)
  const offset = createMemo(() => props.offset ?? 0)
  const [run, setRun] = createSignal(active())
  const swap = 220
  let timer: ReturnType<typeof setTimeout> | undefined

  createEffect(() => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }

    if (active()) {
      setRun(true)
      return
    }

    timer = setTimeout(() => {
      timer = undefined
      setRun(false)
    }, swap)
  })

  onCleanup(() => {
    if (!timer) return
    clearTimeout(timer)
  })

  return (
    <Dynamic
      component={props.as ?? "span"}
      data-component="v2-text-shimmer"
      data-active={active() ? "true" : "false"}
      class={props.class}
      aria-label={text()}
      style={{
        "--_swap": `${swap}ms`,
        "--_index": `${offset()}`,
      }}
    >
      <span data-slot="v2-text-shimmer-char">
        <span data-slot="v2-text-shimmer-base" class="v2-text-shimmer-base" aria-hidden="true">
          {text()}
        </span>
        <span data-slot="v2-text-shimmer-shimmer" class="v2-text-shimmer-shimmer" data-run={run() ? "true" : "false"} aria-hidden="true">
          {text()}
        </span>
      </span>
    </Dynamic>
  )
}
