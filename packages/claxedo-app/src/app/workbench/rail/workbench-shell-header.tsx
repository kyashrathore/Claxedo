import { Match, Show, Switch, onCleanup, type JSX } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { CompactSwitcher } from "../compact-switcher/compact-switcher"
import type { SwitcherItem } from "../compact-switcher/switcher-items"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { setBrowserToolbarSlot, setReviewTabHeaderSlot, setReviewToolbarSlot } from "@/ui/controls/portal-slot"
import { reviewWorkspaceActiveTab } from "@/features/review/ui/review-workspace-active-tab"
import { isMarkdownPath, markdownSourceView, toggleMarkdownPreview } from "../content/tab-file"
import { useClaxedoState } from "../state/index"
import { WorkspaceScopeButtons } from "./workspace-toolbar"
import { WorkspaceToolButtons } from "./workspace-tool-buttons"

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
          class="flex size-7 items-center justify-center rounded-md text-icon-weak-base transition-[background-color,color,scale] duration-100 hover:bg-surface-base-hover hover:text-icon-base active:scale-[0.96]"
          aria-label={props.workspacePanelFullWidth() ? "Restore workspace panel width" : "Maximize workspace panel"}
          title={props.workspacePanelFullWidth() ? "Restore workspace panel width" : "Maximize workspace panel"}
          onClick={props.onToggleFullWidth}
        >
          <Icon name={props.workspacePanelFullWidth() ? "collapse" : "expand"} size="small" />
        </button>
      </Show>
      <button
        type="button"
        data-testid="workspace-panel-toggle"
        class="relative flex size-7 items-center justify-center rounded-md text-icon-weak-base transition-[background-color,color,scale] duration-100 hover:bg-surface-base-hover hover:text-icon-base active:scale-[0.96]"
        aria-label={props.workspacePanelOpen() ? "Close workspace panel" : "Open workspace panel"}
        title={props.workspacePanelOpen() ? "Close workspace panel" : "Open workspace panel"}
        aria-pressed={props.workspacePanelOpen()}
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
  canUseTerminal: () => boolean
  onCloseSurface: (contentId: string) => void
  onNewPage: () => void
  onNewSession: () => void
  onNewTerminal: (command?: string, title?: string) => void
  onSettings?: () => void
  onShowSidebar: () => void
  onSidebarHotZoneEnter: () => void
  onSelectSurface: (contentId: string) => void
  onToggleWorkspacePanel: (button: HTMLButtonElement) => void
  onToggleWorkspacePanelFullWidth: () => void
  sidebarPinned: () => boolean
  switcherItems: () => SwitcherItem[]
  topBarRight?: () => JSX.Element
  trafficLightPad: () => boolean
  workspacePanelBridgeChromeVisible: () => boolean
  workspacePanelFullWidth: () => boolean
  workspacePanelVisualOpen: () => boolean
  onFloatingChromeRef: (element: HTMLElement | undefined) => void
}) {
  onCleanup(() => props.onFloatingChromeRef(undefined))

  return (
    <div
      data-testid="workbench-shell-header"
      class="relative flex h-9 shrink-0 items-center gap-1 overflow-hidden border-b border-border-weaker-base bg-background-base pr-10"
      style={{ "padding-left": props.trafficLightPad() && !props.sidebarPinned() ? "78px" : undefined }}
    >
      <div class="flex min-w-0 flex-1 items-center gap-1 px-1">
        <Show when={!props.sidebarPinned()}>
          <Tooltip value="Show Sidebar">
            <button
              type="button"
              aria-label="Show Sidebar"
              class="relative z-[90] hidden h-8 w-8 shrink-0 items-center justify-center rounded border-none bg-transparent p-0 text-icon-weak-base transition-colors hover:bg-surface-base-hover hover:text-icon-base md:flex"
              onMouseEnter={(event) => {
                if ((event.relatedTarget as HTMLElement | null)?.closest?.('[data-testid="rail-sidebar"]')) return
                props.onSidebarHotZoneEnter()
              }}
              onClick={props.onShowSidebar}
            >
              <Icon name="layout-left-partial" size="small" />
            </button>
          </Tooltip>
          <CompactSwitcher
            items={props.switcherItems()}
            onSelect={props.onSelectSurface}
            onClose={props.onCloseSurface}
          />
        </Show>
      </div>
      <div data-testid="workbench-header-controls" class="flex shrink-0 items-center gap-1">
        <WorkspaceScopeButtons
          global={props.activeGlobal()}
          canUseTerminal={props.canUseTerminal()}
          onNewSession={props.onNewSession}
          onNewTerminal={props.onNewTerminal}
          canUseDocuments={props.canUseDocuments === true}
          onNewPage={props.onNewPage}
          onSettings={props.onSettings}
        />
        <Show when={props.topBarRight}>
          <div class="flex items-center gap-2 pr-1">
            {props.topBarRight?.()}
          </div>
        </Show>
        <div
          ref={props.onFloatingChromeRef}
          data-testid="workspace-panel-floating-chrome"
          class="absolute inset-y-0 right-1 z-40 flex items-center gap-0.5 will-change-[opacity] transition-opacity duration-[80ms] ease-[cubic-bezier(0.2,0,0,1)]"
          classList={{
            "opacity-0 pointer-events-none": props.workspacePanelVisualOpen() && !props.workspacePanelBridgeChromeVisible(),
          }}
          style={{
            display: props.workspacePanelVisualOpen() && !props.workspacePanelBridgeChromeVisible() ? "none" : undefined,
          }}
        >
          <Show when={!props.workspacePanelVisualOpen() || props.workspacePanelBridgeChromeVisible()}>
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
  const focusedContent = () => {
    const id = claxedoState.wb.selectors.focusedContent()
    return id ? claxedoState.meta.get(id) : undefined
  }
  const tabKind = () => focusedContent()?.type
  const workspaceTab = reviewWorkspaceActiveTab
  const activeFileTab = () => {
    const tab = workspaceTab()
    return tab?.kind === "file" ? tab : undefined
  }
  const reviewContextActive = () => workspaceTab()?.kind === "review" && props.workspacePanelMode() === "review"
  const workspacePanelTargetAvailable = () => props.hasWorkspacePanelTarget()
  return (
    <div
      data-testid="workbench-l2-header"
      class="flex h-9 w-full max-w-full min-w-0 shrink-0 items-center gap-2 overflow-hidden border-b border-border-weaker-base bg-background-base"
    >
      <Switch>
        <Match when={reviewContextActive()}>
          <div data-l2-context="review" class="flex min-w-0 flex-1 items-center gap-2 pl-2 pr-2">
            <div
              ref={(el) => {
                setReviewToolbarSlot(el ?? null)
                return () => setReviewToolbarSlot(null)
              }}
              data-testid="l2-review-toolbar-slot"
              class="flex min-w-0 flex-1 items-center gap-2"
            />
            <WorkspaceToolButtons
              available={workspacePanelTargetAvailable()}
              filesActive={props.workspacePanelForFocusedTarget() && props.workspacePanelNavigator() === "files"}
              changesActive={props.workspacePanelForFocusedTarget() && props.workspacePanelNavigator() === "changes"}
              processesActive={props.workspacePanelForFocusedTarget() && props.workspacePanelNavigator() === "processes"}
              processesAttention={
                !!props.focusedPanelTarget() &&
                (claxedoState.processPane.crashed(props.focusedPanelTarget()?.workspaceDir) ||
                  claxedoState.processPane.crashedWhileClosed())
              }
              showChanges
              showProcesses
              onToggle={props.toggleFocusedWorkspaceNavigator}
            />
          </div>
        </Match>
        <Match when={workspaceTab()?.kind === "browser"}>
          <div data-l2-context="browser" class="grid h-full min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 pr-2">
            <div
              ref={(el) => {
                setBrowserToolbarSlot(el ?? null)
                return () => setBrowserToolbarSlot(null)
              }}
              data-testid="l2-browser-toolbar-slot"
              class="flex h-full min-w-0 w-full items-center overflow-hidden [&>*]:min-w-0 [&>*]:w-full [&>*]:flex-1"
            />
            <WorkspaceToolButtons
              available={workspacePanelTargetAvailable()}
              filesActive={props.workspacePanelForFocusedTarget() && props.workspacePanelNavigator() === "files"}
              onToggle={props.toggleFocusedWorkspaceNavigator}
            />
          </div>
        </Match>
        <Match when={activeFileTab()}>
          {(tab) => (
            <div data-l2-context="file" class="flex min-w-0 flex-1 items-center gap-2 px-2">
              <Icon name="file-text" size="small" class="shrink-0 text-icon-weak-base" />
              <span class="truncate font-mono text-[11px] text-text-weak" title={tab().path}>
                {tab().path}
              </span>
              <Show when={isMarkdownPath(tab().path)}>
                <button
                  type="button"
                  class="flex size-6 shrink-0 items-center justify-center rounded-md text-icon-weak-base transition-colors hover:bg-surface-base-hover hover:text-icon-base"
                  aria-label={markdownSourceView(tab().path) ? "Preview markdown" : "Show source"}
                  title={markdownSourceView(tab().path) ? "Preview markdown" : "Show source"}
                  onClick={() => toggleMarkdownPreview(tab().path)}
                >
                  <Icon name={markdownSourceView(tab().path) ? "eye" : "code"} size="small" />
                </button>
              </Show>
              <span class="flex-1" />
              <WorkspaceToolButtons
                available={workspacePanelTargetAvailable()}
                filesActive={props.workspacePanelForFocusedTarget() && props.workspacePanelNavigator() === "files"}
                onToggle={props.toggleFocusedWorkspaceNavigator}
              />
            </div>
          )}
        </Match>
        <Match when={workspaceTab()}>
          {(tab) => (
            <div data-l2-context={tab().kind} class="flex min-w-0 flex-1 items-center gap-2 px-2">
              <span class="truncate text-[12px] text-text-weak">{tab().label}</span>
              <span class="flex-1" />
              <WorkspaceToolButtons
                available={workspacePanelTargetAvailable()}
                filesActive={props.workspacePanelForFocusedTarget() && props.workspacePanelNavigator() === "files"}
                processesActive={props.workspacePanelForFocusedTarget() && props.workspacePanelNavigator() === "processes"}
                processesAttention={
                  tab().kind === "process" &&
                  !!props.focusedPanelTarget() &&
                  (claxedoState.processPane.crashed(props.focusedPanelTarget()?.workspaceDir) ||
                    claxedoState.processPane.crashedWhileClosed())
                }
                showProcesses={tab().kind === "process"}
                onToggle={props.toggleFocusedWorkspaceNavigator}
              />
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
              <span class="block truncate text-[11px] font-mono text-text-weak">
                {focusedContent()?.filePath ?? focusedContent()?.content?.title ?? ""}
              </span>
            </div>
            <div data-l2-context="browser" hidden />
            <div
              data-l2-context="session"
              hidden={tabKind() !== "session" && tabKind() !== "draft-session"}
              class="min-w-0 max-w-[min(42vw,520px)] overflow-hidden"
            >
              <span class="block truncate text-[11px] text-text-weak">
                {focusedContent()?.content?.title ?? ""}
              </span>
            </div>
            <span class="flex-1" />
            <WorkspaceToolButtons
              available={workspacePanelTargetAvailable()}
              filesActive={props.workspacePanelForFocusedTarget() && props.workspacePanelNavigator() === "files"}
              processesActive={props.workspacePanelForFocusedTarget() && props.workspacePanelNavigator() === "processes"}
              processesAttention={
                !!props.focusedPanelTarget() &&
                (claxedoState.processPane.crashed(props.focusedPanelTarget()?.workspaceDir) ||
                  claxedoState.processPane.crashedWhileClosed())
              }
              showProcesses
              onToggle={props.toggleFocusedWorkspaceNavigator}
            />
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
          ref={(el) => {
            setReviewTabHeaderSlot(el ?? null)
            return () => setReviewTabHeaderSlot(null)
          }}
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
