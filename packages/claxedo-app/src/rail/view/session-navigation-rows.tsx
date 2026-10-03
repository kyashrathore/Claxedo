import { createEffect, createMemo, createSignal, For, Show, type Accessor, type JSX } from "solid-js"
import { createVirtualizer } from "@tanstack/solid-virtual"
import type { SessionId } from "@/server"
import { useSessionStores, type SessionRowView } from "@/session"
import { focusNavigationRow } from "../navigation-focus"

export type SessionNavigationRowsProps = {
  readonly sessionIds: readonly SessionId[]
  readonly scroller: Accessor<HTMLElement | undefined>
  readonly geometry: Accessor<number>
  readonly rowSize?: number
  readonly row: (row: Accessor<SessionRowView>) => JSX.Element
}

function createNavigationKeys(props: SessionNavigationRowsProps, focus: (index: number) => void) {
  return (event: KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute("data-slot") !== "navigation-row-activate") return
    const sessionId = event.target.closest('[data-session-id]')?.getAttribute("data-session-id")
    const index = props.sessionIds.findIndex((id) => id === sessionId)
    const next = event.key === "Home" ? 0 : event.key === "End" ? props.sessionIds.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1)
    if (next < 0 || next >= props.sessionIds.length) return
    event.preventDefault()
    focus(next)
  }
}

export function SessionNavigationRows(props: SessionNavigationRowsProps): JSX.Element {
  const list = useSessionStores().list
  let container: HTMLDivElement | undefined
  const [margin, setMargin] = createSignal(0)
  const [pending, setPending] = createSignal<string>()
  const virtual = () => props.sessionIds.length > 100
  const indexById = createMemo(() => new Map<string, number>(props.sessionIds.map((id, index) => [id, index])))
  const virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
    get count() { return virtual() ? props.sessionIds.length : 0 },
    get enabled() { return virtual() },
    getScrollElement: () => props.scroller() ?? null,
    initialOffset: () => props.scroller()?.scrollTop ?? 0,
    get estimateSize() { const size = props.rowSize ?? 68; return () => size },
    get getItemKey() { const ids = props.sessionIds; return (index: number) => ids[index] },
    get scrollMargin() { return margin() },
    overscan: 5,
  })
  const visible = createMemo(() => virtualizer.getVirtualItems().map((item) => String(item.key)))
  const positions = createMemo(() => new Map(virtualizer.getVirtualItems().map((item) => [String(item.key), item.start])))
  const focus = (sessionId: string) => {
    const index = indexById().get(sessionId)
    if (index === undefined) return false
    setPending(sessionId)
    if (virtual()) virtualizer.scrollToIndex(index, { align: "auto" })
    else container?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(sessionId)}"]`)?.scrollIntoView({ block: "nearest" })
    return true
  }
  createEffect(() => {
    props.geometry()
    props.sessionIds.length
    const scroller = props.scroller()
    queueMicrotask(() => { if (container && scroller) setMargin(container.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop) })
  })
  createEffect(() => {
    visible()
    const target = pending()
    if (target) queueMicrotask(() => { if (container && focusNavigationRow(container, target)) setPending(undefined) })
  })
  const render = (id: string) => {
    const canonical = () => props.sessionIds[indexById().get(id) ?? -1]
    return <Show when={canonical() === undefined ? undefined : list.view(canonical())}>{(row) => <div class="ui-session-navigation-item">{props.row(row)}</div>}</Show>
  }
  return <div ref={container} class="relative" style={{ height: virtual() ? `${virtualizer.getTotalSize()}px` : undefined }} onKeyDown={createNavigationKeys(props, (index) => focus(props.sessionIds[index]))}>
    <Show when={virtual()} fallback={<For each={props.sessionIds}>{render}</For>}>
      <For each={visible()}>{(id) => <div data-index={indexById().get(id)} ref={(element) => queueMicrotask(() => element.isConnected && virtualizer.measureElement(element))} style={{ position: "absolute", width: "100%", top: "0", transform: `translateY(${(positions().get(id) ?? 0) - margin()}px)` }}>{render(id)}</div>}</For>
    </Show>
  </div>
}
