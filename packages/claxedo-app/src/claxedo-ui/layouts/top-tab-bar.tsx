/**
 * Top Tab Bar Component
 *
 * Horizontal tab bar for sessions, terminals, and file tabs.
 * Features:
 * - Drag-to-reorder tabs
 * - Close buttons on hover
 * - Badge display for changes
 * - Keyboard navigation
 */

import { For, Show, createMemo, createSignal, createEffect, on, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { SortableProvider, createSortable, createDroppable } from "@thisbeyond/solid-dnd"
import { useClaxedoLayout, type PaneContent, type TabItem, type TabType } from "../context/claxedo-layout"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Popover } from "@opencode-ai/ui/popover"
import { List } from "@opencode-ai/ui/list"
import { useLanguage, useServer } from "@opencode-ai/claxedo-app"
import { useTheme } from "@opencode-ai/ui/theme"
import { getFilename } from "@opencode-ai/util/path"
import { getTerminalCommands } from "../../components/settings-terminals"
import { useOptionalTerminal } from "@/context/terminal"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { createDebugLogger } from "../../overrides/utils/debug"
import { cachedTerminalSessionPreview } from "../utils/terminal-session-preview"
import { createPreviewLoader } from "../utils/preview-loader"
// Loading indicator - pulsing dot
const PULSE_INTERVAL = 500
const POPOVER_MIN_WIDTH = 260
const POPOVER_HOVER_CLOSE_MS = 80
const tabbarDebug = createDebugLogger("terminal.tabbar", "terminal:tabbar", {
  legacyKey: "opencode.debug.terminal",
})

/** Pulsing dot component for loading state */
function LoadingIndicator(props: { class?: string }) {
  const [visible, setVisible] = createSignal(true)

  const interval = setInterval(() => {
    setVisible((prev) => !prev)
  }, PULSE_INTERVAL)

  onCleanup(() => clearInterval(interval))

  return (
    <span
      class={`relative flex shrink-0 ${props.class ?? ""}`}
      style={{ width: "10px", height: "10px" }}
      aria-hidden="true"
    >
      <span
        class="absolute inline-flex rounded-full"
        style={{
          width: "10px",
          height: "10px",
          "background-color": "#f59e0b", // amber-500
          opacity: visible() ? 1 : 0.4,
          transition: "opacity 200ms ease-in-out",
        }}
      />
    </span>
  )
}

/** Attention dot indicator (red pulsing dot) */
function AttentionDot(props: { class?: string }) {
  return (
    <span class={`relative flex shrink-0 ${props.class ?? ""}`} style={{ width: "10px", height: "10px" }}>
      <span
        class="absolute inline-flex animate-ping rounded-full"
        style={{
          width: "10px",
          height: "10px",
          "background-color": "#f87171", // red-400
          opacity: 0.75,
        }}
      />
      <span
        class="relative inline-flex rounded-full"
        style={{
          width: "10px",
          height: "10px",
          "background-color": "#ef4444", // red-500
        }}
      />
    </span>
  )
}

/** Done indicator (green dot) */
function DoneDot(props: { class?: string }) {
  return (
    <span class={`relative flex shrink-0 ${props.class ?? ""}`} style={{ width: "10px", height: "10px" }}>
      <span
        class="relative inline-flex rounded-full"
        style={{
          width: "10px",
          height: "10px",
          "background-color": "#22c55e", // green-500
        }}
      />
    </span>
  )
}

type PaneStatus = "working" | "permission" | "done" | "idle"

type PaneSummary = {
  leafId: string
  name: string
  focused: boolean
  content: Pick<PaneContent, "type" | "directory" | "sessionId" | "terminalId">
}

const PANE_WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]

function paneName(content: Pick<PaneContent, "type" | "command" | "title">, index: number, total: number): string {
  const prefix = (() => {
    if (content.type === "terminal") {
      const cmd = (content.command || content.title || "").toLowerCase()
      if (cmd.includes("claude")) return "claude"
      if (cmd.includes("codex")) return "codex"
      if (cmd.includes("aider")) return "aider"
      if (cmd.includes("gemini")) return "gemini"
      return "terminal"
    }
    if (content.type === "review") return "review"
    if (content.type === "context") return "context"
    return "session"
  })()
  if (total <= 1) return `@${prefix}`
  const word = PANE_WORDS[index % PANE_WORDS.length]
  const suffix = index >= PANE_WORDS.length ? `-${index + 1}` : ""
  return `@${prefix}-${word}${suffix}`
}

function PaneStatusDot(props: { status: PaneStatus }) {
  const bgColor = () => {
    const s = props.status
    if (s === "working") return "#f59e0b"
    if (s === "permission") return "#ef4444"
    if (s === "done") return "#22c55e"
    return "#6b7280"
  }

  return (
    <span
      class="inline-flex rounded-full shrink-0"
      style={{ width: "6px", height: "6px", "background-color": bgColor() }}
    />
  )
}
// Get terminal commands (reads from localStorage with defaults)
const getCommands = () => {
  const stored = getTerminalCommands()
  return {
    claude: stored.claude,
    codex: stored.codex,
    terminal: "",
    custom: stored.custom,
  }
}

// Icon mapping for tab types
export const TAB_ICONS: Record<
  TabType,
  "bubble-5" | "console" | "code" | "code-lines" | "folder" | "window-cursor" | "page" | "layout-right" | "pin" | "file-tree"
> = {
  session: "bubble-5",
  terminal: "console",
  review: "code",
  "review-workspace": "code-lines",
  file: "folder",
  context: "window-cursor",
  page: "page",
  "multi-pane": "layout-right",
  process: "console",
  filetree: "file-tree",
}

export type TopTabBarProps = {
  groupId?: string
  onNewReview?: () => void
  onToggleReviewPane?: () => void
  onTabSelect?: (tab: TabItem) => void
  onTabClose?: (nextActiveTab: TabItem | undefined) => void
  onSidebarToggle?: () => void
  onStartAllProcesses?: () => void
  onStopAllProcesses?: () => void
  onAddProcess?: () => void
  onToggleFileTree?: () => void
  fileTreeActive?: boolean
  reviewPaneActive?: boolean
  sidebarPinned?: boolean
  mobileSidebarOpen?: boolean
  showSidebarToggle?: boolean
  worktreeInfo?: (directory: string) => { name: string; isMain: boolean; tooltip?: string } | undefined
  class?: string
}

type WorkspaceScopeButtonsProps = {
  onNewSession?: () => void
  onNewTerminal?: (command?: string, title?: string) => void
  onNewPage?: () => void
  onSettings?: () => void
  onProcesses?: () => void
  processAttention?: boolean
  processActive?: boolean
  processRunning?: boolean
  hasProcesses?: boolean
  class?: string
}

