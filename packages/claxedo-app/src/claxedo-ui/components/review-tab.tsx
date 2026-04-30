import {
  Show,
  Match,
  Switch,
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  untrack,
} from "solid-js"
import { createStore } from "solid-js/store"

import { useComments, useFile, useServer } from "@opencode-ai/claxedo-app"
import { useLanguage } from "@/context/language"
import { selectionFromLines } from "@/context/file"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import {
  SessionReview,
  type SessionReviewCommentActions,
  type SessionReviewCommentDelete,
  type SessionReviewCommentUpdate,
  type SessionReviewLineComment,
} from "@opencode-ai/ui/session-review"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ClaxedoLogo as Mark } from "@claxedo/claxedo-ui/components/claxedo-logo"
import type { FileContent, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { createSessionController } from "../../session/store/session-controller"
import { createPanePreferences, reviewModePreferenceScope } from "../../pane/store/pane-preferences"
import { queryClient } from "../../shared/query/query-client"
import { workspaceVcsQuery } from "../../shared/query/runtime"
import { getClaxedoServerUrl } from "../../utils/api"
import { type ReviewMode } from "../workspace-panel/review-intent"
import { ReviewToolbar, type VcsRefs } from "./review-toolbar"

type RawVcsFileDiff = Omit<VcsFileDiff, "status"> & {
  before?: string
  after?: string
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

export function ReviewTab(props: ReviewTabProps) {
  const comments = useComments()
  const file = useFile()
  const language = useLanguage()
  const prompt = usePrompt()
  const sdk = useSDK()
  const server = useServer()
  const session = createSessionController({
    directory: () => props.directory,
    sessionID: () => props.sessionId,
    serverHealthy: () => server.healthy(),
  })
  const panePreferences = createMemo(() => createPanePreferences(localStorage))
  const reviewModeScope = createMemo(() => reviewModePreferenceScope({
    directory: props.directory,
    sessionId: props.sessionId,
  }))
  const [vcsInfo, { refetch: refetchVcsInfo }] = createResource(
    () => props.directory,
    async (directory) =>
      queryClient.fetchQuery(workspaceVcsQuery({
        baseUrl: sdk.url,
        directory,
        client: sdk.createClient({ directory }),
      })),
  )

  const [activeMode, setActiveMode] = createSignal<ReviewMode>(props.initialMode)
  const [activeFromRef, setActiveFromRef] = createSignal(props.initialFromRef ?? "HEAD~1")
  const [activeToRef, setActiveToRef] = createSignal(props.initialToRef ?? "HEAD")

  createEffect(on(() => props.initialMode, (mode) => setActiveMode(mode)))
  createEffect(on(() => props.initialFromRef, (fromRef) => { if (fromRef) setActiveFromRef(fromRef) }))
  createEffect(on(() => props.initialToRef, (toRef) => { if (toRef) setActiveToRef(toRef) }))

  const syncReviewState = (mode = activeMode(), fromRef = activeFromRef(), toRef = activeToRef()) => {
    panePreferences().set("reviewMode", reviewModeScope(), mode)
    void fromRef
    void toRef
  }

  const setReviewMode = (mode: ReviewMode, fromRef = activeFromRef(), toRef = activeToRef()) => {
    batch(() => {
      setActiveFromRef(fromRef)
      setActiveToRef(toRef)
      setActiveMode(mode)
    })
    syncReviewState(mode, fromRef, toRef)
  }

  createEffect(
    on(
      () => [activeMode(), activeFromRef(), activeToRef()] as const,
      ([mode, fromRef, toRef], prev) => {
        if (prev && prev[0] === mode && prev[1] === fromRef && prev[2] === toRef) return
        syncReviewState(mode, fromRef, toRef)
      },
      { defer: true },
    ),
  )

  const claxedoServerUrl = getClaxedoServerUrl()
  const vcsDiffCache = new Map<string, VcsFileDiff[]>()
  const vcsDiffInflight = new Map<string, Promise<VcsFileDiff[]>>()

  const fetchVcsDiff = async (
    mode: string,
    fromRef?: string,
    toRef?: string,
    directory = props.directory,
    options?: { force?: boolean },
  ) => {
    const key = vcsDiffCacheKey(directory, mode, fromRef, toRef)
    if (!options?.force) {
      const cached = vcsDiffCache.get(key)
      if (cached) return cached
      const inflight = vcsDiffInflight.get(key)
      if (inflight) return inflight
    }
    const query: Record<string, string> = { directory, mode }
    if (fromRef) query.fromRef = fromRef
    if (toRef) query.toRef = toRef
    const params = new URLSearchParams(query)
    const request = fetch(`${claxedoServerUrl}/api/claxedo/diff/vcs?${params}`)
      .then(async (res) => {
        if (!res.ok) return []
        const data = await res.json()
        if (!Array.isArray(data)) return []
        const diffs = data.map((diff) => normalizeVcsDiff(diff as RawVcsFileDiff))
        vcsDiffCache.set(key, diffs)
        return diffs
      })
      .finally(() => {
        if (vcsDiffInflight.get(key) === request) vcsDiffInflight.delete(key)
      })
    vcsDiffInflight.set(key, request)
    return request
  }

  const [vcsRefs, setVcsRefs] = createSignal<VcsRefs>({ branches: [], tags: [], recent: [] })
  createEffect(() => {
    if (!props.directory) return
    const refsParams = new URLSearchParams({ directory: props.directory })
    void fetch(`${claxedoServerUrl}/api/claxedo/diff/refs?${refsParams}`)
      .then((response) => response.json())
      .then((data) => setVcsRefs(data as VcsRefs))
      .catch(() => {})
    const targetsParams = new URLSearchParams({ directory: props.directory })
    void fetch(`${claxedoServerUrl}/api/claxedo/diff/targets?${targetsParams}`)
      .then((response) => response.json())
      .then((data: { defaultRef?: string }) => {
        if (data.defaultRef && untrack(activeFromRef) === "HEAD~1") setActiveFromRef(data.defaultRef)
      })
      .catch(() => {})
  })

  const [store, setStore] = createStore({
    openDiffs: [] as string[],
    diffStyle: "split" as "unified" | "split",
    focusedFile: undefined as string | undefined,
    loading: false,
    remoteDiffKey: "",
    remoteDiffs: [] as VcsFileDiff[],
  })

  let vcsRun = 0
  let vcsTask: Promise<void> | undefined

  const loadVcsDiffs = (force = false) => {
    const mode = untrack(activeMode)
    const from = mode === "to-from" ? untrack(activeFromRef).trim() || undefined : undefined
    const to = mode === "to-from" ? untrack(activeToRef).trim() || undefined : undefined
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

  const refreshVcsDiffs = () => {
    loadVcsDiffs(true)
  }

  createEffect(
    on(
      () => [activeMode(), activeFromRef(), activeToRef()] as const,
      () => {
        loadVcsDiffs(false)
      },
    ),
  )

  const stopFileWatcher = sdk.event.listen((evt) => {
    if (evt.details.type === "vcs.branch.updated") {
      void refetchVcsInfo()
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

  createEffect(
    on(
      () => session.status().type,
      (next, prev) => {
        if (next !== "idle" || prev === undefined || prev === "idle") return
        loadVcsDiffs(true)
      },
      { defer: true },
    ),
  )

  const diffs = createMemo((): VcsFileDiff[] => store.remoteDiffs)
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
  const diffsReady = createMemo(() => !store.loading)
  const reviewLoading = createMemo(() => !diffsReady())
  const diffFiles = createMemo(() => diffs().map((diff) => diff.file))

  createEffect(on(diffFiles, (files) => {
    if (files.length === 0) return
    setStore("openDiffs", files)
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
    node.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  createEffect(on(
    () => [props.focusedDiffVersion, props.focusedDiffPath] as const,
    ([, path]) => {
      if (!path) return
      setStore("focusedFile", path)
      setStore("openDiffs", [path])
      requestAnimationFrame(() => scrollToFile(path))
    },
  ))

  return (
    <>
      <ReviewToolbar
        mode={activeMode()}
        fromRef={activeFromRef()}
        toRef={activeToRef()}
        vcsRefs={vcsRefs()}
        onApplyMode={setReviewMode}
        hasReview={hasReview()}
        loading={reviewLoading()}
        reviewCount={reviewCount()}
        totalChanges={totalChanges()}
        scopeLabel={diffScopeLabel()}
        allExpanded={store.openDiffs.length > 0 && store.openDiffs.length === diffFiles().length}
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
            <SessionReview
              diffs={diffs()}
              diffStyle={store.diffStyle}
              onDiffStyleChange={(style) => setStore("diffStyle", style)}
              comments={comments.all()}
              focusedComment={comments.focus()}
              onFocusedCommentChange={comments.setFocus}
              open={store.openDiffs}
              onOpenChange={(open) => setStore("openDiffs", open)}
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
          </Show>
        </Match>
        <Match when={true}>
          <div class="relative flex-1 min-h-0 overflow-hidden">
            <div
              data-testid="review-pane-empty"
              class="h-full px-6 pb-42 flex flex-col items-center justify-center text-center gap-6"
            >
              <Mark class="w-14 opacity-10" />
              <div class="text-14-regular text-text-weak max-w-56">
                No changes for this review mode
              </div>
            </div>
          </div>
        </Match>
      </Switch>
    </>
  )
}
