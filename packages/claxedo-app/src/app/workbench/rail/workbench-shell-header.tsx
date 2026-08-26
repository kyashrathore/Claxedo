import { Match, Show, Switch, createMemo, onCleanup } from "solid-js"
import type { JSX } from "@solidjs/web"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { CompactSwitcher } from "../compact-switcher/compact-switcher"
import { TitlebarDragRegion } from "../titlebar/titlebar-drag-region"
import type { SwitcherItem } from "../compact-switcher/switcher-items"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import {
  createPortalSlotRef,
  setBrowserToolbarSlot,
  setFileHeaderActionsSlot,
  setProcessToolbarSlot,
  setReviewControlsSlot,
  setReviewTabHeaderSlot,
  setReviewToolbarSlot,
} from "@/ui/controls/portal-slot"
import { reviewWorkspaceActiveTab } from "@/features/review/ui/review-workspace-active-tab"
import { isMarkdownPath, markdownSourceView, toggleMarkdownPreview } from "../content/tab-file"
import { useClaxedoState } from "../state/index"
import { WorkspaceScopeButtons } from "./workspace-toolbar"
import { WorkspaceToolButtons } from "./workspace-tool-buttons"
import { useSessionTitleProjection } from "@/features/session/providers/session-title-projection-provider"

export function WorkspacePanelChrome(props: {
  workspacePanelOpen: () => boolean
  workspacePanelFullWidth: () => boolean
  allowFullWidth?: boolean
  onToggleFullWidth: () => void
  onTogglePanel: (button: HTMLButtonElement) => void
}) {
  return (
    <div class="flex shrink-0 items-center gap-0.5 pl-1">
      <Show when={props.workspacePanelOpen() && props.allowFullWidth !== false}>
        <button
          type="button"
          data-icon-interaction="binary"
          class="flex size-6 items-center justify-center rounded-sm text-icon-weak-base transition-colors duration-100 hover:bg-surface-base-hover hover:text-icon-base"
          aria-label={props.workspacePanelFullWidth() ? "Restore workspace panel width" : "Maximize workspace panel"}
          title={props.workspacePanelFullWidth() ? "Restore workspace panel width" : "Maximize workspace panel"}
          aria-pressed={
            props.workspacePanelFullWidth() == null ? undefined : props.workspacePanelFullWidth() ? "true" : "false"
          }
          onClick={props.onToggleFullWidth}
        >
          <Icon name={props.workspacePanelFullWidth() ? "collapse" : "expand"} size="small" />
        </button>
      </Show>
      <button
        type="button"
        data-testid="workspace-panel-toggle"
        data-icon-interaction="binary"
        class="relative flex size-6 items-center justify-center rounded-sm text-icon-weak-base transition-colors duration-100 hover:bg-surface-base-hover hover:text-icon-base"
        aria-label={props.workspacePanelOpen() ? "Close workspace panel" : "Open workspace panel"}
        title={props.workspacePanelOpen() ? "Close workspace panel" : "Open workspace panel"}
        aria-pressed={props.workspacePanelOpen() == null ? undefined : props.workspacePanelOpen() ? "true" : "false"}
        onClick={(event) => props.onTogglePanel(event.currentTarget)}
      >
        <Icon name={props.workspacePanelOpen() ? "layout-right-full" : "layout-right-partial"} size="small" />
      </button>
    </div>
  )
}