/** State dot for the process chip — 6px circle with optional pulsing */
function ProcessChipDot(props: { color: "red" | "green" | "gray" }) {
  return (
    <span class="relative flex shrink-0" style={{ width: "6px", height: "6px" }}>
      <Show when={props.color === "red"}>
        <span
          class="absolute inline-flex animate-ping rounded-full"
          style={{ width: "6px", height: "6px", "background-color": "#f87171", opacity: 0.75 }}
        />
      </Show>
      <span
        class="relative inline-flex rounded-full"
        style={{
          width: "6px",
          height: "6px",
          "background-color":
            props.color === "red" ? "#ef4444" : props.color === "green" ? "#22c55e" : "#6b7280",
        }}
      />
    </span>
  )
}

function WorkspaceScopeButtons(props: WorkspaceScopeButtonsProps) {
  // Dot state: reflects actual process status
  // Priority: crashed (red) > running (green) > stopped (gray) > none (no dot)
  const dotState = () => {
    if (props.processAttention) return "crashed" as const
    if (props.processRunning) return "running" as const
    if (props.hasProcesses) return "stopped" as const
    return "none" as const
  }

  return (
    <div class={`flex items-center gap-0 flex-shrink-0 ${props.class ?? ""}`}>
      {/* Plain icon buttons — stateless creation actions */}
      <Tooltip value="New Session">
        <button
          type="button"
          class="flex items-center justify-center w-8 h-8 hover:bg-surface-base-hover text-text-weak hover:text-text-base transition-colors shrink-0 rounded"
          onClick={() => props.onNewSession?.()}
          aria-label="New Session"
        >
          <Icon name="plus-small" size="small" />
        </button>
      </Tooltip>

      <Tooltip value="New Claude Terminal">
        <button
          type="button"
          class="flex items-center justify-center w-8 h-8 hover:bg-surface-base-hover text-text-weak hover:text-text-base transition-colors shrink-0 rounded"
          onClick={() => props.onNewTerminal?.(getCommands().claude, "Claude")}
          aria-label="New Claude Terminal"
        >
          <span class="text-xs font-bold">C</span>
        </button>
      </Tooltip>

      <Tooltip value="New Codex Terminal">
        <button
          type="button"
          class="flex items-center justify-center w-8 h-8 hover:bg-surface-base-hover text-text-weak hover:text-text-base transition-colors shrink-0 rounded"
          onClick={() => props.onNewTerminal?.(getCommands().codex, "Codex")}
          aria-label="New Codex Terminal"
        >
          <span class="text-xs font-bold">X</span>
        </button>
      </Tooltip>

      <Tooltip value="New Terminal">
        <button
          type="button"
          class="flex items-center justify-center w-8 h-8 hover:bg-surface-base-hover text-text-weak hover:text-text-base transition-colors shrink-0 rounded"
          onClick={() => props.onNewTerminal?.()}
          aria-label="New Terminal"
        >
          <Icon name="console" size="small" />
        </button>
      </Tooltip>

      <Tooltip value="New Page">
        <button
          type="button"
          class="flex items-center justify-center w-8 h-8 hover:bg-surface-base-hover text-text-weak hover:text-text-base transition-colors shrink-0 rounded"
          onClick={() => props.onNewPage?.()}
          aria-label="New Page"
        >
          <Icon name="page" size="small" />
        </button>
      </Tooltip>

      {/* Process chip — stateful singleton */}
      <Tooltip value={props.hasProcesses ? "Toggle Processes" : "Open Processes"}>
        <button
          type="button"
          class="flex items-center gap-1.5 h-7 px-2 ml-1 rounded transition-colors shrink-0"
          classList={{
            "bg-surface-base-hover text-text-base": props.processActive,
            "hover:bg-surface-base-hover text-text-weak": !props.processActive,
          }}
          onClick={() => props.onProcesses?.()}
          aria-label="Processes"
        >
          <span class="text-[12px] font-medium leading-none">Processes</span>
          <Show when={dotState() === "crashed"}>
            <ProcessChipDot color="red" />
          </Show>
          <Show when={dotState() === "running"}>
            <ProcessChipDot color="green" />
          </Show>
          <Show when={dotState() === "stopped"}>
            <ProcessChipDot color="gray" />
          </Show>
        </button>
      </Tooltip>

      {/* Dropdown — overflow menu */}
      <DropdownMenu>
        <DropdownMenu.Trigger class="flex items-center justify-center w-8 h-8 hover:bg-surface-base-hover text-text-weak hover:text-text-base transition-colors cursor-pointer border-none bg-transparent shrink-0 rounded">
          <Icon name="chevron-down" size="small" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="z-[200]">
            <Show when={getCommands().custom.length > 0}>
              <For each={getCommands().custom}>
                {(cmd) => (
                  <Show when={cmd.name && cmd.command}>
                    <DropdownMenu.Item onSelect={() => props.onNewTerminal?.(cmd.command, cmd.name)}>
                      <Icon name="console" size="small" class="mr-2" />
                      {cmd.name}
                    </DropdownMenu.Item>
                  </Show>
                )}
              </For>
              <DropdownMenu.Separator />
            </Show>
            <DropdownMenu.Item onSelect={() => props.onSettings?.()}>
              <Icon name="settings-gear" size="small" class="mr-2" />
              Configure...
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}

function SortableTab(props: {
  tab: TabItem
  isActive: boolean
  onClose: (tabId: string) => void
  onSelect?: (tab: TabItem) => void
  onSetActive: (tabId: string) => void
  onDblClick: (dir: string) => void
  onContextMenu?: (e: MouseEvent, tabId: string) => void
  worktreeColor?: string
  paneSummariesFn?: (tab: TabItem) => PaneSummary[]
  paneStatusFn?: (tab: TabItem, content: Pick<PaneContent, "type" | "directory" | "sessionId" | "terminalId">) => PaneStatus
  onPaneFocus?: (leafId: string) => void
}) {
  // Pinned tabs are excluded from SortableProvider ids, but createSortable
  // still needs to be called (unconditionally, per SolidJS hook rules).
  // For pinned tabs the sortable simply won't match any provider id → no drag.
  const sortable = createSortable(props.tab.id)
  // Pane summaries computed lazily inside each tab — avoids tracking pane
  // reactive state in the parent visibleWithMeta memo (which would re-key all tabs).
  const paneList = createMemo(() => props.paneSummariesFn?.(props.tab) ?? [])
  const hasPaneSummary = createMemo(() => paneList().length > 0)
  // Only show popover for tabs with non-idle activity (working, permission, done)
  const hasActivePane = createMemo(() => {
    if (!hasPaneSummary() || !props.paneStatusFn) return false
    return paneList().some((pane) => {
      const s = props.paneStatusFn!(props.tab, pane.content)
      return s !== "idle"
    })
  })
  const canShowPaneDetails = createMemo(() => hasActivePane() && !props.isActive)
  let root: HTMLDivElement | undefined
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  const [open, setOpen] = createSignal(false)
  const [anchor, setAnchor] = createSignal({ left: 0, top: 0, width: POPOVER_MIN_WIDTH })
  const isPinned = () => !!props.tab.pinned

  const clearHideTimer = () => {
    if (!hideTimer) return
    clearTimeout(hideTimer)
    hideTimer = undefined
  }

  const placeAnchor = () => {
    const rect = root?.getBoundingClientRect()
    if (!rect) return
    setAnchor({
      left: rect.left,
      top: rect.bottom + 4,
      width: Math.max(rect.width, POPOVER_MIN_WIDTH),
    })
  }

  const scheduleClose = () => {
    clearHideTimer()
    hideTimer = setTimeout(() => setOpen(false), POPOVER_HOVER_CLOSE_MS)
  }

  const handleMouseEnter = () => {
    if (!canShowPaneDetails()) return
    clearHideTimer()
    placeAnchor()
    setOpen(true)
  }

  const handleMouseLeave = () => {
    if (!canShowPaneDetails()) return
    scheduleClose()
  }

  onCleanup(() => {
    clearHideTimer()
  })

  const handleSelect = () => {
    clearHideTimer()
    setOpen(false)
    props.onSetActive(props.tab.id)
    props.onSelect?.(props.tab)
  }

  const handleDblClick = () => {
    setOpen(false)
    props.onDblClick(props.tab.directory)
  }

  const handleAuxClick = (e: MouseEvent) => {
    if (e.button !== 1 || !props.tab.closable) return
    e.preventDefault()
    e.stopImmediatePropagation()
    setOpen(false)
    const tabId = props.tab.id
    tabbarDebug.log("close click aux", { tabId, tabType: props.tab.type })
    queueMicrotask(() => props.onClose(tabId))
  }

  const handleClose = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    const tabId = props.tab.id
    tabbarDebug.log("close click", { tabId, tabType: props.tab.type })
    queueMicrotask(() => props.onClose(tabId))
  }

  const handleContextMenu = (e: MouseEvent) => {
    props.onContextMenu?.(e, props.tab.id)
  }

  const handlePaneFocus = (leafId: string, e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    props.onSetActive(props.tab.id)
    props.onSelect?.(props.tab)
    props.onPaneFocus?.(leafId)
    setOpen(false)
  }

  return (
    <div
      // @ts-ignore - solid-dnd directive
      use:sortable
      ref={root}
      data-tab-id={props.tab.id}
      data-active={props.isActive ? "" : undefined}
      class="group relative flex items-center h-10 cursor-pointer flex-shrink-0 select-none transition-[background-color,opacity] duration-200"
      classList={{
        "opacity-50": sortable.isActiveDraggable,
        "pl-2 pr-0": true,
        "max-w-[200px] min-w-[100px] max-md:min-w-[60px] max-md:max-w-[150px] max-md:pl-1.5": !isPinned(),
        // active / inactive bg
        "bg-background-stronger border border-b-0": props.isActive,
        "bg-transparent hover:bg-surface-base-hover/40": !props.isActive,
      }}
      style={{
        ...(props.isActive ? { "border-color": props.worktreeColor ?? "transparent" } : {}),
      }}
      onClick={handleSelect}
      onDblClick={handleDblClick}
      onAuxClick={handleAuxClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        class="flex items-center gap-1 overflow-hidden"
        style={{ flex: "1", "margin-left": "4px", "min-width": "0" }}
      >
        <span
          class="text-[13px] max-md:text-[12px] font-[450] whitespace-nowrap overflow-hidden text-ellipsis min-w-0 transition-colors duration-100"
          classList={{
            "text-text-strong font-medium": props.isActive,
            "text-text-weak group-hover:text-text-base": !props.isActive,
          }}
        >
          {props.tab.title}
        </span>
      </div>
      <Show when={isPinned()}>
        <Icon
          name="pin"
          size="small"
          class="flex-shrink-0 ml-2 mr-2 transition-colors duration-100"
          classList={{
            "text-icon-base": props.isActive,
            "text-icon-weak group-hover:text-icon-base": !props.isActive,
          }}
        />
      </Show>

      {/* Tab status dots */}
      <Show when={props.tab.loading}>
        <LoadingIndicator class="mx-1" />
      </Show>
      <Show when={props.tab.attention && !props.tab.loading}>
        <AttentionDot class="flex-shrink-0 mx-1" />
      </Show>
      <Show when={props.tab.done && !props.tab.loading && !props.tab.attention && !props.isActive}>
        <DoneDot class="flex-shrink-0 mx-1" />
      </Show>

      <Show when={open() && hasPaneSummary()}>
        <Portal>
          <div
            class="hidden md:block fixed z-[280]"
            style={{
              left: `${anchor().left}px`,
              top: `${anchor().top}px`,
              width: `${anchor().width}px`,
            }}
            onMouseEnter={() => {
              clearHideTimer()
              setOpen(true)
            }}
            onMouseLeave={scheduleClose}
          >
            <div class="overflow-hidden rounded-md border border-border-weak-base bg-background-stronger/95 backdrop-blur shadow-lg">
              <div class="py-1">
                <For each={paneList()}>
                  {(pane) => {
                    const status = () => props.paneStatusFn?.(props.tab, pane.content) ?? "idle"
                    return (
                      <button
                        type="button"
                        class="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-surface-base-hover"
                        classList={{ "bg-surface-base-hover/70": pane.focused }}
                        onClick={(e) => handlePaneFocus(pane.leafId, e)}
                      >
                        <PaneStatusDot status={status()} />
                        <span class="text-[12px] text-text-weak truncate">{pane.name}</span>
                      </button>
                    )
                  }}
                </For>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
      {/* Close button - full height, no margin */}
      <Show when={props.tab.closable}>
        <button
          type="button"
          class={`flex items-center justify-center w-8 h-10 p-0 bg-transparent border-none cursor-pointer flex-shrink-0 transition-all duration-100 ${
            props.isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          } text-icon-weak hover:bg-surface-base-hover hover:text-icon-base`}
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            e.stopImmediatePropagation()
          }}
          onClick={handleClose}
          aria-label="Close tab"
          {...(props.isActive ? { "data-active-close": "" } : {})}
        >
          <Icon name="close" size="small" />
        </button>
      </Show>
    </div>
  )
}

