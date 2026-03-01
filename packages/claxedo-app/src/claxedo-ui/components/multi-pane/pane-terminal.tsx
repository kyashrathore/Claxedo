/**
 * PaneTerminal
 *
 * Lightweight terminal renderer for generic multi-pane layouts.
 * Handles a single terminal leaf inside the shared pane system:
 *
 * - Creates a new PTY via useTerminal().new() when given a pending ID
 * - Updates multi-pane content with the real PTY ID after creation
 * - Renders the Terminal component directly
 * - Handles clone-on-reconnect (WebSocket 1008)
 */

import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Terminal } from "@/components/terminal"
import { useTerminal } from "@/context/terminal"
import { useSDK } from "@/context/sdk"
import { useClaxedoLayout } from "../../context/claxedo-layout"
import { WebSocketCloseError } from "../../../overrides/components/terminal-connection"
import { isMarkdownPath, openMarkdownPageTab } from "../../utils/open-markdown-page-tab"
import { requestTerminalFitOnPaneChange } from "./terminal-fit"
import { shouldWaitForQueuedCreate } from "./pane-terminal-logic"

export interface PaneTerminalProps {
  tabId: string
  leafId: string
  groupId: string
  directory: string
  terminalId: string
  command?: string
  title?: string
}

export function PaneTerminal(props: PaneTerminalProps) {
  const claxedo = useClaxedoLayout()
  const terminal = useTerminal()
  const sdk = useSDK()
  const tabs = createMemo(() => claxedo.groupTabs(props.groupId))

  const [realPtyId, setRealPtyId] = createSignal<string | undefined>(
    props.terminalId.startsWith("pending-") ? undefined : props.terminalId,
  )
  let createStarted = false
  let disposed = false

  onCleanup(() => {
    disposed = true
  })

  // Create a new terminal when mounted with a pending ID.
  // For terminal tabs, a queued create may exist (from queueCreateForTab) —
  // consume it to get command/title/previousPtyId. For multi-pane terminal
  // panes (e.g. from PaneSubHeader), command/title come from props.
  //
  // peekCreateForTab is reactive: if the queued create hasn't arrived yet
  // (e.g. queueCreateForTab called after addTerminal), the effect re-runs
  // when it does. For non-terminal tabs we skip the wait and create directly.
  createEffect(() => {
    if (!props.terminalId.startsWith("pending-")) {
      setRealPtyId(props.terminalId)
      return
    }
    if (createStarted) return

    // Reactive peek — creates a dependency so the effect re-runs when
    // queueCreateForTab is called (handles timing where the queue write
    // happens after this effect's first run).
    const queued = claxedo.terminal.peekCreateForTab?.(props.tabId)

    // Wait for queued create only when this pending ID is the tab's primary
    // terminal target (top-level terminal tab creation). Split panes inside a
    // terminal tab can create directly from props.command/title.
    const tab = tabs()
      .items()
      .find((t) => t.id === props.tabId && t.type === "terminal")
    const waitForQueuedCreate = shouldWaitForQueuedCreate({
      tabTerminalId: tab?.terminalId,
      pendingTerminalId: props.terminalId,
    })
    if (waitForQueuedCreate && !queued) return

    createStarted = true

    // Consume the queued create (if any) so it isn't consumed again
    const consumed = queued ? claxedo.terminal.consumeCreateForTab?.(props.tabId) : undefined
    const command = consumed?.command ?? props.command
    const title = consumed?.title ?? props.title
    const previousPtyId = consumed?.previousPtyId

    const created = terminal.new(command, title, previousPtyId)
    if (!created) {
      createStarted = false
      return
    }

    void created
      .then((createdId) => {
        if (!createdId) {
          createStarted = false
          return
        }
        if (disposed) return
        setRealPtyId(createdId)
        claxedo.terminal.own(props.tabId, createdId)
        // Update multi-pane content with real PTY ID
        claxedo.multiPane.setContent(props.tabId, props.leafId, {
          type: "terminal",
          directory: props.directory,
          terminalId: createdId,
          title: title || "Terminal",
        })
        // For terminal tabs, also update the tab item's terminalId
        if (tab) {
          tabs().patch(props.tabId, { terminalId: createdId })
        }
        requestTerminalFitOnPaneChange()
      })
      .catch(() => {
        createStarted = false
      })
  })

  // Find the PTY object from the terminal store
  const pty = createMemo(() => {
    const id = realPtyId()
    if (!id) return undefined
    return terminal.all().find((p) => p.id === id)
  })

  const handleConnectError = async (error: unknown) => {
    const id = realPtyId()
    if (!id) return
    // Clone-on-reconnect for WebSocket 1008
    if (error instanceof WebSocketCloseError && error.code === 1008) {
      let newId: string | undefined
      try {
        newId = await terminal.clone(id)
      } catch {
        // clone failed — ignore
      }
      if (!newId || disposed) return
      setRealPtyId(newId)
      claxedo.multiPane.setContent(props.tabId, props.leafId, {
        type: "terminal",
        directory: props.directory,
        terminalId: newId,
        title: props.title || "Terminal",
      })
      requestTerminalFitOnPaneChange()
    }
  }

  return (
    <Show
      when={pty()}
      fallback={
        <div class="flex items-center justify-center h-full text-text-weak">
          <div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
        </div>
      }
    >
      {(p) => (
        <div class="flex-1 min-h-0 h-full w-full overflow-hidden">
          <Terminal
            pty={p()}
            onConnectError={handleConnectError}
            onSplitVertical={() => {
              claxedo.dispatch({
                type: "PaneSplitRequested",
                tabId: props.tabId,
                leafId: props.leafId,
                dir: "v",
              })
              requestTerminalFitOnPaneChange()
            }}
            onSplitHorizontal={() => {
              claxedo.dispatch({
                type: "PaneSplitRequested",
                tabId: props.tabId,
                leafId: props.leafId,
                dir: "h",
              })
              requestTerminalFitOnPaneChange()
            }}
            onFileLinkOpen={(filePath) => {
              const dir = props.directory
              if (!dir) return
              if (filePath.startsWith("/") && !filePath.startsWith(dir + "/") && filePath !== dir) return
              if (isMarkdownPath(filePath)) {
                void openMarkdownPageTab({
                  directory: dir,
                  path: filePath,
                  sdk,
                  tabs: tabs(),
                })
                return
              }
              const title = filePath.split("/").at(-1) ?? filePath
              const tabId = tabs().addFile(dir, filePath, title)
              if (tabId) tabs().setActive(tabId)
            }}
          />
        </div>
      )}
    </Show>
  )
}