export function WorkbenchShellHeader(props: {
  activeGlobal: () => boolean
  canUseDocuments?: boolean
  canCreateTerminal: () => boolean
  focusedPanelTarget: () => { workspaceDir: string; targetPaneId: string } | undefined
  hasWorkspacePanelTarget: () => boolean
  onCloseSurface: (contentId: string) => void
  onNewPage: () => void
  onNewSession: () => void
  onNewTerminalDraft: () => void
  onNewTask?: () => void
  onSettings?: () => void
  onShowSidebar: () => void
  onSidebarHotZoneEnter: () => void
  onSelectSurface: (contentId: string) => void
  onToggleWorkspacePanel: (button: HTMLButtonElement) => void
  onToggleWorkspacePanelFullWidth: () => void
  sidebarPinned: () => boolean
  switcherItems: () => SwitcherItem[]
  toggleFocusedWorkspaceNavigator: (navigator: "files" | "changes" | "processes") => void
  topBarRight?: () => JSX.Element
  trafficLightPad: () => boolean
  workspacePanelBridgeChromeVisible: () => boolean
  workspacePanelForFocusedTarget: () => boolean
  workspacePanelFullWidth: () => boolean
  workspacePanelNavigator: () => "files" | "changes" | "processes" | null | undefined
  workspacePanelVisualOpen: () => boolean
  onFloatingChromeRef: (element: HTMLElement | undefined) => void
}) {
  onCleanup(() => props.onFloatingChromeRef(undefined))

  // The compact rail header is the topmost strip when the sidebar is unpinned,
  // so it doubles as the OS titlebar. The whole bar is a drag surface (empty
  // areas move the window via CSS `app-region`, interactive children opt out via
  // base.css `no-drag`); the reserved drag zones below keep a grabbable strip
  // after the sidebar icon and after the tabs even when the strip is packed.
  return (
    <div
      data-testid="workbench-shell-header"
      data-surface="header"
      data-window-drag-region
      class={[
        "relative flex h-9 shrink-0 items-center gap-1 overflow-hidden border-b border-border-weaker-base bg-background-base",
        {
          // The right padding reserves room for the absolutely-positioned
          // floating panel-chrome, which while the panel is closed is just the
          // panel toggle: right-1 + pl-1 + a size-6 button = 28px measured in the
          // running app. It was 8rem when the Files/Changes/Processes trio still
          // sat here; that would now hold ~6rem of dead space open. The chrome is
          // hidden while the panel is open, so drop the reserve then and let the
          // scope buttons sit flush against the panel divider instead.
          "pr-10": !props.workspacePanelVisualOpen(),
          "pr-1": props.workspacePanelVisualOpen(),
        },
      ]}

      style={{ "padding-left": props.trafficLightPad() && !props.sidebarPinned() ? "78px" : undefined }}
    >
      <div class="flex min-w-0 flex-1 items-center gap-1 px-1">
        <Show when={!props.sidebarPinned()}>
          <Tooltip value="Show Sidebar">
            <button
              type="button"
              aria-label="Show Sidebar"
              aria-pressed="false"
              data-icon-interaction="binary"
              class="relative z-[90] hidden size-6 shrink-0 items-center justify-center rounded-sm border-none bg-transparent p-0 text-icon-weak-base transition-colors hover:bg-surface-base-hover hover:text-icon-base md:flex"
              onMouseEnter={(event) => {
                if ((event.relatedTarget as HTMLElement | null)?.closest?.('[data-testid="rail-sidebar"]')) return
                props.onSidebarHotZoneEnter()
              }}
              onClick={props.onShowSidebar}
            >
              <Icon name="layout-left-partial" size="small" />
            </button>
          </Tooltip>
          {/* Zone A — a fixed grab strip immediately after the sidebar icon. */}
          <TitlebarDragRegion class="w-4 shrink-0" />
          <CompactSwitcher
            items={props.switcherItems()}
            onSelect={props.onSelectSurface}
            onClose={props.onCloseSurface}
          />
          {/* Zone B — fills the empty space after the tabs; always leaves a
              floor of grabbable width even when the tab strip overflows. */}
          <TitlebarDragRegion class="min-w-8 flex-1" />
        </Show>
      </div>
      <div data-testid="workbench-header-controls" class="flex shrink-0 items-center gap-1">
        <WorkspaceScopeButtons
          global={props.activeGlobal()}
          canCreateTerminal={props.canCreateTerminal()}
          onNewSession={props.onNewSession}
          onNewTerminalDraft={props.onNewTerminalDraft}
          onNewTask={props.onNewTask}
          canUseDocuments={props.canUseDocuments === true}
          onNewPage={props.onNewPage}
          onSettings={props.onSettings}
        />
        <Show when={props.topBarRight}>
          <div class="flex items-center gap-2 pr-1">{props.topBarRight?.()}</div>
        </Show>
        <div
          ref={props.onFloatingChromeRef}
          data-testid="workspace-panel-floating-chrome"
          class={[
            "absolute inset-y-0 right-1 z-40 flex items-center gap-0.5 will-change-[opacity] transition-opacity duration-[80ms] ease-[cubic-bezier(0.2,0,0,1)]",
            {
              "opacity-0 pointer-events-none":
                props.workspacePanelVisualOpen() && !props.workspacePanelBridgeChromeVisible(),
            },
          ]}

          style={{
            display:
              props.workspacePanelVisualOpen() && !props.workspacePanelBridgeChromeVisible() ? "none" : undefined,
          }}
        >
          <Show when={!props.workspacePanelVisualOpen() || props.workspacePanelBridgeChromeVisible()}>
            {/* The Files/Changes/Processes trio deliberately does NOT appear
                here. It has two homes already: the panel column's own L2 strip
                (below), and the session environment card's vertical rail, which
                stays visible while the panel is closed. A third copy in the
                floating chrome duplicated the same three targets a few pixels
                from the panel toggle that reaches them. */}
            <WorkspacePanelChrome
              workspacePanelOpen={props.workspacePanelVisualOpen}
              workspacePanelFullWidth={props.workspacePanelFullWidth}
              allowFullWidth={false}
              onToggleFullWidth={props.onToggleWorkspacePanelFullWidth}
              onTogglePanel={props.onToggleWorkspacePanel}
            />
          </Show>
        </div>
      </div>
    </div>
  )
}