export function TabDragOverlay(props: { tab: TabItem | undefined }) {
  return (
    <Show when={props.tab}>
      {(tab) => (
        <div class="flex items-center h-10 px-2 cursor-pointer flex-shrink-0 max-w-[200px] min-w-[100px] select-none bg-surface-raised-base shadow-[0_4px_8px_rgba(0,0,0,0.2)]">
          <Icon name={TAB_ICONS[tab().type]} size="small" class="hidden" />
          <span class="text-[13px] font-[450] text-text-weak whitespace-nowrap overflow-hidden text-ellipsis flex-1 min-w-0">
            {tab().title}
          </span>
        </div>
      )}
    </Show>
  )
}

// Worktree border colors for dark mode — brightened for better visibility
const DARK_WORKTREE_COLORS: Record<string, string> = {
  "#3b82f6": "#60a5fa", // blue → bright blue
  "#22c55e": "#4ade80", // green → bright green
  "#a855f7": "#c084fc", // purple → bright purple
  "#f97316": "#fb923c", // orange → bright orange
  "#ec4899": "#f472b6", // pink → bright pink
  "#14b8a6": "#2dd4bf", // teal → bright teal
  "#f59e0b": "#fbbf24", // amber → bright amber
  "#6366f1": "#818cf8", // indigo → bright indigo
  "#ef4444": "#f87171", // red → bright red
  "#06b6d4": "#22d3ee", // cyan → bright cyan
}

