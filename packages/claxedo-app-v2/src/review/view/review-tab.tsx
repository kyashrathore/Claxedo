import { createEffect, createMemo, createSignal, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useTranslator, type DomainTranslate } from "@/i18n"
import { useServer, type DiffSummary, type GitRefs, type PlacementId } from "@/server"
import { ReviewCodeView, type ReviewCodeViewRevealTarget } from "@/transcript"
import { ClaxedoLogo as Mark, DelayedLoading, ScrollThumb, Spinner } from "@/ui"
import { useReviewApi } from "../api"
import { useReviewComments } from "../comments"
import { createDiffContent } from "../diff-content"
import { useErrorText } from "../errors"
import { dictionary, type ReviewKey } from "../i18n"
import { isBaseReviewMode, scopeOf, selectionOf, type ReviewSelection } from "../intent"
import { useReview } from "../store"
import { createCodeViewComments } from "./code-view-comments"
import { ReviewCodeViewFileHeader, ReviewRowBody } from "./review-file-row"
import { ReviewToolbar } from "./review-toolbar"

export type ReviewFocus = { readonly path: string; readonly version: number }

export type ReviewTabProps = {
  readonly placementId: PlacementId
  readonly focus?: ReviewFocus
  readonly onOpenFile: (path: string) => void
}

const EMPTY_REFS: GitRefs = { branches: [], tags: [], recent: [] }

type Translate = DomainTranslate<ReviewKey>

function scopeTooltip(t: Translate, selection: ReviewSelection, branch: string | undefined): string {
  const onBranch = (label: string) =>
    branch && branch !== "HEAD" ? t("review.label.onBranch", { label, branch }) : label
  switch (selection.mode) {
    case "staged":
      return onBranch(t("review.label.staged"))
    case "unstaged":
      return onBranch(t("review.label.unstaged"))
    case "uncommitted":
      return onBranch(t("review.label.uncommitted"))
    case "to-from":
      return t("review.label.range", { from: selection.fromRef, to: selection.toRef })
    case "branch":
      return onBranch(t("review.label.branch", { ref: selection.fromRef }))
    case "branch-worktree":
      return t("review.label.withUncommitted", {
        label: onBranch(t("review.label.branchWorktree", { ref: selection.fromRef })),
      })
  }
}

function useDiffStyleKey(): void {
  const review = useReview()
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() !== "d" || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))
    )
      return
    const panel = document.getElementById("review-panel")
    if (!panel || panel.getAttribute("aria-hidden") === "true") return
    const rect = panel.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    event.preventDefault()
    review.setStyle(review.style() === "split" ? "unified" : "split")
  }
  window.addEventListener("keydown", onKeyDown)
  onCleanup(() => window.removeEventListener("keydown", onKeyDown))
}

function ReviewLoading(): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <div class="relative flex-1 min-h-0 overflow-hidden">
      <div
        data-testid="review-pane-loading"
        class="h-full px-6 pb-42 flex flex-col items-center justify-center text-center gap-3"
      >
        <DelayedLoading>
          <Spinner class="h-5 w-5 text-text-weak" />
          <div class="text-13-regular text-text-weak">{t("review.loadingReview")}</div>
        </DelayedLoading>
      </div>
    </div>
  )
}

function ReviewEmpty(props: { readonly placementId: PlacementId; readonly selection: ReviewSelection }): JSX.Element {
  const t = useTranslator(dictionary)
  const api = useReviewApi()
  const server = useServer()
  const review = useReview()
  const bases = useQuery(() => api.bases(props.placementId))
  const directory = () => server.placements.byId(props.placementId)?.path
  const offer = () => {
    const mode = props.selection.mode
    return mode === "to-from" || isBaseReviewMode(mode) ? undefined : bases.data?.defaultRef
  }
  return (
    <div class="relative flex-1 min-h-0 overflow-hidden">
      <div
        data-testid="review-pane-empty"
        class="h-full px-6 pb-42 flex flex-col items-center justify-center text-center gap-4"
      >
        <Mark class="w-14 opacity-10" />
        <div class="text-14-regular text-text-weak max-w-72">{t("review.emptyMode")}</div>
        <Show when={offer()}>
          {(ref) => (
            <button
              type="button"
              data-testid="review-pane-empty-show-branch-diff"
              class="rounded-md border border-border-weak-base bg-surface-base px-3 py-1.5 text-12-medium text-text-base hover:bg-surface-base-hover transition-colors"
              onClick={() => review.setScope({ kind: "branch", base: ref() })}
            >
              {t("review.showBranchDiff")} <span class="font-mono">{ref()}</span>
            </button>
          )}
        </Show>
        <div class="text-11-regular font-mono text-text-weak/50 max-w-full break-all">
          <Show when={directory()} fallback={t("review.noDirectory")}>
            {(path) => t("review.directory", { directory: path() })}
          </Show>
        </div>
      </div>
    </div>
  )
}

