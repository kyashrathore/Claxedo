import type { AttentionItem } from "@claxedo/workgraph/contracts"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { createMemo, createSignal, For, Show } from "solid-js"
import { toWaitingRow } from "./waiting-source"
import { WaitingRow } from "./waiting-panel"

export function createWaitingCardController(items: () => AttentionItem[]) {
  const [dismissed, setDismissed] = createSignal<Set<string>>(new Set())
  const [floating, setFloating] = createSignal<{ identity: unknown }>()
  const visibleItems = createMemo(() => items().filter((item) => !dismissed().has(toWaitingRow(item).key)))
  const unread = createMemo(() => visibleItems().filter((item) => item.readAt === undefined).length)
  const dismiss = () => {
    setDismissed((current) => new Set([...current, ...visibleItems().map((item) => toWaitingRow(item).key)]))
    setFloating()
  }
  return {
    items: visibleItems,
    unread,
    dismiss,
    reveal: (panelOpen: boolean, identity?: unknown) => {
      setDismissed(new Set<string>())
      if (panelOpen) setFloating({ identity })
    },
    closeFloating: () => setFloating(),
    mode: (panelOpen: boolean, identity?: unknown) => {
      if (visibleItems().length === 0) return undefined
      if (!panelOpen) return "inline" as const
      const request = floating()
      if (request && request.identity === identity) return "floating" as const
      return undefined
    },
  }
}

/** Compact contextual attention card. Previews the four most recent items plus
 *  the total, is dismissible, and opens the full Waiting panel. */
export function WaitingCard(props: {
  mode: "inline" | "floating"
  items: AttentionItem[]
  total: number
  unread: number
  onClose: () => void
  /** Reports the selected item paired with its exact invoking element (the lead
   *  recap button or a compact row button) so the caller can restore focus. */
  onSelect: (item: AttentionItem, element: HTMLElement) => void
}) {
  const preview = createMemo(() => props.items.slice(0, 4))
  const leadRecap = createMemo(() => {
    const first = preview()[0]
    return first && first.kind === "recap_notification" ? first : undefined
  })
  const rows = createMemo(() => (leadRecap() ? preview().slice(1) : preview()))

  return (
    <aside class="workgraph-card" classList={{ "is-inline": props.mode === "inline", "is-floating": props.mode === "floating" }} aria-label="Waiting on you">
      <div class="workgraph-card-head">
        <span class="workgraph-card-title-icon" aria-hidden="true"><Icon name="workgraph" size="small" /></span>
        <span class="workgraph-card-title text-text-weak">Needs you</span>
        <span class="workgraph-card-gap" aria-hidden="true" />
        <Show when={props.unread > 0}><span class="workgraph-attention-dot" aria-label={`${props.unread} unread`} /></Show>
        <span class="workgraph-card-total text-text-base" aria-label={`${props.total} waiting`}>{props.total}</span>
        <Show when={props.mode === "floating"}>
          <IconButton variant="ghost" size="small" icon="close" aria-label="Close waiting context" onClick={props.onClose} />
        </Show>
      </div>
      <Show when={leadRecap()}>
        {(recap) => (
          <button type="button" class="workgraph-card-recap" onClick={(event) => props.onSelect(recap(), event.currentTarget)}>
            <span class="workgraph-card-recap-label text-text-weaker">Latest recap</span>
            <span class="workgraph-card-recap-body text-text-base">{recap().recap.summary}</span>
          </button>
        )}
      </Show>
      <div class="workgraph-card-rows">
        <For each={rows()}>{(item) => <WaitingRow view={toWaitingRow(item)} onSelect={(element) => props.onSelect(item, element)} compact />}</For>
      </div>
    </aside>
  )
}
