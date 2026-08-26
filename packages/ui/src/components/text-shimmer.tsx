import { createEffect, createMemo, createSignal } from "solid-js"
import type { ValidComponent } from "@solidjs/web"
import { Dynamic } from "@solidjs/web"

export const TextShimmer = <T extends ValidComponent = "span">(props: {
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

  // The swap-out timer is the effect phase's cleanup, so it is cancelled both
  // before the next run and on disposal — no module-level handle to juggle.
  createEffect(active, (on) => {
    if (on) {
      setRun(true)
      return
    }
    const timer = setTimeout(() => setRun(false), swap)
    return () => clearTimeout(timer)
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
        <span data-slot="text-shimmer-char-shimmer" class="ui-text-shimmer-char-shimmer" data-run={run() ? "true" : "false"} aria-hidden="true">
          {text()}
        </span>
      </span>
    </Dynamic>
  )
}
