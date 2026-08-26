import {
  Show,
  Match,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  createStore,
  onCleanup,
  storePath,
  untrack,
} from "solid-js"
import type { JSX } from "@solidjs/web"

import { useLanguage } from "@/platform/i18n/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { BP_MD } from "@/ui/controls/breakpoints"
import { selectionFromLines } from "@/platform/files/types"
import {
  createPanePreferences,
  reviewModePreferenceScope,
  useFile,
  usePrompt,
  useSDK,
} from "@/features/review/app-ports"
import {
  cloneReviewSurfaceState,
  restoredOpenDiffs,
  type ReviewDiffStyle,
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
import type { FileContent, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { queryClient } from "@/platform/query/query-client"
import { workspaceVcsQuery } from "@/platform/runtime/workspace-query"
import { getClaxedoServerUrl } from "@/platform/api/api"
import {
  createReviewDiffClient,
  fetchReviewVcsDiffSummary,
  normalizeVcsStatus,
  type RawVcsFileDiff,
} from "./review-vcs-load"
import { type ReviewMode } from "@/features/review/review-intent"
import { ReviewToolbar, type VcsRefs } from "./review-toolbar"
import {
  peekReviewVcsDiff,
  cachedReviewVcsFile,
  cachedReviewVcsRefs,
  cachedReviewVcsTargets,
  updateCachedReviewVcsDiff,
} from "./review-vcs-cache"
import { initialReviewOpenDiffs } from "./review-open-diffs"
import { reviewDiffsReady, reviewShouldShowLoadingPane } from "./review-loading-state"
import { afterVisibleWork } from "./review-deferred-work"
import { warmDiffHighlightWorkerPool } from "@/ui/session-kit-loaders"

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
  /**
   * Bumped by the workspace when a runtime event stales this review. The
   * workspace owns that subscription because it outlives this surface, which
   * unmounts whenever another workspace tab is active.
   */
  staleDiffsVersion?: number
  staleBranchVersion?: number
  focusedDiffPath?: string
  focusedDiffVersion?: number
  onOpenFile: (path: string) => void
  scrollRef?: (el: HTMLDivElement) => void
  onScroll?: JSX.EventHandlerUnion<HTMLDivElement, Event>
}

function vcsDiffCacheKey(directory: string, mode: string, fromRef?: string, toRef?: string) {
  return [directory, mode, fromRef ?? "", toRef ?? ""].join("\0")
}

function hasDiffContent(diff: RawVcsFileDiff) {
  return typeof diff.patch === "string" || typeof diff.before === "string" || typeof diff.after === "string"
}

function initialDiffStyle() {
  if (typeof window !== "undefined" && window.innerWidth < BP_MD) return "unified"
  return "split"
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
  const panePreferences = createMemo(() => createPanePreferences(localStorage))
  const reviewModeScope = createMemo(() =>
    reviewModePreferenceScope({
      directory: props.directory,
      sessionId: props.sessionId,
    }),
  )
  const [vcsInfo, setVcsInfo] = createSignal<{ branch?: string | null; default_branch?: string | null }>()
  const loadVcsInfo = (directory = props.directory) =>
    queryClient
      .fetchQuery(
        workspaceVcsQuery({
          baseUrl: sdk.url,
          directory,
          request: platform.fetch,
          workspaceId: signedWorkspace()?.workspaceId,
          workspace: signedWorkspace(),
          signedControlPlane: !!signedWorkspace(),
          client: sdk.createClient({ directory }),
        }),
      )
      .then((info) => setVcsInfo(info))
      .catch(() => {})

  createEffect(
    () => props.directory,
    (directory) => {
      if (!directory) return
      return afterVisibleWork(() => void loadVcsInfo(directory))
    },
  )

  // Read once: this is where a reopened panel picks its review back up. Later
  // prop changes still win through the effects below.
  const retained = untrack(() => cloneReviewSurfaceState(props.retained ?? {}))
  const [activeMode, setActiveMode] = createSignal<ReviewMode>(untrack(() => retained.mode ?? props.initialMode))
  const [activeFromRef, setActiveFromRef] = createSignal(
    untrack(() => retained.fromRef ?? props.initialFromRef ?? "HEAD~1"),
  )
  const [activeToRef, setActiveToRef] = createSignal(untrack(() => retained.toRef ?? props.initialToRef ?? "HEAD"))

  // Deferred: the signals above already hold the initial props, and running
  // these on mount would overwrite a retained mode with the opening one.
  createEffect(
    () => props.initialMode,
    (mode) => {
      setActiveMode(mode)
    },
    { defer: true },
  )
  createEffect(
    () => props.initialFromRef,
    (fromRef) => {
      if (fromRef) setActiveFromRef(fromRef)
    },
    { defer: true },
  )
  createEffect(
    () => props.initialToRef,
    (toRef) => {
      if (toRef) setActiveToRef(toRef)
    },
    { defer: true },
  )

  const syncReviewState = (mode = activeMode()) => {
    panePreferences().set("reviewMode", reviewModeScope(), mode)
  }

  const setReviewMode = (mode: ReviewMode, fromRef = activeFromRef(), toRef = activeToRef()) => {
    setActiveFromRef(fromRef)
    setActiveToRef(toRef)
    setActiveMode(mode)
    syncReviewState(mode)
  }

  createEffect(
    () => [activeMode(), activeFromRef(), activeToRef()] as const,
    ([mode, fromRef, toRef], prev) => {
      if (prev && prev[0] === mode && prev[1] === fromRef && prev[2] === toRef) return
      syncReviewState(mode)
    },
    { defer: true },
  )

  const claxedoServerUrl = getClaxedoServerUrl()
  const diffClient = createMemo(() =>
    createReviewDiffClient({
      serverUrl: claxedoServerUrl,
      directory: props.directory,
      request: platform.fetch,
      workspaceId: signedWorkspace()?.workspaceId,
      workspace: signedWorkspace(),
    }),
  )

  const fetchVcsDiff = async (
    mode: string,
    fromRef?: string,
    toRef?: string,
    directory = props.directory,
    options?: { force?: boolean },
  ) => {
    return fetchReviewVcsDiffSummary({
      client: diffClient(),
      directory,
      mode,
      fromRef,
      toRef,
      force: options?.force,
    })
  }

  const [vcsRefs, setVcsRefs] = createSignal<VcsRefs>({ branches: [], tags: [], recent: [] })
  // Cache the resolved default-ref so the empty-state
  // CTA ("Show branch diff vs <ref>") can fire even before the
  // dropdown is opened.
  const [defaultBranchRef, setDefaultBranchRef] = createSignal<string | undefined>()
  createEffect(
    () => props.directory,
    (directory) => {
      if (!directory) return
      return afterVisibleWork(() => {
        void cachedReviewVcsRefs({
          directory,
          load: () => diffClient().refs(directory),
        })
          .then((data) => setVcsRefs(data))
          .catch(() => {})
        void cachedReviewVcsTargets({
          directory,
          load: () => diffClient().targets(directory),
        })
          .then((data: { defaultRef?: string }) => {
            if (data.defaultRef) {
              setDefaultBranchRef(data.defaultRef)
              // Reads then writes activeFromRef; the effect phase is untracked, so
              // this seeding cannot re-trigger the effect that performed it.
              if (activeFromRef() === "HEAD~1") setActiveFromRef(data.defaultRef)
            }
          })
          .catch(() => {})
      })
    },
  )

  // Seed the first render from the shared cache: a review remounting after a
  // panel disposal (or a tab switch) paints its corpus in the mount pass
  // instead of sitting empty until the deferred load runs. The deferred load
  // still runs and no-ops on a matching key; the workspace-level staleness
  // watcher already dropped this entry if anything changed while unmounted.
  // Component setup is not a tracking scope, so these are plain one-time reads
  // of the freshly seeded mode/ref signals.
  const seededTarget = {
    directory: props.directory,
    mode: activeMode(),
    fromRef: activeMode() === "to-from" ? activeFromRef().trim() || undefined : undefined,
    toRef: activeMode() === "to-from" ? activeToRef().trim() || undefined : undefined,
  }
  const seededDiffKey = vcsDiffCacheKey(
    seededTarget.directory,
    seededTarget.mode,
    seededTarget.fromRef,
    seededTarget.toRef,
  )
  const seededDiffs = peekReviewVcsDiff(seededTarget)
  const [store, setStore] = createStore({
    openDiffs: [] as string[],
    loadedDiffs: [] as string[],
    diffStyle: (retained.diffStyle ?? initialDiffStyle()) as ReviewDiffStyle,
    focusedFile: retained.focusedFile,
    forcedDiffPaths: retained.forcedDiffPaths ?? [],
    loading: false,
    remoteDiffKey: seededDiffs ? seededDiffKey : "",
    remoteDiffs: (seededDiffs ?? []) as VcsFileDiff[],
  })
  const [renderedHunks, setRenderedHunks] = createSignal(0)

  const activeDiffRefs = () => {
    const mode = untrack(activeMode)
    return {
      mode,
      from: mode === "to-from" ? untrack(activeFromRef).trim() || undefined : undefined,
      to: mode === "to-from" ? untrack(activeToRef).trim() || undefined : undefined,
    }
  }

  let vcsRun = 0
  let vcsTask: Promise<void> | undefined

  const loadVcsDiffs = (force = false) => {
    const { mode, from, to } = activeDiffRefs()
    const key = vcsDiffCacheKey(props.directory, mode, from, to)

    if (!force && !store.loading && store.remoteDiffKey === key) {
      return
    }
    const run = ++vcsRun

    setStore(storePath("loading", true))
    if (store.remoteDiffKey !== key) {
      setStore(storePath("remoteDiffKey", key))
      setStore(storePath("remoteDiffs", []))
    }
    const task = fetchVcsDiff(mode, from, to, props.directory, { force })
      .then((diffs) => {
        if (vcsRun !== run) return
        setStore(storePath("remoteDiffKey", key))
        setStore(storePath("remoteDiffs", diffs))
      })
      .catch(() => {
        if (vcsRun !== run) return
        if (store.remoteDiffKey === key && store.remoteDiffs.length > 0) return
        setStore(storePath("remoteDiffKey", key))
        setStore(storePath("remoteDiffs", []))
      })
      .finally(() => {
        if (vcsRun !== run) return
        setStore(storePath("loading", false))
        if (vcsTask === task) vcsTask = undefined
      })

    vcsTask = task
  }

  const fetchVcsFileDiff = async (file: string, mode: string, from?: string, to?: string) => {
    return cachedReviewVcsFile({
      directory: props.directory,
      mode,
      file,
      fromRef: from,
      toRef: to,
      load: () =>
        diffClient()
          .vcsFile({ directory: props.directory, mode, file, fromRef: from, toRef: to })
          .then((data) => {
            if (!data) return undefined
            return { ...data, status: normalizeVcsStatus(data.status) } as Partial<VcsFileDiff> & { file: string }
          }),
    })
  }

  const mergeVcsFileDiff = (
    diffKey: string,
    file: string,
    diff: (Partial<VcsFileDiff> & { file: string }) | undefined,
  ) => {
    if (!diff || store.remoteDiffKey !== diffKey) return
    const index = store.remoteDiffs.findIndex((item) => item.file === file)
    if (index === -1) return

    const next = { ...store.remoteDiffs[index], ...diff }
    setStore(storePath("remoteDiffs", index, next))

    const { mode, from, to } = activeDiffRefs()
    updateCachedReviewVcsDiff({
      directory: props.directory,
      mode,
      fromRef: from,
      toRef: to,
      file,
      update: () => next,
    })
  }

  const loadRequiredVcsDiffContent = (files: string[]) => {
    if (store.loading) return
    const { mode, from, to } = activeDiffRefs()
    const diffKey = vcsDiffCacheKey(props.directory, mode, from, to)
    if (store.remoteDiffKey !== diffKey) return

    for (const file of files) {
      const diff = store.remoteDiffs.find((item) => item.file === file)
      if (!diff || hasDiffContent(diff as RawVcsFileDiff)) continue
      void fetchVcsFileDiff(file, mode, from, to).then((next) => mergeVcsFileDiff(diffKey, file, next))
    }
  }

  let scheduledVcsRefresh: VoidFunction | undefined
  let scheduledVcsRefreshForce = false

  const scheduleVcsDiffRefresh = (force = false) => {
    scheduledVcsRefreshForce = scheduledVcsRefreshForce || force
    if (scheduledVcsRefresh) return

    scheduledVcsRefresh = afterVisibleWork(() => {
      const forceRefresh = scheduledVcsRefreshForce
      scheduledVcsRefresh = undefined
      scheduledVcsRefreshForce = false
      loadVcsDiffs(forceRefresh)
    })
  }

  const refreshVcsDiffs = () => {
    scheduleVcsDiffRefresh(true)
  }

  createEffect(
    () => [activeMode(), activeFromRef(), activeToRef()] as const,
    () => {
      const stop = afterVisibleWork(() => loadVcsDiffs(false))
      return stop
    },
  )

  // The workspace watches the runtime and invalidates the shared review cache;
  // this surface only has to reload when it is the one on screen.
  createEffect(
    () => props.staleDiffsVersion,
    () => refreshVcsDiffs(),
    { defer: true },
  )
  createEffect(
    () => props.staleBranchVersion,
    () => void loadVcsInfo(props.directory),
    { defer: true },
  )
  onCleanup(() => {
    scheduledVcsRefresh?.()
    scheduledVcsRefresh = undefined
    scheduledVcsRefreshForce = false
  })

  createEffect(
    () => [vcsInfo()?.branch, vcsInfo()?.default_branch] as const,
    (next, prev) => {
      if (prev === undefined) return
      if (next[0] === prev[0] && next[1] === prev[1]) return
      refreshVcsDiffs()
    },
    { defer: true },
  )

  const diffs = createMemo((): VcsFileDiff[] => store.remoteDiffs)
  // A corpus on screen is a promise that some row will be expanded. Build the
  // highlighter's workers now, while the surface is idle, instead of inside
  // the expand click — see `warmDiffHighlightWorkerPool`. The compute collapses
  // to the style so an empty corpus cancels the warm-up and a re-warm only
  // happens for a style the pool has not been built for.
  createEffect(
    () => (store.remoteDiffs.length === 0 ? undefined : store.diffStyle),
    (style) => {
      if (!style) return
      return afterVisibleWork(() => warmDiffHighlightWorkerPool(style))
    },
  )
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
  const diffsReady = createMemo(() => reviewDiffsReady({ loading: store.loading, diffCount: store.remoteDiffs.length }))
  const reviewLoading = createMemo(() =>
    reviewShouldShowLoadingPane({ loading: store.loading, diffCount: store.remoteDiffs.length }),
  )
  const diffFiles = createMemo(() => diffs().map((diff) => diff.file))
  const diffFileKey = createMemo(() => diffFiles().join("\0"))

  // Consumed by the first changeset this mount loads: a retained expansion
  // belongs to the review the user left, not to every later changeset.
  let pendingRetainedOpenDiffs = retained.openDiffs
  createEffect(diffFileKey, () => {
    const files = diffFiles()
    if (files.length === 0) return
    const loaded = initialReviewOpenDiffs(
      files,
      untrack(() => props.focusedDiffPath),
    )
    const focused = untrack(() => props.focusedDiffPath)
    const open = restoredOpenDiffs({ files, retained: pendingRetainedOpenDiffs, focused })
    pendingRetainedOpenDiffs = undefined
    setRenderedHunks(0)
    setStore(storePath("loadedDiffs", loaded))
    setStore(storePath("openDiffs", open))
  })

  // One publisher for every retained field, so the panel's working set always
  // reflects the live surface. Small UI values only — see ReviewSurfaceState.
  createEffect(
    () => ({
      mode: activeMode(),
      fromRef: activeFromRef(),
      toRef: activeToRef(),
      diffStyle: store.diffStyle,
      openDiffs: [...store.openDiffs],
      focusedFile: store.focusedFile,
      forcedDiffPaths: [...store.forcedDiffPaths],
    }),
    (state) => {
      props.onRetainedChange?.(state)
    },
  )

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
  let resumedFocusPath = untrack(() =>
    retained.focusedFile === props.focusedDiffPath ? retained.focusedFile : undefined,
  )
  createEffect(
    () => [props.focusedDiffVersion, props.focusedDiffPath] as const,
    ([, path]) => {
      const resumed = resumedFocusPath
      resumedFocusPath = undefined
      if (!path || path === resumed) return
      setStore(storePath("focusedFile", path))
      setStore(($state) => {
        if (!$state.openDiffs.includes(path)) $state.openDiffs = [...$state.openDiffs, path]
      })
      requestAnimationFrame(() => scrollToFile(path))
    },
  )

  // No reactive input: the shortcut is registered once, and the listener reads
  // the current diff style through the store updater rather than tracking it.
  createEffect(
    () => {},
    () => {
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
        setStore(storePath("diffStyle", (current) => (current === "split" ? "unified" : "split")))
      }
      window.addEventListener("keydown", onKeyDown)
      return () => window.removeEventListener("keydown", onKeyDown)
    },
  )

  return (
    <>
      <ReviewToolbar
        mode={activeMode()}
        fromRef={activeFromRef()}
        toRef={activeToRef()}
        vcsRefs={vcsRefs()}
        onApplyMode={setReviewMode}
        hasReview={hasReview()}
        loading={store.loading}
        reviewCount={reviewCount()}
        totalChanges={totalChanges()}
        scopeLabel={diffScopeLabel()}
        allExpanded={store.loadedDiffs.length > 0 && store.loadedDiffs.every((file) => store.openDiffs.includes(file))}
        onToggleAllDiffs={() => {
          if (store.openDiffs.length > 0) {
            setStore(storePath("openDiffs", []))
            return
          }
          setStore(storePath("openDiffs", store.loadedDiffs))
        }}
        diffStyle={store.diffStyle}
        onSetDiffStyle={(style) => setStore(storePath("diffStyle", style))}
      />

      <Switch>
        <Match when={reviewLoading()}>
          <div class="relative flex-1 min-h-0 overflow-hidden">
            <div
              data-testid="review-pane-loading"
              class="h-full px-6 pb-42 flex flex-col items-center justify-center text-center gap-3"
            >
              <Spinner class="h-5 w-5 text-text-weak" />
              <div class="text-13-regular text-text-weak">Loading review{language.t("common.loading.ellipsis")}</div>
            </div>
          </div>
        </Match>
        <Match when={hasReview()}>
          <Show
            when={diffsReady()}
            fallback={
              <div class="px-3 py-2 text-12-regular text-text-weak">
                {language.t("common.loading")}
                {language.t("common.loading.ellipsis")}
              </div>
            }
          >
            <div class="contents" data-review-diff-style={store.diffStyle} data-review-rendered-hunks={renderedHunks()}>
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
                    setStore(($state) => {
                      $state.openDiffs = $state.openDiffs.includes(file)
                        ? $state.openDiffs.filter((path) => path !== file)
                        : [...$state.openDiffs, file]
                    })
                  }
                  scrollRef={props.scrollRef}
                  onScrollEvent={(event) => {
                    const handler = props.onScroll
                    if (!handler) return
                    if (Array.isArray(handler)) {
                      const [fn, data] = handler as [(data: unknown, ev: Event) => void, unknown]
                      fn(data, event)
                      return
                    }
                    ;(handler as (ev: Event) => void)(event)
                  }}
                  onDiffRendered={() => setRenderedHunks((count) => count + 1)}
                />
              ) : (
                <ClaxedoSessionReview
                  diffs={diffs()}
                  diffStyle={store.diffStyle}
                  onDiffStyleChange={(style) => setStore(storePath("diffStyle", style))}
                  comments={comments.all()}
                  focusedComment={comments.focus()}
                  onFocusedCommentChange={comments.setFocus}
                  open={store.openDiffs}
                  onOpenChange={(open) => setStore(storePath("openDiffs", open))}
                  forcedFiles={store.forcedDiffPaths}
                  onForcedFilesChange={(files) => setStore(storePath("forcedDiffPaths", files))}
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
              {/* Kept multi-line deliberately: collapsing this onto one line puts its
                  `class=` inside the 4-line lookback `check-theme-tokens` uses to decide
                  whether a hyphenated string is a utility, and the `"to-from"` review mode
                  below then reads as the gradient utility `to-<color>`. */}
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
