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
  on,
  type ComponentProps,
} from "solid-js"
import { createStore } from "solid-js/store"

import { useFile, usePlatform } from "@opencode-ai/claxedo-app"
import { useLanguage } from "@/context/language"
import { PromptProvider } from "@/context/prompt"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { SessionContextTab } from "@/components/session/session-context-tab"
import { FileTabContent } from "@/pages/session/file-tabs"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectFile } from "@/components/dialog-select-file"
import { ProcessPanePanel } from "../workspace-panel/ProcessPanePanel"
import { WORKSPACE_PANEL_TOGGLE_FULLWIDTH, workspacePanelFullWidth } from "../workspace-panel/WorkspacePanel"
import { WorkspaceBrowserPanel } from "../workspace-panel/WorkspaceBrowserPanel"
import { AddProcessDialog } from "./add-process-dialog"
import { useProcessPane } from "../context/process-pane"
import { type ReviewMode } from "../workspace-panel/review-intent"
import { SessionParamsProvider } from "../context/session-params"
import { ReviewTab } from "./review-tab"

const PROCESS_SECTION_PREFIX = "process:"

function processTabId(processId: string) {
  return `${PROCESS_SECTION_PREFIX}${processId}`
}

type WorkspaceTab =
  | { id: "review"; kind: "review" }
  | { id: "context"; kind: "context"; sessionId: string }
  | { id: string; kind: "file"; tabId: string }
  | { id: string; kind: "process"; processId: string }
  | { id: string; kind: "browser"; url?: string; title?: string }

const REVIEW_TAB_ID = "review"
const CONTEXT_TAB_ID = "context"
const REVIEW_TAB: WorkspaceTab = { id: REVIEW_TAB_ID, kind: "review" }

function ProcessSectionLabel(props: { processId: string }) {
  const processPane = useProcessPane()
  const config = createMemo(() => processPane.configs().find((item) => item.id === props.processId))

  return (
    <span class="max-w-[120px] truncate text-xs">
      {config()?.name ?? "Process"}
    </span>
  )
}

function ReviewWorkspaceProcessSection(props: { processId: string; directory: string; active: boolean }) {
  const processPane = useProcessPane()
  const dialog = useDialog()
  const config = createMemo(() => processPane.configs().find((item) => item.id === props.processId))
  const process = createMemo(() => processPane.processForConfig(props.processId))
  const openEditDialog = () => {
    const hit = config()
    if (!hit) return
    dialog.show(() => (
      <AddProcessDialog
        directory={props.directory}
        config={hit}
        onDone={() => processPane.refresh()}
      />
    ))
  }

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
            <span class="text-[12px]">Process not found</span>
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
  focusProcessId?: string
  focusProcessVersion?: number
  focusContextSessionId?: string
  focusContextVersion?: number
  leafId?: string
  surfaceId?: string
  class?: string
}

