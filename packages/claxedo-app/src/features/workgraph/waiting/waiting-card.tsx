import type { AttentionItem } from "@claxedo/workgraph/contracts"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/platform/persistence/persist"
import { ContextCard, ContextCardIcon } from "@/ui/context-card/context-card"
import { toWaitingRow } from "./waiting-source"
import { WaitingRow } from "./waiting-panel"

export function createWaitingCardController(items: () => AttentionItem[]) {
  const [floating, setFloating] = createSignal<{ identity: unknown }>()
  // Codex's "pinned summary" model: ONE route-restorable pinned boolean,
  // toggled from the surface header (pinned + panel closed = the inline card;
  // unpinned = nothing — no per-item dismissal bookkeeping), plus Cursor's
  // route-restorable collapse-to-rail preference for the inline card.
  const [ui, setUi] = persisted(
    Persist.global("workgraph.attention-card-pinned.v1"),
    createStore<{ pinned: boolean; collapsed: boolean }>({ pinned: true, collapsed: false }),
  )
  const unread = createMemo(() => items().filter((item) => item.readAt === undefined).length)
  return {
    items,
    unread,
    collapsed: () => ui.collapsed,
    toggleCollapsed: () => setUi("collapsed", !ui.collapsed),
    dismiss: () => {
      setUi("pinned", false)
      setFloating()
    },
    reveal: (panelOpen: boolean, identity?: unknown) => {
      setUi("pinned", true)
      if (panelOpen) setFloating({ identity })
    },
    closeFloating: () => setFloating(),
    mode: (panelOpen: boolean, identity?: unknown) => {
      if (items().length === 0) return undefined
      if (!panelOpen) return ui.pinned ? ("inline" as const) : undefined
      const request = floating()
      if (request && request.identity === identity) return "floating" as const
      return undefined
    },
  }
}

/** Compact contextual attention card — the Codex "pinned summary" shape.
 *  Previews the four most recent items plus the total; visibility is toggled
 *  from the surface header, and the inline card can also fold into Cursor's
 *  icon rail (`collapsed`). Rows open the item dialog directly; the head's
 *  expand action opens the full Waiting panel. */
export function WaitingCard(props: {
  mode: "inline" | "floating"
  items: AttentionItem[]
  total: number
  unread: number
  /** Collapse-to-rail, inline mode only — floating reveals are always full. */
  collapsed?: boolean
  onToggleCollapse?: () => void
  onClose: () => void
  /** Reports the selected item paired with its exact invoking element (the lead
   *  recap button or a compact row button) so the caller can restore focus.
   *  Rows open the item directly (a dialog), never a detour. */
  onSelect: (item: AttentionItem, element: HTMLElement) => void
  /** Opens the full Waiting list in the shared panel. */
  onOpenPanel: () => void
}) {
  const preview = createMemo(() => props.items.slice(0, 4))
  const leadRecap = createMemo(() => {
    const first = preview()[0]
    return first && first.kind === "recap_notification" ? first : undefined
  })
  const rows = createMemo(() => (leadRecap() ? preview().slice(1) : preview()))

  // The collapsed rail keeps one real control per capability: the full panel.
  const rail = (
    <button
      type="button"
      class="ui-context-card-rail-item"
      classList={{ "is-unread": props.unread > 0 }}
      aria-label="Open Needs you panel"
      onClick={() => props.onOpenPanel()}
    >
      <ContextCardIcon name="bullet-list" size="small" />
    </button>
  )

  return (
    <ContextCard
      variant="floating"
      ariaLabel="Waiting on you"
      class={`workgraph-card ${props.mode === "inline" ? "is-inline" : ""}`}
      label="Needs you"
      count={props.total}
      countLabel={`${props.total} waiting`}
      unread={props.unread > 0}
      unreadLabel={`${props.unread} unread`}
      collapsed={props.mode === "inline" ? props.collapsed : false}
      onToggleCollapse={props.mode === "inline" ? props.onToggleCollapse : undefined}
      collapsedLabel="Expand Needs you"
      collapsedContent={rail}
      headerActions={
        <IconButton
          variant="ghost"
          size="small"
          icon="maximize"
          aria-label="Open Needs you panel"
          onClick={() => props.onOpenPanel()}
        />
      }
      onClose={props.mode === "floating" ? props.onClose : undefined}
      closeLabel="Close waiting context"
    >
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
    </ContextCard>
  )
}
