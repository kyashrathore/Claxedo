import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js"
import { ClaxedoIcon as Icon } from "@/ui"

export function TimelineJumpButton(props: { shown: boolean; working: boolean; label: string; onClick: () => void }) {
  const [fadedOut, setFadedOut] = createSignal(untrack(() => !props.shown))
  createEffect(() => {
    if (props.shown) setFadedOut(false)
  })
  let fade: HTMLDivElement | undefined
  let runningTransitions = 0
  onCleanup(() => {
    if (!fade || runningTransitions === 0) return
    fade.style.transition = "none"
    for (const animation of fade.getAnimations()) animation.cancel()
  })
  const countFade = (event: TransitionEvent, change: 1 | -1) => {
    if (event.target === event.currentTarget) runningTransitions = Math.max(0, runningTransitions + change)
  }
  const settleFade = (event: TransitionEvent) => {
    countFade(event, -1)
    if (event.target === event.currentTarget && event.propertyName === "opacity" && !props.shown) setFadedOut(true)
  }
  return (
    <div
      data-session-timeline-jump
      class="pointer-events-none absolute inset-x-0 bottom-[calc(1.5rem+var(--timeline-dock-inset,0px))] z-[60] flex justify-center"
    >
      <div
        ref={fade}
        class="transition-all duration-200 ease-out"
        classList={{
          "opacity-100 translate-y-0 scale-100 pointer-events-auto": props.shown,
          "opacity-0 translate-y-2 scale-95 pointer-events-none": !props.shown,
        }}
        onTransitionRun={(event) => countFade(event, 1)}
        onTransitionCancel={(event) => countFade(event, -1)}
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
