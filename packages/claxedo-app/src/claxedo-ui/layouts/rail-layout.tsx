/**
 * Rail Layout
 *
 * The main layout component implementing the rail, surface canvas, and workspace panel.
 * This wraps/replaces the upstream layout when Claxedo mode is enabled.
 *
 * Structure:
 * ┌─────────────────────────────────────────────────────────────┐
 * │                        Titlebar                              │
 * ├────────┬────────────────────────────────────────────────────┤
 * │        │  [Surface switcher]        │ workspace controls     │
 * │  Rail  ├────────────────────────────────────────────────────┤
 * │        │                                                     │
 * │        │               Surface Canvas                        │
 * │        │                                                     │
 * └────────┴────────────────────────────────────────────────────┘
 */

import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onMount,
  onCleanup,
  type ComponentProps,
  type ParentProps,
  type JSX,
  type Accessor,
} from "solid-js"
import { useClaxedoState, isGlobalContent, contentScopeDir, type ContentMeta } from "../state"
import { Workbench } from "../layout"
import { ContentRenderer } from "../content-renderers"
import { RailSidebar, type ProjectItem, type WorkspaceItem, parseOwnerRepo } from "./rail-sidebar"
import { WorkspaceScopeButtons } from "./workspace-toolbar"
import { CompactSwitcher } from "../compact-switcher/CompactSwitcher"
import { buildSwitcherGroups, buildSwitcherItemsFromState, type SwitcherStatus } from "../compact-switcher/switcher-items"
import { ReviewWorkspace } from "../components/review-workspace"
import { DirectoryScope } from "../components/directory-scope"
import { SessionParamsProvider } from "../context/session-params"
import { ProcessPaneProvider } from "../context/process-pane"
import { SDKProvider } from "@/context/sdk"
import { useCommand, useServer, useGlobalSync, usePlatform, getAvatarColors } from "@opencode-ai/claxedo-app"
import { Avatar } from "@opencode-ai/ui/avatar"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { HoverCard } from "@opencode-ai/ui/hover-card"
import { List } from "@opencode-ai/ui/list"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { getFilename } from "@opencode-ai/util/path"
import { projectWorkspaceDirectories, workspaceDisplayName, workspaceIsCloud } from "../utils/workspace-display"
import { WorkspaceCreateFlow } from "../components/workspace-create-flow"
import { WorkspaceAttachBrowser, type WorkspaceAttachItem } from "../components/workspace-attach-browser"
import { WorkspacePanel } from "../workspace-panel/WorkspacePanel"
import { WorkspaceFilesNavigator } from "../workspace-panel/WorkspaceFilesNavigator"
import { WorkspaceProcessesNavigator } from "../workspace-panel/WorkspaceProcessesNavigator"
import { WorkspaceBrowserPanel } from "../workspace-panel/WorkspaceBrowserPanel"
import type { WorkspacePanelMode, WorkspacePanelState, WorkspacePanelTab } from "../workspace-panel/workspace-panel-state"
import { loadTerminalSessionPreview } from "../utils/terminal-session-preview"
import { getClaxedoServerUrl } from "../../utils/api"
import "../styles.css"

export type RailLayoutProps = ParentProps<{
  /**
   * List of projects to display in the rail
   */
  projects: ProjectItem[]

  /**
   * Currently active project ID
   */
  activeProjectId?: string

  /**
   * Currently active worktree directory (route)
   */
  activeWorkspaceId?: string

  /**
   * Currently active session ID
   */
  activeSessionId?: string
  globalChatEnabled?: boolean
  workgraphEnabled?: boolean

  /**
   * Home directory for path shortening
   */
  homedir?: string

  /**
   * Callback when a worktree is selected
   */
  onWorkspaceSelect?: (project: ProjectItem, workspaceDir: string) => void

  /**
   * Callback when a session is selected
   */
  onSessionSelect?: (workspaceDir: string, sessionId: string) => void

  /**
   * Callback to create a new project
   */
  onNewProject?: () => void

  /**
   * Callback to create a new worktree in a project
   */
  onNewWorkspace?: (project: ProjectItem) => Promise<import("./workspace-toolbar").WorkspaceBarItem | undefined>

  /**
   * Callback to create a local worktree directly (no dialog)
   */
  onNewLocalWorkspace?: (
    project: ProjectItem,
    onProgress?: (step: string, message?: string) => void,
    workspaceName?: string,
  ) => Promise<import("./workspace-toolbar").WorkspaceBarItem | undefined>

  /**
   * Callback to create a cloud sandbox directly (no dialog).
   * Accepts a progress callback for provisioning step updates.
   */
  onNewCloudWorkspace?: (
    project: ProjectItem,
    onProgress?: (step: string, message?: string) => void,
    workspaceName?: string,
  ) => Promise<import("./workspace-toolbar").WorkspaceBarItem | undefined>

  /**
   * Callback to open settings
   */
  onSettings?: () => void

  /**
   * Callback to open help
   */
  onHelp?: () => void

  /**
   * Callback to open WorkGraph
   */
  onOpenWorkGraph?: () => void

  /**
   * Callback to create a new session. When no workspace is selected yet,
   * callers may pass `undefined` to create an unattached draft first.
   */
  onNewSession?: (workspaceDir?: string, paneId?: string) => void
  onDeleteSession?: (session: import("./rail-sidebar").SessionItem) => void
  onArchiveSession?: (session: import("./rail-sidebar").SessionItem) => void
  onDeleteWorkspace?: (workspace: import("./rail-sidebar").WorkspaceItem) => void
  onRemoveProject?: (project: import("./rail-sidebar").ProjectItem) => void

  /**
   * Callback to create a new terminal
   * @param workspaceDir - The workspace directory to create the terminal in
   * @param command - Optional command to run in the terminal (e.g., "claude --dangerously-skip-permissions")
   * @param title - Optional title for the terminal surface (e.g., "Claude", "Codex")
   */
  onNewTerminal?: (workspaceDir: string, command?: string, title?: string, paneId?: string) => void

  /**
   * Callback to create a new page
   */
  onNewPage?: () => void

  /**
   * Callback to create a new review workspace surface
   */
  onNewReview?: (workspaceDir: string, paneId?: string) => void

  /**
   * Callback when a surface is selected.
   */
  onTabSelect?: (surface: ContentMeta) => void

  /**
   * Callback when a surface is closed (to sync URL with the next active surface).
   */
  onTabClose?: (nextActiveTab: ContentMeta | undefined) => void

  /**
   * Render function for empty state (shown when no project selected)
   */
  renderEmpty?: () => JSX.Element

  /**
   * Titlebar component to render
   */
  titlebar?: JSX.Element

  /**
   * Additional content for the top bar (right side)
   */
  topBarRight?: () => JSX.Element
}>