function ReviewDiffList(props: {
  readonly placementId: PlacementId
  readonly summaries: readonly DiffSummary[]
  readonly reveal: ReviewCodeViewRevealTarget | null
  readonly onRevealed: () => void
  readonly onOpenFile: (path: string) => void
}): JSX.Element {
  const review = useReview()
  const comments = useReviewComments()
  const errorText = useErrorText()
  const content = createDiffContent({
    placementId: props.placementId,
    scope: review.scope,
    summaries: () => props.summaries,
    forced: review.forced,
  })
  const codeViewComments = createCodeViewComments({ comments, diffs: content.diffs })
  const [frame, setFrame] = createSignal<HTMLDivElement>()
  const [scroller, setScroller] = createSignal<HTMLDivElement>()
  return (
    <div
      ref={setFrame}
      class="relative h-full min-h-0"
      data-review-diff-style={review.style()}
      data-review-open-diff-count={review.open().length}
    >
      <ReviewCodeView
        class="claxedo-workspace-review h-full [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        scrollRef={setScroller}
        diffs={content.diffs()}
        diffStyle={review.style()}
        open={review.open()}
        focusedFile={props.reveal?.file}
        renderHeader={(file, active) => (
          <ReviewCodeViewFileHeader
            diffs={props.summaries}
            file={file}
            onViewFile={props.onOpenFile}
            showControls={active}
          />
        )}
        onToggleOpen={review.toggleOpen}
        comments={comments.enabled() ? codeViewComments : undefined}
        selectedLines={comments.enabled() ? codeViewComments.selectedLines() : null}
        revealTarget={props.reveal}
        onRevealed={props.onRevealed}
        onDiffContentRequired={content.request}
        customFiles={content.custom()}
        renderCustomBody={(file) => {
          const body = content.body(file)
          return (
            <ReviewRowBody
              file={file}
              media={body.media}
              guarded={body.guarded}
              deleted={body.deleted}
              content={body.content}
              changedLines={body.changedLines}
              onRenderAnyway={review.force}
              error={body.error ? errorText(body.error) : undefined}
              onRetry={body.retry}
            />
          )
        }}
      />
      <ScrollThumb scroller={scroller()} hoverTarget={frame()} />
    </div>
  )
}

export function ReviewTab(props: ReviewTabProps): JSX.Element {
  const t = useTranslator(dictionary)
  const api = useReviewApi()
  const review = useReview()
  const diff = useQuery(() => api.diff(props.placementId, review.scope()))
  const status = useQuery(() => api.status(props.placementId))
  const bases = useQuery(() => api.bases(props.placementId))
  const refs = useQuery(() => api.refs(props.placementId))
  const summaries = () => diff.data ?? []
  const selection = createMemo(() => selectionOf(review.scope()))
  const totals = createMemo(() =>
    summaries().reduce(
      (sum, entry) => ({ additions: sum.additions + entry.additions, deletions: sum.deletions + entry.deletions }),
      { additions: 0, deletions: 0 },
    ),
  )
  const [reveal, setReveal] = createSignal<ReviewCodeViewRevealTarget | null>(null)
  createEffect(
    on(
      () => props.focus,
      (focus) => {
        if (!focus) return
        review.expand(focus.path)
        setReveal({ file: focus.path })
      },
    ),
  )
  useDiffStyleKey()
  return (
    <>
      <ReviewToolbar
        mode={selection().mode}
        fromRef={selection().fromRef}
        toRef={selection().toRef}
        currentBranch={status.data?.branch}
        defaultBaseRef={bases.data?.defaultRef}
        refs={refs.data ?? EMPTY_REFS}
        onApplyMode={(mode, fromRef, toRef) => review.setScope(scopeOf(mode, fromRef, toRef))}
        hasReview={summaries().length > 0}
        loading={diff.isFetching}
        reviewCount={summaries().length}
        totalChanges={totals()}
        scopeLabel={scopeTooltip(t, selection(), status.data?.branch)}
        hasExpandedDiffs={review.open().length > 0}
        onToggleAllDiffs={() => review.setOpen(review.open().length > 0 ? [] : summaries().map((entry) => entry.file))}
        diffStyle={review.style()}
        onSetDiffStyle={review.setStyle}
      />
      <Switch fallback={<ReviewEmpty placementId={props.placementId} selection={selection()} />}>
        <Match when={diff.isPending}>
          <ReviewLoading />
        </Match>
        <Match when={summaries().length > 0}>
          <ReviewDiffList
            placementId={props.placementId}
            summaries={summaries()}
            reveal={reveal()}
            onRevealed={() => setReveal(null)}
            onOpenFile={props.onOpenFile}
          />
        </Match>
      </Switch>
    </>
  )
}
