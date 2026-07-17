import type { AttentionItem } from "@claxedo/workgraph/contracts"
import { Icon } from "@opencode-ai/ui/icon"
import { For, Match, Show, Switch } from "solid-js"
import { toWaitingRow, type WaitingRowView } from "./waiting-source"

/** Body of the shared Needs-you panel tab. Purely presentational; the caller
 *  owns the attention resource, pagination, and refetching. */
export function WaitingPanelBody(props: {
  items: AttentionItem[]
  total: number
  hasMore: boolean
  loading: boolean
  loadingMore?: boolean
  loaded: boolean
  error: unknown
  retry: () => void
  unread: number
  onMarkAllRead: () => void
  onClear: () => void
  onLoadMore?: () => void
  onSelect: (item: AttentionItem, element: HTMLElement) => void
}) {
  // Zero attention is a successful, reassuring state. Keep it distinct from
  // loading and failures so an empty panel never reads like missing content.
  return (
    <Switch>
      <Match when={props.error}>
        <div class="workgraph-waiting">
          <div class="workgraph-detail-status is-error" role="alert">
            <span>{errorMessage(props.error)}</span>
            <button type="button" class="workgraph-detail-retry" onClick={props.retry}>
              Retry
            </button>
          </div>
        </div>
      </Match>
      <Match when={props.loading && !props.loaded}>
        <div class="workgraph-waiting">
          <div class="workgraph-detail-status" role="status" aria-live="polite">
            Loading…
          </div>
        </div>
      </Match>
      <Match when={props.loaded && props.items.length === 0}>
        <div class="workgraph-waiting-empty" role="status">
          <div class="workgraph-waiting-empty-mark" aria-hidden="true">
            <Icon name="check" size="small" />
          </div>
          <div class="workgraph-waiting-empty-copy">
            <h2 class="text-[13px] font-semibold text-text-strong">Nothing needs you right now</h2>
            <p class="text-[11px] leading-4 text-text-base">No decisions, proposals, or follow-ups are waiting. We’ll buzz you when that changes.</p>
          </div>
        </div>
      </Match>
      <Match when={props.loaded && props.items.length > 0}>
        <div class="workgraph-waiting">
          <div class="workgraph-waiting-intro">
            <div class="workgraph-waiting-intro-head">
              <span class="text-[12px] font-semibold text-text-strong">Needs you</span>
              <span class="workgraph-card-gap" aria-hidden="true" />
              <button type="button" class="workgraph-waiting-action" disabled={props.unread === 0} onClick={props.onMarkAllRead}>Mark all read</button>
              <button type="button" class="workgraph-waiting-action" onClick={props.onClear}>Clear</button>
            </div>
            <p class="text-[11px] leading-4 text-text-base">Decisions, proposed work, and discovered candidates. Open one to act on it.</p>
          </div>
          <ul class="workgraph-waiting-list">
            <For each={props.items}>
              {(item) => (
                <li>
                  <WaitingRow view={toWaitingRow(item)} onSelect={(element) => props.onSelect(item, element)} />
                </li>
              )}
            </For>
            <Show when={props.hasMore}>
              <li class="workgraph-waiting-more">
                <button type="button" class="workgraph-detail-retry" disabled={props.loadingMore} onClick={() => props.onLoadMore?.()}>
                  {props.loadingMore ? "Loading…" : `Load more (${props.items.length} of ${props.total})`}
                </button>
              </li>
            </Show>
          </ul>
        </div>
      </Match>
    </Switch>
  )
}

/** Shared attention row used by both the panel list and the contextual card. Its
 *  click reports the exact invoking element — `event.currentTarget`, always the
 *  row button rather than the inner glyph a click may land on — so the caller can
 *  pair that element with the item it stands for. */
export function WaitingRow(props: { view: WaitingRowView; onSelect: (element: HTMLElement) => void; compact?: boolean }) {
  return (
    <button type="button" class="workgraph-waiting-row" classList={{ "is-compact": props.compact }} onClick={(event) => props.onSelect(event.currentTarget)}>
      <WaitingRowGlyph view={props.view} />
      <span class="workgraph-waiting-row-main">
        <span class="workgraph-waiting-row-title text-text-base">{props.view.title}</span>
        <Show when={!props.compact}>
          <span class="workgraph-waiting-row-meta text-text-base">{props.view.meta}</span>
        </Show>
      </span>
      <span class="workgraph-waiting-row-tag text-text-base">{props.view.tag}</span>
    </button>
  )
}

export function WaitingRowGlyph(props: { view: WaitingRowView }) {
  return (
    <span class="workgraph-waiting-row-glyph" classList={{ "is-critical": props.view.critical }} aria-hidden="true">
      <Switch fallback={<Icon name="circle-alert" size="small" />}>
        <Match when={props.view.kind === "recap_notification"}>
          <Icon name="bullet-list" size="small" class="text-icon-weak-base" />
        </Match>
        <Match when={props.view.kind === "admission_proposal"}>
          <span class="workgraph-outcome-marker" />
        </Match>
        <Match when={props.view.kind === "unorganized_ai_work"}>
          <Icon name="download" size="small" class="text-icon-weak-base" />
        </Match>
        <Match when={props.view.kind === "configuration_required"}>
          <Icon name="warning" size="small" class="text-icon-weak-base" />
        </Match>
      </Switch>
    </span>
  )
}

function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  return "Waiting could not be loaded."
}
