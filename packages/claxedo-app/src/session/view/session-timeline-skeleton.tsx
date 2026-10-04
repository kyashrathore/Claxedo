import { Index, Show } from "solid-js"
import { SLOW_LOAD_MS, useElapsed } from "@/lib/delay"
import { usePhone } from "@/lib/viewport"
import { useServer, type PlacementId } from "@/server"
import { DelayedLoading, SkeletonBar } from "@/ui"
import { useSessionScreenText } from "./text"

type SkeletonTurn = {
  readonly bubble: string
  readonly user: readonly number[]
  readonly assistant: readonly number[]
}

const TURNS: readonly SkeletonTurn[] = [
  { bubble: "min(52%, 40ch)", user: [100], assistant: [97, 84, 62] },
  { bubble: "min(68%, 52ch)", user: [100, 71], assistant: [92, 100, 78, 45] },
]

export function SessionTimelineSkeleton(props: { centered?: boolean; waiting?: string }) {
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
                    <Index each={turn().user}>{(width) => <SkeletonBar width={`${width()}%`} class="h-3" />}</Index>
                  </div>
                </div>
                <div class="mt-6 flex flex-col gap-2.5">
                  <Index each={turn().assistant}>{(width) => <SkeletonBar width={`${width()}%`} class="h-3" />}</Index>
                </div>
              </div>
            )}
          </Index>
        </div>
        <Show when={props.waiting}>
          {(waiting) => (
            <p data-testid="session-messages-waiting" class="w-full px-4 pt-6 text-center text-12-regular text-text-weaker md:px-5">
              {waiting()}
            </p>
          )}
        </Show>
      </DelayedLoading>
    </div>
  )
}

export function SessionHistoryLoading(props: { placementId: PlacementId }) {
  const t = useSessionScreenText()
  const server = useServer()
  const phone = usePhone()
  const slow = useElapsed(SLOW_LOAD_MS)
  const waiting = () => {
    if (!slow()) return undefined
    const where = server.placements.byId(props.placementId)?.label
    return where ? t("sessionScreen.loadingSlow", { where }) : t("sessionScreen.loadingSlowUnnamed")
  }
  return <SessionTimelineSkeleton centered={!phone()} waiting={waiting()} />
}
