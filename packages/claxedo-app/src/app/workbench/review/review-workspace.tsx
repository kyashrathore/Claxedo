/**
 * ReviewWorkspace
 *
 * A standalone pane leaf that renders the full review experience:
 * - Review panel with sections (review diffs, context, individual files, processes)
 *
 * This mirrors the review experience as a first-class multi-pane leaf.
 */

import {
  Show,
  For,
  createMemo,
  createEffect,
  createSignal,
  on,
  onCleanup,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useQuery } from "@tanstack/solid-query"

import { useLanguage } from "@/platform/i18n/provider"
import { useFile } from "@/app/providers/file"
import { PromptProvider } from "@/features/session/providers/prompt"
import { ClaxedoIcon as Icon, type ClaxedoIconName } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@/lib/path"
import { SessionContextTab } from "@/features/session/ui/components/session-context-tab"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectFile } from "@/features/session/ui/dialogs/select-file"
import { ProcessPanePanel } from "@/features/processes/ui"
import { AddProcessDialog } from "@/features/processes/ui"
import { useProcessPane } from "@/app/workbench/context/process-pane"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { RoleGuardedTerminal } from "@/features/terminal/core/role-guarded-terminal"
import { type ReviewMode } from "@/features/review/review-intent"
import { WorkspaceBrowserPanel } from "@/app/workbench/workspace-panel/browser-panel"
import { reviewTabHeaderSlot } from "@/ui/controls/portal-slot"
import { setReviewWorkspaceActiveTab } from "@/features/review/ui/review-workspace-active-tab"
import { SessionParamsProvider } from "@/features/session/providers/session-params"
import { ReviewTab } from "@/features/review/ui/review-tab"
import { isMarkdownPath, TabFile } from "@/app/workbench/content/tab-file"
import { retainMountedTabsPolicy } from "@/ui/controls/retain-mounted-tabs-policy"
import { useClaxedoState } from "@/app/workbench/state"
import { documentsApi } from "@/features/documents/data/documents-api"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import {
  BROWSER_TAB_ID,
  CONTEXT_TAB_ID,
  REVIEW_TAB,
  REVIEW_TAB_ID,
  closeWorkspaceTab,
  openBrowserWorkspaceTab,
  openContextWorkspaceTab,
  openFileWorkspaceTab,
  openProcessWorkspaceTab,
  processTabId,
  type ReviewWorkspaceTab,
} from "@/features/review/ui/review-workspace-tabs"
import { closeReviewWorkspaceTab } from "./review-close"

function ReviewWorkspaceProcessSection(props: { processId: string; directory: string; active: boolean }) {
  const processPane = useProcessPane()
  const platform = usePlatform()
  const dialog = useDialog()
  const config = createMemo(() => processPane.configs().find((item) => item.id === props.processId))
  const process = createMemo(() => processPane.processForConfig(props.processId))
  const openEditDialog = () => {
    const hit = config()
    if (!hit) return
    dialog.show(() => (
      <AddProcessDialog
        directory={props.directory}
        request={platform.fetch}
        config={hit}
        onDone={() => processPane.refresh()}
      />
    ))
  }
  createEffect(on(
    () => [props.processId, processPane.loaded(), config()?.id] as const,
    ([processId, loaded, configId]) => {
      if (!processId || !loaded || configId) return
      void processPane.refresh()
    },
  ))

  return (
    <Show
      when={config()}
      fallback={
        <div class="flex h-full flex-col items-center justify-center gap-3 text-text-weak">
          <Show
            when={processPane.loaded()}
            fallback={<div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />}
          >
            <Icon name="console" size="medium" />
            <span class="text-sm">Process not found</span>
          </Show>
        </div>
      }
    >
      <ProcessPanePanel
        config={config()!}
        active={props.active}
        process={process()}
        onStart={() => processPane.start(props.processId)}
        onStop={() => processPane.stop(props.processId)}
        onRestart={() => processPane.restart(props.processId)}
        onResolveConflict={(strategy) => processPane.resolveConflict(props.processId, strategy)}
        onResolveRouteConflict={(strategy) => processPane.resolveRouteConflict(props.processId, strategy)}
        onEdit={openEditDialog}
        portalHeader={props.active}
        renderTerminal={(terminal) => <RoleGuardedTerminal pty={terminal} />}
      />
    </Show>
  )
}

