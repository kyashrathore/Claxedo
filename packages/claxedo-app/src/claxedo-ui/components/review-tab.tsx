// target-layer: surfaces/review (org doc §3c) — the ONE review surface (vcs modes are props).
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
} from "solid-js"
import { createStore } from "solid-js/store"

import { useLanguage } from "@claxedo/context/language"
import { usePlatform } from "@claxedo/context/platform"
import { selectionFromLines, useFile } from "@/context/file"
import { useComments } from "@/context/comments"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import {
  ClaxedoSessionReview,
  type SessionReviewCommentActions,
  type SessionReviewCommentDelete,
  type SessionReviewCommentUpdate,
  type SessionReviewLineComment,
} from "./claxedo-session-review"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ClaxedoLogo as Mark } from "@claxedo/claxedo-ui/components/claxedo-logo"
import type { FileContent, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { createPanePreferences, reviewModePreferenceScope } from "../../pane/store/pane-preferences"
import { queryClient } from "../../shared/query/query-client"
import { workspaceVcsQuery } from "../../shared/query/runtime"
import { resolveWorkspaceRuntime } from "../../cloud/runtime/workspace-runtime-store"
import { getClaxedoServerUrl } from "../../utils/api"
import { createWorkspaceDiffClient } from "../utils/workspace-diff-client"
import { type ReviewMode } from "../workspace-panel/review-intent"
import { ReviewToolbar, type VcsRefs } from "./review-toolbar"
import {
  cachedReviewVcsDiff,
  cachedReviewVcsFile,
  cachedReviewVcsRefs,
  cachedReviewVcsTargets,
  updateCachedReviewVcsDiff,
} from "./review-vcs-cache"
import { INITIAL_REVIEW_OPEN_DIFF_LIMIT, REVIEW_OPEN_DIFF_BATCH, expandReviewOpenDiffsForScroll, initialReviewOpenDiffs } from "./review-open-diffs"
import { reviewDiffsReady, reviewShouldShowLoadingPane } from "./review-loading-state"
import { fastSessionSwitchAnyQuietDelay } from "../../session/store/fast-session-switch"

type RawVcsFileDiff = Omit<VcsFileDiff, "status" | "patch"> & {
  before?: string
  after?: string
  patch?: string
  status?: string
}

export type ReviewTabProps = {
  directory: string
  sessionId: string
  initialMode: ReviewMode
  initialFromRef?: string
  initialToRef?: string
  focusedDiffPath?: string
  focusedDiffVersion?: number
  onOpenFile: (path: string) => void
}

function normalizeVcsStatus(status: string | undefined): VcsFileDiff["status"] {
  if (status === "A" || status === "added") return "added"
  if (status === "D" || status === "deleted") return "deleted"
  if (!status) return undefined
  return "modified"
}

function normalizeVcsDiff(diff: RawVcsFileDiff): VcsFileDiff {
  return { ...diff, status: normalizeVcsStatus(diff.status) } as VcsFileDiff
}

function vcsDiffCacheKey(directory: string, mode: string, fromRef?: string, toRef?: string) {
  return [directory, mode, fromRef ?? "", toRef ?? ""].join("\0")
}

function hasDiffContent(diff: RawVcsFileDiff) {
  return typeof diff.patch === "string" || typeof diff.before === "string" || typeof diff.after === "string"
}

function initialDiffStyle() {
  if (typeof window !== "undefined" && window.innerWidth < 768) return "unified"
  return "split"
}

function afterVisibleWork(callback: () => void) {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame: ReturnType<typeof requestAnimationFrame> | undefined
  let idle: ReturnType<typeof requestIdleCallback> | undefined

  frame = requestAnimationFrame(() => {
    frame = undefined
    if (cancelled) return
    const schedule = () => {
      if (cancelled) return
      callback()
    }
    if (typeof requestIdleCallback === "function") {
      idle = requestIdleCallback(() => {
        timer = setTimeout(schedule, fastSessionSwitchAnyQuietDelay())
      }, { timeout: 1_200 })
      return
    }
    timer = setTimeout(schedule, fastSessionSwitchAnyQuietDelay({ baseDelay: 120 }))
  })

  return () => {
    cancelled = true
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (idle !== undefined && typeof cancelIdleCallback === "function") cancelIdleCallback(idle)
    if (timer) clearTimeout(timer)
  }
}

export function ReviewTab(props: ReviewTabProps) {
  const comments = useComments()
  const file = useFile()
  const language = useLanguage()
  const prompt = usePrompt()
  const sdk = useSDK()
  const platform = usePlatform()
  const signedWorkspace = createMemo(() => sdk.workspace?.(props.directory))
  const panePreferences = createMemo(() => createPanePreferences(localStorage))
  const reviewModeScope = createMemo(() => reviewModePreferenceScope({
    directory: props.directory,
    sessionId: props.sessionId,
  }))
  const [vcsInfo, setVcsInfo] = createSignal<{ branch?: string | null; default_branch?: string | null }>()
  const loadVcsInfo = (directory = props.directory) =>
    queryClient.fetchQuery(workspaceVcsQuery({
        baseUrl: sdk.url,
        directory,
        request: platform.fetch,
        workspaceId: signedWorkspace()?.workspaceId,
        workspace: signedWorkspace(),
        signedControlPlane: !!signedWorkspace(),
        client: sdk.createClient({ directory }),
      }))
      .then((info) => setVcsInfo(info))
      .catch(() => {})

  createEffect(() => {
    if (!props.directory) return
    const stop = afterVisibleWork(() => void loadVcsInfo(props.directory))
    onCleanup(stop)
  })

  const [activeMode, setActiveMode] = createSignal<ReviewMode>(props.initialMode)
  const [activeFromRef, setActiveFromRef] = createSignal(props.initialFromRef ?? "HEAD~1")
  const [activeToRef, setActiveToRef] = createSignal(props.initialToRef ?? "HEAD")

  createEffect(on(() => props.initialMode, (mode) => setActiveMode(mode)))
  createEffect(on(() => props.initialFromRef, (fromRef) => { if (fromRef) setActiveFromRef(fromRef) }))
  createEffect(on(() => props.initialToRef, (toRef) => { if (toRef) setActiveToRef(toRef) }))

  const syncReviewState = (mode = activeMode()) => {
    panePreferences().set("reviewMode", reviewModeScope(), mode)
  }

  const setReviewMode = (mode: ReviewMode, fromRef = activeFromRef(), toRef = activeToRef()) => {
    batch(() => {
      setActiveFromRef(fromRef)
      setActiveToRef(toRef)
      setActiveMode(mode)
    })
    syncReviewState(mode)
  }

  createEffect(
    on(
      () => [activeMode(), activeFromRef(), activeToRef()] as const,
      ([mode, fromRef, toRef], prev) => {
        if (prev && prev[0] === mode && prev[1] === fromRef && prev[2] === toRef) return
        syncReviewState(mode)
      },
      { defer: true },
    ),
  )

  const claxedoServerUrl = getClaxedoServerUrl()
  const diffClient = createMemo(() => createWorkspaceDiffClient({
    serverUrl: claxedoServerUrl,
    directory: props.directory,
    request: platform.fetch,
    workspaceId: signedWorkspace()?.workspaceId,
    workspace: signedWorkspace(),
    resolveWorkspaceRuntime: (input) => resolveWorkspaceRuntime({
      baseUrl: claxedoServerUrl,
      request: platform.fetch,
      directory: input.directory,
    }),
  }))

  const fetchVcsDiff = async (
    mode: string,
    fromRef?: string,
    toRef?: string,
    directory = props.directory,
    options?: { force?: boolean },
  ) => {
    return cachedReviewVcsDiff({
      directory,
      mode,
      fromRef,
      toRef,
      force: options?.force,
      load: () => {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("claxedo:review-vcs-load", {
            detail: { directory, mode, from: fromRef, to: toRef, force: options?.force === true },
          }))
        }
        return diffClient()
          .vcs({ directory, mode, fromRef, toRef, content: "summary" })
          .then((data) => {
            const diffs = data.map((diff) => normalizeVcsDiff(diff))
            return diffs
          })
      },
    })
  }

  const [vcsRefs, setVcsRefs] = createSignal<VcsRefs>({ branches: [], tags: [], recent: [] })
  // Cache the resolved default-ref so the empty-state
  // CTA ("Show branch diff vs <ref>") can fire even before the
  // dropdown is opened.
  const [defaultBranchRef, setDefaultBranchRef] = createSignal<string | undefined>()
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
          if (data.defaultRef) {
            setDefaultBranchRef(data.defaultRef)
            if (untrack(activeFromRef) === "HEAD~1") setActiveFromRef(data.defaultRef)
          }
        })
        .catch(() => {})
    })
    onCleanup(stop)
  })

  const [store, setStore] = createStore({
    openDiffs: [] as string[],
    loadedDiffs: [] as string[],
    diffStyle: initialDiffStyle() as "unified" | "split",
    focusedFile: undefined as string | undefined,
    loading: false,
    remoteDiffKey: "",
    remoteDiffs: [] as VcsFileDiff[],
  })

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

    batch(() => {
      setStore("loading", true)
      if (store.remoteDiffKey !== key) {
        setStore("remoteDiffKey", key)
        setStore("remoteDiffs", [])
      }
    })
    const task = fetchVcsDiff(mode, from, to, props.directory, { force })
      .then((diffs) => {
        if (vcsRun !== run) return
        batch(() => {
          setStore("remoteDiffKey", key)
          setStore("remoteDiffs", diffs)
        })
      })
      .catch(() => {
        if (vcsRun !== run) return
        if (store.remoteDiffKey === key && store.remoteDiffs.length > 0) return
        batch(() => {
          setStore("remoteDiffKey", key)
          setStore("remoteDiffs", [])
        })
      })
      .finally(() => {
        if (vcsRun !== run) return
        setStore("loading", false)
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
      load: () => diffClient()
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
    diff: Partial<VcsFileDiff> & { file: string } | undefined,
  ) => {
    if (!diff || store.remoteDiffKey !== diffKey) return
    const index = store.remoteDiffs.findIndex((item) => item.file === file)
    if (index === -1) return

    const next = { ...store.remoteDiffs[index], ...diff }
    setStore("remoteDiffs", index, next)

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
    on(
      () => [activeMode(), activeFromRef(), activeToRef()] as const,
      () => {
        const stop = afterVisibleWork(() => loadVcsDiffs(false))
        onCleanup(stop)
      },
    ),
  )

  let lastSessionStatusType: string | undefined
  const stopFileWatcher = sdk.event.listen((evt) => {
    if (evt.details.type === "session.status") {
      const eventProps = evt.details.properties as { sessionID?: string; status?: { type?: string } }
      if (eventProps.sessionID !== props.sessionId) return
      const next = eventProps.status?.type ?? "idle"
      if (next === "idle" && lastSessionStatusType && lastSessionStatusType !== "idle") {
        refreshVcsDiffs()
      }
      lastSessionStatusType = next
      return
    }
    if (evt.details.type === "vcs.branch.updated") {
      void loadVcsInfo(props.directory)
      refreshVcsDiffs()
      return
    }
    if (evt.details.type !== "file.watcher.updated") return
    const eventProps =
      typeof evt.details.properties === "object" && evt.details.properties
        ? (evt.details.properties as Record<string, unknown>)
        : undefined
    const filePath = typeof eventProps?.file === "string" ? eventProps.file : undefined
    if (!filePath || filePath.startsWith(".git/")) return
    refreshVcsDiffs()
  })
  onCleanup(stopFileWatcher)
  onCleanup(() => {
    scheduledVcsRefresh?.()
    scheduledVcsRefresh = undefined
    scheduledVcsRefreshForce = false
  })

  createEffect(
    on(
      () => [vcsInfo()?.branch, vcsInfo()?.default_branch] as const,
      (next, prev) => {
        if (prev === undefined) return
        if (next[0] === prev[0] && next[1] === prev[1]) return
        refreshVcsDiffs()
      },
      { defer: true },
    ),
  )

  const diffs = createMemo((): VcsFileDiff[] => store.remoteDiffs)
  const hasReview = createMemo(() => diffs().length > 0)
  const visibleDiffs = createMemo(() => {
    const loaded = new Set(store.loadedDiffs)
    return diffs().filter((diff) => loaded.has(diff.file))
  })
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
    reviewShouldShowLoadingPane({ loading: store.loading, diffCount: store.remoteDiffs.length })
  )
  const diffFiles = createMemo(() => diffs().map((diff) => diff.file))
  const diffFileKey = createMemo(() => diffFiles().join("\0"))
  let reviewScroll: HTMLDivElement | undefined
  let viewportFillFrame: number | undefined

  const fillReviewViewport = () => {
    viewportFillFrame = undefined
    const target = reviewScroll
    if (!target) return
    if (store.loadedDiffs.length >= diffFiles().length) return
    if (store.loadedDiffs.length >= INITIAL_REVIEW_OPEN_DIFF_LIMIT + REVIEW_OPEN_DIFF_BATCH) return
    if (target.scrollHeight > target.clientHeight + 24) return

    const next = expandReviewOpenDiffsForScroll({
      files: diffFiles(),
      open: store.loadedDiffs,
      scrollTop: target.scrollTop,
      clientHeight: target.clientHeight,
      scrollHeight: target.scrollHeight,
    })
    if (next === store.loadedDiffs || next.length === store.loadedDiffs.length) return
    setStore("loadedDiffs", next)
    scheduleReviewViewportFill()
  }

  const scheduleReviewViewportFill = () => {
    if (viewportFillFrame !== undefined) return
    viewportFillFrame = requestAnimationFrame(fillReviewViewport)
  }

  createEffect(on(diffFileKey, () => {
    const files = diffFiles()
    if (files.length === 0) return
    const loaded = initialReviewOpenDiffs(files, untrack(() => props.focusedDiffPath))
    const focused = untrack(() => props.focusedDiffPath)
    batch(() => {
      setStore("loadedDiffs", loaded)
      setStore("openDiffs", focused ? [focused] : [])
    })
    scheduleReviewViewportFill()
  }))

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

  let scrollExpansionTimer: number | undefined
  const expandDiffsNearScrollEnd = (event: Event) => {
    const target = event.currentTarget
    if (!(target instanceof HTMLElement)) return
    scheduleDiffExpansion(target)
  }

  const expandDiffsOnWheel = (event: WheelEvent) => {
    if (event.deltaY <= 0) return
    const target = event.currentTarget
    if (!(target instanceof HTMLElement)) return
    if (target.scrollHeight > target.clientHeight + 24) return
    scheduleDiffExpansion(target)
  }

  const scheduleDiffExpansion = (target: HTMLElement) => {
    const next = expandReviewOpenDiffsForScroll({
      files: diffFiles(),
      open: store.loadedDiffs,
      scrollTop: target.scrollTop,
      clientHeight: target.clientHeight,
      scrollHeight: target.scrollHeight,
    })
    if (next === store.loadedDiffs || next.length === store.loadedDiffs.length) return
    if (scrollExpansionTimer !== undefined) window.clearTimeout(scrollExpansionTimer)
    scrollExpansionTimer = window.setTimeout(() => {
      scrollExpansionTimer = undefined
      setStore("loadedDiffs", next)
      scheduleReviewViewportFill()
    }, 160)
  }

  onCleanup(() => {
    if (scrollExpansionTimer === undefined) return
    window.clearTimeout(scrollExpansionTimer)
  })
  onCleanup(() => {
    if (viewportFillFrame === undefined) return
    cancelAnimationFrame(viewportFillFrame)
  })

  createEffect(on(
    () => [props.focusedDiffVersion, props.focusedDiffPath] as const,
    ([, path]) => {
      if (!path) return
      batch(() => {
        setStore("focusedFile", path)
        if (!store.loadedDiffs.includes(path)) setStore("loadedDiffs", [...store.loadedDiffs, path])
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
            setStore("openDiffs", [])
            return
          }
          setStore("openDiffs", store.loadedDiffs)
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
            <div class="contents" data-review-diff-style={store.diffStyle}>
              <ClaxedoSessionReview
                diffs={visibleDiffs()}
                diffStyle={store.diffStyle}
                onDiffStyleChange={(style) => setStore("diffStyle", style)}
                comments={comments.all()}
                focusedComment={comments.focus()}
                onFocusedCommentChange={comments.setFocus}
                open={store.openDiffs}
                onOpenChange={(open) => setStore("openDiffs", open)}
                onDiffContentRequired={loadRequiredVcsDiffContent}
                scrollRef={(el) => {
                  reviewScroll = el
                  scheduleReviewViewportFill()
                }}
                onScroll={expandDiffsNearScrollEnd}
                onWheel={expandDiffsOnWheel}
                readFile={readFile}
                onLineComment={handleLineComment}
                onLineCommentUpdate={handleLineCommentUpdate}
                onLineCommentDelete={handleLineCommentDelete}
                lineCommentActions={reviewCommentActions()}
                onViewFile={props.onOpenFile}
                focusedFile={store.focusedFile}
                title=""
                classes={{
                  root: "claxedo-workspace-review pb-6 pr-3",
                  header: "px-3 !hidden",
                  container: "pl-3",
                }}
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
