import { Show, onCleanup, type Accessor } from "solid-js"

import type { ContentMeta } from "../state"
import { emitTerminalFit } from "../terminal/terminal-fit"
import {
  RailSidebar,
  type ProjectItem,
  type SessionItem,
  type WorkspaceItem,
} from "./rail-sidebar"
import type { WorkspaceBarItem } from "./workspace-toolbar"

export type RailSidebarShellProps = {
  activeGlobal: Accessor<boolean>
  activeProjectId?: string
  activeSessionId?: string
  activeWorkspaceId?: string
  closeMobileSidebar: () => void
  globalChatEnabled?: boolean
  hasOpenSurfaces: Accessor<boolean>
  headerSubtitle: Accessor<string | undefined>
  headerTitle: Accessor<string>
  homedir?: string
  mobileSidebarOpen: Accessor<boolean>
  onArchiveSession?: (session: SessionItem) => boolean | Promise<boolean>
  onDeleteSession?: (session: SessionItem) => void
  onDeleteWorkspace?: (workspace: WorkspaceItem) => void
  onHelp?: () => void
  onNewPage?: () => void
  onNewProject?: () => void
  onNewSession?: (workspaceDir?: string, paneId?: string) => void
  onNewTerminal?: (workspaceDir: string, command?: string, title?: string, paneId?: string) => void
  onNewWorkspace?: (project: ProjectItem) => Promise<WorkspaceBarItem | undefined>
  onOpenMarketplace?: () => void
  onRailCancelCollapse: () => void
  onRailLockChange: (locked: boolean) => void
  onRemoveProject?: (project: ProjectItem) => void
  onSettings?: () => void
  onSidebarMouseLeave: () => void
  onSidebarResize: (width: number) => void
  onSidebarResizeEnd: () => void
  onSessionSelect?: (workspaceDir: string, sessionId: string) => void
  onTabSelect?: (surface: ContentMeta) => void
  onToggleSidebar: () => void
  onRailTrackPosition: (
    clientX: number,
    clientY: number,
    railRect: { top: number; right: number; bottom: number },
  ) => void
  onWorkspaceSelect?: (project: ProjectItem, workspaceDir: string) => void
  projects: ProjectItem[]
  sidebarEligible: Accessor<boolean>
  sidebarExpanded: Accessor<boolean>
  sidebarHidden: Accessor<boolean>
  sidebarPinned: Accessor<boolean>
  sidebarWidth: Accessor<number>
  trafficLightPad: Accessor<boolean>
}

