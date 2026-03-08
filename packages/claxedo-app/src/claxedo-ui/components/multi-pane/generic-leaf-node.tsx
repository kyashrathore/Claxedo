/**
 * GenericLeafNode
 *
 * Per-leaf renderer for multi-pane tabs. Renders pane content and a
 * compact pane header with split/create actions.
 */

import { For, Show, Switch, Match, Suspense, lazy, createMemo, createEffect, createSignal, on, onCleanup, onMount, type Accessor } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { DialogSettings, useGlobalSync, useSync, useComments, useServer } from "@opencode-ai/claxedo-app"
import { REVIEW_MODE_LABEL } from "../../context/claxedo-layout/review-intent"
import { useClaxedoLayout, type PaneContent } from "../../context/claxedo-layout"
import { DirectoryScope } from "../directory-scope"
import { useGlobalSDK } from "@/context/global-sdk"
import { SDKProvider } from "@/context/sdk"
import { usePrompt } from "@/context/prompt"
import { useLocal } from "@/context/local"
import { SessionParamsProvider } from "../../context/session-params"
import { GroupIdProvider } from "../../context/group-id"
import { GroupLayoutProvider } from "../group-layout-provider"
import { TabReview } from "../tab-review"
import { ReviewWorkspace } from "../review-workspace"
import { TabFile } from "../tab-file"
import { TabPage } from "../tab-page"
import { PageIndex } from "../page-index"
import { TabContext } from "../tab-context"
import { PaneTerminal } from "./pane-terminal"
import { FileTreePane } from "./file-tree-pane"
import { useProcessPane } from "../../context/process-pane"
import { ProcessPanePanel } from "../process-pane-panel"
import { AddProcessDialog } from "../add-process-dialog"
import { getTerminalCommands } from "../../../components/settings-terminals"
import { pagesApi } from "../../../utils/pages-api"
import { requestTerminalFitOnPaneChange, requestTerminalFitOnPaneFocus } from "./terminal-fit"
import { createDebugLogger } from "../../../overrides/utils/debug"
import { sessionPaneSummary } from "../../utils/session-pane-summary"
import { cachedTerminalSessionPreview } from "../../utils/terminal-session-preview"
import { cachedTerminalLogSummary } from "../../utils/terminal-log-summary"
import { terminalSessionSummary } from "../../utils/terminal-session-summary"
import { createPreviewLoader } from "../../utils/preview-loader"
import {
  usePane,
  notifyProducerRemoval,
  peersWithCapability,
  getBound,
  bind,
} from "../../context/pane-bus"
import { isMarkdownPath, openMarkdownPageTab } from "../../utils/open-markdown-page-tab"

const paneLeafDebug = createDebugLogger("pane.leaf.summary", "pane:leaf", {
  defaultLevel: 0,
})

const SessionPage = lazy(() => import("../../../overrides/pages/session"))

function Loading() {
  return (
    <div class="flex items-center justify-center h-full text-text-weak">
      <div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
    </div>
  )
}

function PickerItem(props: { icon: string; label: string; onClick: () => void; muted?: boolean }) {
  return (
    <button
      type="button"
      class="flex items-center gap-2.5 w-full px-2.5 py-1.5 text-left text-12-regular transition-colors duration-100 hover:bg-surface-base-hover"
      classList={{ "text-text-weak hover:text-text-base": !props.muted, "text-text-weaker hover:text-text-weak": !!props.muted }}
      onClick={props.onClick}
    >
      <Icon name={props.icon as any} size="small" class="shrink-0" />
      <span>{props.label}</span>
    </button>
  )
}

