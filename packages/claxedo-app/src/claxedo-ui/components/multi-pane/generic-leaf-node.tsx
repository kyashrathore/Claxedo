/**
 * GenericLeafNode
 *
 * Per-leaf renderer for multi-pane tabs. Renders pane content and a
 * compact pane header with split/create actions.
 */

import { For, Show, Switch, Match, Suspense, lazy, createMemo, createEffect, createSignal, on, onCleanup, onMount, untrack, type Accessor } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { DialogSettings, useGlobalSync, useSync, useComments, useServer } from "@opencode-ai/claxedo-app"
import { REVIEW_MODE_LABEL } from "../../context/claxedo-layout/review-intent"
import { useClaxedoLayout, type PaneContent } from "../../context/claxedo-layout"
import { isGlobalPane, isGlobalTab, realDirectory } from "../../context/claxedo-layout/types"
import { DirectoryScope } from "../directory-scope"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePrompt } from "@/context/prompt"
import { useLocal } from "@/context/local"
import { SessionParamsProvider } from "../../context/session-params"
import { GroupIdProvider } from "../../context/group-id"
import { GroupLayoutProvider } from "../group-layout-provider"
import { TabReview } from "../tab-review"
import { ReviewWorkspace } from "../review-workspace"
import { TabFile } from "../tab-file"
import { TabPage } from "../tab-page"
import { TabWorkgraph } from "../tab-workgraph"
import { PageIndex } from "../page-index"
import { TabContext } from "../tab-context"
import { PaneTerminal } from "./pane-terminal"
import { FileTreePane } from "./file-tree-pane"
import { BrowserPane } from "../../../browser/components/browser-pane"
import { useProcessPane } from "../../context/process-pane"
import { ProcessPanePanel } from "../process-pane-panel"
import { AddProcessDialog } from "../add-process-dialog"
import { WorkspaceSDKProvider } from "../workspace-sdk-provider"
import { getTerminalCommands } from "../../../components/settings-terminals"
import { type Page } from "../../../utils/pages-api"
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
import { useBrowserComments } from "../../../browser/store/browser-comments"
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
  let browserComments: ReturnType<typeof useBrowserComments> | undefined
  try {
    browserComments = useBrowserComments()
  } catch {
    // Provider may not be mounted (e.g. tests, non-app contexts); the
    // page-comment:receive handler short-circuits when absent.
  }

  usePane({
    leafId: props.leafId,
    tabId: props.tabId,
    type: "session",
    name: () => {
      if (!props.sessionId || props.sessionId === "new") return "Session"
      const info = sync.session.get(props.sessionId)
      return info?.title || "Session"
    },
    capabilities: ["comment:receive", "model:provide", "session:provide", "page-comment:receive"],
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
      "page-comment:receive": {
        onPageComment: (payload) => {
          if (!browserComments) return
          if (!props.sessionId || props.sessionId === "new") return
          browserComments.enqueue(props.sessionId, payload)
        },
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
function ProcessLeafContent(props: { processId: string; directory: string; active: boolean }) {
  const pp = useProcessPane()
  const dialog = useDialog()
  const debug = createDebugLogger("layout.process", "layout:process", {
    legacyKey: "opencode.debug.terminal",
  })
  const inst = Math.random().toString(36).slice(2, 7)

  const config = createMemo(() => pp.configs().find((c) => c.id === props.processId))
  const process = createMemo(() => pp.processForConfig(props.processId))
  const cfg = createMemo(() => config())
  const snap = () => ({
    inst,
    processId: props.processId,
    dir: props.directory,
    loaded: pp.loaded(),
    configId: cfg()?.id ?? null,
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
    const hit = cfg()
    if (!hit) return
    dialog.show(() => (
      <AddProcessDialog
        directory={props.directory}
        config={hit}
        onDone={() => pp.refresh()}
      />
    ))
  }

  return (
    <Show
      when={cfg()}
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
      <ProcessPanePanel
        config={cfg()!}
        active={props.active}
        process={process()}
        onStart={() => pp.start(props.processId)}
        onStop={() => pp.stop(props.processId)}
        onRestart={() => pp.restart(props.processId)}
        onResolveConflict={(strategy) => pp.resolveConflict(props.processId, strategy)}
        onDismissConflict={() => pp.dismissConflict(props.processId)}
        onEdit={openEditDialog}
      />
    </Show>
  )
}

/** Placeholder leaf shown before process configs are loaded, or empty state when none exist. */
function ProcessPlaceholder(props: { directory: string }) {
  const pp = useProcessPane()
  const loaded = createMemo(() => pp.loaded())
  const hasConfigs = createMemo(() => pp.configs().length > 0)

  return (
    <div
      data-testid="process-empty-state"
      class="flex flex-col items-center justify-center h-full text-text-weak gap-3"
    >
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
  tabActive: Accessor<boolean>
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
    // Untrack to prevent reactive loop: ensureTerminalSession → ensureSessionMessages
    // reads store.part, then writes store.part on fetch resolve, re-triggering this effect.
    const terminalId = content.terminalId
    const directory = content.directory
    untrack(() => ensureTerminalSession(terminalId, directory))
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
    if (content.type === "pages-index") return "Pages"
    if (content.type === "page") return "Page"
    if (content.type === "workgraph") return "WorkGraph"
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
  const tab = createMemo(() => tabs().items().find((item) => item.id === props.tabId))
  const terminalCommands = createMemo(() => getTerminalCommands())
  const directory = createMemo(() => {
    const value = realDirectory(props.content()?.directory)
    return value ?? claxedo.groupWorktree(props.groupId).default() ?? ""
  })

  const setPaneContent = (content: PaneContent) => {
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
    const source = props.content()
    const target = realDirectory(source?.directory) ?? directory()
    if ((source?.type === "pages-index" && isGlobalPane(source)) || (!source && tab()?.type === "pages-index" && tab() && isGlobalTab(tab()!))) {
      setPaneContent({ type: "pages-index", title: "Pages" })
      return
    }
    if (!target) {
      setPaneContent({ type: "pages-index", title: "Pages" })
      return
    }
    setPaneContent({
      type: "pages-index",
      directory: target,
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

  // Floating pane controls – proximity-based visibility (Ghostty-like)
  // Grab and buttons track independently so hovering one doesn't light the other
  const [grabProximity, setGrabProximity] = createSignal<'hidden' | 'dim' | 'highlighted'>('hidden')
  const [buttonsVisible, setButtonsVisible] = createSignal(false)
  let grabRef: HTMLDivElement | undefined

  const nearEl = (ref: HTMLDivElement | undefined, e: PointerEvent, padX: number, padY: number) => {
    if (!ref) return false
    const cr = ref.getBoundingClientRect()
    return e.clientX >= cr.left - padX && e.clientX <= cr.right + padX &&
           e.clientY >= cr.top - padY && e.clientY <= cr.bottom + padY
  }

  const handlePointerMove = (e: PointerEvent) => {
    if (props.isOnlyLeaf() || props.isDragActive?.()) {
      setGrabProximity('hidden')
      setButtonsVisible(false)
      return
    }
    const pane = e.currentTarget as HTMLElement
    const rect = pane.getBoundingClientRect()
    const distFromTop = e.clientY - rect.top

    if (distFromTop < 0 || distFromTop > 200) {
      setGrabProximity('hidden')
      setButtonsVisible(false)
      return
    }

    // Grab: highlighted when within 50px, dim otherwise
    setGrabProximity(nearEl(grabRef, e, 50, 20) ? 'highlighted' : 'dim')
    // Buttons: visible in top zone, per-icon hover is CSS-only
    setButtonsVisible(true)
  }

  const handlePointerLeave = () => {
    setGrabProximity('hidden')
    setButtonsVisible(false)
  }

  return (
    <div
      data-pane={props.leafId}
      class="group relative size-full min-w-0 min-h-0 overflow-hidden transition-opacity duration-150"
      style={{ opacity: props.isDragging?.() ? "0.35" : String(dim()) }}
      onPointerDown={() => {
        props.onFocus()
        requestTerminalFitOnPaneFocus({ type: props.content()?.type })
      }}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
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

      {/* Floating pane controls — invisible → dim (cursor near top) → highlighted (cursor near controls) */}
      <Show when={!props.isOnlyLeaf()}>
        {/* Centered grab handle — 50px grabbable zone each side */}
        <div
          class="absolute top-0 left-1/2 -translate-x-1/2 z-10 transition-opacity duration-200 select-none cursor-grab active:cursor-grabbing"
          classList={{
            "opacity-0 pointer-events-none": grabProximity() === 'hidden',
            "opacity-30 pointer-events-auto": grabProximity() === 'dim',
            "opacity-100 pointer-events-auto": grabProximity() === 'highlighted',
          }}
          onPointerDown={(e) => props.onStartMove?.(e)}
        >
          <div class="px-[50px] pb-4 pane-ctrl-icon">
            <div ref={grabRef!}>
              <Icon name="dot-grid" size="small" class="text-icon-base" />
            </div>
          </div>
        </div>

        {/* Right-aligned action buttons — no group bg, per-icon hover */}
        <div
          class="absolute top-0 right-1 z-10 select-none transition-opacity duration-200"
          classList={{
            "opacity-0 pointer-events-none": !buttonsVisible(),
            "pointer-events-auto": buttonsVisible(),
          }}
        >
          <div class="flex items-center gap-2">
            <Show when={props.content()?.type === "review-workspace" && peersWithCapability("comment:receive", props.tabId).length > 1}>
              <DropdownMenu gutter={4} placement="bottom-end">
                <DropdownMenu.Trigger class="pane-ctrl-icon opacity-30 hover:opacity-100 transition-opacity p-0.5 cursor-pointer" aria-label="Pane options">
                  <Icon name="kebab" size="small" class="text-icon-base" />
                </DropdownMenu.Trigger>
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
            <Show when={props.content()?.type === "session"}>
              <button
                class="pane-ctrl-icon opacity-30 hover:opacity-100 transition-opacity p-0.5 cursor-pointer"
                onClick={() => {
                  if (props.isFloating?.()) {
                    claxedo.dispatch({ type: "PaneUnfloatRequested", tabId: props.tabId })
                    return
                  }
                  claxedo.dispatch({ type: "PaneFloatRequested", tabId: props.tabId, leafId: props.leafId })
                }}
                aria-label={props.isFloating?.() ? "Dock session" : "Float session"}
              >
                <Icon name={props.isFloating?.() ? "expand" : "collapse"} size="small" class="text-icon-base" />
              </button>
            </Show>
            <button type="button" class="pane-ctrl-icon opacity-30 hover:opacity-100 transition-opacity p-0.5 cursor-pointer max-md:hidden" onClick={() => splitEmpty("v")} aria-label="Split right">
              <Icon name="layout-right" size="small" class="text-icon-base" />
            </button>
            <button type="button" class="pane-ctrl-icon opacity-30 hover:opacity-100 transition-opacity p-0.5 cursor-pointer max-md:hidden" onClick={() => splitEmpty("h")} aria-label="Split down">
              <Icon name="layout-bottom" size="small" class="text-icon-base" />
            </button>
            <button type="button" class="pane-ctrl-icon opacity-30 hover:opacity-100 transition-opacity p-0.5 cursor-pointer" onClick={() => props.onClose()} aria-label="Close pane">
              <Icon name="close" size="small" class="text-icon-base" />
            </button>
          </div>
        </div>
      </Show>

      <div class="size-full overflow-hidden pt-3">
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
                  directory={() => content().directory!}
                  groupId={() => props.groupId}
                  tabId={() => props.tabId}
                  leafId={() => props.leafId}
                >
                  <GroupIdProvider groupId={props.groupId}>
                    <GroupLayoutProvider groupId={props.groupId}>
                      <DirectoryScope
                        directory={content().directory!}
                        onNavigateToSession={(sessionId) => {
                          const ta = tabs()
                          const newTabId = ta.addSession(content().directory!, sessionId, "Session")
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
                    directory={content().directory!}
                    onNavigateToSession={(sessionId) => {
                      const ta = tabs()
                      const newTabId = ta.addSession(content().directory!, sessionId, "Session")
                      if (newTabId) ta.setActive(newTabId)
                    }}
                  >
                    <PaneTerminal
                      tabId={props.tabId}
                      leafId={props.leafId}
                      groupId={props.groupId}
                      directory={content().directory!}
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
                    directory={content().directory!}
                    onNavigateToSession={(sessionId) => {
                      const ta = tabs()
                      const newTabId = ta.addSession(content().directory!, sessionId, "Session")
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
                  directory={() => content().directory!}
                  groupId={() => props.groupId}
                  tabId={() => props.tabId}
                  leafId={() => props.leafId}
                >
                  <GroupIdProvider groupId={props.groupId}>
                    <DirectoryScope
                      directory={content().directory!}
                      onNavigateToSession={(sessionId) => {
                        const ta = tabs()
                        const newTabId = ta.addSession(content().directory!, sessionId, "Session")
                        if (newTabId) ta.setActive(newTabId)
                      }}
                    >
                      <ReviewWorkspace
                        sessionId={content().sessionId!}
                        directory={content().directory!}
                        mode={content().reviewMode ?? "session"}
                        fromRef={content().reviewFromRef}
                        toRef={content().reviewToRef}
                        leafId={props.leafId}
                        tabId={props.tabId}
                        getLeafView={claxedo.select.multiPaneLeafView}
                      />
                    </DirectoryScope>
                  </GroupIdProvider>
                </SessionParamsProvider>
              </Match>

              <Match when={content().type === "context" && content().directory && content().sessionId}>
                <SessionParamsProvider
                  sessionId={() => content().sessionId}
                  directory={() => content().directory!}
                  groupId={() => props.groupId}
                  tabId={() => props.tabId}
                  leafId={() => props.leafId}
                >
                  <GroupIdProvider groupId={props.groupId}>
                    <DirectoryScope
                      directory={content().directory!}
                      onNavigateToSession={(sessionId) => {
                        const ta = tabs()
                        const newTabId = ta.addSession(content().directory!, sessionId, "Session")
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
                  directory={content().directory!}
                  active={props.tabActive()}
                />
              </Match>

              <Match when={content().type === "process" && !content().processId}>
                <ProcessPlaceholder directory={content().directory!} />
              </Match>

              <Match when={content().type === "filetree" && content().directory}>
                <DirectoryScope directory={content().directory!}>
                  <FileTreePane
                    directory={content().directory!}
                    tabId={props.tabId}
                    leafId={props.leafId}
                    groupId={props.groupId}
                  />
                </DirectoryScope>
              </Match>

              <Match when={content().type === "file" && content().directory && content().filePath}>
                <WorkspaceSDKProvider directory={() => content().directory!}>
                  <TabFile
                    path={content().filePath!}
                    onOpenInPageEditor={
                      isMarkdownPath(content().filePath!)
                        ? () => {
                            void openMarkdownPageTab({
                              directory: content().directory!,
                              path: content().filePath!,
                              sdk: globalSDK,
                              tabs: tabs(),
                            })
                          }
                        : undefined
                    }
                  />
                </WorkspaceSDKProvider>
              </Match>

              <Match when={content().type === "pages-index"}>
                <PageIndex
                  scope={content().directory ? "project" : "all"}
                  directory={content().directory}
                  projects={globalSync.data.project as Array<{ id: string; name?: string | null; worktree: string; sandboxes?: string[] }>}
                  onOpenPage={(page: Page) => {
                    const dir = page.project_id
                      ? page.directory || content().directory || page.project_worktree || undefined
                      : undefined
                    const id = tabs().addPage(page.id, page.title, dir, page.file_path ?? undefined)
                    if (id) tabs().setActive(id)
                  }}
                />
              </Match>

              <Match when={content().type === "workgraph"}>
                <TabWorkgraph
                  onBackToIndex={() => {
                    const id = tabs().addPagesIndex(content().directory)
                    if (id) tabs().setActive(id)
                  }}
                />
              </Match>

              <Match when={content().type === "browser"}>
                <BrowserPane
                  paneId={props.leafId}
                  tabId={props.tabId}
                  browserId={tab()?.browserId}
                  initialUrl={tab()?.currentUrl}
                  onNavigationChange={(patch) => {
                    const ops = tabs()
                    if (typeof ops.updateBrowserTab === "function") {
                      ops.updateBrowserTab(props.tabId, patch)
                    }
                  }}
                />
              </Match>

              <Match when={content().type === "page" && content().pageId}>
                {(() => {
                  const backToIndex = () => {
                    const id = tabs().addPagesIndex(content().directory)
                    if (id) tabs().setActive(id)
                  }
                  return (
                <Show
                  when={content().directory}
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
                      directory={content().directory!}
                      onNavigateToSession={(sessionId) => {
                        const ta = tabs()
                        const newTabId = ta.addSession(content().directory!, sessionId, "Session")
                        if (newTabId) ta.setActive(newTabId)
                      }}
                    >
                      <TabPage
                        pageId={content().pageId!}
                        sessionId={content().sessionId}
                        directory={content().directory!}
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
