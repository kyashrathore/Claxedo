import { createMemo, For, Match, Show, Switch, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { DiffSummary, PlacementId } from "@/server"
import { FailedNotice, fetchView, PlaceholderRows } from "@/files"
import { useReviewApi } from "../api"
import { t } from "../i18n"
import { useReview } from "../store"
import { ChangedFileRow } from "./changed-file-row"
import { DiffRow } from "./diff-row"

function totals(diffs: readonly DiffSummary[]) {
  return diffs.reduce(
    (sum, diff) => ({ additions: sum.additions + diff.additions, deletions: sum.deletions + diff.deletions }),
    { additions: 0, deletions: 0 },
  )
}

export function ChangedFiles(props: { readonly placementId: PlacementId }): JSX.Element {
  const api = useReviewApi()
  const review = useReview()
  const query = useQuery(() => api.diff(props.placementId, review.scope()))
  const bases = useQuery(() => api.bases(props.placementId))
  const view = createMemo(() => fetchView(query))
  const failed = createMemo(() => {
    const current = view()
    return current.kind === "failed" ? current : undefined
  })
  const diffs = createMemo(() => {
    const current = view()
    return current.kind === "ready" ? current.data : undefined
  })
  const defaultBase = createMemo(() => {
    const current = fetchView(bases)
    return current.kind === "ready" ? current.data.defaultRef : undefined
  })
  const offerBranchDiff = () => {
    const kind = review.scope().kind
    return defaultBase() !== undefined && kind !== "branch" && kind !== "branchWorktree" && kind !== "range"
  }
  return (
    <section data-component="review-changed-files" aria-label={t("review.tab")} class="flex shrink-0 flex-col">
      <Switch>
        <Match when={view().kind === "loading"}>
          <PlaceholderRows label={t("review.loading")} />
        </Match>
        <Match when={failed()}>
          {(failure) => <FailedNotice message={failure().error.message} retryLabel={t("review.retry")} onRetry={() => void query.refetch()} />}
        </Match>
        <Match when={diffs()}>
          {(list) => (
            <Show when={list().length > 0} fallback={<EmptyChanges offer={offerBranchDiff() ? defaultBase() : undefined} />}>
              <div class="flex h-7 items-center gap-2 px-3 text-11-regular text-text-weak">
                <span>{list().length}</span>
                <span class="text-[var(--text-diff-add-base)]">+{totals(list()).additions}</span>
                <span class="text-[var(--text-diff-delete-base)]">−{totals(list()).deletions}</span>
              </div>
              <ul class="flex flex-col gap-px px-2 pb-2" aria-label={t("review.tab")}>
                <For each={list()}>
                  {(diff) => (
                    <li class="flex flex-col">
                      <ChangedFileRow placementId={props.placementId} diff={diff} />
                      <Show when={review.isOpen(diff.file)}>
                        <DiffRow placementId={props.placementId} diff={diff} />
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          )}
        </Match>
      </Switch>
    </section>
  )
}

function EmptyChanges(props: { readonly offer: string | undefined }) {
  const review = useReview()
  return (
    <div data-component="review-empty" class="flex flex-col items-center gap-2 px-3 py-6 text-center text-12-regular text-text-weak">
      <span>{t("review.empty")}</span>
      <Show when={props.offer}>
        {(base) => (
          <button
            type="button"
            class="min-h-8 rounded-md border border-border-weak-base bg-surface-base px-3 text-12-medium text-text-base hover:bg-surface-base-hover pointer-coarse:min-h-11"
            onClick={() => review.setScope({ kind: "branch", base: base() })}
          >
            {t("review.showBranchDiff", { base: base() })}
          </button>
        )}
      </Show>
    </div>
  )
}