/**
 * The Files / Changes / Processes navigator trio, wired to the focused panel
 * target. One owner for the wiring: the panel column's L2 strip renders it
 * while the workspace panel is open, and `WorkbenchShellHeader`'s floating
 * chrome renders the SAME component while the panel is closed — without the
 * closed-panel copy the trio (and the Processes crash-attention dot) lived
 * only inside the `display:none` panel shell, so a user whose panel was
 * closed (e.g. restored closed after a reload) had no affordance at all to
 * reach Files/Changes/Processes.
 */
function WorkspacePanelToolTrio(props: {
  focusedPanelTarget: () => { workspaceDir: string; targetPaneId: string } | undefined
  hasWorkspacePanelTarget: () => boolean
  workspacePanelForFocusedTarget: () => boolean
  workspacePanelNavigator: () => "files" | "changes" | "processes" | null | undefined
  toggleFocusedWorkspaceNavigator: (navigator: "files" | "changes" | "processes") => void
}) {
  const claxedoState = useClaxedoState()
  return (
    <WorkspaceToolButtons
      available={props.hasWorkspacePanelTarget()}
      filesActive={props.workspacePanelForFocusedTarget() && props.workspacePanelNavigator() === "files"}
      changesActive={props.workspacePanelForFocusedTarget() && props.workspacePanelNavigator() === "changes"}
      processesActive={props.workspacePanelForFocusedTarget() && props.workspacePanelNavigator() === "processes"}
      processesAttention={
        claxedoState.processPane.crashedWhileClosed() ||
        (!!props.focusedPanelTarget() && claxedoState.processPane.crashed(props.focusedPanelTarget()?.workspaceDir))
      }
      showChanges
      showProcesses
      onToggle={props.toggleFocusedWorkspaceNavigator}
    />
  )
}

/**
 * L2HeaderStrip is always visible below L1. Contextual children use CSS
 * `hidden` instead of conditional mount so tab switches preserve subtree state.
 */