export function RailSidebarShell(props: RailSidebarShellProps) {
  let resizing = false
  let startX = 0
  let startWidth = 0

  const finishResize = () => {
    if (!resizing) return
    resizing = false
    props.onRailLockChange(false)
    props.onSidebarResizeEnd()
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
    emitTerminalFit()
    window.removeEventListener("pointermove", handleResizeMove)
    window.removeEventListener("pointerup", finishResize)
    window.removeEventListener("pointercancel", finishResize)
  }

  const handleResizeMove = (event: PointerEvent) => {
    if (!resizing) return
    props.onSidebarResize(startWidth + event.clientX - startX)
    emitTerminalFit()
  }

  const startResize = (event: PointerEvent) => {
    if (!props.sidebarExpanded()) return
    resizing = true
    startX = event.clientX
    startWidth = props.sidebarWidth()
    props.onRailLockChange(true)
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    window.addEventListener("pointermove", handleResizeMove)
    window.addEventListener("pointerup", finishResize)
    window.addEventListener("pointercancel", finishResize)
    event.preventDefault()
    event.stopPropagation()
  }

  onCleanup(finishResize)

  return (
    <Show when={props.sidebarEligible()}>
      <Show when={props.mobileSidebarOpen()}>
        <div
          class="fixed inset-0 bg-background-stronger/70 z-[90] md:hidden"
          onClick={props.closeMobileSidebar}
        />
      </Show>

      <div
        class={`
          relative flex flex-col
          w-[var(--claxedo-sidebar-width)] shrink-0 overflow-hidden transition-[width] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)]
          ${props.sidebarHidden() ? "pointer-events-none" : "pointer-events-auto"}
          ${props.sidebarPinned() ? "" : "md:absolute md:left-0 md:top-0 md:bottom-0 md:z-[80]"}
          max-md:fixed max-md:top-0 max-md:left-0 max-md:bottom-0 max-md:z-[100] max-md:!w-[280px] max-md:pointer-events-auto
          max-md:transition-[translate,transform] max-md:duration-300 max-md:ease-in-out
          ${props.mobileSidebarOpen() ? "max-md:translate-x-0" : "max-md:-translate-x-full"}
        `}
        style={{
          "--claxedo-sidebar-width": `${props.sidebarWidth()}px`,
        }}
      >
        <div class="flex-1 min-h-0 h-full">
          <RailSidebar
            projects={props.projects}
            activeProjectId={props.activeProjectId}
            activeWorkspaceId={props.activeWorkspaceId}
            activeSessionId={props.activeSessionId}
            activeGlobal={props.activeGlobal()}
            globalChatEnabled={props.globalChatEnabled}
            headerTitle={props.headerTitle()}
            headerSubtitle={props.headerSubtitle()}
            hasActiveTabs={props.hasOpenSurfaces()}
            homedir={props.homedir}
            onWorkspaceSelect={(project, workspaceDir) => {
              props.onWorkspaceSelect?.(project, workspaceDir)
              props.closeMobileSidebar()
            }}
            onSessionSelect={(workspaceDir, sessionId) => {
              props.onSessionSelect?.(workspaceDir, sessionId)
              props.closeMobileSidebar()
            }}
            onNewSession={(workspaceDir) => {
              props.onNewSession?.(workspaceDir)
              props.closeMobileSidebar()
            }}
            onNewTerminal={(workspaceDir, command, title) => {
              props.onNewTerminal?.(workspaceDir, command, title)
              props.closeMobileSidebar()
            }}
            onDeleteSession={props.onDeleteSession}
            onArchiveSession={props.onArchiveSession}
            onDeleteWorkspace={props.onDeleteWorkspace}
            onRemoveProject={props.onRemoveProject}
            onNewWorkspace={async (project) => {
              const result = await props.onNewWorkspace?.(project)
              props.closeMobileSidebar()
              return result
            }}
            onNewProject={() => {
              props.onNewProject?.()
              props.closeMobileSidebar()
            }}
            onSettings={() => {
              props.onSettings?.()
              props.closeMobileSidebar()
            }}
            onHelp={() => {
              props.onHelp?.()
              props.closeMobileSidebar()
            }}
            onOpenMarketplace={
              props.onOpenMarketplace
                ? () => {
                    props.onOpenMarketplace?.()
                    props.closeMobileSidebar()
                  }
                : undefined
            }
            onOpenPages={
              props.onNewPage
                ? () => {
                    props.onNewPage?.()
                    props.closeMobileSidebar()
                  }
                : undefined
            }
            onRailMouseLeave={props.onSidebarMouseLeave}
            onRailCancelCollapse={props.onRailCancelCollapse}
            onRailLockChange={props.onRailLockChange}
            onRailTrackPosition={props.onRailTrackPosition}
            onToggleSidebar={props.onToggleSidebar}
            railDocked={props.sidebarPinned()}
            railExpanded={props.sidebarExpanded()}
            railWidth={props.sidebarWidth()}
            onTabSelect={props.onTabSelect}
            trafficLightPad={props.trafficLightPad()}
          />
        </div>
        <Show when={props.sidebarExpanded()}>
          <div
            aria-hidden="true"
            class="max-md:hidden absolute top-0 right-[-4px] bottom-0 w-2 cursor-col-resize z-[90] group"
            onPointerDown={startResize}
          >
            <div class="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-transparent group-hover:bg-border-base/80 transition-colors duration-100" />
          </div>
        </Show>
      </div>
    </Show>
  )
}