// Check if running inside the Electron desktop shell.
const isDesktopApp = () => typeof window !== "undefined" && !!(window as any).api

// ─── Workspace Selector Popover ──────────────────────────────────────────────

type WorkspaceSelectorPopoverProps = {
  allProjects: ProjectItem[]
  allWorkspaceItems: () => WorkspaceAttachItem[]
  currentDir: () => string | undefined
  projectName: () => string
  workspaceName: () => string
  trigger?: JSX.Element
  triggerClass?: string
  triggerLabel?: string
  onWorktreeClick: (projectId: string, dir: string) => void
  onNewLocalWorkspace?: (
    project: ProjectItem,
    onProgress?: (step: string, message?: string) => void,
    workspaceName?: string,
  ) => Promise<{ directory: string } | undefined>
  onNewCloudWorkspace?: (
    project: ProjectItem,
    onProgress?: (step: string, message?: string) => void,
    workspaceName?: string,
  ) => Promise<{ directory: string } | undefined>
}

function WorkspaceSelectorPopover(props: WorkspaceSelectorPopoverProps) {
  const [targetProject, setTargetProject] = createSignal<ProjectItem | null>(null)
  const [targetProjectName, setTargetProjectName] = createSignal("")

  const reset = () => {
    setTargetProject(null)
    setTargetProjectName("")
  }

  return (
    <Popover
      placement="bottom-start"
      onOpenChange={(open) => { if (!open) reset() }}
      trigger={props.trigger ?? (
        <div class="flex items-baseline gap-1">
          <span class="text-[13px] font-medium text-text-base truncate max-w-[180px]">{props.workspaceName()}</span>
          <span class="text-[9px] text-text-weak/50">·</span>
          <span class="text-[10px] text-text-weak/50 truncate max-w-[180px]">{props.projectName()}</span>
          <Icon name="chevron-down" size="small" class="text-icon-weak-base shrink-0 ml-0.5 self-center" />
        </div>
      )}
      triggerAs="button"
      triggerProps={{
        class: props.triggerClass ?? "flex items-center shrink-0 pl-3 pr-1 h-full hover:bg-surface-base-hover transition-colors cursor-pointer border-none bg-transparent",
        "aria-label": props.triggerLabel,
      }}
      class="w-[280px] [&_[data-slot=popover-body]]:p-0"
    >
      <Show when={!targetProject()}>
        <WorkspaceAttachBrowser
          projects={props.allProjects.map((project) => ({
            id: project.id,
            name: project.name ?? getFilename(project.worktree),
            worktree: project.worktree,
          }))}
          items={props.allWorkspaceItems()}
          currentDirectory={props.currentDir()}
          onSelect={props.onWorktreeClick}
          onCreateProject={(projectId, projectName) => {
            const project = props.allProjects.find((entry) => entry.id === projectId)
            if (!project) return
            setTargetProject(project)
            setTargetProjectName(projectName)
          }}
        />
      </Show>
      <Show when={targetProject()}>
        {(project) => (
          <WorkspaceCreateFlow
            project={{
              id: project().id,
              name: project().name ?? getFilename(project().worktree),
              worktree: project().worktree,
            }}
            projectName={targetProjectName() || project().name || getFilename(project().worktree)}
            canCreateCloud={!!props.onNewCloudWorkspace}
            onBack={() => setTargetProject(null)}
            onComplete={reset}
            onCreateLocal={async (_project, onProgress, workspaceName) =>
              props.onNewLocalWorkspace?.(project(), onProgress, workspaceName)
            }
            onCreateCloud={async (_project, onProgress, workspaceName) =>
              props.onNewCloudWorkspace?.(project(), onProgress, workspaceName)
            }
          />
        )}
      </Show>
    </Popover>
  )
}

function projectWorkspaces(project: ProjectItem, isCloud: boolean): WorkspaceItem[] {
  const items: WorkspaceItem[] = []
  for (const dir of projectWorkspaceDirectories(project)) {
    const main = dir === project.worktree
    const cloud = workspaceIsCloud(project, dir, { mainIsCloud: isCloud })
    items.push({
      id: dir,
      directory: dir,
      name: workspaceDisplayName(project, dir, { cloud }),
      isMain: main,
      projectWorktree: project.worktree,
      isCloud: cloud,
      canDelete: main ? cloud : true,
      available: project.workspaces?.[dir]?.available ?? true,
    })
  }
  return items
}

function projectDisplayName(project: ProjectItem, repoName?: string): string {
  return repoName ?? project.name ?? getFilename(project.worktree)
}

function projectHasDir(project: ProjectItem, dir: string) {
  return dir === project.worktree || (project.sandboxes ?? []).includes(dir) || dir in (project.workspaces ?? {})
}

function projectMatchesRef(project: ProjectItem, ref?: string) {
  if (!ref) return false
  return ref === project.id || ref === project.worktree
}

type WorkspacePanelButtonProps = {
  icon: "file-tree" | "code-lines" | "console" | "square-arrow-top-right"
  label: string
  active: boolean
  attention?: boolean
  onClick: () => void
}

function WorkspacePanelButton(props: WorkspacePanelButtonProps) {
  return (
    <Tooltip value={props.active ? `Close ${props.label}` : `Open ${props.label}`}>
      <button
        type="button"
        class="relative flex h-8 w-8 items-center justify-center rounded text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base"
        classList={{
          "bg-surface-base-hover text-text-base": props.active,
        }}
        aria-label={props.active ? `Close ${props.label}` : `Open ${props.label}`}
        aria-pressed={props.active ? "true" : "false"}
        onClick={props.onClick}
      >
        <Show when={props.attention}>
          <span class="absolute right-1 top-1 size-1.5 rounded-full bg-surface-critical-strong" />
        </Show>
        <Icon name={props.icon} size="small" />
      </button>
    </Tooltip>
  )
}