export type ReviewWorkspaceProps = {
  sessionId: string
  directory: string
  mode: ReviewMode
  fromRef?: string
  toRef?: string
  focusPath?: string
  focusVersion?: number
  focusFileIntent?: "tab" | "review"
  focusLine?: number
  focusProcessId?: string
  focusProcessVersion?: number
  focusContextSessionId?: string
  focusContextVersion?: number
  focusBrowserUrl?: string
  focusBrowserVersion?: number
  leafId?: string
  surfaceId?: string
  class?: string
  active?: boolean
}

export function ReviewWorkspace(props: ReviewWorkspaceProps) {
  const file = useFile()
  const language = useLanguage()
  const dialog = useDialog()
  const processPane = useProcessPane()
  const claxedoState = useClaxedoState()
  const queryOptions = useQueryOptions()
  const projects = useQuery(() => queryOptions.projects())

  const initialTabs: ReviewWorkspaceTab[] = [REVIEW_TAB]
  if (props.focusContextSessionId) {
    initialTabs.push({ id: CONTEXT_TAB_ID, kind: "context", sessionId: props.focusContextSessionId })
  }

  const [store, setStore] = createStore({
    tabs: initialTabs,
    activeTabId: (props.focusContextSessionId ? CONTEXT_TAB_ID : REVIEW_TAB_ID) as string,
  })
  const [readyFileTabs, setReadyFileTabs] = createSignal<Set<string>>(new Set())
  const [mountedTabIds, setMountedTabIds] = createSignal<string[]>([])
  const [reviewBodyVisible, setReviewBodyVisible] = createSignal(true)
  let pendingActivationFrame: number | undefined
  let reviewScrollFrame: number | undefined
  let reviewScrollElement: HTMLDivElement | undefined
  let reviewScrollTop = 0

  const reviewIsVisible = () => (props.active ?? true) && store.activeTabId === REVIEW_TAB_ID && reviewBodyVisible()
  const restoreReviewScroll = () => {
    if (!reviewScrollElement || !reviewIsVisible()) return
    if (reviewScrollFrame !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(reviewScrollFrame)
    }
    if (typeof requestAnimationFrame !== "function") {
      reviewScrollElement.scrollTop = reviewScrollTop
      return
    }
    reviewScrollFrame = requestAnimationFrame(() => {
      reviewScrollFrame = undefined
      if (!reviewScrollElement || !reviewIsVisible()) return
      reviewScrollElement.scrollTop = reviewScrollTop
    })
  }
  const bindReviewScroll = (element: HTMLDivElement) => {
    reviewScrollElement = element
    restoreReviewScroll()
  }
  const rememberReviewScroll: JSX.EventHandler<HTMLDivElement, Event> = (event) => {
    if (!reviewIsVisible()) return
    reviewScrollTop = event.currentTarget.scrollTop
  }

  const contextTab = createMemo(() =>
    store.tabs.find((t): t is Extract<ReviewWorkspaceTab, { kind: "context" }> => t.kind === "context"),
  )
  const contextSectionSessionId = createMemo(() => contextTab()?.sessionId ?? props.sessionId)

  const activateTabAfterMount = (id: string, defer = false) => {
    if (pendingActivationFrame !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(pendingActivationFrame)
      pendingActivationFrame = undefined
    }
    if (!defer || typeof requestAnimationFrame !== "function") {
      setStore("activeTabId", id)
      return
    }
    pendingActivationFrame = requestAnimationFrame(() => {
      pendingActivationFrame = undefined
      setStore("activeTabId", id)
    })
  }

  const openContextTab = (sessionId: string) => {
    const next = openContextWorkspaceTab({ tabs: store.tabs, sessionId })
    if (next.added) {
      setStore("tabs", next.tabs)
      activateTabAfterMount(CONTEXT_TAB_ID)
      return
    }
    if (next.contextIndex !== undefined) setStore("tabs", next.contextIndex, { sessionId } as Partial<ReviewWorkspaceTab>)
    setStore("activeTabId", CONTEXT_TAB_ID)
  }

  // Line focus for file tabs opened from links (`file.ts:42`) derives straight
  // from the panel focus props below — an intermediate per-tab signal went
  // stale for tabs restored from a panel snapshot (the signal was only set by
  // openFileTab, which a restored tab never went through).
  const fileTabFocusLine = (tabId: string) => {
    const path = props.focusPath
    if (!path || props.focusFileIntent === "review") return undefined
    if (file.tab(path) !== tabId) return undefined
    return props.focusLine
  }

  const openFileTab = (path: string, _line?: number) => {
    const id = file.tab(path)
    const next = openFileWorkspaceTab({ tabs: store.tabs, tabId: id })
    if (next.added) {
      setStore("tabs", next.tabs)
      activateTabAfterMount(id, true)
      scheduleFileTabContent(id, path)
      return
    }
    setStore("activeTabId", id)
    if (!readyFileTabs().has(id)) scheduleFileTabContent(id, path)
  }

  const scheduleFileTabContent = (id: string, path: string) => {
    const mountBody = () => {
      setReadyFileTabs((current) => current.has(id) ? current : new Set(current).add(id))
    }
    if (typeof requestAnimationFrame !== "function") {
      queueMicrotask(mountBody)
      return
    }
    requestAnimationFrame(() => setTimeout(mountBody, 120))
  }

  const openProcessTab = (processId: string) => {
    const next = openProcessWorkspaceTab({ tabs: store.tabs, processId })
    if (next.added) {
      setStore("tabs", next.tabs)
      activateTabAfterMount(next.activeTabId)
      return
    }
    setStore("activeTabId", next.activeTabId)
  }

  const openBrowserTab = (url?: string, navigationVersion?: number) => {
    const next = openBrowserWorkspaceTab({
      tabs: store.tabs,
      browserId: `workspace-browser:${encodeURIComponent(props.directory)}`,
      url,
      navigationVersion,
    })
    if (next.tabs !== store.tabs) setStore("tabs", next.tabs)
    if (next.added) {
      activateTabAfterMount(BROWSER_TAB_ID)
      return
    }
    setStore("activeTabId", BROWSER_TAB_ID)
  }

  const relativeToWorkspace = (path: string) => {
    const filePath = path.replaceAll("\\", "/")
    const directory = props.directory.replaceAll("\\", "/").replace(/\/+$/, "")
    if (!directory) return filePath
    if (filePath === directory) return ""
    if (filePath.startsWith(`${directory}/`)) return filePath.slice(directory.length + 1)
    return filePath
  }

  const collaborateWithMarkdown = async (path: string) => {
    if (!isMarkdownPath(path)) return
    try {
      const project = projects.data?.find((item) =>
        item.worktree === props.directory || item.sandboxes?.includes(props.directory),
      )
      const workspace = (project as typeof project & {
        workspaces?: Record<string, { id?: string; workspaceId?: string }>
      })?.workspaces?.[props.directory]
      const workspaceId = workspace?.workspaceId ?? workspace?.id ?? project?.id
      if (!workspaceId) throw new Error("The workspace identity is unavailable.")
      const document = await documentsApi.createFromRepository({
        displayName: getFilename(path) || "Untitled",
        directory: props.directory,
        workspaceId,
        path: relativeToWorkspace(path),
      })
      claxedoState.layout.openPage(
        document.id,
        document.display_name,
        props.directory,
        document.repository_relative_path ?? path,
      )
    } catch (err) {
      showToast({
        title: "Failed to open document collaboration",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    }
  }

  // Kobalte's controlled-tabs onChange. Just route to activeTabId — the
  // tabs array is the source of truth for which keys are valid, so no
  // existence-check or synthetic-event guard is needed.
  const setActiveTab = (id: string) => setStore("activeTabId", id)
  const mountedTabs = createMemo(() => {
    const ids = new Set(mountedTabIds())
    return store.tabs.filter((tab) => tab.kind !== "review" && ids.has(tab.id))
  })

  createEffect(() => {
    const liveIds = new Set(store.tabs.filter((tab) => tab.kind !== "review").map((tab) => tab.id))
    const activeId = store.activeTabId === REVIEW_TAB_ID ? undefined : store.activeTabId
    setMountedTabIds((mounted) => retainMountedTabsPolicy({
      mounted,
      activeId,
      liveIds,
      limit: 5,
    }))
  })

  let reviewRevealTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(on(
    () => store.activeTabId === REVIEW_TAB_ID,
    (reviewActive) => {
      if (reviewRevealTimer) clearTimeout(reviewRevealTimer)
      reviewRevealTimer = undefined
      if (reviewActive) {
        if (reviewBodyVisible()) return
        if (!store.tabs.some((tab) => tab.kind === "context" || tab.kind === "browser")) {
          setReviewBodyVisible(true)
          return
        }
        reviewRevealTimer = setTimeout(() => setReviewBodyVisible(true), 80)
        return
      }
      setReviewBodyVisible(false)
    },
  ))
  createEffect(() => {
    if (!reviewIsVisible()) return
    restoreReviewScroll()
  })
  onCleanup(() => {
    if (pendingActivationFrame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(pendingActivationFrame)
    if (reviewScrollFrame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(reviewScrollFrame)
    if (reviewRevealTimer) clearTimeout(reviewRevealTimer)
  })

  createEffect(on(
    () => [props.focusVersion, props.focusPath] as const,
    ([, path]) => {
      if (!path) return
      if (props.focusFileIntent === "review") {
        setStore("activeTabId", REVIEW_TAB_ID)
        return
      }
      openFileTab(path, props.focusLine)
    },
  ))

  createEffect(on(
    () => [props.focusProcessVersion, props.focusProcessId] as const,
    ([, id]) => {
      if (!id) return
      openProcessTab(id)
    },
  ))

  createEffect(on(
    () => [props.focusContextVersion, props.focusContextSessionId] as const,
    ([, sessionId]) => {
      if (!sessionId) return
      openContextTab(sessionId)
    },
  ))

  createEffect(on(
    () => [props.focusBrowserVersion, props.focusBrowserUrl] as const,
    ([, url]) => {
      if (!url) return
      openBrowserTab(url, props.focusBrowserVersion)
    },
  ))

  createEffect(() => {
    const active = store.tabs.find((tab) => tab.id === store.activeTabId)
    if (!active) {
      setReviewWorkspaceActiveTab(undefined)
      return
    }
    switch (active.kind) {
      case "review":
        setReviewWorkspaceActiveTab({ kind: "review", label: language.t("session.tab.review") })
        return
      case "context":
        setReviewWorkspaceActiveTab({ kind: "context", label: language.t("session.tab.context") })
        return
      case "file": {
        const path = file.pathFromTab(active.tabId) ?? active.tabId
        setReviewWorkspaceActiveTab({ kind: "file", label: path.split("/").at(-1) ?? path, path })
        return
      }
      case "browser":
        setReviewWorkspaceActiveTab({ kind: "browser", label: "Browser" })
        return
      case "process": {
        const config = processPane.configs().find((item) => item.id === active.processId)
        setReviewWorkspaceActiveTab({ kind: "process", label: config?.name ?? "Process" })
        return
      }
    }
  })

  onCleanup(() => setReviewWorkspaceActiveTab(undefined))

  // Pick the next active tab when `id` is closed. Prefer the neighbor at
  // the same index (the tab that slides into the closing tab's slot).
  const closeTab = (id: string) => {
    const next = closeWorkspaceTab({
      tabs: store.tabs,
      activeTabId: store.activeTabId,
      closeTabId: id,
    })
    if (!next.removed) return
    const remove = () => {
      setStore("tabs", (tabs) => tabs.filter((t) => t.id !== id))
      setReadyFileTabs((current) => {
        if (!current.has(id)) return current
        const updated = new Set(current)
        updated.delete(id)
        return updated
      })
    }
    if (store.activeTabId !== id) {
      remove()
      return
    }
    // Move selection while the trigger still exists, then let Solid finish
    // disposing the active content before the tab item itself is removed.
    setStore("activeTabId", next.activeTabId)
    queueMicrotask(remove)
  }

  // No radius override in `class`: `IconButton` already draws `--radius-sm`, the
  // same corner every other icon button in the app uses. This carried
  // `rounded-full`, which made the one dismiss affordance on the tab a circle.
  const closeButtonFor = (id: string, label: string, visible: boolean) => (
    <IconButton
      icon="close-small"
      variant="ghost"
      class="h-5 w-5 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100"
      classList={{
        "opacity-100 pointer-events-auto": visible,
        "opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100": !visible,
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        closeReviewWorkspaceTab({
          id,
          closePanel: claxedoState.workspacePanel.close,
          closeTab,
        })
      }}
      aria-label={label}
    />
  )

  const tabLabel = (tab: ReviewWorkspaceTab) => {
    switch (tab.kind) {
      case "review":
        return language.t("session.tab.review")
      case "context":
        return language.t("session.tab.context")
      case "file":
        return file.pathFromTab(tab.tabId)?.split("/").at(-1) ?? tab.tabId
      case "browser":
        return "Browser"
      case "process":
        return processPane.configs().find((item) => item.id === tab.processId)?.name ?? "Process"
    }
  }

  const tabIcon = (tab: ReviewWorkspaceTab): ClaxedoIconName => {
    switch (tab.kind) {
      case "review":
        return "review"
      case "context":
        return "circle-half"
      case "file":
        return "file-text"
      case "browser":
        return "globe"
      case "process":
        return "console"
    }
  }

  // Optical sizing: every icon shares the same 16px slot, but a filled square
  // (review) reads larger than an inscribed circle (context/browser) at the
  // same box, so boxy glyphs render a hair smaller and round glyphs a hair
  // larger to equalise perceived size next to the 13px label.
  const tabIconPx = (tab: ReviewWorkspaceTab): number => {
    switch (tab.kind) {
      case "review":
        return 13
      case "file":
      case "process":
        return 14
      case "context":
      case "browser":
        return 15
    }
  }

  const closeLabel = (tab: ReviewWorkspaceTab): string => {
    switch (tab.kind) {
      case "context":
        return "Close context"
      case "file":
        return `Close ${tabLabel(tab)} tab`
      case "browser":
        return "Close browser"
      case "process":
        return "Close process section"
      case "review":
        return "Close review"
    }
  }

  const renderTabButton = (tab: ReviewWorkspaceTab) => {
    const selected = () => store.activeTabId === tab.id
    return (
      <div
        data-slot="workspace-tab"
        data-selected={selected() ? "true" : undefined}
        data-workspace-tab-id={tab.id}
        data-workspace-tab-kind={tab.kind}
        class="group relative my-1 ml-0.5 flex h-7 max-w-[180px] shrink-0 items-center rounded-md border border-transparent text-13-medium transition-[background-color,color] duration-100"
        classList={{
          "bg-surface-base-hover text-text-base": selected(),
          "text-text-weak hover:bg-surface-base-hover/35 hover:text-text-base": !selected(),
        }}
      >
        <button
          type="button"
          class="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2.5 pr-7 leading-none"
          aria-current={selected() ? "true" : undefined}
          onClick={() => setActiveTab(tab.id)}
          onAuxClick={(event) => {
            if (event.button !== 1 || tab.kind === "review") return
            event.preventDefault()
            closeTab(tab.id)
          }}
        >
          <Icon
            name={tabIcon(tab)}
            size="small"
            style={{ width: `${tabIconPx(tab)}px`, height: `${tabIconPx(tab)}px` }}
            classList={{ "text-icon-base": selected(), "text-icon-weak-base": !selected() }}
          />
          <span class="truncate">{tabLabel(tab)}</span>
        </button>
        <div class="absolute right-1 flex h-full items-center">
          {/* `flex` is load-bearing, not cosmetic. As a block, this wrapper laid
              out the inline-flex button on a text baseline, so it measured 22px
              around a 20px button — 2px of descender space below. `items-center`
              centred the 22px box, leaving the X one pixel above the label and
              the tab's own glyph. */}
          <div class="flex" data-testid="workspace-tab-close" data-workspace-tab-id={tab.id}>
            {closeButtonFor(tab.id, closeLabel(tab), selected())}
          </div>
        </div>
      </div>
    )
  }

  const renderTabContent = (tab: ReviewWorkspaceTab) => {
    switch (tab.kind) {
      case "review":
        // Review content is rendered inline below since it owns the panel's
        // primary state (mode selector, diff fetch, etc).
        return null
      case "context":
        return (
          <div class="relative flex h-full min-h-0 flex-col overflow-hidden">
            <SessionParamsProvider
              sessionId={contextSectionSessionId}
              directory={() => props.directory}
              paneId={() => props.leafId ?? ""}
            >
              <SessionContextTab />
            </SessionParamsProvider>
          </div>
        )
      case "file":
        if (!readyFileTabs().has(tab.id)) {
          return (
            <div
              data-testid="workspace-file-tab-deferred"
              class="flex h-full items-center px-4 py-6 text-12-regular text-text-weak"
            >
              Loading...
            </div>
          )
        }
        return (
          <TabFile
            path={file.pathFromTab(tab.tabId) ?? tab.tabId}
            class="h-full"
            hideHeader
            headerActive={store.activeTabId === tab.id}
            focusLine={fileTabFocusLine(tab.tabId)}
            focusNonce={props.focusVersion}
            onCollaborate={() => void collaborateWithMarkdown(file.pathFromTab(tab.tabId) ?? tab.tabId)}
          />
        )
      case "browser":
        return (
          <PromptProvider directory={props.directory} sessionId={props.sessionId}>
            <WorkspaceBrowserPanel
              panelKey={tab.browserId}
              sessionId={props.sessionId}
              initialUrl={tab.url}
              navigationVersion={tab.navigationVersion}
            />
          </PromptProvider>
        )
      case "process":
        return (
          <div class="relative flex h-full min-h-0 flex-col overflow-hidden">
            <ReviewWorkspaceProcessSection
              processId={tab.processId}
              directory={props.directory}
              active={store.activeTabId === tab.id}
            />
          </div>
        )
    }
  }

  const renderTabHeader = () => (
    <div
      data-testid="workspace-tab-header"
      class="flex h-9 w-full max-w-full min-w-0 items-center overflow-hidden bg-background-base"
      style={{ width: "100%" }}
    >
      <div
        data-testid="workspace-tab-scroll"
        class="flex h-full min-w-0 flex-1 items-center overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <For each={store.tabs}>
          {(tab) => renderTabButton(tab)}
        </For>
        <div
          data-testid="workspace-tab-actions"
          class="flex h-full shrink-0 items-center bg-background-base px-1"
        >
          <DropdownMenu gutter={4} placement="bottom-start">
            <DropdownMenu.Trigger
              class="flex size-6 items-center justify-center rounded-sm text-icon-weak-base transition-colors hover:bg-surface-base-hover hover:text-icon-base"
              aria-label="Add workspace tab"
              title="Add workspace tab"
            >
              <Icon name="plus-small" size="small" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="z-[200]">
                <DropdownMenu.Item
                  onSelect={() =>
                    dialog.show(() => (
                      <DialogSelectFile
                        mode="files"
                        directory={props.directory}
                        sessionId={props.sessionId}
                        fileApi={file}
                        onOpenFile={openFileTab}
                      />
                    ))
                  }
                >
                  <Icon name="file-text" size="small" />
                  File
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => openContextTab(props.sessionId)}>
                  <Icon name="circle-half" size="small" />
                  Context
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => openBrowserTab()}>
                  <Icon name="globe" size="small" />
                  Browser
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )

  return (
    <div
      data-testid="review-pane-root"
      data-review-mode={props.mode}
      data-review-surface="workspace-review"
      class={`relative flex size-full min-h-0 overflow-hidden bg-background-base ${props.class ?? ""}`}
    >
      {/* Review section panel — id="review-panel" activates pill-style tab CSS from tabs.css */}
      <div id="review-panel" class="relative flex-1 min-w-0 flex flex-col h-full">
        <div class="flex min-h-0 flex-1 flex-col bg-background-stronger">
          <Show
            when={reviewTabHeaderSlot()}
            fallback={<div class="sticky top-0 shrink-0 flex">{renderTabHeader()}</div>}
          >
            {(host) => (
              <Portal mount={host()}>
                {renderTabHeader()}
              </Portal>
            )}
          </Show>

          <div class="relative min-h-0 flex-1 overflow-hidden contain-strict">
            <div
              class="absolute inset-0 h-full flex-col overflow-hidden"
              classList={{
                flex: reviewBodyVisible(),
                hidden: !reviewBodyVisible(),
                "pointer-events-none": store.activeTabId !== REVIEW_TAB_ID || !reviewBodyVisible(),
              }}
              aria-hidden={store.activeTabId === REVIEW_TAB_ID && reviewBodyVisible() ? undefined : "true"}
            >
              <ReviewTab
                directory={props.directory}
                sessionId={props.sessionId}
                initialMode={props.mode}
                initialFromRef={props.fromRef}
                initialToRef={props.toRef}
                focusedDiffPath={props.focusFileIntent === "review" ? props.focusPath : undefined}
                focusedDiffVersion={props.focusVersion}
                onOpenFile={openFileTab}
                scrollRef={bindReviewScroll}
                onScroll={rememberReviewScroll}
              />
            </div>

            <For each={mountedTabs()}>
              {(tab) => (
                <div
                  class="absolute inset-0 h-full min-h-0 overflow-hidden"
                  classList={{
                    "pointer-events-none": store.activeTabId !== tab.id,
                  }}
                  aria-hidden={store.activeTabId === tab.id ? undefined : "true"}
                  style={{ visibility: store.activeTabId === tab.id ? undefined : "hidden" }}
                >
                  {renderTabContent(tab)}
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  )
}
