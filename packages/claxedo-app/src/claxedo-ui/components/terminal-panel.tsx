/**
 * TerminalPanel
 *
 * Direct-rendering terminal component for terminal tabs in group panels.
 *
 * Key differences from the old approach:
 * - No portal hosts, no MutationObserver, no detection loop
 * - Receives ptyId, directory, groupId, tabId as props
 * - Renders Terminal component directly in the component tree
 * - Manages split panes within a single terminal tab
 * - Handles clone-on-reconnect (WebSocket 1008)
 *
 * Uses useTerminal() context for reactive PTY data. When the global terminal
 * store (T2) is available, lifecycle operations (new, close, clone, update)
 * are routed through it for proper binding and ownership tracking.
 */

import {
  Show,
  createMemo,
  createEffect,
  createSignal,
  on,
  onCleanup,
  batch,
} from "solid-js"
import { useTerminal } from "@/context/terminal"
import { useSDK } from "@/context/sdk"
import { useClaxedoLayout } from "../context/claxedo-layout"
import type { Pane } from "../context/claxedo-layout/types"
import { paneInStore } from "./terminal-pane-layout"
import { createDebugLogger } from "../../overrides/utils/debug"
import { createTerminalPanelLifecycle } from "./terminal-panel/lifecycle"
import { createTerminalPanelSplit } from "./terminal-panel/split"
import { createTerminalPaneActions } from "./terminal-panel/pane-actions"
import { createTerminalPanelInteractions } from "./terminal-panel/interactions"
import { createTerminalPanelRenderers } from "./terminal-panel/renderers"

export interface TerminalPanelProps {
  ptyId: string
  directory: string
  groupId: string
  tabId: string
}

/**
 * TerminalPanel — direct rendering of terminal tabs (no portals).
 *
 * Uses useTerminal() context (provided by DirectoryScope) for reactive PTY
 * data. When the global terminal store (T2) is available, lifecycle operations
 * (new, close, clone, update) are routed through it for proper binding and
 * ownership tracking.
 */
