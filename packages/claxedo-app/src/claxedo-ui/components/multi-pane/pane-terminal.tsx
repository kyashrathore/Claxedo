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

import { Show, batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Terminal } from "@/components/terminal"
import { useTerminal } from "@/context/terminal"
import { useClaxedoLayout } from "../../context/claxedo-layout"
import { WebSocketCloseError } from "../../../overrides/components/terminal-connection"
import { requestTerminalFitOnPaneChange } from "./terminal-fit"
import { shouldWaitForQueuedCreate } from "./pane-terminal-logic"
import { aliasTerminalSessionPreview } from "../../utils/terminal-session-preview"
import { aliasTerminalLogSummary } from "../../utils/terminal-log-summary"
import { createDebugLogger } from "../../../overrides/utils/debug"
import { resolveRecovery, trackRecovery } from "./pane-terminal-recovery"

export interface PaneTerminalProps {
  tabId: string
  leafId: string
  groupId: string
  directory: string
  terminalId: string
  command?: string
  title?: string
}

const recoveryAlias = new Map<string, { id: string; at: number }>()
const recoveryInflight = new Map<string, Promise<string | undefined>>()

export function PaneTerminal(props: PaneTerminalProps) {
  const claxedo = useClaxedoLayout()
  const terminal = useTerminal()
  const tabs = createMemo(() => claxedo.groupTabs(props.groupId))
  const debug = createDebugLogger("terminal.pane", "terminal:pane", {
    defaultLevel: 0,
  })

  const [realPtyId, setRealPtyId] = createSignal<string | undefined>(
    props.terminalId.startsWith("pending-") ? undefined : props.terminalId,
  )
  let createStarted = false
  let disposed = false

  debug.log("mount", {
    tabId: props.tabId,
    leafId: props.leafId,
    groupId: props.groupId,
    directory: props.directory,
    terminalId: props.terminalId,
    command: props.command,
    title: props.title,
  })

  onCleanup(() => {
    disposed = true
    debug.log("cleanup", {
      tabId: props.tabId,
      leafId: props.leafId,
      realPtyId: realPtyId(),
    })
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
      const recovered = resolveRecovery(recoveryAlias, props.terminalId)
      if (recovered !== props.terminalId) {
        debug.log("using recovered terminal id", {
          tabId: props.tabId,
          leafId: props.leafId,
          oldId: props.terminalId,
          recovered,
        })
        setRealPtyId(recovered)
        aliasTerminalSessionPreview(props.terminalId, recovered)
        aliasTerminalLogSummary(props.terminalId, recovered)
        claxedo.terminal.replaceId(props.tabId, props.terminalId, recovered)
        requestTerminalFitOnPaneChange()
        return
      }
      const pending = recoveryInflight.get(props.terminalId)
      if (pending) {
        debug.log("waiting on in-flight recovery", {
          tabId: props.tabId,
          leafId: props.leafId,
          terminalId: props.terminalId,
        })
        void pending.then((newId) => {
          if (!newId || disposed) return
          debug.log("in-flight recovery resolved", {
            tabId: props.tabId,
            leafId: props.leafId,
            oldId: props.terminalId,
            newId,
          })
          setRealPtyId(newId)
          aliasTerminalSessionPreview(props.terminalId, newId)
          aliasTerminalLogSummary(props.terminalId, newId)
          claxedo.terminal.replaceId(props.tabId, props.terminalId, newId)
          requestTerminalFitOnPaneChange()
        })
        return
      }
      terminal.ensure({
        id: props.terminalId,
        title: props.title || "Terminal",
        cwd: props.directory,
        ...(props.command ? { initialCommand: props.command } : {}),
      })
      debug.verbose("sync props terminal id", {
        tabId: props.tabId,
        leafId: props.leafId,
        terminalId: props.terminalId,
        ensured: true,
      })
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
    debug.log("pending terminal effect", {
      tabId: props.tabId,
      leafId: props.leafId,
      pendingTerminalId: props.terminalId,
      tabTerminalId: tab?.terminalId,
      queued: !!queued,
      waitForQueuedCreate,
    })
    if (waitForQueuedCreate && !queued) return

    createStarted = true

    // Consume the queued create (if any) so it isn't consumed again
    const consumed = queued ? claxedo.terminal.consumeCreateForTab?.(props.tabId) : undefined
    const command = consumed?.command ?? props.command
    const title = consumed?.title ?? props.title
    const previousPtyId = consumed?.previousPtyId

    const created = terminal.new(command, title, previousPtyId)
    debug.log("terminal create requested", {
      tabId: props.tabId,
      leafId: props.leafId,
      command,
      title,
      previousPtyId,
    })
    if (!created) {
      createStarted = false
      debug.log("terminal create missing promise", {
        tabId: props.tabId,
        leafId: props.leafId,
      })
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
        debug.log("terminal create resolved", {
          tabId: props.tabId,
          leafId: props.leafId,
          createdId,
          all: terminal.all().map((item) => item.id),
        })
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
        debug.log("terminal create failed", {
          tabId: props.tabId,
          leafId: props.leafId,
        })
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
    debug.log("connect error", {
      tabId: props.tabId,
      leafId: props.leafId,
      id,
      error:
        error instanceof WebSocketCloseError
          ? { name: error.name, message: error.message, code: error.code, reason: error.reason }
          : error instanceof Error
            ? { name: error.name, message: error.message }
            : String(error),
    })
    // Clone-on-reconnect for WebSocket 1008
    if (error instanceof WebSocketCloseError && error.code === 1008) {
      let newId: string | undefined
      try {
        newId = await trackRecovery(recoveryInflight, recoveryAlias, id, () => terminal.clone(id) ?? Promise.resolve(undefined))
      } catch {
        // clone failed — ignore
      }
      if (!newId || disposed) return
      setRealPtyId(newId)
      debug.log("clone resolved", {
        tabId: props.tabId,
        leafId: props.leafId,
        oldId: id,
        newId,
        all: terminal.all().map((item) => item.id),
      })
      aliasTerminalSessionPreview(id, newId)
      aliasTerminalLogSummary(id, newId)
      claxedo.terminal.replaceId(props.tabId, id, newId)
      requestTerminalFitOnPaneChange()
    }
  }

  return (
    <Show
      when={pty()}
      keyed
      fallback={
        <div class="flex items-center justify-center h-full text-text-weak">
          <div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
        </div>
      }
    >
      {(pty) => <div class="flex-1 min-h-0 h-full w-full overflow-hidden">
        <Terminal
          pty={pty}
          autoFocus={false}
          onCleanup={terminal.update}
          onUpdate={terminal.update}
          onConnectError={handleConnectError}
          onAgentInterrupt={() => {
            const id = realPtyId()
            if (!id) return
            if (!claxedo.terminal.isTracked(id)) return
            if (claxedo.terminal.agentStatus(id) === "idle") return

            batch(() => {
              claxedo.terminal.setAgentStatus(id, "idle")
              const aggregated = claxedo.terminal.getTabAgentStatus(props.tabId)
              claxedo.patchTab(props.tabId, {
                loading: aggregated.loading,
                done: aggregated.done,
                attention: aggregated.attention ? undefined : false,
              })
            })
          }}
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
            if (!filePath.startsWith("/") || filePath.startsWith(dir + "/") || filePath === dir) {
              const title = filePath.split("/").at(-1) ?? filePath
              const tabId = tabs().addFile(dir, filePath, title)
              if (tabId) tabs().setActive(tabId)
            }
          }}
        />
      </div>}
    </Show>
  )
}
