import type { AttentionItem } from "@claxedo/workgraph/contracts"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { createMemo, createSignal, For, Show } from "solid-js"
import { toWaitingRow } from "./waiting-source"
import { WaitingRow } from "./waiting-panel"

/**
 * Controls when the compact contextual card appears. It surfaces for newly
 * unseen attention while the full panel is closed, and — once dismissed — does
 * not reopen for the same items. New attention (a key not seen before) makes it
 * reappear. Opening the panel counts as seeing everything.
 */
export function createWaitingCardController(items: () => AttentionItem[]) {
  const [seen, setSeen] = createSignal<Set<string>>(new Set())
  const keys = createMemo(() => items().map((item) => toWaitingRow(item).key))
  const hasUnseen = createMemo(() => keys().some((key) => !seen().has(key)))
  const markAllSeen = () => setSeen(new Set(keys()))
  return {
    hasUnseen,
    markAllSeen,
    /** Whether the card should render: unseen attention exists and panel is closed. */
    visible: (panelOpen: boolean) => !panelOpen && items().length > 0 && hasUnseen(),
  }
}

/** Compact contextual attention card. Previews the four most recent items plus
 *  the total, is dismissible, and opens the full Waiting panel. */
export function WaitingCard(props: {
  items: AttentionItem[]
  total: number
  working?: number
  onOpenPanel: () => void
  onDismiss: () => void
  onSelect: (item: AttentionItem) => void
}) {
  const preview = createMemo(() => props.items.slice(0, 4))
  const leadRecap = createMemo(() => {
    const first = preview()[0]
    return first && first.kind === "recap_notification" ? first : undefined
  })
  const rows = createMemo(() => (leadRecap() ? preview().slice(1) : preview()))

  return (
    <div class="workgraph-card" role="dialog" aria-label="Waiting on you">
      <div class="workgraph-card-head">
        <span class="workgraph-attention-dot" aria-hidden="true" />
        <span class="text-[12px] font-semibold text-text-strong">Waiting on you</span>
        <span class="workgraph-count" aria-hidden="true">
          {props.total}
        </span>
        <Show when={props.working}>
          <span class="workgraph-card-working text-text-weaker">{props.working} working</span>
        </Show>
        <span class="workgraph-card-gap" aria-hidden="true" />
        <IconButton variant="ghost" size="small" icon="close" aria-label="Dismiss waiting card" onClick={props.onDismiss} />
      </div>
      <Show when={leadRecap()}>
        {(recap) => (
          <button type="button" class="workgraph-card-recap" onClick={() => props.onSelect(recap())}>
            <span class="workgraph-card-recap-label text-text-weaker">Latest recap</span>
            <span class="workgraph-card-recap-body text-text-base">{recap().recap.summary}</span>
          </button>
        )}
      </Show>
      <div class="workgraph-card-rows">
        <For each={rows()}>{(item) => <WaitingRow view={toWaitingRow(item)} onSelect={() => props.onSelect(item)} compact />}</For>
      </div>
      <button type="button" class="workgraph-card-open" onClick={props.onOpenPanel}>
        Open Waiting panel
      </button>
    </div>
  )
}
