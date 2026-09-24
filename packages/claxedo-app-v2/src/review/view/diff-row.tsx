import { createMemo, Match, Show, Switch, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { DiffSummary, PlacementId } from "@/server"
import { FailedNotice, fetchView, isMediaPath, PlaceholderRows } from "@/files"
import { useReviewApi } from "../api"
import { t } from "../i18n"
import { useReview } from "../store"
import { PatchView } from "./patch-view"

const MAX_CHANGED_LINES = 500

export function DiffRow(props: { readonly placementId: PlacementId; readonly diff: DiffSummary }): JSX.Element {
  const review = useReview()
  const changed = () => props.diff.additions + props.diff.deletions
  const guarded = () => changed() > MAX_CHANGED_LINES && !review.forced(props.diff.file)
  return (
    <div data-component="review-diff" data-path={props.diff.file} class="mb-1 rounded-md border border-border-weak-base bg-background-stronger">
      <Switch>
        <Match when={isMediaPath(props.diff.file)}>
          <Notice text={t("review.diff.media")} />
        </Match>
        <Match when={guarded()}>
          <div class="flex flex-col items-start gap-2 px-3 py-3 text-12-regular text-text-weak">
            <span class="text-text-base">{t("review.largeDiff.title")}</span>
            <span>{t("review.largeDiff.meta", { limit: MAX_CHANGED_LINES, current: changed() })}</span>
            <button
              type="button"
              class="min-h-8 rounded-md border border-border-weak-base bg-surface-base px-3 text-12-medium text-text-base hover:bg-surface-base-hover pointer-coarse:min-h-11"
              onClick={() => review.force(props.diff.file)}
            >
              {t("review.largeDiff.renderAnyway")}
            </button>
          </div>
        </Match>
        <Match when={true}>
          <PatchLoader placementId={props.placementId} file={props.diff.file} />
        </Match>
      </Switch>
    </div>
  )
}

function Notice(props: { readonly text: string }) {
  return (
    <div role="status" class="px-3 py-3 text-12-regular text-text-weak">
      {props.text}
    </div>
  )
}

function PatchLoader(props: { readonly placementId: PlacementId; readonly file: string }) {
  const api = useReviewApi()
  const review = useReview()
  const query = useQuery(() => api.diffFile(props.placementId, review.scope(), props.file))
  const view = createMemo(() => fetchView(query))
  const failed = createMemo(() => {
    const current = view()
    return current.kind === "failed" ? current : undefined
  })
  const patch = createMemo(() => {
    const current = view()
    return current.kind === "ready" ? (current.data.patch ?? "") : undefined
  })
  return (
    <Switch>
      <Match when={view().kind === "loading"}>
        <PlaceholderRows label={t("review.diff.loading")} />
      </Match>
      <Match when={failed()}>
        {(failure) => <FailedNotice message={failure().error.message} retryLabel={t("review.retry")} onRetry={() => void query.refetch()} />}
      </Match>
      <Match when={patch() !== undefined}>
        <Show when={patch()} fallback={<Notice text={t("review.diff.empty")} />}>
          {(text) => <PatchView file={props.file} patch={text()} />}
        </Show>
      </Match>
    </Switch>
  )
}
