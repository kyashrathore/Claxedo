import { createEffect, createMemo, createSignal, onCleanup, Show, type ValidComponent } from "solid-js"
import { Dynamic } from "solid-js/web"
import "./text-shimmer-v2.css"

export const TextShimmerV2 = (props: {
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
        {/* The swept copy carries a second full copy of the text and a gradient clipped to
            those glyphs, and a transcript holds one of these per tool row (39 of 40 idle in
            a measured lab session), so it exists only while it is sweeping. It outlives
            `active` by the swap so the fade-out has something to fade. */}
        <Show when={run()}>
          <span data-slot="text-shimmer-v2-shimmer" class="ui-text-shimmer-v2-shimmer" aria-hidden="true">
            {text()}
          </span>
        </Show>
      </span>
    </Dynamic>
  )
}