function brightenWorktreeColor(color: string | undefined, mode: string): string {
  if (!color || color === "transparent") return "transparent"
  if (mode === "dark") return DARK_WORKTREE_COLORS[color] ?? color
  return color
}

export function TopTabBar(props: TopTabBarProps) {
  const claxedo = useClaxedoLayout()
  const terminal = useOptionalTerminal()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const theme = useTheme()
  const wtBorderColor = (color: string | undefined) => brightenWorktreeColor(color, theme.mode())

  // Use group-specific tabs when groupId is provided, otherwise backward-compatible topTabs
  const tabs = createMemo(() => (props.groupId ? claxedo.groupTabs(props.groupId) : claxedo.topTabs))
  const wt = createMemo(() => (props.groupId ? claxedo.groupWorktree(props.groupId) : claxedo.worktree))

  const [contextMenu, setContextMenu] = createSignal<{ tabId: string; x: number; y: number } | null>(null)
  const closingTabs = new Set<string>()
  const active = createMemo(() => tabs().active())
  const pinned = createMemo(() => wt().pinned())
  const selected = createMemo(() => wt().default())
  const scope = createMemo(() => {
    const tab = active()
    if (tab && (tab.type === "session" || tab.type === "review" || tab.type === "context" || tab.type === "file")) {
      return tab.directory
    }
    return selected()
  })

  const tabScopeDir = (tab: TabItem) => {
    if (tab.type === "review" || tab.type === "context" || tab.type === "file") {
      return scope() ?? tab.directory
    }
    return tab.directory
  }

  const orderedTabs = createMemo(() => tabs().visualOrderedItems())
  const scopeFilteredTabs = createMemo(() => {
    const pin = pinned()
    if (pin) return orderedTabs().filter((t) => t.pinned || tabScopeDir(t) === pin)

    const dir = scope()
    if (!dir) return orderedTabs()

    return orderedTabs().filter((t) => {
      if (t.pinned) return true
      if (t.type === "review" || t.type === "context" || t.type === "file") return tabScopeDir(t) === dir
      return true
    })
  })
  const visibleTabs = createMemo(() => {
    const list = scopeFilteredTabs()
    const groups = new Map<string, TabItem[]>()
    for (const tab of list) {
      const dir = tabScopeDir(tab)
      const existing = groups.get(dir)
      if (existing) {
        existing.push(tab)
        continue
      }
      groups.set(dir, [tab])
    }
    return Array.from(groups.values()).flat()
  })
  const server = useServer()

  const { terminalSession, ensureSessionMessages, ensureTerminalSession } =
    createPreviewLoader({
      sdkUrl: () => globalSDK.url,
      serverHealthy: () => server.healthy() === true,
      globalSyncChild: (dir, opts) => globalSync.child(dir, opts),
      fetchSessionMessages: (params) => globalSDK.client.session.messages(params),
      debug: tabbarDebug,
    })

  createEffect(() => {
    const sessions = new Set<string>()
    const terminals = new Map<string, string>()

    visibleTabs().forEach((tab) => {
      if (tab.type === "terminal" && tab.terminalId && !tab.terminalId.startsWith("pending-")) {
        terminals.set(tab.terminalId, tab.directory)
      }

      claxedo.select.multiPaneLeafView(tab.id).forEach((leaf) => {
        const content = leaf.content
        if (!content) return

        if (content.type === "session" || content.type === "review" || content.type === "context") {
          if (!content.directory || !content.sessionId || content.sessionId === "new") return
          sessions.add(`${content.directory}:${content.sessionId}`)
          return
        }

        if (content.type === "terminal" && content.terminalId && !content.terminalId.startsWith("pending-")) {
          terminals.set(content.terminalId, content.directory || tab.directory)
        }
      })
    })

    sessions.forEach((entry) => {
      const index = entry.lastIndexOf(":")
      if (index <= 0 || index >= entry.length - 1) return
      const directory = entry.slice(0, index)
      const sessionId = entry.slice(index + 1)
      ensureSessionMessages(directory, sessionId)
    })

    terminals.forEach((directory, terminalId) => {
      ensureTerminalSession(terminalId, directory)
    })

    if (tabbarDebug.enabled(2)) {
      tabbarDebug.verbose("summary scan", {
        tabCount: visibleTabs().length,
        sessionRefs: sessions.size,
        terminalRefs: terminals.size,
      })
    }
  })

  // When filtering, auto-select first visible tab if active tab is filtered out
  createEffect(() => {
    const visible = visibleTabs()
    const currentActive = active()
    if (!currentActive) return
    const isActiveVisible = visible.some((t) => t.id === currentActive.id)
    if (!isActiveVisible && visible.length > 0) {
      tabs().setActive(visible[0].id)
    }
  })

  const tabIds = createMemo(() => visibleTabs().filter((t) => !t.pinned).map((t) => t.id))

  const paneStatus = (tab: TabItem, content: Pick<PaneContent, "type" | "directory" | "sessionId" | "terminalId">): PaneStatus => {
    if (content.type === "terminal" && content.terminalId) {
      // In-memory agent status from lifecycle hooks (real-time)
      const status = claxedo.terminal.agentStatus(content.terminalId)
      const tracked = claxedo.terminal.isTracked(content.terminalId)

      // HTTP session preview — always resolve for non-opencode providers
      // Some agents (Gemini) don't send permission lifecycle events, so the HTTP
      // session preview is the only signal for their permission state.
      const resolved =
        terminalSession[content.terminalId] ?? cachedTerminalSessionPreview(globalSDK.url, content.terminalId)
      const provider = (resolved?.provider || "").toLowerCase()
      const httpEvent = (resolved?.eventType || "").toLowerCase()

      // 1. Permission from lifecycle (highest priority — real-time)
      if (status === "permission") return "permission"

      // 2. Permission from HTTP — catches agents that don't send permission lifecycle events (Gemini)
      if (provider && provider !== "opencode" && httpEvent === "useractionrequired") {
        return "permission"
      }

      // 3. Working from lifecycle
      if (status === "working") return "working"

      // 4. Done: tab.done or seen() backup (agent finished, user hasn't focused yet)
      if (tab.done || claxedo.terminal.seen(content.terminalId)) return "done"

      // 5. HTTP fallback for untracked terminals (no lifecycle events received yet)
      if (!tracked && provider && provider !== "opencode") {
        if (httpEvent === "busy") return "working"
      }

      return "idle"
    }

    if ((content.type === "session" || content.type === "review" || content.type === "context") && content.sessionId) {
      const [store] = globalSync.child(content.directory)
      const status = store.session_status[content.sessionId]
      const perms = store.permission[content.sessionId] ?? []
      // Busy/retry takes priority — agent is actively working, stale permissions don't matter
      if (status?.type === "busy" || status?.type === "retry") return "working"
      // Permission only when session is actually waiting (not busy)
      if (perms.length > 0) return "permission"
      // Done: use tab.done (cleared when user activates the tab)
      if (tab.done) return "done"
      return "idle"
    }

    if (tab.loading) return "working"
    if (tab.attention) return "permission"
    if (tab.done) return "done"
    return "idle"
  }

  const paneSummaries = (tab: TabItem): PaneSummary[] => {
    const leaves = claxedo.select.multiPaneLeafView(tab.id)
    // No popover for single-pane tabs
    if (leaves.length <= 1) return []
    const total = leaves.length
    return leaves.map((leaf, index) => {
      const content = leaf.content
      if (!content) {
        return {
          leafId: leaf.id,
          name: `@pane-${PANE_WORDS[index % PANE_WORDS.length]}`,
          focused: leaf.focused,
          content: { type: "session" as const, directory: "", sessionId: undefined, terminalId: undefined },
        }
      }

      return {
        leafId: leaf.id,
        name: paneName(content, index, total),
        focused: leaf.focused,
        content: {
          type: content.type,
          directory: content.directory,
          sessionId: content.sessionId,
          terminalId: content.terminalId,
        },
      }
    })
  }

  const handlePaneFocus = (tabId: string, leafId: string) => {
    tabs().setActive(tabId)
    claxedo.dispatch({
      type: "PaneFocusRequested",
      tabId,
      leafId,
    })
  }
  const visibleWithMeta = createMemo(() => {
    const list = visibleTabs()
    return list.map((tab, index) => {
      if (index === 0) return { tab, showDivider: false }
      const prev = list[index - 1]
      return {
        tab,
        showDivider: tabScopeDir(prev) !== tabScopeDir(tab),
      }
    })
  })
  const showPaneButtons = createMemo(() => !!(wt().default() || active()?.directory))

  const droppable = createDroppable(`group-zone-${props.groupId ?? "default"}`)

  const handleTabClose = (tabId: string) => {
    if (props.groupId && claxedo.split.focusedId() !== props.groupId) {
      claxedo.dispatch({ type: "SplitFocusRequested", groupId: props.groupId })
    }
    const tabItem = tabs().items().find((t) => t.id === tabId)
    if (tabItem?.pinned) {
      tabbarDebug.log("close ignored: tab is pinned", { tabId })
      return
    }
    if (closingTabs.has(tabId)) {
      tabbarDebug.log("close ignored: already closing", { tabId })
      return
    }
    closingTabs.add(tabId)
    const tab = tabs()
      .items()
      .find((t) => t.id === tabId)
    const terminalIds =
      tab?.type === "terminal"
        ? new Set<string>(
            [...claxedo.terminal.ids(tab.id), tab.terminalId].filter(
              (id): id is string => typeof id === "string" && id.length > 0 && !id.startsWith("pending-"),
            ),
          )
        : undefined
    tabbarDebug.log("close requested", {
      tabId,
      tabType: tab?.type,
      terminalIds: terminalIds ? [...terminalIds] : [],
    })
    tabbarDebug.log("close execute", { tabId })
    try {
      tabs().close(tabId)
    } catch (error) {
      tabbarDebug.log("close failed", {
        tabId,
        error: error instanceof Error ? error.message : String(error),
      })
      closingTabs.delete(tabId)
      return
    }
    props.onTabClose?.(tabs().active())
    if (terminalIds && terminalIds.size > 0 && terminal) {
      queueMicrotask(() => {
        for (const id of terminalIds) {
          void terminal.close(id)
        }
      })
    }
    queueMicrotask(() => {
      closingTabs.delete(tabId)
      tabbarDebug.log("close complete", { tabId })
    })
  }

  const handleTabSetActive = (tabId: string) => {
    tabs().setActive(tabId)
  }

  const handleTabDblClick = (dir: string) => {
    wt().setDefault(dir)
    if (wt().pinned() === dir) {
      wt().setPinned(null)
      return
    }
    wt().setPinned(dir)
  }

  const handleTabContextMenu = (e: MouseEvent, tabId: string) => {
    e.preventDefault()
    setContextMenu({ tabId, x: e.clientX, y: e.clientY })
  }

  const ContextualPaneButtons = () => (
    <div data-tab-actions="true" class="flex items-center gap-0.5 shrink-0 pl-1 border-l border-border-weak-base/50">
      <Tooltip value={props.reviewPaneActive ? "Close Review Pane" : "Open Review Pane"}>
        <button
          type="button"
          class={`flex items-center justify-center h-8 w-8 rounded transition-colors ${
            props.reviewPaneActive ? "text-text-base bg-surface-base-hover" : "text-text-weak hover:text-text-base hover:bg-surface-base-hover"
          }`}
          onClick={() => props.onToggleReviewPane?.()}
          aria-label={props.reviewPaneActive ? "Close Review Pane" : "Open Review Pane"}
        >
          <Icon name="code-lines" size="small" />
        </button>
      </Tooltip>
      <Tooltip value={props.fileTreeActive ? "Close File Tree Pane" : "Open File Tree Pane"}>
        <button
          type="button"
          class={`flex items-center justify-center h-8 w-8 rounded transition-colors ${
            props.fileTreeActive ? "text-text-base bg-surface-base-hover" : "text-text-weak hover:text-text-base hover:bg-surface-base-hover"
          }`}
          onClick={() => props.onToggleFileTree?.()}
          aria-label={props.fileTreeActive ? "Close File Tree Pane" : "Open File Tree Pane"}
        >
          <Icon name={props.fileTreeActive ? "file-tree-active" : "file-tree"} size="small" />
        </button>
      </Tooltip>
    </div>
  )

  // Close context menu on click anywhere
  const closeContextMenu = () => setContextMenu(null)

  // Scroll active tab into view when it changes (e.g., new tab created off-screen)
  let tabScrollContainer: HTMLDivElement | undefined
  createEffect(
    on(
      () => tabs().activeId(),
      (activeId) => {
        if (!activeId || !tabScrollContainer) return
        requestAnimationFrame(() => {
          const el = tabScrollContainer?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`)
          if (typeof el?.scrollIntoView === "function") {
            el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" })
          }
        })
      },
    ),
  )

  return (
    <div
      class={`flex items-center h-10 bg-background-base pr-2 gap-0 overflow-hidden border-b border-border-weak-base box-content ${props.class ?? ""}`}
    >
      {/* Sidebar toggle button - hamburger on mobile, layout icon on desktop. Only on primary panel. */}
      <Show when={props.showSidebarToggle !== false}>
        <Tooltip value={props.sidebarPinned ? "Hide Sidebar" : "Show Sidebar"}>
          <div class="flex items-center">
            {/* Mobile: hamburger/close icon */}
            <IconButton
              icon={props.mobileSidebarOpen ? "close" : "menu"}
              variant="ghost"
              class="shrink-0 mr-2 rounded md:hidden"
              onClick={() => props.onSidebarToggle?.()}
              aria-label={props.mobileSidebarOpen ? "Close Menu" : "Open Menu"}
            />
          </div>
        </Tooltip>
      </Show>

      {/* Droppable zone wraps the tab bar area for cross-panel drops */}
      <div
        ref={tabScrollContainer}
        // @ts-ignore - solid-dnd directive
        use:droppable
        class="flex items-center gap-0 min-w-0 overflow-x-auto overflow-y-hidden flex-1 no-scrollbar"
      >
        <SortableProvider ids={tabIds()}>
          <For each={visibleWithMeta()}>
            {(entry, i) => {
              const tab = entry.tab
              const color = wtBorderColor(claxedo.getWorktreeColor(tabScopeDir(tab)))
              return (
                <>
                  <div class="flex items-center" style={{ "box-shadow": `inset 0 -1px 0 0 ${color}` }}>
                    <Show when={entry.showDivider}>
                      <div class="w-px h-10 bg-border-weak-base flex-shrink-0" />
                    </Show>
                    <SortableTab
                      tab={tab}
                      isActive={tabs().activeId() === tab.id}
                      onClose={handleTabClose}
                      onSelect={props.onTabSelect}
                      onSetActive={handleTabSetActive}
                      onDblClick={handleTabDblClick}
                      onContextMenu={handleTabContextMenu}
                      worktreeColor={color}
                      paneSummariesFn={paneSummaries}
                      paneStatusFn={paneStatus}
                      onPaneFocus={(leafId) => handlePaneFocus(tab.id, leafId)}
                    />
                  </div>
                </>
              )
            }}
          </For>
        </SortableProvider>
      </div>
      <Show when={showPaneButtons()}>
        <ContextualPaneButtons />
      </Show>

      {/* Process tab action buttons — shown when process tab is active */}
      <Show when={active()?.type === "process"}>
        <div class="flex items-center gap-0.5 shrink-0 pl-1 border-l border-border-weak-base/50">
          <Tooltip value="Start all processes">
            <button
              type="button"
              class="text-[11px] font-medium px-1.5 py-0.5 rounded text-text-weak hover:text-text-base hover:bg-surface-base-hover transition-colors"
              onClick={() => props.onStartAllProcesses?.()}
            >
              Start All
            </button>
          </Tooltip>
          <Tooltip value="Stop all processes">
            <button
              type="button"
              class="text-[11px] font-medium px-1.5 py-0.5 rounded text-text-weak hover:text-text-base hover:bg-surface-base-hover transition-colors"
              onClick={() => props.onStopAllProcesses?.()}
            >
              Stop All
            </button>
          </Tooltip>
          <div class="w-px h-4 bg-border-weak-base" />
          <Tooltip value="Add process">
            <IconButton
              icon="plus-small"
              variant="ghost"
              onClick={() => props.onAddProcess?.()}
              aria-label="Add process"
            />
          </Tooltip>
        </div>
      </Show>

      {/* Tab context menu - portaled to body to escape overflow clipping */}
      <Show when={contextMenu()}>
        {(menu) => {
          const groupId = () => props.groupId
          const isSplit = () => claxedo.split.active()
          const groups = () => claxedo.split.groups()
          const otherGroupId = () => {
            const all = groups()
            const gId = groupId()
            return all.find((g) => g.id !== gId)?.id
          }
          const menuTab = () => tabs().items().find((t) => t.id === menu().tabId)
          const isMenuTabPinned = () => !!menuTab()?.pinned
          return (
            <Portal>
              <div
                class="fixed inset-0 z-[300]"
                onClick={closeContextMenu}
                onContextMenu={(e) => {
                  e.preventDefault()
                  closeContextMenu()
                }}
              />
              <div
                class="fixed z-[301] bg-background-base border border-border-weak-base rounded-md shadow-lg py-1 min-w-[180px]"
                style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
              >
                <Show when={!isSplit()}>
                  <button
                    type="button"
                    class="w-full px-3 py-1.5 text-left text-[13px] text-text-base hover:bg-surface-base-hover transition-colors"
                    onClick={() => {
                      const gId = groupId()
                      if (gId) {
                        claxedo.dispatch({
                          type: "TabMoveAcrossGroupsRequested",
                          tabId: menu().tabId,
                          fromGroupId: gId,
                          toGroupId: "new",
                        })
                      }
                      closeContextMenu()
                    }}
                  >
                    Open in Split View
                  </button>
                </Show>
                <Show when={isSplit() && otherGroupId()}>
                  <button
                    type="button"
                    class="w-full px-3 py-1.5 text-left text-[13px] text-text-base hover:bg-surface-base-hover transition-colors"
                    onClick={() => {
                      const gId = groupId()
                      const other = otherGroupId()
                      if (gId && other) {
                        claxedo.dispatch({
                          type: "TabMoveAcrossGroupsRequested",
                          tabId: menu().tabId,
                          fromGroupId: gId,
                          toGroupId: other,
                        })
                      }
                      closeContextMenu()
                    }}
                  >
                    Move to Other Panel
                  </button>
                </Show>
                <button
                  type="button"
                  class="w-full px-3 py-1.5 text-left text-[13px] text-text-base hover:bg-surface-base-hover transition-colors"
                  onClick={() => {
                    const tabId = menu().tabId
                    if (isMenuTabPinned()) {
                      tabs().patch(tabId, { pinned: false, closable: true })
                    } else {
                      tabs().patch(tabId, { pinned: true, closable: false })
                    }
                    closeContextMenu()
                  }}
                >
                  {isMenuTabPinned() ? "Unpin Tab" : "Pin Tab"}
                </button>
                <Show when={!isMenuTabPinned()}>
                  <button
                    type="button"
                    class="w-full px-3 py-1.5 text-left text-[13px] text-text-base hover:bg-surface-base-hover transition-colors"
                    onClick={() => {
                      handleTabClose(menu().tabId)
                      closeContextMenu()
                    }}
                  >
                    Close Tab
                  </button>
                </Show>
              </div>
            </Portal>
          )
        }}
      </Show>
    </div>
  )
}

/**
 * Individual tab component for use outside the tab bar
 * (e.g., for rendering a single tab in a different context)
 */
export function TopTab(props: { tab: TabItem; active?: boolean; onSelect?: () => void; onClose?: () => void }) {
  const handleClick = (e: MouseEvent) => {
    if (e.button === 1 && props.tab.closable) {
      e.preventDefault()
      queueMicrotask(() => props.onClose?.())
      return
    }
    props.onSelect?.()
  }

  return (
    <div
      data-tab-id={props.tab.id}
      data-active={props.active ? "" : undefined}
      class={`group relative flex items-center h-10 pl-2 pr-0 cursor-pointer flex-shrink-0 max-w-[200px] min-w-[100px] select-none transition-colors duration-150 max-md:min-w-[60px] max-md:max-w-[150px] max-md:pl-1.5 ${
        props.active
          ? "bg-background-stronger border border-b-0 border-transparent"
          : "bg-transparent hover:bg-surface-base-hover/40"
      }`}
      onMouseDown={handleClick}
      onAuxClick={handleClick}
    >
      <span
        class={`text-[13px] max-md:text-[12px] font-[450] whitespace-nowrap overflow-hidden text-ellipsis flex-1 min-w-0 transition-colors duration-100 ${
          props.active ? "text-text-strong font-medium" : "text-text-weak group-hover:text-text-base"
        }`}
      >
        {props.tab.title}
      </span>

      {/* Loading spinner - shows when session/terminal is working */}
      <Show when={props.tab.loading}>
        <LoadingIndicator class="mx-1" />
      </Show>

      {/* Attention dot - shows when terminal needs attention (e.g., interrupted) */}
      <Show when={props.tab.attention && !props.tab.loading}>
        <AttentionDot class="flex-shrink-0 mx-1" />
      </Show>

      {/* Done dot - shows after an agent completes at least one turn, only on inactive tabs */}
      <Show when={props.tab.done && !props.tab.loading && !props.tab.attention && !props.active}>
        <DoneDot class="flex-shrink-0 mx-1" />
      </Show>

      <Show when={props.tab.closable}>
        <button
          type="button"
          class={`flex items-center justify-center w-8 h-10 p-0 bg-transparent border-none cursor-pointer flex-shrink-0 transition-all duration-100 ${
            props.active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          } text-icon-weak hover:bg-surface-base-hover hover:text-icon-base`}
          onClick={(e) => {
            e.stopPropagation()
            queueMicrotask(() => props.onClose?.())
          }}
          aria-label="Close tab"
          {...(props.active ? { "data-active-close": "" } : {})}
        >
          <Icon name="close" size="small" />
        </button>
      </Show>
    </div>
  )
}

export type WorkspaceBarItem = {
  id: string
  directory: string
  name: string
  notification?: boolean
  isMain?: boolean
  isCloud?: boolean
  canDelete?: boolean
  projectWorktree?: string
}

export type WorkspaceBarProject = {
  id: string
  name: string
  worktree: string
  workspaces: WorkspaceBarItem[]
}

export type WorkspaceBarProps = {
  projects: WorkspaceBarProject[]
  defaultDirectory?: string | null
  pinnedDirectory?: string | null
  activeProjectId?: string
  onNewSession?: () => void
  onNewTerminal?: (command?: string, title?: string) => void
  onNewPage?: () => void
  onProcesses?: () => void
  onSettings?: () => void
  processAttention?: boolean
  processActive?: boolean
  processRunning?: boolean
  hasProcesses?: boolean
  onWorktreeClick?: (projectId: string, directory: string) => void
  onWorktreeDblClick?: (projectId: string, directory: string) => void
  onWorktreeDelete?: (projectId: string, workspace: WorkspaceBarItem) => Promise<void> | void
  onProjectClick?: (projectId: string) => void
  onNewWorktree?: (projectId: string) => Promise<WorkspaceBarItem | undefined>
  allProjects?: import("./rail-sidebar").ProjectItem[]
  visibleWorkspaces?: Set<string>
  onToggleWorkspace?: (directory: string, visible: boolean) => void
  class?: string
}

/** Green notification dot for workspaces with activity */
function WorkspaceNotificationDot() {
  return (
    <span class="relative flex" style={{ width: "8px", height: "8px" }}>
      <span
        class="animate-ping absolute inline-flex rounded-full"
        style={{
          width: "8px",
          height: "8px",
          "background-color": "#22c55e",
          opacity: 0.75,
        }}
      />
      <span
        class="relative inline-flex rounded-full"
        style={{
          width: "8px",
          height: "8px",
          "background-color": "#22c55e",
        }}
      />
    </span>
  )
}

/** Project group component - shows project name and its workspaces */
function WorkspaceBarProjectGroup(props: {
  project: WorkspaceBarProject
  defaultDirectory?: string | null
  pinnedDirectory?: string | null
  onWorktreeClick?: (projectId: string, directory: string) => void
  onWorktreeDblClick?: (projectId: string, directory: string) => void
  onProjectClick?: (projectId: string) => void
  onNewWorktree?: (projectId: string) => Promise<WorkspaceBarItem | undefined>
}) {
  const claxedo = useClaxedoLayout()
  const theme = useTheme()
  const current = () => props.pinnedDirectory ?? props.defaultDirectory
  const [creating, setCreating] = createSignal<"idle" | "loading" | "done">("idle")
  const [createdName, setCreatedName] = createSignal<string | null>(null)

  const handleNewWorktree = async () => {
    if (creating() !== "idle") return
    const handler = props.onNewWorktree
    if (!handler) return

    setCreating("loading")
    try {
      const result = await handler(props.project.id)
      if (result) {
        setCreatedName(result.name)
        setCreating("done")
        // Reset after a short delay
        setTimeout(() => {
          setCreating("idle")
          setCreatedName(null)
        }, 1500)
      } else {
        setCreating("idle")
      }
    } catch {
      setCreating("idle")
    }
  }

  return (
    <div
      class={`group/project flex items-center gap-0 rounded px-2 py-1 -mx-1 transition-colors hover:bg-surface-base-hover/30`}
    >
      {/* Project name - always dim, clicking it selects the project's main workspace */}
      <button
        type="button"
        class="text-[13px] font-medium font-mono text-text-weak transition-colors px-1 py-1 -ml-1 rounded hover:bg-surface-base-hover/30"
        onClick={() => props.onProjectClick?.(props.project.id)}
      >
        {props.project.name}
      </button>

      {/* Workspaces */}
      <For each={props.project.workspaces}>
        {(ws) => {
          const isCurrent = () => ws.directory === current()
          const isPinned = () => ws.directory === props.pinnedDirectory
          const text = () => (isCurrent() ? "text-text-base font-semibold" : "text-text-weak hover:text-text-base")
          const line = () => (isPinned() ? "underline underline-offset-4" : "")
          const dotColor = () => brightenWorktreeColor(claxedo.getWorktreeColor(ws.directory), theme.mode())

          return (
            <button
              type="button"
              data-workspace-button={ws.directory}
              class={`flex items-center gap-1 px-2 py-1.5 rounded text-[13px] cursor-pointer transition-colors hover:bg-surface-base-hover/30 ${text()}`}
              onClick={(e) => {
                if (e.detail !== 1) return
                props.onWorktreeClick?.(props.project.id, ws.directory)
              }}
              onDblClick={() => {
                props.onWorktreeDblClick?.(props.project.id, ws.directory)
              }}
            >
              <span class="text-text-weak/50">/</span>
              <span class="size-2.5 rounded-sm shrink-0" style={{ "background-color": dotColor() }} aria-hidden="true" />
              <span class={line()}>{ws.name}</span>
              <Show when={ws.notification}>
                <WorkspaceNotificationDot />
              </Show>
            </button>
          )
        }}
      </For>

      <Show when={props.onNewWorktree}>
        <Show
          when={creating() === "idle"}
          fallback={
            <div class="flex items-center gap-1 px-2 text-[13px] text-text-weak shrink-0">
              <Show when={creating() === "loading"}>
                <div class="size-3 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
              </Show>
              <Show when={creating() === "done" && createdName()}>
                <span class="text-text-weak">/</span>
                <span class="text-text-base font-semibold">{createdName()}</span>
                <Icon name="check-small" size="small" class="text-green-500" />
              </Show>
            </div>
          }
        >
          <button
            type="button"
            class="flex items-center justify-center size-6 rounded text-icon-weak hover:text-icon-base hover:bg-surface-base-hover active:bg-surface-base-active transition-colors shrink-0 ml-1"
            onClick={handleNewWorktree}
            aria-label="Create worktree"
          >
            <Icon name="plus-small" size="small" />
          </button>
        </Show>
      </Show>
    </div>
  )
}

/**
 * Workspace bar showing the current project/workspace context.
 * The full workspace list remains available from the overflow menu.
 */
export function WorkspaceBar(props: WorkspaceBarProps) {
  const prefix = createMemo(() => "Current")
  const current = createMemo(() => props.pinnedDirectory ?? props.defaultDirectory)
  const currentProjects = createMemo(() => {
    const dir = current()
    if (!dir) return []

    return props.projects.flatMap((project) => {
      const ws = project.workspaces.find((item) => item.directory === dir)
      if (!ws) return []
      return [{ ...project, workspaces: [ws] }]
    })
  })
  const showWorkspaceActions = createMemo(
    () =>
      !!(
        props.defaultDirectory ||
        props.pinnedDirectory ||
        props.onNewSession ||
        props.onNewTerminal ||
        props.onNewPage ||
        props.onProcesses
      ),
  )

  return (
    <div data-workspace-bar class={`relative h-9 bg-background-base border-b border-border-weak-base/50 ${props.class ?? ""}`}>
      <div class="flex items-center h-full px-3 gap-0">
        <span class="shrink-0 text-[13px] font-medium text-text-weak mr-2 whitespace-nowrap">{prefix()}:</span>
        <div class="flex items-center gap-0 min-w-0 overflow-hidden shrink">
          <div class="flex items-center gap-0 min-w-0 overflow-x-auto no-scrollbar">
            <For each={currentProjects()}>
              {(project, index) => (
                <>
                  <Show when={index() > 0}>
                    <div class="w-px h-5 bg-border-weak-base mx-2 shrink-0" />
                  </Show>
                  <WorkspaceBarProjectGroup
                    project={project}
                    defaultDirectory={props.defaultDirectory}
                    pinnedDirectory={props.pinnedDirectory}
                    onWorktreeClick={props.onWorktreeClick}
                    onWorktreeDblClick={props.onWorktreeDblClick}
                    onProjectClick={props.onProjectClick}
                    onNewWorktree={props.onNewWorktree}
                  />
                </>
              )}
            </For>
          </div>

          {/* More button */}
          <Show when={props.allProjects}>
            <div class="flex items-center justify-center ml-2 shrink-0">
              <Popover
                placement="bottom-end"
                trigger={<Icon name="chevron-down" size="small" />}
                triggerAs="button"
                triggerProps={{
                  class:
                    "flex items-center justify-center size-6 rounded text-icon-weak hover:text-icon-base hover:bg-surface-base-hover transition-colors cursor-pointer border-none bg-transparent",
                }}
                class="w-[300px] [&_[data-slot=popover-body]]:p-0 [&_[data-slot=list-item]:hover_.ws-delete]:opacity-100 [&_[data-slot=list-item][data-active=true]_.ws-delete]:opacity-100"
              >
                <div class="flex flex-col max-h-[400px]">
                  {(() => {
                    // Flatten projects to items
                    const items = createMemo(() => {
                      const list: Array<{
                        id: string
                        name: string
                        directory: string
                        projectId: string
                        projectName: string
                        isMain: boolean
                      }> = []
                      for (const p of props.allProjects ?? []) {
                        // Main
                        list.push({
                          id: p.worktree,
                          name: "main",
                          directory: p.worktree,
                          projectId: p.id,
                          projectName: p.name || getFilename(p.worktree),
                          isMain: true,
                        })
                        // Sandboxes
                        for (const s of p.sandboxes ?? []) {
                          if (s === p.worktree) continue
                          list.push({
                            id: s,
                            name: getFilename(s),
                            directory: s,
                            projectId: p.id,
                            projectName: p.name || getFilename(p.worktree),
                            isMain: false,
                          })
                        }
                      }
                      return list
                    })

                    return (
                      <List
                        items={items()}
                        key={(item) => item.directory}
                        groupBy={(item) => item.projectName}
                        search={{ placeholder: "Filter workspaces...", autofocus: true }}
                        onSelect={(item) => {
                          if (!item) return
                          if (props.onWorktreeClick) {
                            props.onWorktreeClick(item.projectId, item.directory)
                            return
                          }
                          props.onToggleWorkspace?.(item.directory, true)
                        }}
                        children={(item) => (
                          <div class="flex items-center gap-2 w-full text-left">
                            <span class="text-text-base truncate flex-1">{item.name}</span>
                            <Show when={!item.isMain && props.onWorktreeDelete}>
                              <button
                                type="button"
                                class="ws-delete flex items-center justify-center size-5 rounded text-icon-weak hover:text-icon-critical-base transition-colors shrink-0 opacity-0"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  props.onWorktreeDelete?.(item.projectId, {
                                    id: item.id,
                                    name: item.name,
                                    directory: item.directory,
                                  })
                                }}
                              >
                                <Icon name="trash" size="small" />
                              </button>
                            </Show>
                            <Show when={current() === item.directory}>
                              <span class="inline-flex items-center justify-center shrink-0">
                                <Icon name="check-small" />
                              </span>
                            </Show>
                          </div>
                        )}
                      />
                    )
                  })()}
                </div>
              </Popover>
            </div>
          </Show>

          <Show when={showWorkspaceActions()}>
            <div class="flex items-center justify-center ml-2 border-l border-border-weak-base pl-2 pr-2 shrink-0">
              <WorkspaceScopeButtons
                onNewSession={props.onNewSession}
                onNewTerminal={props.onNewTerminal}
                onNewPage={props.onNewPage}
                onProcesses={props.onProcesses}
                onSettings={props.onSettings}
                processAttention={props.processAttention}
                processActive={props.processActive}
                processRunning={props.processRunning}
                hasProcesses={props.hasProcesses}
              />
            </div>
          </Show>
        </div>

        <div class="flex-1 min-w-0" />
      </div>
    </div>
  )
}
