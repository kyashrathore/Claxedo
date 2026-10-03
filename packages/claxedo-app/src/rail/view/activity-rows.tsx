import { createMemo, createSignal, onMount, Show, type Accessor, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useElapsed } from "@/lib/delay"
import type { SessionId } from "@/server"
import { useSessionStores, type SessionList } from "@/session"
import { railDictionary } from "../i18n"
import { createNavigationGeometry } from "../navigation-geometry"
import { SessionNavigationRows, type SessionNavigationRowsProps } from "./session-navigation-rows"

type InventoryWindow = ReturnType<SessionList["inventory"]["window"]>
type ActivityRowsProps = Pick<SessionNavigationRowsProps, "row"> & {
  readonly page: Accessor<InventoryWindow>
  readonly sessionIds: readonly SessionId[]
}

function ActivityLoading(): JSX.Element {
  const t = useTranslator(railDictionary)
  const elapsed = useElapsed()
  return <Show when={elapsed()}><p role="status" class="px-2 pb-3 text-xs text-text-weak">{t("rail.loadingSessions")}</p></Show>
}

export function ActivityRows(props: ActivityRowsProps): JSX.Element {
  const t = useTranslator(railDictionary)
  const inventory = useSessionStores().list.inventory
  const [scroller, setScroller] = createSignal<HTMLDivElement>()
  const [content, setContent] = createSignal<HTMLDivElement>()
  const [mounted, setMounted] = createSignal(false)
  const geometry = createNavigationGeometry(scroller, content)
  const rowSize = createMemo(() => {
    geometry()
    const element = scroller()
    if (!mounted() || !element) return undefined
    return Number.parseFloat(getComputedStyle(element).getPropertyValue("--activity-row-height"))
  })
  onMount(() => setMounted(true))
  return (
    <div ref={setScroller} role="region" aria-label={t("rail.activity")} class="ui-activity-rows min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 rail-sidebar-scroll">
      <div ref={setContent} class="pb-2">
        <Show when={props.sessionIds.length === 0 && (props.page().kind === "idle" || props.page().kind === "loading")}><ActivityLoading /></Show>
        <Show when={props.sessionIds.length === 0 && props.page().kind === "ready"}><p class="px-2 pb-3 text-xs text-text-weak">{t("rail.activity.empty")}</p></Show>
        <Show when={rowSize()}>{(size) => <SessionNavigationRows row={props.row} sessionIds={props.sessionIds} scroller={scroller} geometry={geometry} rowSize={size()} />}</Show>
        <Show when={props.page().after}><button type="button" disabled={props.page().kind === "loading"} class="min-h-11 px-2 text-xs text-text-weak" onClick={() => void inventory.more()}>{t("rail.loadMore")}</button></Show>
      </div>
    </div>
  )
}
