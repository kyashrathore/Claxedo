import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js"
import { ClaxedoIcon as Icon } from "@/ui"

export function TimelineJumpButton(props: { shown: boolean; working: boolean; label: string; onClick: () => void }) {
  const [fadedOut, setFadedOut] = createSignal(untrack(() => !props.shown))
  createEffect(() => {
    if (props.shown) setFadedOut(false)
  })
  let fade: HTMLDivElement | undefined
  onCleanup(() => {
    for (const animation of fade?.getAnimations() ?? []) animation.cancel()
  })
  const settleFade = (event: TransitionEvent) => {
    if (event.target === event.currentTarget && event.propertyName === "opacity" && !props.shown) setFadedOut(true)
  }
  return (
    <div
      data-session-timeline-jump
      class="pointer-events-none absolute inset-x-0 bottom-6 z-[60] flex justify-center"
    >
      <div
        ref={fade}
        class="transition-all duration-200 ease-out"
        classList={{
          "opacity-100 translate-y-0 scale-100 pointer-events-auto": props.shown,
          "opacity-0 translate-y-2 scale-95 pointer-events-none": !props.shown,
        }}
        onTransitionEnd={settleFade}
      >
        <button
          class="flex h-8 w-8 items-center justify-center rounded-full border border-border-weaker-base bg-surface-raised-stronger-non-alpha text-text-base cursor-pointer p-0 transition-colors hover:border-border-weak-base"
          aria-label={props.label}
          onClick={props.onClick}
        >
          <Show when={props.working && !fadedOut()} fallback={<Icon name="scroll-to-latest" size="large" />}>
            <span class="tl-dot-wave" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </Show>
        </button>
      </div>
    </div>
  )
}