export function TerminalPanel(props: TerminalPanelProps) {
  const claxedo = useClaxedoLayout()
  const terminal = useTerminal()
  const sdk = useSDK()

  const ptys = createMemo(() => terminal.all())

  const tabs = createMemo(() => claxedo.groupTabs(props.groupId))
  const [tabCloseHandled, setTabCloseHandled] = createSignal(false)
  const [tabWasLive, setTabWasLive] = createSignal(false)
  let pendingCreateStarted = false
  let disposed = false

  onCleanup(() => {
    disposed = true
  })

  const debug = createDebugLogger("terminal.panel", "terminal-panel", {
    legacyKey: "opencode.debug.terminal",
  })
  const log = (...args: unknown[]) => debug.log(...args)

  // Map of ptyId → LocalPTY for quick lookup
  const map = createMemo(() => {
    const m = new Map<string, ReturnType<typeof ptys>[number]>()
    for (const pty of ptys()) {
      if (pty.id.startsWith("pending-")) continue
      m.set(pty.id, pty)
    }
    const tabTitle = tabs().items().find((t) => t.id === props.tabId && t.type === "terminal")?.title ?? "Terminal"
    for (const id of claxedo.terminal.ids(props.tabId)) {
      if (id.startsWith("pending-")) continue
      if (m.has(id)) continue
      const lifecycle = claxedo.terminal.lifecycle?.(id)
      const pending = lifecycle === "creating" || lifecycle === "attaching"
      if (!pending) continue
      if (claxedo.terminal.isClosing?.(id)) continue
      m.set(id, {
        id,
        title: tabTitle,
        titleNumber: 1,
        cwd: props.directory,
      })
    }
    return m
  })

  const lifecycle = createTerminalPanelLifecycle({
    claxedo,
    terminal,
    map,
    tabId: props.tabId,
    groupId: props.groupId,
    tabExists: () => tabs().items().some((tab) => tab.id === props.tabId),
  })

  const rootPtyId = createMemo(() => {
    if (lifecycle.isUsablePtyId(props.ptyId)) return props.ptyId
    const focus = claxedo.terminal.focus(props.tabId)
    if (lifecycle.isUsablePtyId(focus)) return focus
    const ids = claxedo.terminal.ids(props.tabId)
    const id = ids.find((item) => lifecycle.isUsablePtyId(item))
    if (id) return id
    return
  })

  // Ensure the pane tree has at least the root PTY
  createEffect(() => {
    const ptyId = rootPtyId()
    if (!ptyId) return
    if (!lifecycle.isUsablePtyId(ptyId)) return
    claxedo.terminal.ensure(props.tabId, ptyId)
  })

  // Backfill missing terminalId on existing persisted tabs
  createEffect(() => {
    const tabItems = tabs().items()
    const tab = tabItems.find((t) => t.id === props.tabId)
    if (!tab || tab.type !== "terminal") return
    if (tab.terminalId) return
    const ptyId = rootPtyId()
    if (!ptyId) return
    tabs().patch(props.tabId, { terminalId: ptyId })
  })

  // Pane tree from claxedo layout state
  const paneRoot = createMemo(() => claxedo.terminal.pane(props.tabId))

  const paneValid = createMemo(() => {
    const pane = paneRoot()
    return paneInStore(pane, (id) => map().has(id))
  })

  createEffect(() => {
    const pendingId = props.ptyId
    if (!pendingId.startsWith("pending-")) return
    if (pendingCreateStarted) return
    const queued = claxedo.terminal.peekCreateForTab?.(props.tabId)
    if (!queued) return
    pendingCreateStarted = true

    const consumed = claxedo.terminal.consumeCreateForTab?.(props.tabId) ?? queued
    const command = consumed.command
    const title = consumed.title
    const previousPtyId = consumed.previousPtyId

    claxedo.terminal.transitionLifecycle?.(pendingId, "creating", "pending_tab_create_start")
    if (!terminal) return

    const created = terminal.new(command, title, previousPtyId)
    if (!created) {
      pendingCreateStarted = false
      return
    }

    void created
      .then((createdId) => {
        if (!createdId) {
          pendingCreateStarted = false
          return
        }
        if (disposed || !tabs().items().some((tab) => tab.id === props.tabId)) {
          lifecycle.closePty(createdId)
          return
        }
        tabs().patch(props.tabId, { terminalId: createdId })
        claxedo.terminal.replaceId(props.tabId, pendingId, createdId)
        claxedo.terminal.setFocus(props.tabId, createdId)
        claxedo.terminal.transitionLifecycle?.(createdId, "attached", "pending_tab_create_ready")
      })
      .catch(() => {
        pendingCreateStarted = false
      })
  })

  // Prune stale pane IDs after reload so removed PTYs don't keep phantom leaves.
  createEffect(() => {
    const ids = claxedo.terminal.ids(props.tabId)
    if (ids.length === 0) return
    const live = new Set(ptys().map((pty) => pty.id))

    for (const id of ids) {
      if (live.has(id)) continue
      const lifecycle = claxedo.terminal.lifecycle?.(id)
      const closing = claxedo.terminal.isClosing?.(id)
      if (!closing && lifecycle !== "closing" && lifecycle !== "closed") continue
      log("prune stale pane id", { tabId: props.tabId, id, lifecycle, closing })
      batch(() => {
        claxedo.terminal.close({ tab: props.tabId, id })
        claxedo.terminal.disown(id)
        claxedo.terminal.clearClosing?.(id)
      })
    }

    const tab = tabs().items().find((item) => item.id === props.tabId && item.type === "terminal")
    if (!tab) return
    if (!tab.terminalId) return
    if (live.has(tab.terminalId)) return
    const next = claxedo.terminal.ids(props.tabId).find((id) => live.has(id))
    if (!next) return
    const title = map().get(next)?.title ?? tab.title
    tabs().patch(props.tabId, { terminalId: next, title })
    claxedo.terminal.setFocus(props.tabId, next)
  })

  // Repair stale focus pointers
  createEffect(() => {
    const ids = claxedo.terminal.ids(props.tabId)
    if (ids.length === 0) return
    const current = claxedo.terminal.focus(props.tabId)
    const next = lifecycle.resolveLiveFocus(props.tabId)
    if (!next || current === next) return
    claxedo.terminal.setFocus(props.tabId, next)
  })

  const split = createTerminalPanelSplit({
    claxedo,
    terminal,
    ptys,
    tabId: props.tabId,
    log,
    resolveLiveFocus: lifecycle.resolveLiveFocus,
    terminalOrigin: lifecycle.terminalOrigin,
  })
  const splitPending = split.splitPending
  const splitFor = split.splitFor

  const pane = createTerminalPaneActions({
    claxedo,
    tabs,
    map,
    tabId: props.tabId,
    directory: props.directory,
    resolveLiveFocus: lifecycle.resolveLiveFocus,
    closePty: lifecycle.closePty,
    terminalOrigin: lifecycle.terminalOrigin,
  })
  const closePane = pane.closePane
  const detachPane = pane.detachPane
  const focusPane = pane.focusPane

  // If a terminal tab is closed via tab-bar actions, force-close all PTYs
  // linked to that tab (global + legacy stores) before unmount.
  createEffect(() => {
    if (tabCloseHandled()) return
    const isLive = tabs().items().some((tab) => tab.id === props.tabId)
    if (isLive) {
      if (!tabWasLive()) setTabWasLive(true)
      return
    }
    if (!tabWasLive()) return
    setTabCloseHandled(true)
    const ids = new Set<string>([...claxedo.terminal.ids(props.tabId), props.ptyId].filter(Boolean))
    for (const id of ids) {
      lifecycle.closePty(id)
    }
  })

  const interactions = createTerminalPanelInteractions({
    tabId: props.tabId,
    claxedo,
    resolveLiveFocus: lifecycle.resolveLiveFocus,
    splitFor,
    closePane,
  })
  const moveState = interactions.moveState
  const overState = interactions.overState

  const renderers = createTerminalPanelRenderers({
    props: { tabId: props.tabId, directory: props.directory },
    sdk,
    claxedo,
    terminal,
    tabs,
    paneRoot,
    map,
    splitPending,
    splitFor,
    closePane,
    detachPane,
    focusPane,
    persistUpdate: lifecycle.persistUpdate,
    moveState,
    overState,
    startMove: interactions.startMove,
    resolveLiveFocus: lifecycle.resolveLiveFocus,
    log,
  })
  const FlatPaneRenderer = renderers.FlatPaneRenderer
  const emptyFallback = renderers.emptyFallback

  return (
    <div
      id={`claxedo-tab-host-${props.tabId}`}
      data-claxedo-group-id={props.groupId}
      class="absolute inset-0 overflow-hidden bg-background-base"
    >
      <Show
        when={paneValid() ? paneRoot() : undefined}
        fallback={
          <Show when={paneRoot()}>
            {emptyFallback()}
          </Show>
        }
      >
        <FlatPaneRenderer />
      </Show>
    </div>
  )
}
