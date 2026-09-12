import {
  Show,
  Match,
  Switch,
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"

import { useLanguage } from "@/platform/i18n/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { selectionFromLines } from "@/platform/files/types"
import { useFile, usePrompt, useSDK } from "@/features/review/app-ports"
import {
  cloneReviewSurfaceState,
  restoredOpenDiffs,
  type ReviewSurfaceState,
} from "@/features/review/review-surface-state"
import { useComments } from "@/platform/comments/provider"
import {
  ClaxedoSessionReview,
  type SessionReviewCommentActions,
  type SessionReviewCommentDelete,
  type SessionReviewCommentUpdate,
  type SessionReviewLineComment,
} from "./review-session"
import { ReviewCodeView } from "@/ui/session-kit"
import { ReviewCodeViewFileHeader } from "./review-file-header"
import { diffTriggerTestId } from "./review-session-logic"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ClaxedoLogo as Mark } from "@/ui/controls/claxedo-logo"
import type {
  AgentFileContent as FileContent,
  AgentVcsFileDiff as VcsFileDiff,
} from "@claxedo/agent-runtime-contract"
import { workspaceVcsQuery } from "@/platform/runtime/workspace-query"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { createReviewDiffClient, normalizeVcsStatus, reviewVcsDiffSummaryQueryOptions, type RawVcsFileDiff } from "./review-vcs-load"
import { createReviewSelection, type ReviewMode } from "@/features/review/review-intent"
import { ReviewToolbar, type VcsRefs } from "./review-toolbar"
import { reviewToggleAllAction } from "./review-toggle-all"
import { reviewLoadedDiffIdentity } from "./review-loaded-diff-identity"
import {
  cachedReviewVcsFile,
  cachedReviewVcsRefs,
  cachedReviewVcsTargets,
  invalidateReviewVcsDirectory,
  updateCachedReviewVcsDiff,
} from "./review-vcs-cache"
import { reviewDiffsReady, reviewShouldShowLoadingPane } from "./review-loading-state"
import { afterVisibleWork } from "./review-deferred-work"
import { warmDiffHighlightWorkerPool } from "@/ui/session-kit-loaders"
import { callEventHandler } from "@/ui/event-handler"


export type ReviewTabProps = {
  directory: string
  sessionId: string
  initialMode: ReviewMode
  initialFromRef?: string
  initialToRef?: string
  /**
   * Review state retained across a panel disposal. Takes precedence over the
   * `initial*` props, which describe how a review opens for the first time.
   */
  retained?: ReviewSurfaceState
  onRetainedChange?: (state: ReviewSurfaceState) => void
  /** Semantic scroll anchor the workspace's restoration will target. */
  scrollAnchorPath?: string
  focusedDiffPath?: string
  focusedDiffVersion?: number
  /** Applied with the focus: the mode whose diff the focused file is revealed in. */
  focusedDiffMode?: ReviewMode
  onOpenFile: (path: string) => void
  /** Forwarded verbatim to the review surfaces; see `ReviewSessionProps.scrollRef`. */
  scrollRef?: (el: HTMLElement) => void
  onScroll?: JSX.EventHandlerUnion<HTMLDivElement, Event>
}

function vcsDiffCacheKey(directory: string, mode: string, fromRef?: string, toRef?: string) {
  return [directory, mode, fromRef ?? "", toRef ?? ""].join("\0")
}

function hasDiffContent(diff: RawVcsFileDiff) {
  return typeof diff.patch === "string" || typeof diff.before === "string" || typeof diff.after === "string"
}

function initialDiffStyle(): "unified" | "split" {
  return "unified"
}

// Stage-1 spike (build-time flag): render the review corpus through Pierre's
// CodeView document engine instead of the accordion list. Measurement gate:
// the heavy-workspace benchmark ladder. Comments/gutter/custom headers are
// out of scope until the spike's numbers justify stage 2.
const REVIEW_CODEVIEW_SPIKE = import.meta.env.VITE_REVIEW_CODEVIEW === "1"