function WorkspacePanelTabBar(props: {
  tabs: WorkspacePanelTab[]
  activeTabId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** Omit to hide the `+` button (e.g. on web where browser is unavailable). */
  onAddBrowser?: () => void
}) {
  const tabLabel = (tab: WorkspacePanelTab) => {
    if (tab.type === "review") return "Review"
    return tab.title?.trim() || tab.url?.replace(/^https?:\/\//, "") || "New tab"
  }
  return (
    <div
      class="flex h-9 shrink-0 items-center gap-px overflow-x-auto border-b border-border-weak-base bg-background-base px-1"
      data-testid="workspace-panel-tab-bar"
      role="tablist"
    >
      <For each={props.tabs}>
        {(tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={props.activeTabId === tab.id}
            class="group flex h-7 max-w-[180px] shrink-0 items-center gap-1.5 rounded px-2 text-12-regular text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base"
            classList={{
              "bg-surface-base-hover text-text-base": props.activeTabId === tab.id,
            }}
            onClick={() => props.onSelect(tab.id)}
            data-tab-id={tab.id}
            data-tab-type={tab.type}
          >
            <Icon
              name={tab.type === "browser" ? "square-arrow-top-right" : "code-lines"}
              size="small"
              class="shrink-0"
            />
            <span class="truncate">{tabLabel(tab)}</span>
            <Show when={tab.type !== "review"}>
              <span
                role="button"
                aria-label={`Close ${tabLabel(tab)}`}
                tabindex={0}
                class="ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded text-text-weaker opacity-0 transition-opacity hover:bg-surface-base-active hover:text-text-base group-hover:opacity-100"
                classList={{ "opacity-100": props.activeTabId === tab.id }}
                onClick={(e) => {
                  e.stopPropagation()
                  props.onClose(tab.id)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    e.stopPropagation()
                    props.onClose(tab.id)
                  }
                }}
              >
                <Icon name="close-small" size="small" />
              </span>
            </Show>
          </button>
        )}
      </For>
      <Show when={props.onAddBrowser}>
        {(addBrowser) => (
          <Popover
            placement="bottom-start"
            class="z-50 min-w-[180px] rounded-md border border-border-weak-base bg-background-base p-1 shadow-lg"
            triggerAs="button"
            triggerProps={{
              type: "button" as const,
              class:
                "flex size-7 shrink-0 items-center justify-center rounded text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base",
              "aria-label": "Open new tab",
            } as ComponentProps<"button">}
            trigger={<Icon name="plus-small" size="small" />}
          >
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-12-regular text-text-base transition-colors hover:bg-surface-base-hover"
              onClick={() => addBrowser()()}
              data-testid="workspace-panel-add-browser-tab"
            >
              <Icon name="square-arrow-top-right" size="small" class="text-text-weak" />
              <span>Open Browser Tab</span>
            </button>
          </Popover>
        )}
      </Show>
    </div>
  )
}

function WorkspacePanelBody(props: {
  mode: WorkspacePanelMode
  state: WorkspacePanelState
}) {
  const claxedoState = useClaxedoState()
  const platform = usePlatform()
  const activeTab = () => {
    const id = props.state.activeTabId
    return props.state.tabs.find((t) => t.id === id) ?? props.state.tabs[0]
  }
  const directory = () => props.state.workspaceDir
  const focusPath = () => props.state.focus?.kind === "file" ? props.state.focus.path : undefined
  const focusVersion = () => props.state.focus?.kind === "file" ? props.state.focus.version : 0
  const focusFileIntent = () => props.state.focus?.kind === "file" ? props.state.focus.intent : undefined
  const focusProcessId = () => props.state.focus?.kind === "process" ? props.state.focus.processId : undefined
  const focusProcessVersion = () => props.state.focus?.kind === "process" ? props.state.focus.version : 0
  const focusContextSessionId = () => props.state.focus?.kind === "context" ? props.state.focus.sessionId : undefined
  const focusContextVersion = () => props.state.focus?.kind === "context" ? props.state.focus.version : 0
  const activeSurfaceId = () => {
    return claxedoState.wb.selectors.focusedContent() ?? undefined
  }
  const activeSurface = () => {
    const target = targetContentId()
    return target ? claxedoState.meta.get(target) : undefined
  }
  const targetPaneId = () => props.state.targetPaneId ?? claxedoState.wb.state.focusedPaneId ?? undefined
  const targetContentId = () => {
    const paneId = props.state.targetPaneId ?? claxedoState.wb.state.focusedPaneId
    const paneContent = paneId
      ? claxedoState.wb.state.panes.find((pane) => pane.id === paneId)?.contentId
      : undefined
    return paneContent ?? activeSurfaceId()
  }
  const targetContent = () => {
    const target = targetContentId()
    if (!target) return
    return claxedoState.meta.get(target)
  }
  const targetTerminalId = () => {
    const content = targetContent()
    if (content?.type === "terminal") return content.terminalId
    const surface = activeSurface()
    if (surface?.type === "terminal") return surface.terminalId
    return undefined
  }
  const [targetTerminalSession] = createResource(targetTerminalId, (terminalId) =>
    loadTerminalSessionPreview(getClaxedoServerUrl(), terminalId)
  )
  const targetSessionId = () => {
    const content = targetContent()
    if (content?.type === "session" || content?.type === "context") return content.sessionId
    if (content?.type === "terminal") return targetTerminalSession()?.sessionId ?? undefined
    const surface = activeSurface()
    if (surface?.type === "terminal") return targetTerminalSession()?.sessionId ?? undefined
    return surface?.sessionId
  }
  return (
    <Show
      when={directory()}
      fallback={
        <div class="flex h-full items-center justify-center px-6 text-center text-[13px] text-text-weak">
          Select a workspace to use this panel.
        </div>
      }
    >
      {(dir) => (
        <SessionParamsProvider
          sessionId={targetSessionId}
          directory={() => dir()}
          paneId={() => targetPaneId() ?? ""}
        >
          <DirectoryScope directory={dir()}>
            <ProcessPaneProvider>
            <div class="flex h-full min-h-0 flex-col">
              <WorkspacePanelTabBar
                tabs={props.state.tabs}
                activeTabId={props.state.activeTabId}
                onSelect={(id) => claxedoState.workspacePanel.setActiveTab(id)}
                onClose={(id) => claxedoState.workspacePanel.closeTab(id)}
                onAddBrowser={
                  platform.platform === "desktop"
                    ? () => claxedoState.workspacePanel.addBrowserTab()
                    : undefined
                }
              />
              <div class="min-h-0 flex-1 overflow-hidden">
                <Switch>
                  <Match when={activeTab()?.type === "browser"}>
                    <WorkspaceBrowserPanel
                      panelKey={`browser:${dir()}:${activeTab()?.id}`}
                      sessionId={targetSessionId() ?? "new"}
                    />
                  </Match>
                  <Match when={activeTab()?.type === "review"}>
                    <Show when={targetSessionId() ?? "new"}>
                      {(sessionId) => (
                        <div class="flex size-full min-w-0 overflow-hidden">
                          <div class="min-w-0 flex-1">
                            <ReviewWorkspace
                              class="h-full"
                              directory={dir()}
                              sessionId={sessionId()}
                              mode="uncommitted"
                              focusPath={focusPath()}
                              focusVersion={focusVersion()}
                              focusFileIntent={focusFileIntent()}
                              focusProcessId={focusProcessId()}
                              focusProcessVersion={focusProcessVersion()}
                              focusContextSessionId={focusContextSessionId()}
                              focusContextVersion={focusContextVersion()}
                            />
                          </div>
                          <Show when={props.state.navigator === "files"}>
                            <div class="w-[320px] shrink-0 border-l border-border-weak-base bg-background-base transition-transform duration-200 ease-out will-change-transform">
                              <WorkspaceFilesNavigator
                                activePath={focusPath()}
                                onFileClick={(path, intent) =>
                                  claxedoState.workspacePanel.retarget({
                                    workspaceDir: dir(),
                                    targetPaneId: targetPaneId(),
                                    focus: { kind: "file", path, intent },
                                  })}
                              />
                            </div>
                          </Show>
                          <Show when={props.state.navigator === "processes"}>
                            <div class="w-[280px] shrink-0 border-l border-border-weak-base bg-background-base transition-transform duration-200 ease-out will-change-transform">
                              <WorkspaceProcessesNavigator
                                directory={dir()}
                                activeProcessId={focusProcessId()}
                                onProcessSelect={(processId) =>
                                  claxedoState.workspacePanel.retarget({
                                    workspaceDir: dir(),
                                    targetPaneId: targetPaneId(),
                                    focus: { kind: "process", processId },
                                  })}
                              />
                            </div>
                          </Show>
                        </div>
                      )}
                    </Show>
                  </Match>

                </Switch>
              </div>
            </div>
            </ProcessPaneProvider>
          </DirectoryScope>
        </SessionParamsProvider>
      )}
    </Show>
  )
}


