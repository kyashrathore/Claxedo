import { createMemo, Match, Show, Switch, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { fetchView, PlaceholderRows } from "@/files"
import { useTranslator } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import type { DiffSummary, PlacementId } from "@/server"
import { ReviewCodeView } from "@/transcript"
import { Button } from "@/ui"
import { useReviewApi } from "../api"
import { useReviewComments } from "../comments"
import { createDiffContent } from "../diff-content"
import { dictionary } from "../i18n"
import { useReview } from "../store"
import { createCodeViewComments } from "./code-view-comments"
import { DiffBody } from "./diff-body"
import { FileHeader } from "./file-header"

export function ReviewDiffs(props: { readonly placementId: PlacementId }): JSX.Element {
  const t = useTranslator(dictionary)
  const api = useReviewApi()
  const review = useReview()
  const query = useQuery(() => api.diff(props.placementId, review.scope()))
  const view = createMemo(() => fetchView(query))
  const failed = createMemo(() => {
    const current = view()
    return current.kind === "failed" ? current.error : undefined
  })
  const summaries = createMemo(() => {
    const current = view()
    return current.kind === "ready" ? current.data : undefined
  })
  return (
    <Switch>
      <Match when={view().kind === "loading"}>
        <PlaceholderRows label={t("review.loading")} rows={4} />
      </Match>
      <Match when={failed()}>
        {(error) => (
          <FailureNotice
            title={t("review.loadFailed")}
            message={error().message}
            retryLabel={t("review.retry")}
            onRetry={() => void query.refetch()}
          />
        )}
      </Match>
      <Match when={summaries()}>
        {(list) => (
          <Show when={list().length > 0} fallback={<EmptyChanges placementId={props.placementId} />}>
            <DiffDocument placementId={props.placementId} summaries={list()} />
          </Show>
        )}
      </Match>
    </Switch>
  )
}

function DiffDocument(props: {
  readonly placementId: PlacementId
  readonly summaries: readonly DiffSummary[]
}): JSX.Element {
  const review = useReview()
  const comments = useReviewComments()
  const content = createDiffContent({
    placementId: props.placementId,
    scope: review.scope,
    summaries: () => props.summaries,
    forced: review.forced,
  })
  const codeViewComments = createCodeViewComments({ comments, diffs: content.diffs })
  const summaryOf = (file: string) => props.summaries.find((summary) => summary.file === file)
  return (
    <ReviewCodeView
      class="min-h-0 flex-1"
      diffs={content.diffs()}
      diffStyle={review.style()}
      open={review.open()}
      onToggleOpen={review.toggleOpen}
      renderHeader={(file) => <Show when={summaryOf(file)}>{(summary) => <FileHeader diff={summary()} />}</Show>}
      onDiffContentRequired={content.request}
      customFiles={content.custom()}
      renderCustomBody={(file) => <DiffBody body={content.body(file)} onForce={() => review.force(file)} />}
      comments={comments.enabled() ? codeViewComments : undefined}
      selectedLines={comments.enabled() ? codeViewComments.selectedLines() : null}
    />
  )
}

function EmptyChanges(props: { readonly placementId: PlacementId }): JSX.Element {
  const t = useTranslator(dictionary)
  const api = useReviewApi()
  const review = useReview()
  const bases = useQuery(() => api.bases(props.placementId))
  const offer = createMemo(() => {
    const kind = review.scope().kind
    if (kind === "branch" || kind === "branchWorktree" || kind === "range") return undefined
    return bases.data?.defaultRef
  })
  return (
    <div
      data-testid="review-empty"
      class="flex flex-col items-center gap-3 px-3 py-6 text-center text-sm text-text-muted"
    >
      <span>{t("review.empty")}</span>
      <Show when={offer()}>
        {(base) => (
          <Button variant="outline" size="small" onClick={() => review.setScope({ kind: "branch", base: base() })}>
            {t("review.showBranchDiff", { base: base() })}
          </Button>
        )}
      </Show>
    </div>
  )
}
