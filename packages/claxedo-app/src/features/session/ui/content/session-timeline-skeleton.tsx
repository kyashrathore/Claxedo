import { Index } from "solid-js"

import { useLanguage } from "@/platform/i18n/provider"

/**
 * Loading placeholder for the message timeline.
 *
 * It borrows the timeline's own geometry rather than inventing a shape: the
 * same centred column and breakpoints as `TimelineRowFrame`, the same
 * `px-4 md:px-5` row padding, the same 24px assistant offset, and the same
 * bubble chrome the legacy user message paints (message-part.css `:1497`).
 * It also anchors to the bottom the way a restored conversation does, so the
 * real messages land where the placeholder sat instead of the whole view
 * jumping the moment they arrive.
 */

type SkeletonBar = {
  /** Share of the row this line covers. */
  width: number
  /** Position in the wave that runs down the column. */
  delay: string
}

type SkeletonTurn = {
  /** Bubble width — the real bubble is `width: fit-content; max-width: min(82%, 64ch)`. */
  bubble: string
  user: SkeletonBar[]
  assistant: SkeletonBar[]
}

const TURNS: SkeletonTurn[] = (() => {
  const shape = [
    { bubble: "min(52%, 40ch)", user: [100], assistant: [97, 84, 62] },
    { bubble: "min(68%, 52ch)", user: [100, 71], assistant: [92, 100, 78, 45] },
  ]
  let step = 0
  const bar = (width: number): SkeletonBar => ({ width, delay: `${step++ * 70}ms` })
  return shape.map((turn) => ({
    bubble: turn.bubble,
    user: turn.user.map(bar),
    assistant: turn.assistant.map(bar),
  }))
})()

export function SessionTimelineSkeleton(props: { centered?: boolean }) {
  const language = useLanguage()
  const centered = () => props.centered !== false

  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="session-messages-loading"
      // The Environment card reserves a right gutter on the timeline's scroll
      // viewport and on the composer dock (session-environment-card.css). This
      // placeholder stands in for the whole timeline — scroll viewport included —
      // so it has to claim the same gutter itself, or it centres on the full pane
      // while every other column centres on the squeezed one.
      data-session-timeline-loading
      class="flex h-full w-full flex-col justify-end overflow-hidden pb-2"
      style={{
        // The top of the column dissolves, so the placeholder reads as the tail
        // of a conversation rather than a card floating in empty space.
        "mask-image": "linear-gradient(to bottom, transparent 0%, #000 34%)",
        "-webkit-mask-image": "linear-gradient(to bottom, transparent 0%, #000 34%)",
      }}
    >
      <span class="sr-only">{language.t("session.messages.loading")}</span>
      <div
        aria-hidden="true"
        classList={{
          "min-w-0 w-full max-w-full": true,
          "md:max-w-192 2xl:max-w-[880px] md:mx-auto": centered(),
        }}
      >
        <Index each={TURNS}>
          {(turn) => (
            <div class="w-full px-4 pt-8 md:px-5">
              <div class="flex flex-col items-end">
                <div
                  class="flex flex-col gap-2.5 rounded-[6px] border border-border-weak-base bg-surface-base px-3 py-2.5"
                  style={{ width: turn().bubble }}
                >
                  <Index each={turn().user}>{(bar) => <SkeletonLine bar={bar()} />}</Index>
                </div>
              </div>
              <div class="mt-6 flex flex-col gap-2.5">
                <Index each={turn().assistant}>{(bar) => <SkeletonLine bar={bar()} />}</Index>
              </div>
            </div>
          )}
        </Index>
      </div>
    </div>
  )
}

function SkeletonLine(props: { bar: SkeletonBar }) {
  return (
    <div
      class="session-skeleton-bar h-3 rounded-[4px]"
      style={{ width: `${props.bar.width}%`, "animation-delay": props.bar.delay }}
    />
  )
}