function L2HeaderStrip(props: {
  focusedPanelTarget: () => { workspaceDir: string; targetPaneId: string } | undefined
  hasWorkspacePanelTarget: () => boolean
  workspacePanelForFocusedTarget: () => boolean
  workspacePanelNavigator: () => "files" | "changes" | "processes" | null | undefined
  workspacePanelMode: () => string | undefined
  toggleFocusedWorkspaceNavigator: (navigator: "files" | "changes" | "processes") => void
  trailing?: JSX.Element
}) {
  const claxedoState = useClaxedoState()
  const sessionTitles = useSessionTitleProjection()
  const focusedContent = () => {
    const id = claxedoState.wb.selectors.focusedContent()
    return id ? claxedoState.meta.get(id) : undefined
  }
  const tabKind = () => focusedContent()?.type
  const focusedTitleSelection = createMemo(() => {
    const meta = focusedContent()
    if (meta?.type !== "session" || !meta.sessionId) return
    return sessionTitles.select({
      sessionId: meta.sessionId,
      ...(meta.directory ? { directory: meta.directory } : {}),
      ...(meta.content?.sessionRef ? { sessionRef: meta.content.sessionRef } : {}),
    })
  })
  const focusedTitle = () => {
    const meta = focusedContent()
    const projected = focusedTitleSelection()?.title()
    if (projected) return projected
    return meta?.content?.title ?? ""
  }
  const workspaceTab = reviewWorkspaceActiveTab
  const activeFileTab = () => {
    const tab = workspaceTab()
    return tab?.kind === "file" ? tab : undefined
  }
  const reviewContextActive = () => workspaceTab()?.kind === "review" && props.workspacePanelMode() === "review"
  const WorkspaceTools = () => (
    <WorkspacePanelToolTrio
      focusedPanelTarget={props.focusedPanelTarget}
      hasWorkspacePanelTarget={props.hasWorkspacePanelTarget}
      workspacePanelForFocusedTarget={props.workspacePanelForFocusedTarget}
      workspacePanelNavigator={props.workspacePanelNavigator}
      toggleFocusedWorkspaceNavigator={props.toggleFocusedWorkspaceNavigator}
    />
  )
  return (
    <div
      data-testid="workbench-l2-header"
      class="flex h-9 w-full max-w-full min-w-0 shrink-0 items-center gap-2 overflow-hidden border-b border-border-weaker-base bg-background-base"
    >
      <Switch>
        <Match when={reviewContextActive()}>
          <div data-l2-context="review" class="flex min-w-0 flex-1 items-center gap-2 pl-2 pr-2">
            <div
              ref={createPortalSlotRef(setReviewToolbarSlot)}
              data-testid="l2-review-toolbar-slot"
              class="flex min-w-0 flex-1 items-center gap-2"
            />
            <div
              ref={createPortalSlotRef(setReviewControlsSlot)}
              data-testid="l2-review-controls-slot"
              class="flex shrink-0 items-center gap-0.5"
            />
            <WorkspaceTools />
          </div>
        </Match>
        <Match when={workspaceTab()?.kind === "browser"}>
          <div
            data-l2-context="browser"
            class="grid h-full min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 pr-2"
          >
            <div
              ref={createPortalSlotRef(setBrowserToolbarSlot)}
              data-testid="l2-browser-toolbar-slot"
              class="flex h-full min-w-0 w-full items-center overflow-hidden [&>*]:min-w-0 [&>*]:w-full [&>*]:flex-1"
            />
            <WorkspaceTools />
          </div>
        </Match>
        <Match when={activeFileTab()}>
          {(tab) => (
            <div data-l2-context="file" class="flex min-w-0 flex-1 items-center gap-2 px-2">
              <Icon name="file-text" size="small" class="shrink-0 text-icon-weak-base" />
              <span class="truncate font-mono text-xs text-text-weak" title={tab().path}>
                {tab().path}
              </span>
              <Show when={isMarkdownPath(tab().path)}>
                <button
                  type="button"
                  class="flex size-6 shrink-0 items-center justify-center rounded-sm text-icon-weak-base transition-colors hover:bg-surface-base-hover hover:text-icon-base"
                  aria-label={markdownSourceView(tab().path) ? "Preview markdown" : "Show source"}
                  title={markdownSourceView(tab().path) ? "Preview markdown" : "Show source"}
                  onClick={() => toggleMarkdownPreview(tab().path)}
                >
                  <Icon name={markdownSourceView(tab().path) ? "eye" : "code"} size="small" />
                </button>
              </Show>
              <span ref={createPortalSlotRef(setFileHeaderActionsSlot)} class="flex shrink-0 items-center gap-0.5" />
              <span class="flex-1" />
              <WorkspaceTools />
            </div>
          )}
        </Match>
        <Match when={workspaceTab()}>
          {(tab) => (
            <div data-l2-context={tab().kind} class="flex min-w-0 flex-1 items-center gap-2 px-2">
              <Show
                when={tab().kind === "process"}
                fallback={
                  <>
                    <span class="truncate text-sm text-text-weak">{tab().label}</span>
                    <span class="flex-1" />
                  </>
                }
              >
                <div
                  ref={createPortalSlotRef(setProcessToolbarSlot)}
                  data-testid="l2-process-toolbar-slot"
                  class="flex h-full min-w-0 flex-1 items-center overflow-hidden"
                />
              </Show>
              <WorkspaceTools />
            </div>
          )}
        </Match>
        <Match when={true}>
          <div class="flex min-w-0 flex-1 items-center gap-2 px-2">
            <div
              data-l2-context="file"
              hidden={tabKind() !== "page" && tabKind() !== "pages-index"}
              class="min-w-0 max-w-[min(42vw,520px)] overflow-hidden"
            >
              <span class="block truncate text-xs font-mono text-text-weak">
                {focusedContent()?.filePath ?? focusedContent()?.content?.title ?? ""}
              </span>
            </div>
            <div data-l2-context="browser" hidden />
            <div
              data-l2-context="session"
              hidden={tabKind() !== "session" && tabKind() !== "draft-session"}
              class="min-w-0 max-w-[min(42vw,520px)] overflow-hidden"
            >
              <span class="block truncate text-xs text-text-weak">{focusedTitle()}</span>
            </div>
            <span class="flex-1" />
            <WorkspaceTools />
          </div>
        </Match>
      </Switch>
      <Show when={props.trailing}>
        <div class="flex h-full shrink-0 items-center pr-1">{props.trailing}</div>
      </Show>
    </div>
  )
}

