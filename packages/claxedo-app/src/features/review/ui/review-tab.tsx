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
import { ReviewCodeView, mediaKindFromPath, type ReviewCodeViewRevealTarget } from "@/ui/session-kit"
import {
  createReviewCodeViewComments,
  type SessionReviewCommentDelete,
  type SessionReviewCommentUpdate,
  type SessionReviewLineComment,
} from "./review-code-view-comments"
import type { SessionReviewCommentActions } from "./review-comment-menu"
import { reviewCommentFocusAction } from "./review-comment-focus"
import { isReviewMediaFile, reviewContentRequestPlan, reviewMediaLoad } from "./review-content-requests"
import { ReviewCodeViewFileHeader, ReviewRowBody } from "./review-file-row"
import { diffTriggerTestId, exceedsDiffLimit } from "./review-session-logic"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ClaxedoLogo as Mark } from "@/ui/controls/claxedo-logo"
import type { AgentVcsFileDiff as VcsFileDiff } from "@claxedo/agent-runtime-contract"
import { workspaceVcsQuery } from "@/platform/runtime/workspace-query"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { createReviewDiffClient, normalizeVcsStatus, reviewVcsDiffSummaryQueryOptions } from "./review-vcs-load"
import { createReviewSelection, isBaseReviewMode, reviewDiffRefs, type ReviewMode } from "@/features/review/review-intent"
import { ReviewToolbar, type VcsRefs } from "./review-toolbar"
import { reviewToggleAllAction } from "./review-toggle-all"
import { reviewLoadedDiffIdentity } from "./review-loaded-diff-identity"
import {
  cachedReviewVcsFile,
  cachedReviewVcsRefs,
  cachedReviewVcsTargets,
  invalidateReviewVcsDirectory,
  updateCachedReviewVcsDiff,
  reviewVcsFileQueryKey,
  type ReviewVcsDiffInput,
} from "./review-vcs-cache"
import { createReviewContentQueue } from "./review-content-queue"
import { reviewDiffsReady, reviewShouldShowLoadingPane } from "./review-loading-state"
import { afterVisibleWork } from "./review-deferred-work"
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
  /**
   * Receives a reader for where a file sits in the review document. The
   * restoration owner uses it to target a semantic anchor whose row is not
   * rendered, instead of replaying a pixel top captured against an older
   * document. Absent while the surface owns no document of its own.
   */
  anchorTopRef?: (resolve: ((file: string) => number | undefined) | undefined) => void
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

/**
  * Structural rather than `RawVcsFileDiff`: the callers hold the row as the
  * summary type, as a partial fetch result, and as a cache miss, and the answer
  * reads the same three fields out of all three.
  */
function hasDiffContent(diff: { patch?: unknown; before?: unknown; after?: unknown } | undefined) {
  return typeof diff?.patch === "string" || typeof diff?.before === "string" || typeof diff?.after === "string"
}

