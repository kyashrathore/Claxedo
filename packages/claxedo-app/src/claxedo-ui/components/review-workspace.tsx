/**
 * ReviewWorkspace
 *
 * A standalone pane leaf that renders the full review experience:
 * - Review panel with tabs (review diffs, context, individual file tabs)
 *
 * This mirrors the review experience as a first-class multi-pane leaf.
 */

import {
  Show,
  Match,
  Switch,
  For,
  createMemo,
  createEffect,
  createSignal,
  on,
  onCleanup,
} from "solid-js"
import { createStore } from "solid-js/store"

import { useSync, useFile, useComments, useServer } from "@opencode-ai/claxedo-app"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { selectionFromLines } from "@/context/file"
import {
  SessionReview,
  type SessionReviewLineComment,
} from "@opencode-ai/ui/session-review"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Popover } from "@opencode-ai/ui/popover"
import { Mark } from "@opencode-ai/ui/logo"
import { SessionContextTab } from "@/components/session/session-context-tab"
import { FileTabContent } from "@/pages/session/file-tabs"
import { StickyAddButton } from "@/pages/session/review-tab"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectFile } from "@/components/dialog-select-file"
import type { FileDiff, FileContent, UserMessage } from "@opencode-ai/sdk/v2"
import type { ContextItem } from "@/context/prompt"
import type { ReviewMode } from "../context/claxedo-layout/types"
import { useClaxedoLayout } from "../context/claxedo-layout"
import {
  REVIEW_MODE_LABEL,
  REVIEW_POPOVER_MODES,
  sumChanges,
  createReviewIntentAdapter,
  type ReviewPopoverMode,
  type ReviewModeStats,
} from "../context/claxedo-layout/review-intent"
import {
  usePane,
  peersWithCapability,
  getBound,
  sendComment,
  sendCommentRemoval,
  autoBind,
  unbind,
} from "../context/pane-bus"
import { SessionParamsProvider } from "../context/session-params"
import { createDebugLogger } from "../../overrides/utils/debug"

type VcsRefs = { branches: string[]; tags: string[]; recent: { hash: string; subject: string }[] }