export function WorkspacePanelHeader(props: {
  focusedPanelTarget: () => { workspaceDir: string; targetPaneId: string } | undefined
  hasWorkspacePanelTarget: () => boolean
  workspacePanelForFocusedTarget: () => boolean
  workspacePanelNavigator: () => "files" | "changes" | "processes" | null | undefined
  workspacePanelMode: () => string | undefined
  toggleFocusedWorkspaceNavigator: (navigator: "files" | "changes" | "processes") => void
  workspacePanelOpen: () => boolean
  workspacePanelFullWidth: () => boolean
  onToggleFullWidth: () => void
  onTogglePanel: (button: HTMLButtonElement) => void
}) {
  return (
    <div class="shrink-0 bg-background-base">
      <div
        data-testid="workspace-panel-l1-header"
        class="relative flex h-9 shrink-0 items-center overflow-hidden border-b border-border-weaker-base bg-background-base"
      >
        <div
          ref={createPortalSlotRef(setReviewTabHeaderSlot)}
          data-testid="workspace-panel-tab-header-slot"
          class="flex h-full min-w-0 flex-1 items-center overflow-hidden [&>*]:min-w-0 [&>*]:w-full [&>*]:flex-1"
        />
        <div class="flex h-full shrink-0 items-center pr-1">
          <Show when={props.workspacePanelOpen()}>
            <WorkspacePanelChrome
              workspacePanelOpen={props.workspacePanelOpen}
              workspacePanelFullWidth={props.workspacePanelFullWidth}
              onToggleFullWidth={props.onToggleFullWidth}
              onTogglePanel={props.onTogglePanel}
            />
          </Show>
        </div>
      </div>
      <L2HeaderStrip
        focusedPanelTarget={props.focusedPanelTarget}
        hasWorkspacePanelTarget={props.hasWorkspacePanelTarget}
        workspacePanelForFocusedTarget={props.workspacePanelForFocusedTarget}
        workspacePanelNavigator={props.workspacePanelNavigator}
        workspacePanelMode={props.workspacePanelMode}
        toggleFocusedWorkspaceNavigator={props.toggleFocusedWorkspaceNavigator}
      />
    </div>
  )
}