function initialDiffStyle(): "unified" | "split" {
  return "unified"
}

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
    const refs = reviewDiffRefs({ mode, fromRef: activeFromRef(), toRef: activeToRef() })
    return { directory: props.directory, mode, fromRef: refs.fromRef, toRef: refs.toRef }
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
  }))

  const fetchVcsFileDiff = async (
    file: string,
    target: ReviewVcsDiffInput,
    client: ReturnType<typeof createReviewDiffClient>,
    force = false,
  ) => {
    return cachedReviewVcsFile({
      ...target,
      file,
      force,
      load: () => client
        .vcsFile({ ...target, file })
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

  // Pierre reports the complete current range. Replacing queued work on each
  // range change prioritizes a direction reversal without cancelling in-flight
  // cache reads. Capture both target and client before a request enters the queue.
  const [requiredContent, setRequiredContent] = createSignal({ targetKey: "", files: [] as string[] })
  const [contentErrors, setContentErrors] = createStore<Record<string, string | undefined>>({})
  const retryContent = new Set<string>()
  const contentKey = (target: ReviewVcsDiffInput, file: string) => JSON.stringify(reviewVcsFileQueryKey({ ...target, file }))
  const contentQueue = createReviewContentQueue({
    onError: (request, error) => setContentErrors(request.key, error instanceof Error ? error.message : String(error)),
  })
  onCleanup(() => contentQueue.dispose())
  const requireCodeViewContent = (files: string[]) => {
    const targetKey = diffKey()
    const previous = requiredContent()
    if (previous.targetKey !== targetKey) {
      retryContent.clear()
      for (const key of Object.keys(contentErrors)) setContentErrors(key, undefined)
    } else if (previous.files.length === files.length && previous.files.every((file, index) => file === files[index])) {
      return
    }
    setRequiredContent({ targetKey, files })
  }
  createEffect(() => {
    const target = diffTarget()
    const targetKey = diffKey()
    const required = requiredContent()
    if (required.targetKey !== targetKey) {
      contentQueue.replace([])
      return
    }
    const client = diffClient()
    const corpus = new Map(remoteDiffs().map((diff) => [diff.file, diff]))
    const plans = reviewContentRequestPlan({
      files: required.files,
      isMedia: isReviewMediaFile,
      isDeleted: (path) => corpus.get(path)?.status === "deleted",
      isKnown: (path) => corpus.has(path),
      hasDiff: (path) => hasDiffContent(corpus.get(path)),
      hasMedia: (path) => mediaContent(path) !== undefined,
      hasError: (path) => !!contentErrors[contentKey(target, path)],
    })
    const requests = plans.map(({ file: path, kind }) => {
      const key = contentKey(target, path)
      if (kind === "media") {
        return {
          key,
          load: reviewMediaLoad({
            reader: file,
            path,
            key,
            targetKey,
            currentTargetKey: diffKey,
            retries: retryContent,
          }),
        }
      }
      return { key, load: async () => {
        const force = retryContent.delete(key)
        const next = await fetchVcsFileDiff(path, target, client, force)
        if (!next || !hasDiffContent(next)) throw new Error("Diff content is unavailable")
        mergeVcsFileDiff(targetKey, path, next)
      } }
    })
    contentQueue.replace(requests)
  })

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
  // Classify before normalization, including collapsed files, so opening a
  // review cannot parse oversized content before the user permits rendering.
  const guardedCodeViewFiles = createMemo(() => {
    const forced = new Set(store.forcedDiffPaths)
    return new Set(diffs().filter((diff) => exceedsDiffLimit({
      changedLines: diff.additions + diff.deletions,
      expanded: true,
      forced: forced.has(diff.file),
      media: !!mediaKindFromPath(diff.file),
    })).map((diff) => diff.file))
  })
  // An image or an audio file has no text diff worth showing. CodeView still
  // owns where the row sits and how tall it is; the preview itself is a custom
  // body this surface mounts only while the engine renders that item.
  const mediaCodeViewFiles = createMemo(() =>
    new Set(diffs().filter((diff) => isReviewMediaFile(diff.file)).map((diff) => diff.file)),
  )
  const customCodeViewFiles = createMemo(() => new Set([...guardedCodeViewFiles(), ...mediaCodeViewFiles()]))
  const diffForFile = (file: string) => diffs().find((diff) => diff.file === file)
  const changedLinesForFile = (file: string) => {
    const diff = diffs().find((diff) => diff.file === file)
    return (diff?.additions ?? 0) + (diff?.deletions ?? 0)
  }
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
    if (activeMode() === "branch") return `changes since ${activeFromRef()}${branchLabel}`
    if (activeMode() === "branch-worktree") return `everything since ${activeFromRef()}${branchLabel}, uncommitted included`
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

  /** A media row's bytes, once the review's own scheduler has fetched them. */
  const mediaContent = (path: string) => file.get(path)?.content

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

  // A comment state machine per file Pierre renders, plus the draft and
  // selection state those rows share.
  const codeViewComments = createReviewCodeViewComments({
    comments: () => comments.all(),
    diffs: () => diffs(),
    actions: reviewCommentActions,
    onLineComment: handleLineComment,
    onLineCommentUpdate: handleLineCommentUpdate,
    onLineCommentDelete: handleLineCommentDelete,
  })

  // What the user asked to see, held until the surface can actually show it.
  // A file's row may not be committed yet and a comment's row may still be a
  // summary Pierre has no line geometry for; both resolve by themselves, so
  // nothing here retries on a timer or drops the request on the floor.
  const [fileRevealPath, setFileRevealPath] = createSignal<string | undefined>()
  /**
   * One target object per request, so the surface can tell "still the same
   * request" from "ask again": a new focus is a new object even for the file
   * the reader just scrolled away from.
   */
  const fileTarget = createMemo<ReviewCodeViewRevealTarget | null>(() => {
    const focus = comments.focus()
    if (focus) return { file: focus.file }
    const path = fileRevealPath()
    return path ? { file: path } : null
  })
  /** The comment the caller asked for, while that request is still open. */
  const focusedComment = createMemo(() => {
    const focus = comments.focus()
    if (!focus) return undefined
    return comments.all().find((item) => item.file === focus.file && item.id === focus.id)
  })
  /**
   * A focused comment's file counts as open while the request is live, so the
   * engine can expand the row and resolve the line. `onRevealed` is what makes
   * that expansion the user's own state.
   */
  const openDiffs = createMemo(() => {
    const focus = comments.focus()
    if (!focus || store.openDiffs.includes(focus.file)) return store.openDiffs
    return [...store.openDiffs, focus.file]
  })
  const focusedFile = createMemo(() => comments.focus()?.file ?? store.focusedFile)

  /**
   * Derived, never applied here: only the surface knows when CodeView has
   * committed the item, and it reports back through `onRevealed`.
   *
   * A file whose content has not arrived is revealed by item identity first, so
   * the bounded queue asks for exactly that file; the line follows once the row
   * is a real expanded diff.
   */
  const revealTarget = createMemo<ReviewCodeViewRevealTarget | null>(() => {
    const focus = comments.focus()
    if (!focus) return fileTarget()
    const comment = focusedComment()
    const diff = diffs().find((item) => item.file === focus.file)
    const action = reviewCommentFocusAction({
      mounted: true,
      commentExists: !!comment,
      renderable: !!diff
        && hasDiffContent(diff)
        && !guardedCodeViewFiles().has(focus.file)
        && openDiffs().includes(focus.file),
    })
    if (action === "apply-line" && comment) {
      return {
        file: focus.file,
        lineNumber: Math.max(comment.selection.start, comment.selection.end),
        side: comment.selection.endSide ?? comment.selection.side ?? "additions",
      }
    }
    if (action === "reveal-file") return fileTarget()
    return null
  })

  /**
   * The surface applied a target. A file-level nudge is a step, not the answer:
   * only the line jump ends a comment request, and it is what commits the
   * transient expansion the reveal needed into the user's own review state.
   */
  const onRevealApplied = (target: ReviewCodeViewRevealTarget) => {
    const focus = comments.focus()
    if (!focus) {
      setFileRevealPath(undefined)
      return
    }
    // A target for some other file belongs to a request this one replaced.
    if (target.file !== focus.file) return
    // The file-level step is a step; only the line jump ends the request and
    // commits the expansion it needed into the reader's own review state.
    if (target.lineNumber === undefined) return
    codeViewComments.openComment(focus)
    batch(() => {
      setStore("focusedFile", focus.file)
      if (!store.openDiffs.includes(focus.file)) setStore("openDiffs", [...store.openDiffs, focus.file])
      comments.setFocus(null)
    })
  }

  const scrollToFile = (path: string) => batch(() => {
    // A stale focus would otherwise keep answering for this request.
    if (comments.focus()) comments.setFocus(null)
    setFileRevealPath(path)
  })

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
      scrollToFile(path)
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
        defaultBaseRef={defaultBranchRef()}
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
              <ReviewCodeView
                  class="claxedo-workspace-review h-full"
                  diffs={diffs()}
                  diffStyle={store.diffStyle}
                  open={openDiffs()}
                  focusedFile={focusedFile()}
                  headerTestId={diffTriggerTestId}
                  renderHeader={(file, active) => (
                    <ReviewCodeViewFileHeader
                      diffs={diffs()}
                      file={file}
                      onViewFile={props.onOpenFile}
                      showControls={active}
                    />
                  )}
                  onToggleOpen={(file) =>
                    setStore(
                      "openDiffs",
                      store.openDiffs.includes(file)
                        ? store.openDiffs.filter((path) => path !== file)
                        : [...store.openDiffs, file],
                    )
                  }
                  comments={codeViewComments}
                  selectedLines={codeViewComments?.selectedLines() ?? null}
                  scrollRef={props.scrollRef}
                  anchorTopRef={props.anchorTopRef}
                  revealTarget={revealTarget()}
                  onRevealed={onRevealApplied}
                  onScrollEvent={(event) => callEventHandler(props.onScroll, event)}
                  onDiffRendered={() => setRenderedHunks((count) => count + 1)}
                  onDiffContentRequired={requireCodeViewContent}
                  customFiles={customCodeViewFiles()}
                  renderCustomBody={(file) => (
                    <ReviewRowBody
                      file={file}
                      media={mediaCodeViewFiles().has(file)}
                      guarded={guardedCodeViewFiles().has(file)}
                      deleted={diffForFile(file)?.status === "deleted"}
                      content={mediaContent(file)}
                      changedLines={changedLinesForFile(file)}
                      onRenderAnyway={(path) => setStore("forcedDiffPaths", (files) => [...files, path])}
                      error={contentErrors[contentKey(diffTarget(), file)]}
                      onRetry={(path) => {
                        const key = contentKey(diffTarget(), path)
                        retryContent.add(key)
                        setContentErrors(key, undefined)
                      }}
                    />
                  )}
              />
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
              {/* An empty worktree review usually means the work is
                  already committed; the branch view is where it shows. */}
              <Show when={defaultBranchRef() && activeMode() !== "to-from" && !isBaseReviewMode(activeMode())}>
                <button
                  type="button"
                  data-testid="review-pane-empty-show-branch-diff"
                  class="rounded-md border border-border-weak-base bg-surface-base px-3 py-1.5 text-12-medium text-text-base hover:bg-surface-base-hover transition-colors"
                  onClick={() => {
                    const ref = defaultBranchRef()
                    if (!ref) return
                    setReviewMode("branch", ref, "")
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