function ContentPicker(props: {
  onSession: () => void
  onClaude: () => void
  onCodex: () => void
  onTerminal: () => void
  onPage: () => void
  onReviewWorkspace: () => void
  onConfigure: () => void
  custom: Array<{ name: string; command: string }>
  onCustom: (cmd: { name: string; command: string }) => void
}) {
  return (
    <div class="flex size-full items-center justify-center p-8">
      <div class="flex w-full max-w-[240px] flex-col items-center gap-4">
        <Icon name="dot-grid" size="large" class="text-icon-weak-base" />
        <div class="flex flex-col gap-1 items-center text-center">
          <div class="text-14-medium text-text-strong">New pane</div>
          <div class="text-12-regular text-text-weak">Choose what to display</div>
        </div>
        <div class="flex flex-col w-full mt-1">
          <PickerItem icon="new-session" label="Session" onClick={props.onSession} />
          <PickerItem icon="brain" label="Claude" onClick={props.onClaude} />
          <PickerItem icon="code" label="Codex" onClick={props.onCodex} />
          <PickerItem icon="console" label="Terminal" onClick={props.onTerminal} />
          <PickerItem icon="page" label="Page" onClick={props.onPage} />
          <PickerItem icon="code-lines" label="Review" onClick={props.onReviewWorkspace} />
          <For each={props.custom}>
            {(cmd) => <PickerItem icon="console" label={cmd.name} onClick={() => props.onCustom(cmd)} />}
          </For>
          <div class="border-t border-border-weak-base my-1" />
          <PickerItem icon="settings-gear" label="Configure..." onClick={props.onConfigure} muted />
        </div>
      </div>
    </div>
  )
}

/**
 * Registers a session pane on the pane bus with comment:receive (for review
 * workspaces) and model:provide (for sibling page AI). Single registration
 * avoids overwriting — pane bus stores one registration per leafId.
 * Must be rendered inside DirectoryScope.
 */
function SessionPaneBusConsumer(props: { leafId: string; tabId: string; sessionId: string }) {
  const sync = useSync()
  const prompt = usePrompt()
  const local = useLocal()

  usePane({
    leafId: props.leafId,
    tabId: props.tabId,
    type: "session",
    name: () => {
      if (!props.sessionId || props.sessionId === "new") return "Session"
      const info = sync.session.get(props.sessionId)
      return info?.title || "Session"
    },
    capabilities: ["comment:receive", "model:provide", "session:provide"],
    handlers: {
      "comment:receive": {
        onComment: (payload) => prompt.context.add(payload),
        onRemove: (path, commentID) => prompt.context.removeComment(path, commentID),
      },
      "model:provide": () => {
        const m = local.model.current()
        if (!m) return undefined
        return { providerID: m.provider.id, modelID: m.id }
      },
      "session:provide": () => {
        if (!props.sessionId || props.sessionId === "new") return undefined
        return props.sessionId
      },
    },
  })

  // Watch for removals in session's prompt context → notify review workspace
  createEffect(
    on(
      () => prompt.context.items() as { key: string; type: string; path: string; commentID?: string }[],
      (items, prevItems) => {
        if (!prevItems) return
        const currentKeys = new Set(items.map((i) => i.key))
        for (const prevItem of prevItems) {
          if (currentKeys.has(prevItem.key)) continue
          if (prevItem.type !== "file" || !prevItem.commentID) continue
          notifyProducerRemoval(props.leafId, prevItem.path, prevItem.commentID)
        }
      },
      { defer: true },
    ),
  )

  return null
}

/**
 * Renders a single process within a multi-pane leaf.
 * Uses useProcessPane() from the shared provider in MultiPaneTab.
 */
