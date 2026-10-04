import { Index } from "solid-js"
import { DelayedLoading } from "@/ui"
import { useSessionScreenText } from "./text"

type SkeletonBar = {
  width: number
  delay: string
}

type SkeletonTurn = {
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
  const t = useSessionScreenText()
  const centered = () => props.centered !== false

  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="session-messages-loading"
      data-session-timeline-loading
      class="flex h-full w-full flex-col justify-end overflow-hidden pb-2"
      style={{
        "mask-image": "linear-gradient(to bottom, transparent 0%, #000 34%)",
        "-webkit-mask-image": "linear-gradient(to bottom, transparent 0%, #000 34%)",
      }}
    >
      <span class="sr-only">{t("sessionScreen.loading")}</span>
      <DelayedLoading>
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
                    class="flex flex-col gap-2.5 rounded-md border border-border-weak-base bg-surface-base px-3 py-2.5"
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
      </DelayedLoading>
    </div>
  )
}

function SkeletonLine(props: { bar: SkeletonBar }) {
  return (
    <div
      class="session-skeleton-bar h-3 rounded-sm"
      style={{ width: `${props.bar.width}%`, "animation-delay": props.bar.delay }}
    />
  )
}
