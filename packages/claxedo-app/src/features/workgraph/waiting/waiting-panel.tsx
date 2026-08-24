import type { AttentionItem } from "@claxedo/workgraph/contracts"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { toWaitingRow, type WaitingRowView } from "./waiting-source"

/** A staged (pending_approval) work_item Attention item. */
type StagedItem = Extract<AttentionItem, { kind: "work_item" }>

function isStaged(item: AttentionItem): item is StagedItem {
  return item.kind === "work_item" && item.record.state === "pending_approval"
}

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
  /** Approve a single staged task (owner-only; CAS on the rendered version). */
  onApprove?: (item: AttentionItem) => void
  /** Reject a single staged task with a required reason. */
  onReject?: (item: AttentionItem, reason: string) => void
  /** Approve every staged task in a Stream, sending the exact rendered versions. */
  onApproveAllStaged?: (streamId: string, items: AttentionItem[]) => void
  /** Per-stream partial-conflict summary after a bulk approve. */
  bulkResult?: { streamId: string; approved: number; conflicted: number }
  /** Work item ids that came back version_conflict and stay Staged (flagged). */
  conflictedIds?: ReadonlySet<string>
  /** Whether a staged command is in flight (disables the affordances). */
  busy?: boolean
}) {
  // Staged tasks lead the panel, grouped per Stream so the bulk "Approve all
  // staged" is scoped to one Stream (never a blind approve-everything sweep).
  const stagedGroups = createMemo(() => {
    const groups = new Map<string, StagedItem[]>()
    for (const item of props.items) {
      if (!isStaged(item)) continue
      const group = groups.get(item.record.streamId) ?? []
      group.push(item)
      groups.set(item.record.streamId, group)
    }
    return [...groups.entries()].map(([streamId, items]) => ({ streamId, items }))
  })
  const rest = createMemo(() => props.items.filter((item) => !isStaged(item)))
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
            <h2 class="text-compact font-semibold text-text-strong">Nothing needs you right now</h2>
            <p class="text-xs leading-4 text-text-base">
              No decisions, proposals, or follow-ups are waiting. We’ll buzz you when that changes.
            </p>
          </div>
        </div>
      </Match>
      <Match when={props.loaded && props.items.length > 0}>
        <div class="workgraph-waiting">
          <div class="workgraph-waiting-intro">
            <div class="workgraph-waiting-intro-head">
              <span class="text-sm font-semibold text-text-strong">Needs you</span>
              <span class="workgraph-card-gap" aria-hidden="true" />
              <button
                type="button"
                class="workgraph-waiting-action"
                disabled={props.unread === 0}
                onClick={props.onMarkAllRead}
              >
                Mark all read
              </button>
              <button type="button" class="workgraph-waiting-action" onClick={props.onClear}>
                Clear
              </button>
            </div>
            <p class="text-xs leading-4 text-text-base">
              Decisions, proposed work, and discovered candidates. Open one to act on it.
            </p>
          </div>
          <For each={stagedGroups()}>
            {(group) => (
              <div class="workgraph-staged-group" aria-label="Staged tasks awaiting approval">
                <div class="workgraph-staged-group-head">
                  <span class="text-xs font-semibold text-text-strong">
                    Staged · {group.items.length} awaiting approval
                  </span>
                  <span class="workgraph-card-gap" aria-hidden="true" />
                  <button
                    type="button"
                    class="workgraph-waiting-action"
                    disabled={props.busy || !props.onApproveAllStaged}
                    onClick={() => props.onApproveAllStaged?.(group.streamId, group.items)}
                  >
                    Approve all staged ({group.items.length})
                  </button>
                </div>
                <Show when={props.bulkResult?.streamId === group.streamId ? props.bulkResult : undefined}>
                  {(result) => (
                    <p class="workgraph-staged-conflict text-text-weaker" role="status">
                      {result().approved} approved · {result().conflicted} changed since you looked — re-review
                    </p>
                  )}
                </Show>
                <ul class="workgraph-waiting-list">
                  <For each={group.items}>
                    {(item) => (
                      <li>
                        <StagedWaitingRow
                          view={toWaitingRow(item)}
                          conflicted={!!props.conflictedIds?.has(item.record.id)}
                          busy={props.busy}
                          onSelect={(element) => props.onSelect(item, element)}
                          onApprove={props.onApprove ? () => props.onApprove?.(item) : undefined}
                          onReject={props.onReject ? (reason) => props.onReject?.(item, reason) : undefined}
                        />
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            )}
          </For>
          <ul class="workgraph-waiting-list">
            <For each={rest()}>
              {(item) => (
                <li>
                  <WaitingRow view={toWaitingRow(item)} onSelect={(element) => props.onSelect(item, element)} />
                </li>
              )}
            </For>
            <Show when={props.hasMore}>
              <li class="workgraph-waiting-more">
                <button
                  type="button"
                  class="workgraph-detail-retry"
                  disabled={props.loadingMore}
                  onClick={() => props.onLoadMore?.()}
                >
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
export function WaitingRow(props: {
  view: WaitingRowView
  onSelect: (element: HTMLElement) => void
  compact?: boolean
}) {
  return (
    <button
      type="button"
      class={["workgraph-waiting-row", { "is-compact": !!props.compact }]}
      onClick={(event) => props.onSelect(event.currentTarget)}
    >
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

/** A staged task row: distinct from result-review rows (dashed glyph, verb
 *  "Approve to run") and carrying inline Approve/Reject. Reject reveals a
 *  required-reason field. A version_conflict from a bulk approve flags the row
 *  and keeps it Staged. The row is a div (not a button) so the action controls
 *  are valid interactive descendants. */
function StagedWaitingRow(props: {
  view: WaitingRowView
  conflicted?: boolean
  busy?: boolean
  onSelect: (element: HTMLElement) => void
  onApprove?: () => void
  onReject?: (reason: string) => void
}) {
  const [rejecting, setRejecting] = createSignal(false)
  const [reason, setReason] = createSignal("")
  return (
    <div class={["workgraph-waiting-row is-staged", { "is-conflicted": !!props.conflicted }]}>
      <span class="workgraph-waiting-row-glyph" aria-hidden="true">
        <Icon name="circle-dashed" size="small" />
      </span>
      <button
        type="button"
        class="workgraph-waiting-row-main workgraph-staged-open"
        aria-label={`Open task ${props.view.title}`}
        onClick={(event) => props.onSelect(event.currentTarget)}
      >
        <span class="workgraph-waiting-row-title text-text-base">{props.view.title}</span>
        <span class="workgraph-waiting-row-meta text-text-base">
          {props.conflicted ? "Changed since you looked — re-review" : "Approve to run"}
        </span>
      </button>
      <Show
        when={rejecting()}
        fallback={
          <span class="workgraph-staged-actions">
            <button
              type="button"
              class="workgraph-waiting-action"
              disabled={props.busy || !props.onApprove}
              onClick={() => props.onApprove?.()}
            >
              Approve
            </button>
            <button
              type="button"
              class="workgraph-waiting-action"
              disabled={props.busy || !props.onReject}
              onClick={() => setRejecting(true)}
            >
              Reject
            </button>
          </span>
        }
      >
        <span class="workgraph-staged-actions">
          <input
            ref={(input) => requestAnimationFrame(() => input.isConnected && input.focus())}
            class="workgraph-input"
            aria-label={`Reject reason for ${props.view.title}`}
            value={reason()}
            placeholder="Reason to reject"
            disabled={props.busy}
            onInput={(event) => setReason(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && reason().trim()) {
                event.preventDefault()
                props.onReject?.(reason().trim())
              }
              if (event.key === "Escape") {
                setRejecting(false)
                setReason("")
              }
            }}
          />
          <button
            type="button"
            class="workgraph-waiting-action"
            disabled={props.busy || !reason().trim()}
            onClick={() => props.onReject?.(reason().trim())}
          >
            Reject task
          </button>
        </span>
      </Show>
    </div>
  )
}

export function WaitingRowGlyph(props: { view: WaitingRowView }) {
  return (
    <span class={["workgraph-waiting-row-glyph", { "is-critical": props.view.critical }]} aria-hidden="true">
      <Switch fallback={<Icon name="circle-alert" size="small" />}>
        <Match when={props.view.staged}>
          <Icon name="circle-dashed" size="small" />
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
        <Match when={props.view.kind === "master_escalation"}>
          <Icon name="circle-alert" size="small" class="text-icon-weak-base" />
        </Match>
      </Switch>
    </span>
  )
}

function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  return "Waiting could not be loaded."
}
