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
    const id = props.sessionId
    if (!id || id === "new") return
    reviewIntent.refreshDiffModeStats({
      modes: visibleModes().filter((m) => m !== "session" && m !== "session-turn"),
      directory: props.directory,
      sessionID: id,
      committed: activeFromRef().trim() || undefined,
      from: activeFromRef().trim(),
      to: activeToRef().trim(),
      context: undefined,
      patch: patchModeStats,
    })
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
    if (activeMode() !== "session") return
    if (sync.data.session_diff[id] !== undefined) return
    if (sync.status === "loading") return
    void sync.session.diff(id)
  })

  // Fetch remote diffs for non-session modes
  createEffect(() => {
    const id = props.sessionId
    if (!id || id === "new") return
    const currentMode = activeMode()
    if (currentMode === "session" || currentMode === "session-turn") return
    const mode = currentMode === "committed" ? ("to-from" as const) : currentMode

    const from = activeFromRef().trim() || undefined
    const to = activeToRef().trim() || undefined

    setStore("loading", true)
    void sdk.client.session
      .diff({
        sessionID: id,
        mode,
        fromRef: from,
        toRef: to,
      })
      .then((result) => {
        setStore("remoteDiffs", result.data ?? [])
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

                    <Show when={activeMode() === "committed"}>
                      <div class="flex flex-col gap-1">
                        <div class="text-12-medium text-text-weak">Base ref</div>
                        <input
                          class="h-8 rounded-md border border-border-weak-base bg-background-base px-2 text-13-regular"
                          value={activeFromRef()}
                          onInput={(e) => setActiveFromRef(e.currentTarget.value)}
                          placeholder="main"
                        />
                      </div>
                    </Show>

                    <Show when={activeMode() === "to-from"}>
                      <div class="grid grid-cols-2 gap-2">
                        <div class="flex flex-col gap-1">
                          <div class="text-12-medium text-text-weak">From</div>
                          <input
                            class="h-8 rounded-md border border-border-weak-base bg-background-base px-2 text-13-regular"
                            value={activeFromRef()}
                            onInput={(e) => setActiveFromRef(e.currentTarget.value)}
                            placeholder="HEAD~1"
                          />
                        </div>
                        <div class="flex flex-col gap-1">
                          <div class="text-12-medium text-text-weak">To</div>
                          <input
                            class="h-8 rounded-md border border-border-weak-base bg-background-base px-2 text-13-regular"
                            value={activeToRef()}
                            onInput={(e) => setActiveToRef(e.currentTarget.value)}
                            placeholder="HEAD"
                          />
                        </div>
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
                    <div class="h-full px-6 pb-42 flex flex-col items-center justify-center text-center gap-6">
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
