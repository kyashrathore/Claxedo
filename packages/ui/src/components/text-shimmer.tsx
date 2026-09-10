import { createEffect, createMemo, createSignal, onCleanup, Show, type ValidComponent } from "solid-js"
import { Dynamic } from "solid-js/web"

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
      data-component="text-shimmer"
      data-active={active() ? "true" : "false"}
      class={props.class}
      aria-label={text()}
      style={{
        "--text-shimmer-swap": `${swap}ms`,
        "--text-shimmer-index": `${offset()}`,
      }}
    >
      <span data-slot="text-shimmer-char">
        <span data-slot="text-shimmer-char-base" class="ui-text-shimmer-char-base" aria-hidden="true">
          {text()}
        </span>
        {/* The swept copy exists only while it is sweeping. It carries a second full copy
            of the text and a gradient clipped to those glyphs, and a transcript holds one
            of these per tool row — 39 of 40 idle in a measured lab session — so mounting
            it unconditionally duplicated text that never animated. `run` outlives `active`
            by the swap, which is what keeps the fade-out. */}
        <Show when={run()}>
          <span data-slot="text-shimmer-char-shimmer" class="ui-text-shimmer-char-shimmer" data-run="true" aria-hidden="true">
            {text()}
          </span>
        </Show>
      </span>
    </Dynamic>
  )
}
