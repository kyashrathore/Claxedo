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
  onLoadMore?: () => void
  onSelect: (item: AttentionItem) => void
}) {
  // At zero attention with a successful load there is nothing to say: no intro,
  // dot, list, or placeholder renders. A real request error still shows with
  // Retry, and the first load still shows a loading indicator.
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
      <Match when={props.loaded && props.items.length > 0}>
        <div class="workgraph-waiting">
          <div class="workgraph-waiting-intro">
            <div class="workgraph-waiting-intro-head">
              <span class="workgraph-attention-dot" aria-hidden="true" />
              <span class="text-[12px] font-semibold text-text-strong">Needs you</span>
            </div>
            <p class="text-[11px] leading-4 text-text-weaker">Decisions, proposed work, and discovered candidates. Open one to act on it.</p>
          </div>
          <ul class="workgraph-waiting-list">
            <For each={props.items}>
              {(item) => (
                <li>
                  <WaitingRow view={toWaitingRow(item)} onSelect={() => props.onSelect(item)} />
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

export function WaitingRow(props: { view: WaitingRowView; onSelect: () => void; compact?: boolean }) {
  return (
    <button type="button" class="workgraph-waiting-row" classList={{ "is-compact": props.compact }} onClick={props.onSelect}>
      <WaitingRowGlyph view={props.view} />
      <span class="workgraph-waiting-row-main">
        <span class="workgraph-waiting-row-title text-text-base">{props.view.title}</span>
        <Show when={!props.compact}>
          <span class="workgraph-waiting-row-meta text-text-weaker">{props.view.meta}</span>
        </Show>
      </span>
      <span class="workgraph-waiting-row-tag text-text-weaker">{props.view.tag}</span>
    </button>
  )
}

function WaitingRowGlyph(props: { view: WaitingRowView }) {
  return (
    <span class="workgraph-waiting-row-glyph" aria-hidden="true">
      <Switch fallback={<span class="workgraph-status-dot" data-tone={props.view.critical ? "critical" : "info"} />}>
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