function RailLayoutBody(props: RailLayoutProps) {
  const claxedoState = useClaxedoState()
  const command = useCommand()
  const platform = usePlatform()
  const server = useServer()
  const globalSync = useGlobalSync()
  const dialog = useDialog()

  // macOS traffic light padding: only when desktop + macOS + not fullscreen
  const isMac = platform.platform === "desktop" && platform.os === "macos"
  const [macFullscreen, setMacFullscreen] = createSignal(false)
  onMount(() => {
    if (!isMac) return

    const api = typeof window !== "undefined" ? (window as any).api : undefined
    const guess = () => {
      const fs = window.innerHeight >= screen.height
      setMacFullscreen(fs)
    }
    const sync = () => {
      if (!api?.getWindowFullscreen) {
        guess()
        return
      }
      guess()
      void api.getWindowFullscreen().then(setMacFullscreen).catch(guess)
    }

    sync()

    if (api?.onFullscreenChange) {
      const unsub = api.onFullscreenChange((fs: boolean) => {
        setMacFullscreen(fs)
      })
      onCleanup(unsub)
      return
    }

    window.addEventListener("resize", guess)
    onCleanup(() => window.removeEventListener("resize", guess))
  })
  const trafficLightPad = () => isMac && !macFullscreen()

  const projectRepoName = (project: ProjectItem) => {
    const sessions = globalSync.globalSessions.store.byProject[project.id]
    const remote = sessions?.find((s: { git?: { remote?: string } }) => s.git?.remote)?.git?.remote
    return parseOwnerRepo(remote)
  }

  const sidebarPinned = () => claxedoState.rail.pinned()
  const sidebarCollapsed = () => claxedoState.rail.collapsed()
  const hasOpenSurfaces = createMemo(() => {
    return claxedoState.wb.selectors.aliveContents().length > 0
  })
  const activeGlobal = createMemo(() => {
    const contentId = claxedoState.wb.selectors.focusedContent()
    const surface = contentId ? claxedoState.meta.get(contentId) : undefined
    return !!surface && isGlobalContent(surface)
  })

  // Dispatch terminal fit when workspace-level split state changes
  // (toggle split, show/hide split). Deferred to skip the initial mount.
  createEffect(
    on(
      () => [claxedoState.wb.state.panes.length, claxedoState.wb.state.split.root] as const,
      () => {
        setTimeout(() => window.dispatchEvent(new Event("opencode:terminal-fit")), 150)
      },
      { defer: true },
    ),
  )

  // Mobile sidebar state - separate from desktop pinned state
  const [mobileSidebarOpen, setMobileSidebarOpen] = createSignal(false)

  const toggleMobileSidebar = () => setMobileSidebarOpen(!mobileSidebarOpen())
  const closeMobileSidebar = () => setMobileSidebarOpen(false)
  const closeFocusedPane = () => {
    const focusedPaneId = claxedoState.wb.state.focusedPaneId
    if (!focusedPaneId) return

    if (claxedoState.wb.selectors.aliveContents().length === 0) {
      if (platform.platform === "desktop") {
        dialog.show(() => (
          <Dialog title="Quit Claxedo?" description="Are you sure you want to quit the application?">
            <div class="flex justify-end gap-2 mt-4">
              <Button variant="ghost" onClick={() => dialog.close()}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void platform.quit?.()}>
                Quit
              </Button>
            </div>
          </Dialog>
        ))
      }
      return
    }

    claxedoState.layout.closePane(focusedPaneId, { destroyContent: false })
  }

  // Register keyboard shortcuts
  command.register(() => [
    {
      id: "claxedo.pane.close",
      title: "Close Pane",
      category: "View",
      keybind: "mod+w",
      onSelect: closeFocusedPane,
    },
    {
      id: "claxedo.surface.next",
      title: "Next Surface",
      category: "View",
      keybind: "mod+tab",
      onSelect: () => {
        const ids = claxedoState.wb.selectors.recentContents()
        const current = claxedoState.wb.selectors.focusedContent()
        const index = ids.findIndex((id) => id === current)
        const next = ids[index + 1] ?? ids[0]
        if (next) claxedoState.wb.navigation.show(next)
      },
    },
    {
      id: "claxedo.surface.previous",
      title: "Previous Surface",
      category: "View",
      keybind: "mod+shift+tab",
      onSelect: () => {
        const ids = claxedoState.wb.selectors.recentContents()
        const current = claxedoState.wb.selectors.focusedContent()
        const index = ids.findIndex((id) => id === current)
        const previous = ids[index - 1] ?? ids.at(-1)
        if (previous) claxedoState.wb.navigation.show(previous)
      },
    },
    {
      id: "claxedo.surface.reopen",
      title: "Reopen Closed Surface",
      category: "View",
      keybind: "mod+shift+t",
      onSelect: () => {
        const previous = claxedoState.wb.selectors.recentContents()[1]
        if (previous) claxedoState.wb.navigation.show(previous)
      },
    },
    {
      id: "claxedo.sidebar.toggle",
      title: "Toggle Sidebar",
      category: "View",
      keybind: "mod+b",
      onSelect: () => claxedoState.rail.toggle(),
    },
    // Surface switching shortcuts (Cmd+1 through Cmd+9).
    // Content switching shortcuts (Cmd+1 through Cmd+9).
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `claxedo.surface.${i + 1}`,
      title: `Switch to Surface ${i + 1}`,
      category: "View",
      keybind: `mod+${i + 1}`,
      onSelect: () => {
        const contentId = claxedoState.wb.selectors.recentContents()[i]
        if (contentId) claxedoState.wb.navigation.show(contentId)
      },
    })),
    // Split view shortcuts.
    {
      id: "claxedo.split.focusLeft",
      title: "Focus Left/Top Panel",
      category: "View",
      keybind: "mod+alt+ArrowLeft",
      onSelect: () => {
        const panes = claxedoState.wb.selectors.visiblePanes()
        const focusedId = claxedoState.wb.state.focusedPaneId
        const idx = panes.findIndex((p) => p.id === focusedId)
        if (idx > 0) claxedoState.wb.split.focus(panes[idx - 1].id)
      },
    },
    {
      id: "claxedo.split.focusRight",
      title: "Focus Right/Bottom Panel",
      category: "View",
      keybind: "mod+alt+ArrowRight",
      onSelect: () => {
        const panes = claxedoState.wb.selectors.visiblePanes()
        const focusedId = claxedoState.wb.state.focusedPaneId
        const idx = panes.findIndex((p) => p.id === focusedId)
        if (idx >= 0 && idx < panes.length - 1) claxedoState.wb.split.focus(panes[idx + 1].id)
      },
    },
  ])

  const worktreeInfo = (dir: string) => {
    const proj = props.projects.find((p) => projectHasDir(p, dir))
    if (!proj) return
    const ws = projectWorkspaces(proj, !server.isLocal()).find((item) => item.directory === dir)
    const name = ws?.name || getFilename(dir)
    return { name, isMain: !!ws?.isMain, tooltip: `🌳 ${name}` }
  }

  const visiblePanes = createMemo(() => claxedoState.wb.selectors.visiblePanes())
  const workspacePanelTargetForPane = (paneId: string) => {
    const contentId = claxedoState.wb.state.panes.find((pane) => pane.id === paneId)?.contentId
    const active = contentId ? claxedoState.meta.get(contentId) : undefined
    if (active && !isGlobalContent(active) && active.directory) {
      return {
        workspaceDir: active.directory,
        targetPaneId: paneId,
      }
    }

    if (props.activeWorkspaceId) {
      return {
        workspaceDir: props.activeWorkspaceId,
        targetPaneId: paneId,
      }
    }

    const wt = claxedoState.workspace.paneWorktree(paneId)
    const pinned = wt.pinned
    if (pinned && pinned !== "__process__") {
      return {
        workspaceDir: pinned,
        targetPaneId: paneId,
      }
    }

    const dir = wt.default
    if (!dir || dir === "__process__") return undefined
    return {
      workspaceDir: dir,
      targetPaneId: paneId,
    }
  }
  const focusedSplitPaneId = () => claxedoState.wb.state.focusedPaneId ?? visiblePanes()[0]?.id
  const workbenchHeaderVisible = () => sidebarCollapsed() && !sidebarPinned()
  // Switcher items come from the stable workbench content registry joined with
  // `state.meta`; terminal status is still read from the terminal aggregator.
  const headerSurfaceStatus = (contentId: string): SwitcherStatus => {
    const meta = claxedoState.meta.get(contentId)
    if (!meta) return "idle"

    if (meta.type === "terminal") {
      if (!meta.terminalId) return "idle"
      const status = claxedoState.terminal.agentStatus(meta.terminalId)
      if (status === "permission") return "permission"
      if (status === "working") return "working"
      if (claxedoState.terminal.seen(meta.terminalId)) return "done"
    }

    if (meta.type === "session" && meta.sessionId && meta.sessionId !== "new" && meta.directory) {
      const store = globalSync.child?.(meta.directory)?.[0]
      const runtimeStatus = store?.session_status?.[meta.sessionId]
      if (runtimeStatus?.type === "busy" || runtimeStatus?.type === "retry") return "working"
    }

    return "idle"
  }
  const headerSwitcherGroups = createMemo(() =>
    buildSwitcherGroups({
      items: buildSwitcherItemsFromState(claxedoState).map((item) => ({
        ...item,
        status: headerSurfaceStatus(item.contentId),
      })),
      maxPerWorkspace: 5,
      recentContentIds: claxedoState.wb.selectors.recentContents(),
      labelForWorkspace: (workspaceDir) => {
        if (!workspaceDir) return { workspaceLabel: "Global" }
        const project = props.projects.find((project) => projectHasDir(project, workspaceDir))
        return {
          workspaceLabel: worktreeInfo(workspaceDir)?.name || getFilename(workspaceDir),
          projectLabel: project ? projectDisplayName(project, projectRepoName(project)) : undefined,
        }
      },
    })
  )
  const selectHeaderSurface = (contentId: string) => {
    claxedoState.wb.navigation.show(contentId)
    const meta = claxedoState.meta.get(contentId)
    if (meta) props.onTabSelect?.(meta)
  }
  const createHeaderSession = () => {
    const paneId = focusedSplitPaneId()
    props.onNewSession?.(focusedPaneWorkspaceDir(paneId) ?? sidebarDir(), paneId)
  }
  const createHeaderTerminal = (command?: string, title?: string) => {
    const paneId = focusedSplitPaneId()
    const dir = focusedPaneWorkspaceDir(paneId) ?? sidebarDir()
    if (!dir) return
    props.onNewTerminal?.(dir, command, title, paneId)
  }
  const focusedPaneWorkspaceDir = (paneId?: string) => {
    if (!paneId) return undefined
    const contentId = claxedoState.wb.state.panes.find((pane) => pane.id === paneId)?.contentId
    const active = contentId ? claxedoState.meta.get(contentId) : undefined
    if (active && !isGlobalContent(active) && active.directory) return active.directory

    const wt = claxedoState.workspace.paneWorktree(paneId)
    const pinned = wt.pinned
    if (pinned && pinned !== "__process__") return pinned

    const dir = wt.default
    if (dir && dir !== "__process__") return dir

    return props.activeWorkspaceId
  }
  const focusedPanelTarget = () => {
    const paneId = focusedSplitPaneId()
    if (!paneId) return
    return workspacePanelTargetForPane(paneId)
  }
  const workspacePanelOpen = () => claxedoState.workspacePanel.state().open
  const workspacePanelNavigator = () => claxedoState.workspacePanel.state().navigator
  const workspacePanelMode = () => claxedoState.workspacePanel.state().mode
  const workspacePanelForFocusedTarget = () => {
    const target = focusedPanelTarget()
    return !!target && workspacePanelOpen() && claxedoState.workspacePanel.state().workspaceDir === target.workspaceDir
  }
  const openFocusedWorkspacePanel = (input: { navigator: "files" | "processes" | null; focus?: null }) => {
    const target = focusedPanelTarget()
    if (!target) return
    claxedoState.workspacePanel.open("review", {
      workspaceDir: target.workspaceDir,
      targetPaneId: target.targetPaneId,
      navigator: input.navigator,
      focus: input.focus ?? null,
    })
  }
  const toggleFocusedWorkspaceNavigator = (navigator: "files" | "processes") => {
    openFocusedWorkspacePanel({
      navigator: workspacePanelForFocusedTarget() && workspacePanelNavigator() === navigator ? null : navigator,
    })
  }
  const toggleFocusedWorkspaceReview = () => {
    const target = focusedPanelTarget()
    if (!target) return
    claxedoState.workspacePanel.toggle("review", {
      workspaceDir: target.workspaceDir,
      targetPaneId: target.targetPaneId,
      navigator: null,
      focus: null,
    })
  }

  const sidebarDir = createMemo(() => {
    const focusedId = claxedoState.wb.state.focusedPaneId
    if (!focusedId) return props.activeWorkspaceId
    const contentId = claxedoState.wb.selectors.focusedContent()
    const surface = contentId ? claxedoState.meta.get(contentId) : undefined
    if (surface && !isGlobalContent(surface)) return surface.directory
    if (props.activeWorkspaceId) return props.activeWorkspaceId
    const wt = claxedoState.workspace.paneWorktree(focusedId)
    const pinned = wt.pinned
    if (pinned && pinned !== "__process__") return pinned
    const dir = wt.default
    if (dir && dir !== "__process__") return dir
    return props.activeWorkspaceId
  })
  const sidebarProject = createMemo(() => {
    const dir = sidebarDir()
    if (dir) {
      const hit = props.projects.find((p) => projectHasDir(p, dir))
      if (hit) return hit
    }
    if (props.activeProjectId) return props.projects.find((project) => projectMatchesRef(project, props.activeProjectId))
    return undefined
  })

  // Workspace selector for sidebar header (same popover as merged bar)
  const sidebarProjectName = createMemo(() => {
    const proj = sidebarProject()
    return proj ? projectDisplayName(proj, projectRepoName(proj)) : ""
  })
  const sidebarWorkspaceName = createMemo(() => {
    const dir = sidebarDir()
    if (!dir) return ""
    const info = worktreeInfo(dir)
    return info?.name || getFilename(dir)
  })
  const sidebarAllWorkspaceItems = createMemo(() => {
    const list: WorkspaceAttachItem[] = []
    for (const p of props.projects) {
      const pName = projectDisplayName(p, projectRepoName(p))
      for (const ws of projectWorkspaces(p, !server.isLocal())) {
        list.push({
          id: ws.id,
          name: ws.name || getFilename(ws.directory),
          directory: ws.directory,
          projectId: p.id,
          projectName: pName,
          isMain: !!ws.isMain,
          isCloud: !!ws.isCloud,
        })
      }
    }
    return list
  })
  const sidebarHandleWorktreeClick = (projectId: string, dir: string) => {
    const project = props.projects.find((p) => p.id === projectId)
    if (project) props.onWorkspaceSelect?.(project, dir)
    closeMobileSidebar()
  }

  let toolbarLabelRef: HTMLButtonElement | undefined
  createEffect(on(
    () => `${activeGlobal() ? "global" : ""}|${sidebarWorkspaceName()}|${sidebarProjectName()}`,
    () => {
      if (!toolbarLabelRef) return
      toolbarLabelRef.classList.remove("claxedo-pop-bounce")
      void toolbarLabelRef.offsetWidth
      toolbarLabelRef.classList.add("claxedo-pop-bounce")
    },
    { defer: true },
  ))

  const sidebarWorkspaceSelector = () => {
    if (!activeGlobal() && !sidebarDir()) return undefined
    return (
      <WorkspaceSelectorPopover
        allProjects={props.projects}
        allWorkspaceItems={sidebarAllWorkspaceItems}
        currentDir={sidebarDir}
        projectName={sidebarProjectName}
        workspaceName={sidebarWorkspaceName}
        trigger={<Icon name="plus-small" size="small" />}
        triggerClass="flex items-center justify-center size-7 rounded text-icon-weak-base hover:text-icon-base hover:bg-surface-base-hover transition-colors cursor-pointer border-none bg-transparent"
        triggerLabel="Select or create workspace"
        onWorktreeClick={sidebarHandleWorktreeClick}
        onNewLocalWorkspace={async (project, onProgress, wsName) => {
          const result = await props.onNewLocalWorkspace?.(project, onProgress, wsName)
          if (result) sidebarHandleWorktreeClick(project.id, result.directory)
          return result
        }}
        onNewCloudWorkspace={async (project, onProgress, wsName) => {
          const result = await props.onNewCloudWorkspace?.(project, onProgress, wsName)
          if (result) sidebarHandleWorktreeClick(project.id, result.directory)
          return result
        }}
      />
    )
  }

  return (
    <div class="flex flex-col w-full h-full bg-background-base overflow-hidden" data-claxedo>
      {/* Desktop window chrome spacer - for macOS traffic lights / Windows title bar */}

      <div class="flex flex-1 min-h-0 overflow-hidden relative">
        {/* Mobile backdrop - closes sidebar when tapped */}
        <Show when={mobileSidebarOpen()}>
          <div class="fixed inset-0 bg-background-stronger/70 z-[90] md:hidden" onClick={closeMobileSidebar} />
        </Show>

        {/* Sidebar container - desktop: floats/pinned, mobile: slide-in overlay */}
        <div
          class={`
            flex flex-col
            transition-all duration-200 ease-out
            ${sidebarPinned()
              ? "relative z-10 shrink-0 h-full"
              : "absolute top-0 left-0 bottom-0 z-[100] pointer-events-none"
            }
            max-md:fixed max-md:top-0 max-md:left-0 max-md:bottom-0 max-md:z-[100] max-md:pointer-events-auto
            max-md:transition-transform max-md:duration-300 max-md:ease-in-out
            ${mobileSidebarOpen() ? "max-md:translate-x-0" : "max-md:-translate-x-full"}
          `}
        >
          {/* Rail Sidebar - fills full height */}
          <div class="flex-1 min-h-0 h-full">
            <RailSidebar
              projects={props.projects}
              activeProjectId={props.activeProjectId}
              activeWorkspaceId={props.activeWorkspaceId}
              activeSessionId={props.activeSessionId}
              activeGlobal={activeGlobal()}
              globalChatEnabled={props.globalChatEnabled}
              headerTitle={activeGlobal() ? "Global" : sidebarWorkspaceName()}
              headerSubtitle={activeGlobal() ? undefined : sidebarProjectName()}
              hasActiveTabs={hasOpenSurfaces()}
              homedir={props.homedir}
              onWorkspaceSelect={(project, workspaceDir) => {
                props.onWorkspaceSelect?.(project, workspaceDir)
                closeMobileSidebar()
              }}
              onSessionSelect={(workspaceDir, sessionId) => {
                props.onSessionSelect?.(workspaceDir, sessionId)
                closeMobileSidebar()
              }}
              onNewSession={(workspaceDir) => {
                props.onNewSession?.(workspaceDir)
                closeMobileSidebar()
              }}
              onNewTerminal={(workspaceDir, command, title) => {
                props.onNewTerminal?.(workspaceDir, command, title)
                closeMobileSidebar()
              }}
              onDeleteSession={props.onDeleteSession}
              onArchiveSession={props.onArchiveSession}
              onDeleteWorkspace={props.onDeleteWorkspace}
              onRemoveProject={props.onRemoveProject}
              onNewWorkspace={async (project) => {
                const result = await props.onNewWorkspace?.(project)
                closeMobileSidebar()
                return result
              }}
              onNewProject={() => {
                props.onNewProject?.()
                closeMobileSidebar()
              }}
              onSettings={() => {
                props.onSettings?.()
                closeMobileSidebar()
              }}
              onHelp={() => {
                props.onHelp?.()
                closeMobileSidebar()
              }}
              onOpenWorkGraph={() => {
                props.onOpenWorkGraph?.()
                closeMobileSidebar()
              }}
              onTabSelect={props.onTabSelect}
              workgraphEnabled={props.workgraphEnabled}
              trafficLightPad={trafficLightPad()}
              workspaceSelector={sidebarWorkspaceSelector()}
            />
          </div>
        </div>
        <div class="relative flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden bg-background-stronger md:rounded-tl-[12px] transition-[background-color,border-color] duration-200 ease-out">
            <Show when={props.projects.length > 0}>
              <div
                class="flex h-9 shrink-0 items-center gap-1 overflow-hidden border-b border-border-weaker-base bg-background-base"
                style={{ "padding-left": trafficLightPad() && !sidebarPinned() ? "78px" : undefined }}
              >
                <Show when={workbenchHeaderVisible()}>
                  <Tooltip value="Show Sidebar">
                    <IconButton
                      icon="layout-left-partial"
                      variant="ghost"
                      class="shrink-0 rounded ml-1"
                      onClick={() => claxedoState.rail.toggle()}
                      aria-label="Show Sidebar"
                    />
                  </Tooltip>
                  <div class="flex min-w-0 shrink-0 pl-2 w-50 max-md:w-35">
                    <HoverCard
                      openDelay={200}
                      closeDelay={120}
                      trigger={
                        <button
                          ref={toolbarLabelRef}
                          type="button"
                          class="flex min-w-0 w-full items-center gap-1.5 px-1.5 py-0.5 rounded-md hover:bg-surface-base-hover/40 transition-colors cursor-default"
                          aria-label="Workspace details"
                        >
                          <Show
                            when={activeGlobal()}
                            fallback={
                              <span class="contents">
                                <span class="truncate text-[12px] font-medium text-text-base">
                                  {sidebarWorkspaceName() || sidebarProjectName()}
                                </span>
                                <Show when={sidebarWorkspaceName() && sidebarProjectName()}>
                                  <span class="shrink-0 text-[9px] text-text-weak/40">·</span>
                                  <span class="truncate text-[11px] text-text-weak/55">
                                    {sidebarProjectName()}
                                  </span>
                                </Show>
                              </span>
                            }
                          >
                            <span class="truncate text-[12px] font-medium text-text-base">Global</span>
                          </Show>
                        </button>
                      }
                    >
                      <div class="flex flex-col gap-2 p-3 min-w-[280px] max-w-[360px]">
                        <Show
                          when={!activeGlobal()}
                          fallback={
                            <div class="text-[13px] font-semibold text-text-strong">Global workspace</div>
                          }
                        >
                          <div class="flex items-center gap-2">
                            <Icon name="laptop" size="small" class="text-icon-weak-base shrink-0" />
                            <span class="truncate text-[13px] font-semibold text-text-strong">
                              {sidebarWorkspaceName() || "Workspace"}
                            </span>
                          </div>
                          <Show when={sidebarProjectName()}>
                            <div class="flex items-center gap-2 text-[12px] text-text-base">
                              <Icon name="branch" size="small" class="text-icon-weak-base shrink-0" />
                              <span class="truncate">{sidebarProjectName()}</span>
                              <Show when={sidebarWorkspaceName()}>
                                <span class="text-text-weak/50 shrink-0">·</span>
                                <span class="truncate text-text-weak">{sidebarWorkspaceName()}</span>
                              </Show>
                            </div>
                          </Show>
                          <Show when={sidebarDir()}>
                            <div class="flex items-center gap-2 text-[11px] text-text-weak font-mono">
                              <Icon name="folder" size="small" class="text-icon-weak-base shrink-0" />
                              <span class="truncate">{sidebarDir()}</span>
                            </div>
                          </Show>
                        </Show>
                      </div>
                    </HoverCard>
                  </div>
                  <Show when={sidebarWorkspaceSelector()}>
                    {(selector) => selector()}
                  </Show>
                  <div class="mx-1 h-4 w-px shrink-0 bg-border-weak-base" />
                  <div class="min-w-0 flex-[1_1_auto]">
                    <CompactSwitcher
                      groups={headerSwitcherGroups()}
                      onSelect={selectHeaderSurface}
                    />
                  </div>
                </Show>
                <div class="min-w-2 flex-1" />
                <Show when={workbenchHeaderVisible()}>
                  <div class="mx-1 h-4 w-px shrink-0 bg-border-weak-base" />
                </Show>
                <WorkspaceScopeButtons
                  global={activeGlobal()}
                  onNewSession={createHeaderSession}
                  onNewTerminal={createHeaderTerminal}
                  onNewPage={() => {
                    props.onNewPage?.()
                  }}
                  onSettings={props.onSettings}
                />
                <Show when={props.topBarRight}>
                  <div class="flex items-center gap-2 pr-1">
                    {props.topBarRight?.()}
                  </div>
                </Show>
                <Show when={focusedPanelTarget()}>
                  <WorkspacePanelButton
                    icon="file-tree"
                    label="Files"
                    active={workspacePanelForFocusedTarget() && workspacePanelNavigator() === "files"}
                    onClick={() => toggleFocusedWorkspaceNavigator("files")}
                  />
                  <WorkspacePanelButton
                    icon="console"
                    label="Processes"
                    active={workspacePanelForFocusedTarget() && workspacePanelNavigator() === "processes"}
                    attention={!!focusedPanelTarget() && (claxedoState.processPane.crashed(focusedPanelTarget()?.workspaceDir) || claxedoState.processPane.crashedWhileClosed())}
                    onClick={() => toggleFocusedWorkspaceNavigator("processes")}
                  />
                  <WorkspacePanelButton
                    icon="code-lines"
                    label="Workspace Review"
                    active={workspacePanelForFocusedTarget() && workspacePanelMode() === "review" && !workspacePanelNavigator()}
                    onClick={toggleFocusedWorkspaceReview}
                  />
                </Show>
              </div>
            </Show>
            <div class="flex min-h-0 flex-1 overflow-hidden">
              <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                <Workbench
                  renderContent={(id, ctx) => <ContentRenderer id={id} ctx={ctx} />}
                  renderEmpty={() => (
                    <div class="flex flex-col items-center justify-center h-full text-text-weak gap-4">
                      <Show
	                        when={(props.projects?.length ?? 0) > 0}
	                        fallback={
	                          <div class="flex flex-col items-center gap-4">
	                            <span class="text-14-regular">No projects yet. Create one to get started.</span>
	                            <Button icon="plus-small" onClick={() => props.onNewProject?.()}>
	                              New Project
	                            </Button>
	                          </div>
	                        }
	                      >
                        <span class="text-14-regular">Select a session or create a new one</span>
                      </Show>
                    </div>
                  )}
                  onPaneResize={() => {
                    // Terminals re-fit themselves on resize via their own
                    // ResizeObserver; this callback fires for every pane rect
                    // change. Nudging the global terminal-fit event keeps
                    // mounted terminals in sync.
                    window.dispatchEvent(new Event("opencode:terminal-fit"))
                  }}
                  onContentClose={(id, reason) => {
                    // Workbench reasons are "user" | "stale". Map "stale" to
                    // "panic" since orchestration's ContentCloseReason is
                    // "user" | "panic" | "merge" — "stale" content leaked from
                    // a missing pane is closer to "panic" than "user" intent.
                    const orchestrationReason = reason === "stale" ? "panic" : "user"
                    claxedoState.layout._cleanupOnClose(id, orchestrationReason)
                  }}
                />
              </div>
              <WorkspacePanel
                state={claxedoState.workspacePanel.state()}
                onModeSelect={(mode) => claxedoState.workspacePanel.select(mode)}
                onClose={() => {
                  claxedoState.workspacePanel.close()
                }}
                renderMode={(mode, state) => (
                  <WorkspacePanelBody
                    mode={mode}
                    state={state}
                  />
                )}
              />
            </div>

            {/* Mount route content (DirectoryLayout + providers) without rendering it visually. */}
            <div class="hidden">{props.children}</div>
          </div>
      </div>
    </div>
  )
}

function RailLayoutInner(props: RailLayoutProps) {
  return <RailLayoutBody {...props} />
}

/**
 * Rail Layout Inner (without provider)
 *
 * Use this when the caller already provides ClaxedoStateProvider.
 */
export { RailLayoutInner }