export function ReviewTab(props: ReviewTabProps) {
  const comments = useComments()
  const file = useFile()
  const language = useLanguage()
  const prompt = usePrompt()
  const sdk = useSDK()
  const platform = usePlatform()
  const signedWorkspace = createMemo(() => sdk.workspace?.(props.directory))
  const vcsInfoQuery = useQuery(() => ({
    ...workspaceVcsQuery({
      baseUrl: sdk.url,
      directory: props.directory,
      request: platform.fetch,
      workspaceId: signedWorkspace()?.workspaceId,
      workspace: signedWorkspace(),
      signedControlPlane: !!signedWorkspace(),
      client: sdk.createClient({ directory: props.directory }),
    }),
    enabled: !!props.directory,
  }))
  const vcsInfo = () => vcsInfoQuery.data

  // Read once: this is where a reopened panel picks its review back up when
  // the pane has no persisted selection yet.
  const retained = cloneReviewSurfaceState(props.retained ?? {})
  const [defaultBranchRef, setDefaultBranchRef] = createSignal<string | undefined>()
  const review = createReviewSelection({
    scope: () => ({ directory: props.directory, sessionId: props.sessionId }),
    fallback: () => ({
      mode: retained.mode ?? props.initialMode,
      fromRef: retained.fromRef ?? props.initialFromRef,
      toRef: retained.toRef ?? props.initialToRef,
    }),
  })
  const activeMode = () => review.selection().mode
  const activeFromRef = () => review.selection().fromRef ?? defaultBranchRef() ?? "HEAD~1"
  const activeToRef = () => review.selection().toRef ?? "HEAD"
  const setReviewMode = (mode: ReviewMode, fromRef = activeFromRef(), toRef = activeToRef()) =>
    review.set({ mode, fromRef, toRef })

  // Deferred: the selection already covers the opening props, and running
  // these on mount would overwrite a persisted selection with the opening one.
  createEffect(on(() => props.initialMode, (mode) => setReviewMode(mode), { defer: true }))
  createEffect(on(() => props.initialFromRef, (fromRef) => { if (fromRef) setReviewMode(activeMode(), fromRef) }, { defer: true }))
  createEffect(on(() => props.initialToRef, (toRef) => { if (toRef) setReviewMode(activeMode(), activeFromRef(), toRef) }, { defer: true }))

  const claxedoServerUrl = getClaxedoServerUrl()
  const diffClient = createMemo(() => createReviewDiffClient({
    serverUrl: claxedoServerUrl,
    directory: props.directory,
    request: platform.fetch,
    workspaceId: signedWorkspace()?.workspaceId,
    workspace: signedWorkspace(),
  }))

  const [vcsRefs, setVcsRefs] = createSignal<VcsRefs>({ branches: [], tags: [], recent: [] })
  createEffect(() => {
    if (!props.directory) return
    const stop = afterVisibleWork(() => {
      void cachedReviewVcsRefs({
        directory: props.directory,
        load: () => diffClient().refs(props.directory),
      })
      .then((data) => setVcsRefs(data))
      .catch(() => {})
      void cachedReviewVcsTargets({
        directory: props.directory,
        load: () => diffClient().targets(props.directory),
      })
        .then((data: { defaultRef?: string }) => {
          if (data.defaultRef) setDefaultBranchRef(data.defaultRef)
        })
        .catch(() => {})
    })
    onCleanup(stop)
  })

  const [store, setStore] = createStore({
    openDiffs: [] as string[],
    diffStyle: (retained.diffStyle ?? initialDiffStyle()),
    focusedFile: retained.focusedFile,
    forcedDiffPaths: retained.forcedDiffPaths ?? [],
  })
  const [renderedHunks, setRenderedHunks] = createSignal(0)

  /** The review target: which changed-file set this surface is showing. */
  const diffTarget = createMemo(() => {
    const mode = activeMode()
    return {
      directory: props.directory,
      mode,
      fromRef: mode === "to-from" ? activeFromRef().trim() || undefined : undefined,
      toRef: mode === "to-from" ? activeToRef().trim() || undefined : undefined,
    }
  })
  const diffKey = createMemo(() => {
    const target = diffTarget()
    return vcsDiffCacheKey(target.directory, target.mode, target.fromRef, target.toRef)
  })

  // An observer, not a fetch: the changed-file set belongs to the worktree, and
  // `WorkspaceVcsCacheHonesty` invalidates it from the runtime's event stream.
  // A surface holding its own copy could not be reached by that invalidation,
  // so a change landing while the review was on screen left it showing the
  // corpus it had already loaded.
  const diffQuery = useQuery(() => ({
    ...reviewVcsDiffSummaryQueryOptions({ client: diffClient(), ...diffTarget() }),
    enabled: !!props.directory,
  }))
  const remoteDiffs = createMemo((): VcsFileDiff[] => diffQuery.data ?? [])

  /**
   * The corpus as it stands, read outside the reactive graph: the callers are
   * the callbacks a file fetch resolves into, which must compare against the
   * target that started them rather than subscribe to the one on screen now.
   */
  const currentDiffState = () => untrack(() => ({
    target: diffTarget(),
    key: diffKey(),
    diffs: remoteDiffs(),
  }))

  const fetchVcsFileDiff = async (file: string, mode: string, from?: string, to?: string) => {
    return cachedReviewVcsFile({
      directory: props.directory,
      mode,
      file,
      fromRef: from,
      toRef: to,
      load: () => diffClient()
        .vcsFile({ directory: props.directory, mode, file, fromRef: from, toRef: to })
        .then((data) => {
          if (!data) return undefined
          return { ...data, status: normalizeVcsStatus(data.status) } as Partial<VcsFileDiff> & { file: string }
        }),
    })
  }

  // The cached row is the one the surface renders, so a file's fetched content
  // is merged into the cache rather than into a copy of it. A target the user
  // has since moved off writes nothing: its rows are no longer on screen and
  // the fetch that produced them was keyed to the target it started under.
  const mergeVcsFileDiff = (
    key: string,
    file: string,
    diff: Partial<VcsFileDiff> & { file: string } | undefined,
  ) => {
    const { target, key: onScreenKey } = currentDiffState()
    if (!diff || onScreenKey !== key) return
    updateCachedReviewVcsDiff({
      ...target,
      file,
      update: (current) => ({ ...current, ...diff }),
    })
  }

  const loadRequiredVcsDiffContent = (files: string[]) => {
    if (diffQuery.isPending) return
    const { target, key, diffs: corpus } = currentDiffState()

    for (const file of files) {
      const diff = corpus.find((item) => item.file === file)
      if (!diff || hasDiffContent(diff as RawVcsFileDiff)) continue
      void fetchVcsFileDiff(file, target.mode, target.fromRef, target.toRef)
        .then((next) => mergeVcsFileDiff(key, file, next))
    }
  }

  // A branch move the runtime never announced: the diff cache is keyed by mode
  // and refs, not by the commit those refs point at, so every mode's entry for
  // this worktree is now describing the old HEAD.
  createEffect(
    on(
      () => [vcsInfo()?.branch, vcsInfo()?.default_branch] as const,
      (next, prev) => {
        if (prev === undefined) return
        if (next[0] === prev[0] && next[1] === prev[1]) return
        invalidateReviewVcsDirectory({ directory: props.directory })
      },
      { defer: true },
    ),
  )

  const diffs = remoteDiffs
  // A corpus on screen is a promise that some row will be expanded. Build the
  // highlighter's workers now, while the surface is idle, instead of inside
  // the expand click — see `warmDiffHighlightWorkerPool`.
  createEffect(() => {
    if (diffs().length === 0) return
    const style = store.diffStyle
    const stop = afterVisibleWork(() => warmDiffHighlightWorkerPool(style))
    onCleanup(stop)
  })
  const hasReview = createMemo(() => diffs().length > 0)
  const reviewCount = createMemo(() => diffs().length)
  const totalChanges = createMemo(() => {
    const diffList = diffs()
    return {
      additions: diffList.reduce((acc, diff) => acc + (diff.additions ?? 0), 0),
      deletions: diffList.reduce((acc, diff) => acc + (diff.deletions ?? 0), 0),
    }
  })
  const diffScopeLabel = createMemo(() => {
    const branch = vcsInfo()?.branch
    const branchLabel = branch && branch !== "HEAD" ? ` on ${branch}` : ""
    if (activeMode() === "staged") return `staged changes${branchLabel}`
    if (activeMode() === "unstaged") return `unstaged changes${branchLabel}`
    if (activeMode() === "uncommitted") return `uncommitted changes${branchLabel}`
    if (activeMode() === "to-from") return `${activeFromRef()} -> ${activeToRef()}`
    return `uncommitted changes${branchLabel}`
  })
  const loading = () => diffQuery.isFetching
  const diffsReady = createMemo(() => reviewDiffsReady({ loading: loading(), diffCount: diffs().length }))
  const reviewLoading = createMemo(() =>
    reviewShouldShowLoadingPane({ loading: loading(), diffCount: diffs().length })
  )
  const diffFiles = createMemo(() => diffs().map((diff) => diff.file))
  const diffFileKey = createMemo(() => diffFiles().join("\0"))
  const loadedDiffIdentity = createMemo(() => reviewLoadedDiffIdentity(diffFiles()))

  // Consumed by the first changeset this mount loads: a retained expansion
  // belongs to the review the user left, not to every later changeset.
  let pendingRetainedOpenDiffs = retained.openDiffs
  createEffect(on(diffFileKey, () => {
    const files = diffFiles()
    if (files.length === 0) return
    const focused = untrack(() => props.focusedDiffPath)
    const open = restoredOpenDiffs({ files, retained: pendingRetainedOpenDiffs, focused })
    pendingRetainedOpenDiffs = undefined
    batch(() => {
      setRenderedHunks(0)
      setStore("openDiffs", open)
    })
  }))

  // One publisher for every retained field, so the panel's working set always
  // reflects the live surface. Small UI values only — see ReviewSurfaceState.
  createEffect(() => {
    props.onRetainedChange?.({
      mode: activeMode(),
      fromRef: activeFromRef(),
      toRef: activeToRef(),
      diffStyle: store.diffStyle,
      openDiffs: [...store.openDiffs],
      focusedFile: store.focusedFile,
      forcedDiffPaths: [...store.forcedDiffPaths],
    })
  })

  const readFile = async (path: string): Promise<FileContent | undefined> => {
    await file.load(path)
    return file.get(path)?.content
  }

  const handleLineComment = (comment: SessionReviewLineComment) => {
    const saved = comments.add({
      file: comment.file,
      selection: comment.selection,
      comment: comment.comment,
    })
    const selection = selectionFromLines(comment.selection)

    prompt.context.add({
      type: "file",
      path: comment.file,
      selection,
      comment: comment.comment,
      commentID: saved.id,
      commentOrigin: "review",
      preview: comment.preview,
    })
  }

  const handleLineCommentUpdate = (comment: SessionReviewCommentUpdate) => {
    comments.update(comment.file, comment.id, comment.comment)
    prompt.context.updateComment(comment.file, comment.id, {
      comment: comment.comment,
      preview: comment.preview,
    })
  }

  const handleLineCommentDelete = (comment: SessionReviewCommentDelete) => {
    comments.remove(comment.file, comment.id)
    prompt.context.removeComment(comment.file, comment.id)
  }

  const reviewCommentActions = createMemo((): SessionReviewCommentActions => ({
    moreLabel: language.t("common.moreOptions"),
    editLabel: language.t("common.edit"),
    deleteLabel: language.t("common.delete"),
    saveLabel: language.t("common.save"),
  }))

  const scrollToFile = (path: string) => {
    const escaped = globalThis.CSS && CSS.escape ? CSS.escape(path) : path.replaceAll('"', '\\"')
    const node = document.querySelector(`[data-component="session-review"] [data-file="${escaped}"]`)
    if (!(node instanceof HTMLElement)) return
    node.scrollIntoView({ behavior: "auto", block: "start" })
  }

  // The focus this mount resumed on. Review now unmounts while another
  // workspace tab is active, so this effect runs again on every remount with
  // the same focus prop the user already acted on -- and scrolling to that file
  // would throw away the position the workspace just restored. A focus that
  // differs from the retained one is a real request and still applies.
  let resumedFocusPath = retained.focusedFile === props.focusedDiffPath ? retained.focusedFile : undefined
  createEffect(on(
    () => [props.focusedDiffVersion, props.focusedDiffPath] as const,
    ([, path]) => {
      const resumed = resumedFocusPath
      resumedFocusPath = undefined
      if (!path || path === resumed) return
      const mode = props.focusedDiffMode
      if (mode && mode !== activeMode()) setReviewMode(mode)
      batch(() => {
        setStore("focusedFile", path)
        if (!store.openDiffs.includes(path)) setStore("openDiffs", [...store.openDiffs, path])
      })
      requestAnimationFrame(() => scrollToFile(path))
    },
  ))

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "d") return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return
        if (/^(input|textarea|select)$/i.test(target.tagName)) return
      }
      const panel = document.getElementById("review-panel")
      if (!panel || panel.getAttribute("aria-hidden") === "true") return
      const rect = panel.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      event.preventDefault()
      setStore("diffStyle", store.diffStyle === "split" ? "unified" : "split")
    }
    window.addEventListener("keydown", onKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown))
  })

  return (
    <>
      <ReviewToolbar
        mode={activeMode()}
        fromRef={activeFromRef()}
        toRef={activeToRef()}
        currentBranch={vcsInfo()?.branch ?? undefined}
        vcsRefs={vcsRefs()}
        onApplyMode={setReviewMode}
        hasReview={hasReview()}
        loading={loading()}
        reviewCount={reviewCount()}
        totalChanges={totalChanges()}
        scopeLabel={diffScopeLabel()}
        hasExpandedDiffs={reviewToggleAllAction(store.openDiffs.length) === "collapse"}
        onToggleAllDiffs={() => {
          if (store.openDiffs.length > 0) {
            setStore("openDiffs", [])
            return
          }
          setStore("openDiffs", diffFiles())
        }}
        diffStyle={store.diffStyle}
        onSetDiffStyle={(style) => setStore("diffStyle", style)}
      />

      <Switch>
        <Match when={reviewLoading()}>
          <div class="relative flex-1 min-h-0 overflow-hidden">
            <div
              data-testid="review-pane-loading"
              class="h-full px-6 pb-42 flex flex-col items-center justify-center text-center gap-3"
            >
              <Spinner class="h-5 w-5 text-text-weak" />
              <div class="text-13-regular text-text-weak">
                Loading review{language.t("common.loading.ellipsis")}
              </div>
            </div>
          </div>
        </Match>
        <Match when={hasReview()}>
          <Show
            when={diffsReady()}
            fallback={
              <div class="px-3 py-2 text-12-regular text-text-weak">
                {language.t("common.loading")}{language.t("common.loading.ellipsis")}
              </div>
            }
          >
            <div
              class="contents"
              data-review-diff-style={store.diffStyle}
              data-review-rendered-hunks={renderedHunks()}
              data-review-open-diff-count={store.openDiffs.length}
              data-review-loaded-diff-count={diffFiles().length}
              data-review-loaded-diff-identity={loadedDiffIdentity()}
            >
              {REVIEW_CODEVIEW_SPIKE ? (
                <ReviewCodeView
                  class="claxedo-workspace-review h-full"
                  diffs={diffs()}
                  diffStyle={store.diffStyle}
                  open={store.openDiffs}
                  focusedFile={store.focusedFile}
                  headerTestId={diffTriggerTestId}
                  renderHeader={(file) => (
                    <ReviewCodeViewFileHeader diffs={diffs()} file={file} onViewFile={props.onOpenFile} />
                  )}
                  onToggleOpen={(file) =>
                    setStore(
                      "openDiffs",
                      store.openDiffs.includes(file)
                        ? store.openDiffs.filter((path) => path !== file)
                        : [...store.openDiffs, file],
                    )
                  }
                  scrollRef={props.scrollRef}
                  onScrollEvent={(event) => callEventHandler(props.onScroll, event)}
                  onDiffRendered={() => setRenderedHunks((count) => count + 1)}
                />
              ) : (
              <ClaxedoSessionReview
                diffs={diffs()}
                diffStyle={store.diffStyle}
                onDiffStyleChange={(style) => setStore("diffStyle", style)}
                comments={comments.all()}
                focusedComment={comments.focus()}
                onFocusedCommentChange={comments.setFocus}
                open={store.openDiffs}
                onOpenChange={(open) => setStore("openDiffs", open)}
                forcedFiles={store.forcedDiffPaths}
                onForcedFilesChange={(files) => setStore("forcedDiffPaths", files)}
                anchorFile={props.scrollAnchorPath}
                onDiffContentRequired={loadRequiredVcsDiffContent}
                onDiffRendered={() => setRenderedHunks((count) => count + 1)}
                readFile={readFile}
                onLineComment={handleLineComment}
                onLineCommentUpdate={handleLineCommentUpdate}
                onLineCommentDelete={handleLineCommentDelete}
                lineCommentActions={reviewCommentActions()}
                onViewFile={props.onOpenFile}
                scrollRef={props.scrollRef}
                onScroll={props.onScroll}
                focusedFile={store.focusedFile}
                title=""
                classes={{
                  root: "claxedo-workspace-review pb-6",
                  header: "px-3 !hidden",
                  container: "",
                }}
              />
              )}
            </div>
          </Show>
        </Match>
        <Match when={true}>
          <div class="relative flex-1 min-h-0 overflow-hidden">
            <div
              data-testid="review-pane-empty"
              class="h-full px-6 pb-42 flex flex-col items-center justify-center text-center gap-4"
            >
              <Mark class="w-14 opacity-10" />
              <div class="text-14-regular text-text-weak max-w-72">
                No changes for this review mode
              </div>
              {/* When uncommitted is empty but the branch
                  is ahead of its tracking ref, the user almost always
                  wants to see the branch diff. Offer a one-click
                  switch into to-from mode targeting the resolved
                  default ref. */}
              <Show when={defaultBranchRef() && activeMode() !== "to-from"}>
                <button
                  type="button"
                  data-testid="review-pane-empty-show-branch-diff"
                  class="rounded-md border border-border-weak-base bg-surface-base px-3 py-1.5 text-12-medium text-text-base hover:bg-surface-base-hover transition-colors"
                  onClick={() => {
                    const ref = defaultBranchRef()
                    if (!ref) return
                    setReviewMode("to-from", ref, "HEAD")
                  }}
                >
                  Show branch diff vs <span class="font-mono">{defaultBranchRef()}</span>
                </button>
              </Show>
              {/* Diagnostic strip: dir + server URL so the user can
                  tell at a glance whether the panel is bound to the
                  right repo and whether the backend is reachable. */}
              <div class="text-11-regular font-mono text-text-weak/50 max-w-full break-all">
                <Show when={props.directory} fallback="no directory bound to this panel">
                  dir: {props.directory}
                </Show>
              </div>
              <div class="text-11-regular font-mono text-text-weak/40 max-w-full break-all">
                via {claxedoServerUrl || "(no claxedo-server url configured)"}
              </div>
            </div>
          </div>
        </Match>
      </Switch>
    </>
  )
}