function ProcessLeafContent(props: { processId: string; directory: string }) {
  const pp = useProcessPane()
  const dialog = useDialog()
  const debug = createDebugLogger("layout.process", "layout:process", {
    legacyKey: "opencode.debug.terminal",
  })
  const inst = Math.random().toString(36).slice(2, 7)

  const config = createMemo(() => pp.configs().find((c) => c.id === props.processId))
  const process = createMemo(() => pp.processForConfig(props.processId))
  const snap = () => ({
    inst,
    processId: props.processId,
    dir: props.directory,
    loaded: pp.loaded(),
    configId: config()?.id ?? null,
    status: process()?.status ?? null,
    ptyId: process()?.ptyId ?? null,
    configs: pp.configs().length,
  })

  onMount(() => {
    debug.verbose("process leaf mount", snap())
  })

  onCleanup(() => {
    debug.log("process leaf cleanup", snap())
    queueMicrotask(() => {
      debug.verbose("process leaf cleanup settled", snap())
    })
  })
  createEffect(
    on(
      () => [pp.loaded(), config()?.id ?? null, process()?.status ?? null, process()?.ptyId ?? null] as const,
      () => {
        debug.verbose("process leaf state", snap())
      },
      { defer: true },
    ),
  )

  const openEditDialog = () => {
    const cfg = config()
    if (!cfg) return
    dialog.show(() => (
      <AddProcessDialog
        config={cfg}
        onDone={() => pp.refresh()}
      />
    ))
  }

  return (
    <Show
      when={config()}
      fallback={
        <div class="flex flex-col items-center justify-center h-full text-text-weak gap-3">
          <Show
            when={pp.loaded()}
            fallback={
              <div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
            }
          >
            <Icon name="console" size="medium" />
            <span class="text-[12px]">Process not found</span>
          </Show>
        </div>
      }
    >
      {(cfg) => (
        <ProcessPanePanel
          config={cfg()}
          process={process()}
          onStart={() => pp.start(props.processId)}
          onStop={() => pp.stop(props.processId)}
          onRestart={() => pp.restart(props.processId)}
          onEdit={openEditDialog}
        />
      )}
    </Show>
  )
}

/** Placeholder leaf shown before process configs are loaded, or empty state when none exist. */
function ProcessPlaceholder(props: { directory: string }) {
  const pp = useProcessPane()
  const loaded = createMemo(() => pp.loaded())
  const hasConfigs = createMemo(() => pp.configs().length > 0)

  return (
    <div class="flex flex-col items-center justify-center h-full text-text-weak gap-3">
      <Show
        when={loaded() && !hasConfigs()}
        fallback={
          <div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
        }
      >
        <Icon name="console" size="medium" />
        <span class="text-[12px]">No processes configured</span>
      </Show>
    </div>
  )
}

type GenericLeafNodeProps = {
  tabId: string
  groupId: string
  leafId: string
  content: Accessor<PaneContent | undefined>
  isFocused: Accessor<boolean>
  isZoomed: Accessor<boolean>
  isOnlyLeaf: Accessor<boolean>
  isFloating?: Accessor<boolean>
  isDragging?: Accessor<boolean>
  isDragOver?: Accessor<boolean>
  isDragActive?: Accessor<boolean>
  onStartMove?: (e: PointerEvent) => void
  onClose: () => void
  onFocus: () => void
}