function RefPickerField(props: {
  label: string
  value: string
  onInput: (value: string) => void
  onSelect: (value: string) => void
  placeholder: string
  refs: VcsRefs
}) {
  const [open, setOpen] = createSignal(false)
  const [filter, setFilter] = createSignal("")

  const filtered = createMemo(() => {
    const q = filter().toLowerCase()
    const branches = props.refs.branches.filter((b) => !q || b.toLowerCase().includes(q))
    const tags = props.refs.tags.filter((t) => !q || t.toLowerCase().includes(q))
    const recent = props.refs.recent.filter(
      (c) => !q || c.hash.toLowerCase().includes(q) || c.subject.toLowerCase().includes(q),
    )
    return { branches, tags, recent }
  })

  const hasResults = createMemo(() => {
    const f = filtered()
    return f.branches.length > 0 || f.tags.length > 0 || f.recent.length > 0
  })

  const select = (value: string) => {
    props.onSelect(value)
    setOpen(false)
    setFilter("")
  }

  return (
    <div class="flex flex-col gap-1">
      <div class="text-12-medium text-text-weak">{props.label}</div>
      <div class="relative">
        <input
          class="h-8 w-full rounded-md border border-border-weak-base bg-background-base pl-2 pr-7 text-13-regular"
          value={props.value}
          onInput={(e) => {
            props.onInput(e.currentTarget.value)
            setFilter(e.currentTarget.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={props.placeholder}
        />
        <button
          type="button"
          class="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-text-weak hover:text-text-base"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { setFilter(""); setOpen(!open()) }}
        >
          <svg class="w-3 h-3" viewBox="0 0 12 12">
            <path d="M3 5l3 3 3-3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <Show when={open() && hasResults()}>
          <div class="absolute left-0 right-0 top-full z-50 mt-1 max-h-52 overflow-y-auto rounded-md border border-border-weak-base bg-background-base shadow-lg">
            <Show when={filtered().branches.length > 0}>
              <div class="px-2 pt-1.5 pb-0.5 text-11-medium text-text-weak uppercase tracking-wider">Branches</div>
              <For each={filtered().branches.slice(0, 15)}>
                {(branch) => (
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 px-2 py-1 text-12-regular text-text-base hover:bg-surface-base-hover truncate"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => select(branch)}
                  >
                    <svg class="w-3 h-3 shrink-0 text-text-weak" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.5 2.5 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
                    </svg>
                    <span class="truncate">{branch}</span>
                  </button>
                )}
              </For>
            </Show>
            <Show when={filtered().tags.length > 0}>
              <div class="px-2 pt-1.5 pb-0.5 text-11-medium text-text-weak uppercase tracking-wider">Tags</div>
              <For each={filtered().tags.slice(0, 10)}>
                {(tag) => (
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 px-2 py-1 text-12-regular text-text-base hover:bg-surface-base-hover truncate"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => select(tag)}
                  >
                    <svg class="w-3 h-3 shrink-0 text-text-weak" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.75 1.75 0 0 1 1 7.775ZM6 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z" />
                    </svg>
                    <span class="truncate">{tag}</span>
                  </button>
                )}
              </For>
            </Show>
            <Show when={filtered().recent.length > 0}>
              <div class="px-2 pt-1.5 pb-0.5 text-11-medium text-text-weak uppercase tracking-wider">Commits</div>
              <For each={filtered().recent}>
                {(commit) => (
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 px-2 py-1 text-12-regular text-text-base hover:bg-surface-base-hover"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => select(commit.hash)}
                  >
                    <span class="shrink-0 font-mono text-11-regular text-text-weak">{commit.hash}</span>
                    <span class="truncate">{commit.subject}</span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

export type ReviewWorkspaceProps = {
  sessionId: string
  directory: string
  mode: ReviewMode
  fromRef?: string
  toRef?: string
  leafId?: string
  tabId?: string
  class?: string
}

export function ReviewWorkspace(props: ReviewWorkspaceProps) {
  const sync = useSync()
  const file = useFile()
  const comments = useComments()
  const server = useServer()
  const sdk = useSDK()
  const language = useLanguage()
  const prompt = usePrompt()
  const dialog = useDialog()
  const claxedo = useClaxedoLayout()
  const debug = createDebugLogger("review-workspace", "review-workspace", {
    defaultLevel: 0,
  })

  // Mutable mode — defaults to props.mode but can be changed via the mode selector
  const [activeMode, setActiveMode] = createSignal<ReviewMode>(props.mode)
  createEffect(() => setActiveMode(props.mode))

  // Local ref signals — user-editable within the workspace
  const [activeFromRef, setActiveFromRef] = createSignal(props.fromRef ?? "HEAD~1")
  const [activeToRef, setActiveToRef] = createSignal(props.toRef ?? "HEAD")
  createEffect(() => { if (props.fromRef) setActiveFromRef(props.fromRef) })
  createEffect(() => { if (props.toRef) setActiveToRef(props.toRef) })

  const [modeSelectorOpen, setModeSelectorOpen] = createSignal(false)

  // Session modes are only available when we have a real session
  const hasSession = createMemo(() => !!props.sessionId && props.sessionId !== "new")

  // VCS diffs go through /session/vcs-diff (no session needed)
  const fetchVcsDiff = async (mode: string, fromRef?: string, toRef?: string) => {
    const query: Record<string, string> = { mode }
    if (fromRef) query.fromRef = fromRef
    if (toRef) query.toRef = toRef
    const res = await (sdk.client as any).client.get({
      url: "/session/vcs-diff",
      query,
    })
    return (res.data ?? []) as FileDiff[]
  }

  // Real git refs for the to/from picker
  const [vcsRefs, setVcsRefs] = createSignal<VcsRefs>({ branches: [], tags: [], recent: [] })
  createEffect(() => {
    if (!props.directory) return
    void (sdk.client as any).client.get({ url: "/session/vcs-refs" })
      .then((res: any) => {
        const data = res.data as VcsRefs | undefined
        if (data) setVcsRefs(data)
      })
      .catch(() => {})
    // Also fetch default base ref
    void sdk.client.session.diffTargets({ directory: props.directory })
      .then((res) => {
        if (res.data?.defaultRef && activeFromRef() === "HEAD~1") {
          setActiveFromRef(res.data.defaultRef)
        }
      })
      .catch(() => {})
  })

  const visibleModes = createMemo<ReviewPopoverMode[]>(() => {
    if (hasSession()) return [...REVIEW_POPOVER_MODES]
    return REVIEW_POPOVER_MODES.filter((m) => m !== "session-turn" && m !== "session")
  })

  // --- Stats for mode buttons (green/red +N/-N) ---
  const [modeStatsMap, setModeStatsMap] = createSignal<Partial<Record<ReviewPopoverMode, ReviewModeStats>>>({})

  const reviewIntent = createReviewIntentAdapter({
    session: sdk.client.session,
    formatError: (error) => String(error),
    log: (event, payload) => debug.log(event, payload),
  })

  const patchModeStats = (mode: ReviewPopoverMode, patch: Partial<ReviewModeStats>) => {
    setModeStatsMap((prev) => {
      const current = prev[mode] ?? { additions: 0, deletions: 0, files: 0, loading: false, ready: false }
      return { ...prev, [mode]: { ...current, ...patch } }
    })
  }

  // Source session meta for session-mode stats
  const sourceSessionMeta = createMemo(() => {
    const id = props.sessionId
    if (!id || id === "new") return undefined
    const session = sync.session.get(id)
    const title = session?.title ?? "Session"
    const sessionDiffs = sync.data.session_diff[id] ?? []
    const sessionCount = session?.summary?.files ?? sessionDiffs.length
    const sessionChanges = {
      additions: session?.summary?.additions ?? sumChanges(sessionDiffs).additions,
      deletions: session?.summary?.deletions ?? sumChanges(sessionDiffs).deletions,
    }
    const users = (sync.data.message[id] ?? []).filter((msg): msg is UserMessage => msg.role === "user")
    const lastTurnDiffs = users.at(-1)?.summary?.diffs ?? []
    const turnCount = lastTurnDiffs.length
    const turnChanges = sumChanges(lastTurnDiffs)
    return { title, sessionCount, turnCount, sessionChanges, turnChanges }
  })

  // Sync session-mode stats when popover is open
  createEffect(() => {
    if (!modeSelectorOpen()) return
    reviewIntent.syncSessionModeStats({
      visibleModes: visibleModes(),
      source: sourceSessionMeta(),
      patch: patchModeStats,
    })
  })

  // Clear stats for hidden modes
  createEffect(() => {
    if (!modeSelectorOpen()) return
    reviewIntent.clearHiddenModeStats({
      allModes: REVIEW_POPOVER_MODES,
      visibleModes: visibleModes(),
      patch: patchModeStats,
    })
  })

  // Fetch remote-mode stats when popover is open
  createEffect(() => {
    if (!modeSelectorOpen()) return
    const vcsModes = visibleModes().filter((m) => m !== "session" && m !== "session-turn")
    for (const mode of vcsModes) {
      if (mode === "to-from" && (!activeFromRef().trim() || !activeToRef().trim())) {
        patchModeStats(mode, { loading: false, ready: false, error: "Enter from and to refs" })
        continue
      }
      const sdkMode = mode
      const fromRef = mode === "to-from" ? activeFromRef().trim() : undefined
      const toRef = mode === "to-from" ? activeToRef().trim() : undefined
      patchModeStats(mode, { loading: true, ready: false, error: undefined })
      void fetchVcsDiff(sdkMode, fromRef, toRef)
        .then((diffs) => {
          patchModeStats(mode, {
            additions: diffs.reduce((sum, d) => sum + (d.additions ?? 0), 0),
            deletions: diffs.reduce((sum, d) => sum + (d.deletions ?? 0), 0),
            files: diffs.length,
            loading: false,
            ready: true,
            error: undefined,
          })
        })
        .catch((error) => {
          patchModeStats(mode, { loading: false, ready: false, error: String(error) })
        })
    }
  })

  const getModeStats = (mode: ReviewPopoverMode) => modeStatsMap()[mode]

  const renderModeStats = (mode: ReviewPopoverMode) => {
    const stats = getModeStats(mode)
    if (stats?.loading) {
      return <span class="text-12-regular text-text-weak">...</span>
    }
    if (stats?.ready) {
      return (
        <span class="flex items-center gap-1 text-12-medium">
          <span style={{ color: "#4ade80" }}>+{stats.additions}</span>
          <span style={{ color: "#f87171" }}>-{stats.deletions}</span>
        </span>
      )
    }
    if (stats?.error) {
      return <span class="text-12-medium text-text-danger">!</span>
    }
    return <span class="text-12-regular text-text-weak">--</span>
  }

  // Session ID for the context tab — set by the toggle caller (SessionContextUsage)
  const [contextSessionId, setContextSessionId] = createSignal<string | undefined>()

  // Register this review workspace on the pane bus with both comment:produce
  // and context:toggle capabilities. usePane auto-cleans up on disposal.
  usePane({
    leafId: props.leafId ?? "",
    tabId: props.tabId ?? "",
    type: "review-workspace",
    name: () => REVIEW_MODE_LABEL[activeMode()],
    capabilities: ["comment:produce", "context:toggle", "review:focus-file"],
    handlers: {
      "comment:produce": {
        onRemoveFromConsumer: (path, commentID) => {
          comments.remove(path, commentID)
          prompt.context.removeComment(path, commentID)
        },
      },
      "review:focus-file": {
        onFocusFile: (path) => openPath(path),
      },
      "context:toggle": (sessionId) => {
        if (sessionId) setContextSessionId(sessionId)
        const opening = !store.contextOpen
        setStore("contextOpen", opening)
        if (opening) setStore("activeTab", "context")
        else if (store.activeTab === "context") setStore("activeTab", "review")
      },
    },
  })

  // Auto-bind to the single comment receiver in the same tab (if any)
  createEffect(() => {
    if (!props.leafId || !props.tabId) return
    peersWithCapability("comment:receive", props.tabId) // track registration changes
    autoBind(props.leafId, "comment", "comment:receive")
  })
  onCleanup(() => {
    if (props.leafId) unbind("comment", props.leafId)
  })

  // Resolve which session to show in the context tab:
  // 1. Explicit session from toggle caller (SessionContextUsage passes its session)
  // 2. Bound consumer's session (comment channel binding)
  // 3. Fallback to review's own session
  const contextTabSessionId = createMemo(() => {
    const explicit = contextSessionId()
    if (explicit) return explicit
    if (!props.leafId || !props.tabId) return props.sessionId
    const consumerLeafId = getBound("comment", props.leafId)
    if (!consumerLeafId) return props.sessionId
    const leaves = claxedo.select.multiPaneLeafView(props.tabId)
    const consumerLeaf = leaves.find((l) => l.id === consumerLeafId)
    return consumerLeaf?.content?.sessionId ?? props.sessionId
  })

  // Watch for context item additions AND removals, publish to bound consumer.
  createEffect(
    on(
      () => prompt.context.items() as (ContextItem & { key: string })[],
      (items: (ContextItem & { key: string })[], prevItems: (ContextItem & { key: string })[] | undefined) => {
        if (!props.leafId) return

        // Detect new items → publish to consumer
        const prevKeys = new Set((prevItems ?? []).map((i) => i.key))
        for (const item of items) {
          if (prevKeys.has(item.key)) continue
          if (item.type !== "file") continue
          sendComment(props.leafId, {
            type: "file",
            path: item.path,
            selection: item.selection,
            comment: item.comment,
            commentID: item.commentID,
            commentOrigin: item.commentOrigin,
            preview: item.preview,
          })
        }

        // Detect removed items → publish removal to consumer
        const currentKeys = new Set(items.map((i) => i.key))
        for (const prevItem of prevItems ?? []) {
          if (currentKeys.has(prevItem.key)) continue
          if (prevItem.type !== "file" || !prevItem.commentID) continue
          sendCommentRemoval(props.leafId, prevItem.path, prevItem.commentID)
        }
      },
      { defer: true },
    ),
  )

  const [store, setStore] = createStore({
    openDiffs: [] as string[],
    diffStyle: "unified" as "unified" | "split",
    focusedFile: undefined as string | undefined,
    loading: false,
    remoteDiffs: [] as FileDiff[],
    activeTab: "review" as string,
    contextOpen: false,
    openFileTabs: [] as string[],
  })

  // Sync session data
  createEffect(() => {
    const id = props.sessionId
    if (!id || id === "new" || server.healthy() !== true) return
    void sync.session.sync(id)
    void sync.session.todo(id)
    if (activeMode() !== "session") return
    if (sync.data.session_diff[id] !== undefined) return
    if (sync.status === "loading") return
    void sync.session.diff(id)
  })

  // Fetch VCS diffs for non-session modes (no session required)
  createEffect(() => {
    const currentMode = activeMode()
    if (currentMode === "session" || currentMode === "session-turn") return
    const mode = currentMode

    const from = activeFromRef().trim() || undefined
    const to = activeToRef().trim() || undefined

    setStore("loading", true)
    void fetchVcsDiff(mode, from, to)
      .then((diffs) => {
        setStore("remoteDiffs", diffs)
      })
      .catch(() => {
        setStore("remoteDiffs", [])
      })
      .finally(() => {
        setStore("loading", false)
      })
  })

  const info = createMemo(() => sync.session.get(props.sessionId))
  const messages = createMemo(() => sync.data.message[props.sessionId] ?? [])
  const userMessages = createMemo(
    () => messages().filter((msg): msg is UserMessage => msg.role === "user"),
  )
  const lastUserMessage = createMemo(() => userMessages().at(-1))
  const turnDiffs = createMemo(() => lastUserMessage()?.summary?.diffs ?? [])

  const diffs = createMemo((): FileDiff[] => {
    if (activeMode() === "session-turn") return turnDiffs()
    if (activeMode() === "session")
      return sync.data.session_diff[props.sessionId] ?? []
    return store.remoteDiffs
  })

  const hasReview = createMemo(() => diffs().length > 0)
  const reviewCount = createMemo(() => diffs().length)

  const totalChanges = createMemo(() => {
    const d = diffs()
    return {
      additions: d.reduce((acc, f) => acc + (f.additions ?? 0), 0),
      deletions: d.reduce((acc, f) => acc + (f.deletions ?? 0), 0),
    }
  })

  const diffsReady = createMemo(() => {
    if (activeMode() !== "session") return !store.loading
    return messages().length > 0 || info() !== undefined
  })

  const diffFiles = createMemo(() => diffs().map((d) => d.file))

  const readFile = async (
    path: string,
  ): Promise<FileContent | undefined> => {
    await file.load(path)
    const state = file.get(path)
    return state?.content
  }

  const handleLineComment = (comment: SessionReviewLineComment) => {
    const saved = comments.add({
      file: comment.file,
      selection: comment.selection,
      comment: comment.comment,
    })
    const selection = selectionFromLines(comment.selection)

    // Add to local prompt context — the watcher effect will detect
    // the new item and publish it to the bound consumer automatically.
    prompt.context.add({
      type: "file",
      path: comment.file,
      selection,
      comment: comment.comment,
      commentID: saved.id,
      commentOrigin: "review",
      preview: comment.preview,
    })

    debug.log("line comment added", {
      sessionId: props.sessionId,
      file: comment.file,
      commentID: saved.id,
      boundConsumer: props.leafId ? getBound("comment", props.leafId) : null,
    })
  }

  const handleOpenChange = (open: string[]) => {
    setStore("openDiffs", open)
  }

  const scrollToFile = (path: string) => {
    const escaped = globalThis.CSS && CSS.escape ? CSS.escape(path) : path.replaceAll('"', '\\"')
    const node = document.querySelector(`[data-component="session-review"] [data-file="${escaped}"]`)
    if (!(node instanceof HTMLElement)) return
    node.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const focusReviewDiff = (path: string) => {
    setStore("focusedFile", path)
    setStore("openDiffs", [path])
    setStore("activeTab", "review")
    requestAnimationFrame(() => scrollToFile(path))
  }

  const openPath = (path: string) => {
    if (diffFiles().includes(path)) {
      focusReviewDiff(path)
      return
    }
    void file.load(path)
    openFileTab(file.tab(path))
  }

  const openFileTab = (tabValue: string) => {
    if (tabValue === "review" || tabValue === "context") {
      setStore("activeTab", tabValue)
      return
    }
    // File tab
    if (!store.openFileTabs.includes(tabValue)) {
      setStore("openFileTabs", (tabs) => [...tabs, tabValue])
    }
    setStore("activeTab", tabValue)
  }

  const closeFileTab = (tabId: string) => {
    setStore("openFileTabs", (tabs) => tabs.filter((t) => t !== tabId))
    if (store.activeTab === tabId) {
      setStore("activeTab", "review")
    }
  }

  return (
    <div
      data-testid="review-pane-root"
      data-review-mode={activeMode()}
      data-review-surface="review-workspace"
      class={`relative flex size-full min-h-0 overflow-hidden bg-background-base ${props.class ?? ""}`}
    >
      {/* Review tabs panel — id="review-panel" activates pill-style tab CSS from tabs.css */}
      <div id="review-panel" class="relative flex-1 min-w-0 flex flex-col h-full">
        <Tabs value={store.activeTab} onChange={openFileTab}>
          <div class="sticky top-0 shrink-0 flex">
            <Tabs.List>
              <Tabs.Trigger value="review">
                <div class="flex items-center gap-1.5">
                  <div>{language.t("session.tab.review")}</div>
                  <Show when={hasReview()}>
                    <div>{reviewCount()}</div>
                  </Show>
                </div>
              </Tabs.Trigger>
              <Show when={store.contextOpen}>
                <Tabs.Trigger
                  value="context"
                  closeButton={
                    <IconButton
                      icon="close-small"
                      variant="ghost"
                      class="h-5 w-5"
                      onClick={() => {
                        setStore("contextOpen", false)
                        if (store.activeTab === "context")
                          setStore("activeTab", "review")
                      }}
                      aria-label="Close context"
                    />
                  }
                  hideCloseButton
                  onMiddleClick={() => {
                    setStore("contextOpen", false)
                    if (store.activeTab === "context")
                      setStore("activeTab", "review")
                  }}
                >
                  <div>{language.t("session.tab.context")}</div>
                </Tabs.Trigger>
              </Show>
              <For each={store.openFileTabs}>
                {(tab) => (
                  <Tabs.Trigger
                    value={tab}
                    closeButton={
                      <IconButton
                        icon="close-small"
                        variant="ghost"
                        class="h-5 w-5"
                        onClick={() => closeFileTab(tab)}
                        aria-label="Close file tab"
                      />
                    }
                    hideCloseButton
                    onMiddleClick={() => closeFileTab(tab)}
                  >
                    <span class="max-w-[120px] truncate text-xs">
                      {file.pathFromTab(tab)?.split("/").at(-1) ?? tab}
                    </span>
                  </Tabs.Trigger>
                )}
              </For>
              <StickyAddButton>
                <Tooltip value={language.t("command.file.open")}>
                  <IconButton
                    icon="plus-small"
                    variant="ghost"
                    iconSize="large"
                    class="!rounded-md"
                    onClick={() =>
                      dialog.show(() => (
                        <DialogSelectFile mode="files" />
                      ))
                    }
                    aria-label={language.t("command.file.open")}
                  />
                </Tooltip>
              </StickyAddButton>
            </Tabs.List>
          </div>

          {/* Review tab content */}
          <Tabs.Content
            value="review"
            class="flex flex-col h-full overflow-hidden contain-strict"
          >
            <Show when={store.activeTab === "review"}>
              {/* Mode selector — always visible so user can switch modes even with 0 changes */}
              <div class="sticky top-0 shrink-0 px-3 pt-2 pb-1 flex items-center gap-3 text-13-medium z-10">
                <Popover
                  placement="bottom-start"
                  open={modeSelectorOpen()}
                  onOpenChange={setModeSelectorOpen}
                  trigger={
                    <span class="flex items-center gap-1.5">
                      <span>{REVIEW_MODE_LABEL[activeMode()]}</span>
                      <svg class="w-3 h-3 shrink-0" viewBox="0 0 12 12">
                        <path d="M3 5l3 3 3-3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </span>
                  }
                  triggerAs="button"
                  triggerProps={{
                    class: "flex items-center gap-1.5 px-2 py-1 text-11-medium text-text-base hover:bg-surface-base-hover rounded-md transition-colors",
                  }}
                  class="w-[320px] [&_[data-slot=popover-body]]:p-3"
                >
                  <div class="flex flex-col gap-3">
                    <div class="text-12-medium text-text-weak">Review changes</div>

                    <div class="flex flex-col gap-1">
                      <div class="text-12-medium text-text-weak">Mode</div>
                      <div class="flex flex-col gap-1">
                        <For each={visibleModes()}>
                          {(mode) => (
                            <button
                              type="button"
                              class="h-8 rounded-md border px-2 text-12-medium"
                              classList={{
                                "border-border-weak-base bg-background-base text-text-base": activeMode() !== mode,
                                "border-border-strong-base bg-surface-base-hover text-text-strong": activeMode() === mode,
                              }}
                              onClick={() => setActiveMode(mode)}
                              title={getModeStats(mode)?.error}
                            >
                              <span class="flex items-center justify-between gap-3">
                                <span>{REVIEW_MODE_LABEL[mode]}</span>
                                {renderModeStats(mode)}
                              </span>
                            </button>
                          )}
                        </For>
                      </div>
                    </div>

                    <Show when={activeMode() === "session-turn" || activeMode() === "session"}>
                      <div class="rounded-md border border-border-weak-base px-3 py-2 flex items-center justify-between gap-3">
                        <div class="min-w-0 text-12-medium text-text-weak truncate">
                          {sourceSessionMeta()?.title ?? "Session"}
                        </div>
                      </div>
                    </Show>

                    <Show when={activeMode() === "to-from"}>
                      <div class="grid grid-cols-2 gap-2">
                        <RefPickerField
                          label="From"
                          value={activeFromRef()}
                          onInput={setActiveFromRef}
                          onSelect={setActiveFromRef}
                          placeholder="HEAD~1"
                          refs={vcsRefs()}
                        />
                        <RefPickerField
                          label="To"
                          value={activeToRef()}
                          onInput={setActiveToRef}
                          onSelect={setActiveToRef}
                          placeholder="HEAD"
                          refs={vcsRefs()}
                        />
                      </div>
                    </Show>

                    <div class="flex justify-end">
                      <button
                        type="button"
                        class="h-8 rounded-md bg-surface-interactive-base text-text-on-fill text-12-medium px-4 hover:bg-surface-interactive-base-hover transition-colors"
                        onClick={() => setModeSelectorOpen(false)}
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                </Popover>
                <Show when={hasReview()}>
                  <DiffChanges
                    changes={totalChanges()}
                    class="flex-shrink-0"
                  />
                </Show>
              </div>

              <Switch>
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
                      onOpenChange={handleOpenChange}
                      readFile={readFile}
                      onLineComment={handleLineComment}
                      onViewFile={(path) => {
                        void file.load(path)
                        openFileTab(file.tab(path))
                      }}
                      focusedFile={store.focusedFile}
                      classes={{
                        root: "pb-6 pr-3",
                        header: "px-3",
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
            </Show>
          </Tabs.Content>

          {/* Context tab content */}
          <Show when={store.contextOpen}>
            <Tabs.Content
              value="context"
              class="flex flex-col h-full overflow-hidden contain-strict"
            >
              <Show when={store.activeTab === "context"}>
                <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                  <SessionParamsProvider
                    sessionId={contextTabSessionId}
                    directory={() => props.directory}
                    groupId={() => props.leafId ?? ""}
                  >
                    <SessionContextTab />
                  </SessionParamsProvider>
                </div>
              </Show>
            </Tabs.Content>
          </Show>

          {/* File tab contents */}
          <For each={store.openFileTabs}>
            {(tab) => (
              <Show when={store.activeTab === tab}>
                <FileTabContent tab={tab} />
              </Show>
            )}
          </For>
        </Tabs>
      </div>
    </div>
  )
}