export function ReviewWorkspace(props: ReviewWorkspaceProps) {
  const file = useFile()
  const language = useLanguage()
  const dialog = useDialog()
  const platform = usePlatform()

  const initialTabs: WorkspaceTab[] = [REVIEW_TAB]
  if (props.focusContextSessionId) {
    initialTabs.push({ id: CONTEXT_TAB_ID, kind: "context", sessionId: props.focusContextSessionId })
  }

  const [store, setStore] = createStore({
    tabs: initialTabs as WorkspaceTab[],
    activeTabId: (props.focusContextSessionId ? CONTEXT_TAB_ID : REVIEW_TAB_ID) as string,
  })

  const contextTab = createMemo(() =>
    store.tabs.find((t): t is Extract<WorkspaceTab, { kind: "context" }> => t.kind === "context"),
  )
  const contextSectionSessionId = createMemo(() => contextTab()?.sessionId ?? props.sessionId)

  // Defer activeTabId until Solid flushes the trigger-mount effect that
  // registers the new tab into Kobalte's DomCollection. Without this gap,
  // Kobalte's auto-select effect runs first, sees a selectedKey pointing
  // to a not-yet-registered trigger, and falls back to the first key in
  // the collection (which is always "review").
  const activateTabAfterMount = (id: string) => {
    queueMicrotask(() => setStore("activeTabId", id))
  }

  const openContextTab = (sessionId: string) => {
    const idx = store.tabs.findIndex((t) => t.kind === "context")
    if (idx === -1) {
      setStore("tabs", (tabs) => [...tabs, { id: CONTEXT_TAB_ID, kind: "context", sessionId }])
      activateTabAfterMount(CONTEXT_TAB_ID)
      return
    }
    setStore("tabs", idx, { sessionId } as Partial<WorkspaceTab>)
    setStore("activeTabId", CONTEXT_TAB_ID)
  }

  const openFileTab = (path: string) => {
    void file.load(path)
    const id = file.tab(path)
    if (store.tabs.some((t) => t.id === id)) {
      setStore("activeTabId", id)
      return
    }
    setStore("tabs", (tabs) => [...tabs, { id, kind: "file", tabId: id }])
    activateTabAfterMount(id)
  }

  const openProcessTab = (processId: string) => {
    const id = processTabId(processId)
    if (store.tabs.some((t) => t.id === id)) {
      setStore("activeTabId", id)
      return
    }
    setStore("tabs", (tabs) => [...tabs, { id, kind: "process", processId }])
    activateTabAfterMount(id)
  }

  // Browser tabs are user-created via the "+" menu. Each one mounts an
  // independent BrowserPane keyed on the tab id, so multiple browser tabs
  // hold separate webviews. Lifetime is the panel's — closing the
  // workspace panel tears them down (same as file tabs).
  const openBrowserTab = (input: { url?: string; title?: string } = {}) => {
    const id = `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    setStore("tabs", (tabs) => [...tabs, { id, kind: "browser", url: input.url, title: input.title }])
    activateTabAfterMount(id)
  }

  // Kobalte's controlled-tabs onChange. Just route to activeTabId — the
  // tabs array is the source of truth for which keys are valid, so no
  // existence-check or synthetic-event guard is needed.
  const setActiveTab = (id: string) => setStore("activeTabId", id)

  createEffect(on(
    () => [props.focusVersion, props.focusPath] as const,
    ([, path]) => {
      if (!path) return
      if (props.focusFileIntent === "review") {
        setStore("activeTabId", REVIEW_TAB_ID)
        return
      }
      openFileTab(path)
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

  // Pick the next active tab when `id` is closed. Prefer the neighbor at
  // the same index (the tab that slides into the closing tab's slot).
  const nextActiveAfter = (id: string): string => {
    if (store.activeTabId !== id) return store.activeTabId
    const idx = store.tabs.findIndex((t) => t.id === id)
    const after = store.tabs.filter((t) => t.id !== id)
    if (after.length === 0) return REVIEW_TAB_ID
    return after[Math.min(idx, after.length - 1)]?.id ?? REVIEW_TAB_ID
  }

  const closeTab = (id: string) => {
    if (id === REVIEW_TAB_ID) return
    if (!store.tabs.some((t) => t.id === id)) return
    const next = nextActiveAfter(id)
    const remove = () => setStore("tabs", (tabs) => tabs.filter((t) => t.id !== id))
    if (store.activeTabId !== id) {
      remove()
      return
    }
    // Move selection while the trigger still exists, then let Solid finish
    // disposing the active content before the tab item itself is removed.
    setStore("activeTabId", next)
    queueMicrotask(remove)
  }

  const closeButtonFor = (id: string, label: string) => (
    <IconButton
      icon="close-small"
      variant="ghost"
      class="h-5 w-5"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        closeTab(id)
      }}
      aria-label={label}
    />
  )

  const renderTabTrigger = (tab: WorkspaceTab) => {
    switch (tab.kind) {
      case "review":
        return (
          <Tabs.Trigger value={tab.id}>
            <div>{language.t("session.tab.review")}</div>
          </Tabs.Trigger>
        )
      case "context":
        return (
          <Tabs.Trigger
            value={tab.id}
            closeButton={closeButtonFor(tab.id, "Close context")}
            hideCloseButton
            onMiddleClick={() => closeTab(tab.id)}
          >
            <div>{language.t("session.tab.context")}</div>
          </Tabs.Trigger>
        )
      case "file":
        return (
          <Tabs.Trigger
            value={tab.id}
            closeButton={closeButtonFor(tab.id, "Close file section")}
            hideCloseButton
            onMiddleClick={() => closeTab(tab.id)}
          >
            <span class="max-w-[120px] truncate text-xs">
              {file.pathFromTab(tab.tabId)?.split("/").at(-1) ?? tab.tabId}
            </span>
          </Tabs.Trigger>
        )
      case "process":
        return (
          <Tabs.Trigger
            value={tab.id}
            closeButton={closeButtonFor(tab.id, "Close process section")}
            hideCloseButton
            onMiddleClick={() => closeTab(tab.id)}
          >
            <ProcessSectionLabel processId={tab.processId} />
          </Tabs.Trigger>
        )
      case "browser":
        return (
          <Tabs.Trigger
            value={tab.id}
            closeButton={closeButtonFor(tab.id, "Close browser tab")}
            hideCloseButton
            onMiddleClick={() => closeTab(tab.id)}
          >
            <span class="flex max-w-[160px] items-center gap-1 truncate text-xs">
              <Icon name="square-arrow-top-right" size="small" class="shrink-0" />
              <span class="truncate">
                {tab.title?.trim() || tab.url?.replace(/^https?:\/\//, "") || "New tab"}
              </span>
            </span>
          </Tabs.Trigger>
        )
    }
  }

  const renderTabContent = (tab: WorkspaceTab) => {
    switch (tab.kind) {
      case "review":
        // Review content is rendered inline below since it owns the panel's
        // primary state (mode selector, diff fetch, etc).
        return null
      case "context":
        return (
          <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
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
        return (
          <SessionParamsProvider
            sessionId={() => props.sessionId}
            directory={() => props.directory}
            paneId={() => props.leafId ?? ""}
            surfaceId={() => props.surfaceId}
            leafId={() => props.leafId}
          >
            <PromptProvider>
              <FileTabContent tab={tab.tabId} onLinkOpen={openFileTab} />
            </PromptProvider>
          </SessionParamsProvider>
        )
      case "process":
        return (
          <div class="relative flex-1 min-h-0 overflow-hidden">
            <ReviewWorkspaceProcessSection
              processId={tab.processId}
              directory={props.directory}
              active={store.activeTabId === tab.id}
            />
          </div>
        )
      case "browser":
        return (
          <div class="relative flex-1 min-h-0 overflow-hidden">
            <SessionParamsProvider
              sessionId={() => props.sessionId}
              directory={() => props.directory}
              paneId={() => props.leafId ?? ""}
              surfaceId={() => props.surfaceId}
              leafId={() => props.leafId}
            >
              <PromptProvider>
                <WorkspaceBrowserPanel
                  panelKey={`browser:${props.directory}:${tab.id}`}
                  sessionId={props.sessionId}
                />
              </PromptProvider>
            </SessionParamsProvider>
          </div>
        )
    }
  }

  return (
    <div
      data-testid="review-pane-root"
      data-review-mode={props.mode}
      data-review-surface="workspace-review"
      class={`relative flex size-full min-h-0 overflow-hidden bg-background-base ${props.class ?? ""}`}
    >
      {/* Review section panel — id="review-panel" activates pill-style tab CSS from tabs.css */}
      <div id="review-panel" class="relative flex-1 min-w-0 flex flex-col h-full">
        <Tabs value={store.activeTabId} onChange={setActiveTab}>
          <div class="sticky top-0 shrink-0 flex">
            <Tabs.List>
              <For each={store.tabs}>
                {(tab) => renderTabTrigger(tab)}
              </For>
              <div class="sticky right-0 shrink-0 flex items-center ml-auto">
                <Popover
                  placement="bottom-end"
                  class="z-50 min-w-[200px] rounded-md border border-border-weak-base bg-background-base p-1 shadow-lg"
                  triggerAs="button"
                  triggerProps={{
                    type: "button" as const,
                    class:
                      "flex size-7 items-center justify-center rounded-md text-icon-weak-base transition-colors hover:bg-surface-base-hover hover:text-icon-base",
                    "aria-label": language.t("command.file.open"),
                  } as ComponentProps<"button">}
                  trigger={<Icon name="plus-small" size="large" />}
                >
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-12-regular text-text-base transition-colors hover:bg-surface-base-hover"
                    onClick={() => dialog.show(() => <DialogSelectFile mode="files" />)}
                    data-testid="workspace-tab-open-file"
                  >
                    <Icon name="page" size="small" class="text-text-weak" />
                    <span>{language.t("command.file.open")}</span>
                  </button>
                  <Show when={platform.platform === "desktop"}>
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-12-regular text-text-base transition-colors hover:bg-surface-base-hover"
                      onClick={() => openBrowserTab()}
                      data-testid="workspace-tab-open-browser"
                    >
                      <Icon name="square-arrow-top-right" size="small" class="text-text-weak" />
                      <span>Open Browser Tab</span>
                    </button>
                  </Show>
                </Popover>
                <Tooltip value={workspacePanelFullWidth() ? "Collapse workspace panel" : "Expand workspace panel"}>
                  <button
                    type="button"
                    aria-label={workspacePanelFullWidth() ? "Collapse workspace panel" : "Expand workspace panel"}
                    aria-pressed={workspacePanelFullWidth() ? "true" : "false"}
                    class="flex items-center justify-center size-6 rounded text-icon-weak-base hover:text-icon-base hover:bg-surface-base-hover transition-colors cursor-pointer border-none bg-transparent"
                    onClick={() => window.dispatchEvent(new Event(WORKSPACE_PANEL_TOGGLE_FULLWIDTH))}
                  >
                    <Icon
                      name="chevron-double-right"
                      size="small"
                      class={workspacePanelFullWidth() ? "" : "rotate-180"}
                    />
                  </button>
                </Tooltip>
              </div>
            </Tabs.List>
          </div>

          {/* Review tab content */}
          <Tabs.Content
            value="review"
            class="flex flex-col h-full overflow-hidden contain-strict"
          >
            <Show when={store.activeTabId === REVIEW_TAB_ID}>
              <ReviewTab
                directory={props.directory}
                sessionId={props.sessionId}
                initialMode={props.mode}
                initialFromRef={props.fromRef}
                initialToRef={props.toRef}
                focusedDiffPath={props.focusFileIntent === "review" ? props.focusPath : undefined}
                focusedDiffVersion={props.focusVersion}
                onOpenFile={openFileTab}
              />
            </Show>
          </Tabs.Content>

          {/* Non-review tab contents (review owns the panel state and renders inline above) */}
          <For each={store.tabs}>
            {(tab) => (
              <Show when={tab.kind !== "review" && store.activeTabId === tab.id}>
                {renderTabContent(tab)}
              </Show>
            )}
          </For>
        </Tabs>
      </div>
    </div>
  )
}