export function GenericLeafNode(props: GenericLeafNodeProps) {
  const claxedo = useClaxedoLayout()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const server = useServer()
  const dialog = useDialog()
  const dim = () => (props.isZoomed() ? 1 : props.isFocused() ? 1 : 0.7)
  const { terminalSession, terminalLog, ensureTerminalSession } =
    createPreviewLoader({
      sdkUrl: () => globalSDK.url,
      serverHealthy: () => server.healthy() === true,
      globalSyncChild: (dir, opts) => globalSync.child(dir, opts),
      fetchSessionMessages: (params) => globalSDK.client.session.messages(params),
      debug: paneLeafDebug,
    })

  createEffect(() => {
    const content = props.content()
    if (!content || content.type !== "terminal" || !content.terminalId) return
    claxedo.terminal.agentStatus(content.terminalId)
    if (paneLeafDebug.enabled(2)) {
      paneLeafDebug.verbose("terminal pane observed", {
        tabId: props.tabId,
        leafId: props.leafId,
        terminalId: content.terminalId,
        directory: content.directory,
      })
    }
    ensureTerminalSession(content.terminalId, content.directory)
  })

  const sessionTitle = createMemo(() => {
    const content = props.content()
    if (!content) return ""
    if (content.type !== "session" && content.type !== "review" && content.type !== "review-workspace" && content.type !== "context") return ""
    if (!content.sessionId || content.sessionId === "new" || !content.directory) return ""
    const [store] = globalSync.child(content.directory, { bootstrap: false })
    return sessionPaneSummary(store, content.sessionId).title
  })

  const terminalTitle = createMemo(() => {
    const content = props.content()
    if (!content || content.type !== "terminal" || !content.terminalId) return ""
    const resolved =
      terminalSession[content.terminalId] ?? cachedTerminalSessionPreview(globalSDK.url, content.terminalId)
    const sessionId = resolved?.sessionId
    if (!sessionId || sessionId === "new") return ""
    const directory = resolved?.workspaceId || content.directory
    if (!directory) return ""
    const [store] = globalSync.child(directory, { bootstrap: false })
    return sessionPaneSummary(store, sessionId).title
  })

  const terminalSessionTitle = createMemo(() => {
    const content = props.content()
    if (!content || content.type !== "terminal" || !content.terminalId) return ""
    const resolved =
      terminalSession[content.terminalId] ?? cachedTerminalSessionPreview(globalSDK.url, content.terminalId)
    if (!resolved) return ""
    return terminalSessionSummary(resolved || undefined)?.title || ""
  })

  const terminalLogTitle = createMemo(() => {
    const content = props.content()
    if (!content || content.type !== "terminal" || !content.terminalId || !content.directory) return ""
    const resolved =
      terminalSession[content.terminalId] ?? cachedTerminalSessionPreview(globalSDK.url, content.terminalId)
    const provider = (resolved?.provider || "").toLowerCase()
    if (provider !== "opencode") return ""
    const directory = resolved?.workspaceId || content.directory
    if (!directory) return ""
    const preview =
      terminalLog[content.terminalId] ?? cachedTerminalLogSummary(globalSDK.url, content.terminalId, directory)
    return preview?.title || ""
  })

  const contentTitle = createMemo(() => {
    const content = props.content()
    if (!content) return "Empty"
    if (content.type === "terminal" && terminalSessionTitle()) return terminalSessionTitle()
    if (content.type === "terminal" && terminalTitle()) return terminalTitle()
    if (content.type === "terminal" && terminalLogTitle()) return terminalLogTitle()
    if ((content.type === "session" || content.type === "review" || content.type === "review-workspace" || content.type === "context") && sessionTitle()) {
      return sessionTitle()
    }
    if (content.title) return content.title
    if (content.type === "session") return "Session"
    if (content.type === "terminal") return "Terminal"
    if (content.type === "file") return content.filePath?.split("/").at(-1) ?? "File"
    if (content.type === "review") return "Review"
    if (content.type === "review-workspace") return "Review Workspace"
    if (content.type === "page" && content.pageId === "__index__") return "Pages"
    if (content.type === "page") return "Page"
    if (content.type === "context") return "Context"
    if (content.type === "process") return "Processes"
    if (content.type === "filetree") return "Files"
    return content.type
  })

  createEffect(() => {
    if (!paneLeafDebug.enabled(2)) return
    const content = props.content()
    if (!content) return
    paneLeafDebug.verbose("pane title", {
      tabId: props.tabId,
      leafId: props.leafId,
      type: content.type,
      sessionId: content.sessionId,
      terminalId: content.terminalId,
      contentTitle: content.title,
      derivedSessionTitle: sessionTitle(),
      derivedTerminalTitle: terminalTitle(),
      derivedTerminalSessionTitle: terminalSessionTitle(),
      derivedTerminalLogTitle: terminalLogTitle(),
      finalTitle: contentTitle(),
    })
  })

  // Auto-focus terminal when this leaf becomes focused or content switches to a terminal
  createEffect(
    on(
      () => [props.isFocused(), props.content()?.type, props.content()?.terminalId] as const,
      ([focused, type]) => {
        if (!focused || type !== "terminal") return
        setTimeout(() => {
          const pane = document.querySelector(`[data-pane="${props.leafId}"]`)
          if (!pane) return
          const terminal = pane.querySelector('[data-component="terminal"]')
          if (!(terminal instanceof HTMLElement)) return
          const textarea = terminal.querySelector("textarea")
          if (textarea instanceof HTMLTextAreaElement) {
            textarea.focus()
          } else {
            terminal.focus()
          }
        }, 0)
      },
    ),
  )

  const tabs = createMemo(() => claxedo.groupTabs(props.groupId))
  const terminalCommands = createMemo(() => getTerminalCommands())
  const directory = createMemo(() => {
    const value = props.content()?.directory
    if (value && value !== "__pages__") return value
    return claxedo.groupWorktree(props.groupId).default() ?? value ?? ""
  })

  const setPaneContent = (content: PaneContent) => {
    if (!content.directory) return
    claxedo.dispatch({
      type: "PaneContentSetRequested",
      tabId: props.tabId,
      leafId: props.leafId,
      content,
    })
    requestTerminalFitOnPaneChange()
  }

  const splitEmpty = (dir: "h" | "v") => {
    claxedo.dispatch({
      type: "PaneSplitRequested",
      tabId: props.tabId,
      leafId: props.leafId,
      dir,
    })
    requestTerminalFitOnPaneChange()
  }

  const addSessionContent = () => {
    const source = props.content()
    const refs = source?.intent?.name ? [source.intent.name] : undefined
    const target = directory()
    if (!target) return
    if (source?.type === "page") {
      setPaneContent({
        type: "session",
        directory: target,
        sessionId: "new",
        intent: {
          name: "chat",
          role: "assistant",
          refs,
          defaults: {
            agent: "doc",
          },
        },
      })
      return
    }
    setPaneContent({
      type: "session",
      directory: target,
      sessionId: "new",
      intent: refs
        ? {
            role: "assistant",
            refs,
          }
        : undefined,
    })
  }

  const addTerminalContent = (command?: string, title?: string) => {
    const target = directory()
    if (!target) return
    setPaneContent({
      type: "terminal",
      directory: target,
      terminalId: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      command,
      title: title || "Terminal",
    })
  }

  const addPageContent = () => {
    const target = directory()
    if (!target) return
    setPaneContent({
      type: "page",
      directory: target,
      pageId: "__index__",
      title: "Pages",
    })
  }
  const addReviewWorkspaceContent = async () => {
    const target = directory()
    if (!target) return

    // Create a fresh session for the review — SDK requires a real session ID
    let sessionID: string | undefined
    try {
      const created = await globalSDK.client.session.create({
        directory: target,
        title: `Review: ${REVIEW_MODE_LABEL.uncommitted}`,
      })
      sessionID = created.data?.id
    } catch {
      showToast({
        title: "Failed to create review session",
        description: "Could not create a session for the review workspace.",
        variant: "error",
      })
      return
    }
    if (!sessionID) return

    setPaneContent({
      type: "review-workspace",
      directory: target,
      sessionId: sessionID,
      reviewMode: "uncommitted",
    })
  }

  const customCommands = createMemo(() => terminalCommands().custom.filter((cmd) => !!cmd.name && !!cmd.command))

  const openSettings = () => {
    dialog.show(() => <DialogSettings />)
  }

  return (
    <div
      data-pane={props.leafId}
      class="group relative size-full min-w-0 min-h-0 overflow-hidden bg-background-base flex flex-col transition-opacity duration-150"
      style={{ opacity: props.isDragging?.() ? "0.35" : String(dim()) }}
      onPointerDown={() => {
        props.onFocus()
        requestTerminalFitOnPaneFocus({ type: props.content()?.type })
      }}
    >
      {/* Drop-zone overlay — shown on non-source panes while a drag is active */}
      <Show when={props.isDragActive?.() && !props.isDragging?.() && !props.isOnlyLeaf()}>
        <div
          class="absolute inset-0 z-20 flex items-center justify-center pointer-events-none transition-all duration-150"
          classList={{
            "bg-accent-base/8 ring-2 ring-inset ring-accent-base": props.isDragOver?.() ?? false,
            "ring-1 ring-inset ring-border-weak-base/50": !(props.isDragOver?.() ?? false),
          }}
        >
          <Show when={props.isDragOver?.()}>
            <div class="px-3 py-1.5 rounded-md bg-accent-base/15 border border-accent-base/30 text-accent-base text-[11px] font-medium backdrop-blur-sm">
              Drop to swap
            </div>
          </Show>
        </div>
      </Show>

      <div
        class="shrink-0 h-8 flex items-center gap-2 px-2 border-b border-border-weaker-base/50 bg-background-stronger/80 backdrop-blur select-none"
        classList={{
          "cursor-grab active:cursor-grabbing": !props.isOnlyLeaf(),
        }}
        onPointerDown={(e) => {
          // Only start drag from the header itself, not from buttons inside it
          if ((e.target as HTMLElement).closest("button")) return
          if (!props.isOnlyLeaf()) props.onStartMove?.(e)
        }}
      >
        <div class="flex items-center gap-2 min-w-0 flex-1 group/pane-title">
          <Show when={!props.isOnlyLeaf()}>
            <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-icon-weak-base" />
          </Show>
          <span class="text-[12px] font-medium text-text-weak whitespace-nowrap overflow-hidden text-ellipsis">
            {contentTitle()}
          </span>
          <button
            class="shrink-0 opacity-0 group-hover/pane-title:opacity-100 transition-opacity text-icon-weak-base hover:text-icon-base cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              const title = contentTitle()
              if (!title) return
              navigator.clipboard.writeText(title)
              showToast({ title: "Copied to clipboard", variant: "success" })
            }}
            aria-label="Copy pane name"
          >
            <Icon name="copy" size="small" />
          </button>
        </div>

        <div class="flex items-center gap-1">
          <Show when={props.content()?.type === "review-workspace" && peersWithCapability("comment:receive", props.tabId).length > 1}>
            <DropdownMenu gutter={4} placement="bottom-end">
              <DropdownMenu.Trigger as={IconButton} icon="kebab" variant="ghost" aria-label="Pane options" />
              <DropdownMenu.Portal>
                <DropdownMenu.Content>
                  <DropdownMenu.Group>
                    <DropdownMenu.GroupLabel>Bind comments to</DropdownMenu.GroupLabel>
                    <DropdownMenu.RadioGroup
                      value={getBound("comment", props.leafId) ?? ""}
                      onChange={(value) => bind("comment", props.leafId, String(value))}
                    >
                      <For each={peersWithCapability("comment:receive", props.tabId)}>
                        {(peer) => (
                          <DropdownMenu.RadioItem value={peer.leafId}>
                            <DropdownMenu.ItemLabel>{peer.name()}</DropdownMenu.ItemLabel>
                          </DropdownMenu.RadioItem>
                        )}
                      </For>
                    </DropdownMenu.RadioGroup>
                  </DropdownMenu.Group>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu>
          </Show>
          <Show when={props.content()?.type === "session" && !props.isOnlyLeaf()}>
            <IconButton
              icon={props.isFloating?.() ? "expand" : "collapse"}
              variant="ghost"
              onClick={() => {
                if (props.isFloating?.()) {
                  claxedo.dispatch({ type: "PaneUnfloatRequested", tabId: props.tabId })
                } else {
                  claxedo.dispatch({ type: "PaneFloatRequested", tabId: props.tabId, leafId: props.leafId })
                }
              }}
              aria-label={props.isFloating?.() ? "Dock session" : "Float session"}
            />
          </Show>
          <IconButton icon="layout-right" variant="ghost" onClick={() => splitEmpty("v")} aria-label="Split right" class="max-md:hidden" />
          <IconButton icon="layout-bottom" variant="ghost" onClick={() => splitEmpty("h")} aria-label="Split down" class="max-md:hidden" />

          <Show when={!props.isOnlyLeaf()}>
            <IconButton icon="close-small" variant="ghost" onClick={() => props.onClose()} aria-label="Close pane" />
          </Show>
        </div>
      </div>

      <div class="flex-1 min-h-0 h-full w-full overflow-hidden">
        <Show
          when={props.content()}
          fallback={
            <ContentPicker
              onSession={addSessionContent}
              onClaude={() => addTerminalContent(terminalCommands().claude, "Claude")}
              onCodex={() => addTerminalContent(terminalCommands().codex, "Codex")}
              onTerminal={() => addTerminalContent()}
              onPage={addPageContent}
              onReviewWorkspace={addReviewWorkspaceContent}
              onConfigure={openSettings}
              custom={customCommands()}
              onCustom={(cmd) => addTerminalContent(cmd.command, cmd.name)}
            />
          }
        >
          {(content) => (
            <Switch
              fallback={
                <div class="flex items-center justify-center h-full text-text-weak">
                  Unknown content type: {content().type}
                </div>
              }
            >
              <Match when={content().type === "session" && content().directory}>
                <SessionParamsProvider
                  sessionId={() => content().sessionId}
                  directory={() => content().directory}
                  groupId={() => props.groupId}
                  tabId={() => props.tabId}
                  leafId={() => props.leafId}
                >
                  <GroupIdProvider groupId={props.groupId}>
                    <GroupLayoutProvider groupId={props.groupId}>
                      <DirectoryScope
                        directory={content().directory}
                        onNavigateToSession={(sessionId) => {
                          const ta = tabs()
                          const newTabId = ta.addSession(content().directory, sessionId, "Session")
                          if (newTabId) ta.setActive(newTabId)
                        }}
                      >
                        <SessionPaneBusConsumer leafId={props.leafId} tabId={props.tabId} sessionId={content().sessionId ?? "new"} />
                        <Suspense fallback={<Loading />}>
                          <SessionPage />
                        </Suspense>
                      </DirectoryScope>
                    </GroupLayoutProvider>
                  </GroupIdProvider>
                </SessionParamsProvider>
              </Match>

              <Match when={content().type === "terminal" && content().directory}>
                <GroupIdProvider groupId={props.groupId}>
                  <DirectoryScope
                    directory={content().directory}
                    onNavigateToSession={(sessionId) => {
                      const ta = tabs()
                      const newTabId = ta.addSession(content().directory, sessionId, "Session")
                      if (newTabId) ta.setActive(newTabId)
                    }}
                  >
                    <PaneTerminal
                      tabId={props.tabId}
                      leafId={props.leafId}
                      groupId={props.groupId}
                      directory={content().directory}
                      terminalId={content().terminalId!}
                      command={content().command}
                      title={content().title}
                    />
                  </DirectoryScope>
                </GroupIdProvider>
              </Match>

              <Match when={content().type === "review" && content().directory && content().sessionId}>
                <GroupIdProvider groupId={props.groupId}>
                  <DirectoryScope
                    directory={content().directory}
                    onNavigateToSession={(sessionId) => {
                      const ta = tabs()
                      const newTabId = ta.addSession(content().directory, sessionId, "Session")
                      if (newTabId) ta.setActive(newTabId)
                    }}
                  >
                    <TabReview
                      sessionId={content().sessionId!}
                      mode={content().reviewMode ?? "session"}
                      fromRef={content().reviewFromRef}
                      toRef={content().reviewToRef}
                    />
                  </DirectoryScope>
                </GroupIdProvider>
              </Match>

              <Match when={content().type === "review-workspace" && content().directory && content().sessionId}>
                <SessionParamsProvider
                  sessionId={() => content().sessionId}
                  directory={() => content().directory}
                  groupId={() => props.groupId}
                  tabId={() => props.tabId}
                  leafId={() => props.leafId}
                >
                  <GroupIdProvider groupId={props.groupId}>
                    <DirectoryScope
                      directory={content().directory}
                      onNavigateToSession={(sessionId) => {
                        const ta = tabs()
                        const newTabId = ta.addSession(content().directory, sessionId, "Session")
                        if (newTabId) ta.setActive(newTabId)
                      }}
                    >
                      <ReviewWorkspace
                        sessionId={content().sessionId!}
                        directory={content().directory}
                        mode={content().reviewMode ?? "session"}
                        fromRef={content().reviewFromRef}
                        toRef={content().reviewToRef}
                        leafId={props.leafId}
                        tabId={props.tabId}
                      />
                    </DirectoryScope>
                  </GroupIdProvider>
                </SessionParamsProvider>
              </Match>

              <Match when={content().type === "context" && content().directory && content().sessionId}>
                <SessionParamsProvider
                  sessionId={() => content().sessionId}
                  directory={() => content().directory}
                  groupId={() => props.groupId}
                  tabId={() => props.tabId}
                  leafId={() => props.leafId}
                >
                  <GroupIdProvider groupId={props.groupId}>
                    <DirectoryScope
                      directory={content().directory}
                      onNavigateToSession={(sessionId) => {
                        const ta = tabs()
                        const newTabId = ta.addSession(content().directory, sessionId, "Session")
                        if (newTabId) ta.setActive(newTabId)
                      }}
                    >
                      <TabContext sessionId={content().sessionId!} />
                    </DirectoryScope>
                  </GroupIdProvider>
                </SessionParamsProvider>
              </Match>

              <Match when={content().type === "process" && content().processId}>
                <ProcessLeafContent
                  processId={content().processId!}
                  directory={content().directory}
                />
              </Match>

              <Match when={content().type === "process" && !content().processId}>
                <ProcessPlaceholder directory={content().directory} />
              </Match>

              <Match when={content().type === "filetree" && content().directory}>
                <DirectoryScope directory={content().directory}>
                  <FileTreePane
                    directory={content().directory}
                    tabId={props.tabId}
                    leafId={props.leafId}
                    groupId={props.groupId}
                  />
                </DirectoryScope>
              </Match>

              <Match when={content().type === "file" && content().directory && content().filePath}>
                <SDKProvider directory={() => content().directory}>
                  <TabFile
                    path={content().filePath!}
                    onOpenInPageEditor={
                      isMarkdownPath(content().filePath!)
                        ? () => {
                            void openMarkdownPageTab({
                              directory: content().directory,
                              path: content().filePath!,
                              sdk: globalSDK,
                              tabs: tabs(),
                            })
                          }
                        : undefined
                    }
                  />
                </SDKProvider>
              </Match>

              <Match when={content().type === "page" && content().pageId === "__index__"}>
                <PageIndex
                  onOpenPage={(pageId, title) => {
                    setPaneContent({
                      type: "page",
                      directory: content().directory,
                      sessionId: content().sessionId,
                      pageId,
                      title,
                    })
                  }}
                  onCreatePage={() => {
                    void pagesApi.create("Untitled").then((page) => {
                      setPaneContent({
                        type: "page",
                        directory: content().directory,
                        sessionId: content().sessionId,
                        pageId: page.id,
                        title: page.title,
                      })
                    }).catch((error) => {
                      showToast({
                        title: "Failed to create page",
                        description: error instanceof Error ? error.message : String(error),
                        variant: "error",
                      })
                    })
                  }}
                />
              </Match>

              <Match when={content().type === "page" && content().pageId && content().pageId !== "__index__"}>
                {(() => {
                  const backToIndex = () => {
                    setPaneContent({
                      type: "page",
                      directory: content().directory,
                      sessionId: content().sessionId,
                      pageId: "__index__",
                      title: "Pages",
                    })
                  }
                  return (
                <Show
                  when={content().directory && content().directory !== "__pages__"}
                  fallback={
                    <TabPage
                      pageId={content().pageId!}
                      directory={content().directory}
                      filePath={content().filePath}
                      leafId={props.leafId}
                      tabId={props.tabId}
                      onBackToIndex={backToIndex}
                    />
                  }
                >
                  <GroupIdProvider groupId={props.groupId}>
                    <DirectoryScope
                      directory={content().directory}
                      onNavigateToSession={(sessionId) => {
                        const ta = tabs()
                        const newTabId = ta.addSession(content().directory, sessionId, "Session")
                        if (newTabId) ta.setActive(newTabId)
                      }}
                    >
                      <TabPage
                        pageId={content().pageId!}
                        sessionId={content().sessionId}
                        directory={content().directory}
                        filePath={content().filePath}
                        leafId={props.leafId}
                        tabId={props.tabId}
                        onBackToIndex={backToIndex}
                      />
                    </DirectoryScope>
                  </GroupIdProvider>
                </Show>
                  )
                })()}
              </Match>
            </Switch>
          )}
        </Show>
      </div>
    </div>
  )
}
