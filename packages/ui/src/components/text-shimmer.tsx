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
  const [swept, setSwept] = createSignal(active())
  const [lit, setLit] = createSignal(false)
  const swap = 220
  let root: HTMLElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame: number | undefined

  const cancelFrame = () => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
    frame = undefined
  }

  createEffect(() => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    cancelFrame()

    if (active()) {
      setSwept(true)
      frame = requestAnimationFrame(() => {
        frame = undefined
        // A node inserted this frame has no computed style yet, and rAF callbacks
        // run before style recalc, so lighting it here would still paint straight
        // at opacity 1. Reading a layout property computes the 0 the transition
        // then animates from.
        void root?.offsetWidth
        setLit(true)
      })
      return
    }

    setLit(false)
    timer = setTimeout(() => {
      timer = undefined
      setSwept(false)
    }, swap)
  })

  onCleanup(() => {
    cancelFrame()
    if (!timer) return
    clearTimeout(timer)
  })

  return (
    <Dynamic
      component={props.as ?? "span"}
      ref={(el: HTMLElement) => (root = el)}
      data-component="text-shimmer"
      data-active={lit() ? "true" : "false"}
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
        {/* The swept copy carries a second full copy of the text and a gradient clipped to
            those glyphs, and a transcript holds one of these per tool row — 39 of 40 idle
            in a measured lab session — so it exists only while it is sweeping. It outlives
            `active` by the swap so the fade-out has something to fade. */}
        <Show when={swept()}>
          <span data-slot="text-shimmer-char-shimmer" class="ui-text-shimmer-char-shimmer" aria-hidden="true">
            {text()}
          </span>
        </Show>
      </span>
    </Dynamic>
  )
}
