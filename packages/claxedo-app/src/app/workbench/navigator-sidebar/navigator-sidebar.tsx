import { Show, createMemo, onCleanup, type Accessor } from "solid-js"
import { useLanguage } from "@/platform/i18n/provider"
import { NAVIGATOR_MAX_WIDTH, NAVIGATOR_MIN_WIDTH, useClaxedoState, type ClaxedoStateApi } from "../state/index"
import { SessionPaneScope } from "../../../features/session/ui/components/session-pane-scope"
import { emitTerminalFit } from "../../../features/terminal/workbench/terminal-fit"
import type {
  WorkspacePanelFocusTarget,
  WorkspacePanelNavigator,
  WorkspacePanelPaneTarget,
} from "../../../features/workspaces/ui/panel/workspace-panel-state"
import { ProcessPaneProvider } from "../context/process-pane"
import { ProcessesNavigator } from "../workspace-panel/processes-navigator"
import { WorkspaceFilesNavigator } from "../workspace-panel/files-navigator"
import { NavigatorSidebarTabs } from "./navigator-sidebar-tabs"
import "./navigator-sidebar.css"

const RESIZE_KEY_STEP = 24

/** See the note on the same alias in `workbench/terminal/terminal-new-view.tsx`. */
type WorkspaceDirectoryRef = string

export function NavigatorSidebar(props: {
  width: Accessor<number>
  onResize: (width: number) => void
  onResizeEnd: () => void
  target: Accessor<WorkspacePanelPaneTarget | undefined>
}) {
  const claxedoState = useClaxedoState()
  const language = useLanguage()
  const tab = claxedoState.navigator.tab
  return (
    <aside
      data-testid="navigator-sidebar"
      data-tab={tab()}
      class="claxedo-navigator-sidebar relative flex h-full shrink-0 flex-col border-r border-border-weak-base bg-background-base"
      style={{ width: `${props.width()}px`, "--claxedo-navigator-width": `${props.width()}px` }}
    >
      <NavigatorSidebarTabs active={tab()} onSelect={(next) => claxedoState.navigator.select(next)} />
      <div class="min-h-0 flex-1 overflow-hidden">
        <Show
          keyed
          when={props.target()?.workspaceDir}
          fallback={
            <div
              data-testid="navigator-sidebar-empty"
              class="flex h-full items-center justify-center px-6 text-center text-compact text-text-weak"
            >
              {language.t("navigator.sidebar.empty")}
            </div>
          }
        >
          {(directory) => (
            <NavigatorWorkspace directory={directory} paneId={() => props.target()?.targetPaneId} tab={tab} />
          )}
        </Show>
      </div>
      <NavigatorResizeHandle width={props.width} onResize={props.onResize} onResizeEnd={props.onResizeEnd} />
    </aside>
  )
}

/**
 * The session identity of the pane the sidebar is bound to, read the way the
 * workspace panel body reads it for its own `SessionPaneScope`: the pane's
 * content, else the focused surface. A terminal pane's session is left
 * unresolved; the navigators key on the directory, not the session.
 */
export function paneSessionScope(state: ClaxedoStateApi, paneId: string | undefined) {
  const focusedContentId = state.wb.selectors.focusedContent() ?? undefined
  const paneContentId = paneId
    ? state.wb.state.panes.find((pane) => pane.id === paneId)?.contentId ?? undefined
    : undefined
  const surfaceId = paneContentId ?? focusedContentId
  const content = surfaceId ? state.meta.get(surfaceId) : undefined
  return {
    surfaceId,
    sessionId: content?.type === "terminal" ? undefined : content?.sessionId,
    sessionRef: content?.content?.sessionRef,
  }
}

function NavigatorWorkspace(props: {
  directory: WorkspaceDirectoryRef
  paneId: Accessor<string | undefined>
  tab: Accessor<WorkspacePanelNavigator>
}) {
  const claxedoState = useClaxedoState()
  const scope = createMemo(() => paneSessionScope(claxedoState, props.paneId()))
  const focus = () => {
    const panel = claxedoState.workspacePanel.state()
    return panel.workspaceDir === props.directory ? panel.focus : undefined
  }
  const activePath = () => {
    const value = focus()
    return value?.kind === "file" ? value.path : undefined
  }
  const activeProcessId = () => {
    const value = focus()
    return value?.kind === "process" ? value.processId : undefined
  }
  const filesSelected = () => props.tab() !== "processes"
  const filesModeOf = (tab: WorkspacePanelNavigator, previous: "files" | "changes") =>
    tab === "processes" ? previous : tab
  const filesMode = createMemo<"files" | "changes">(
    (previous) => filesModeOf(props.tab(), previous),
    filesModeOf(props.tab(), "files"),
  )
  // A navigator stays mounted once visited so switching back keeps its tree
  // state; only the visible one is active.
  const filesVisited = createMemo<boolean>((visited) => visited || filesSelected(), false)
  const processesVisited = createMemo<boolean>((visited) => visited || !filesSelected(), false)
  const showInPanel = (navigator: WorkspacePanelNavigator, focus: WorkspacePanelFocusTarget) => {
    claxedoState.workspacePanel.open("review", {
      workspaceDir: props.directory,
      targetPaneId: props.paneId(),
      navigator,
      focus,
    })
  }

  return (
    <SessionPaneScope
      directory={props.directory}
      sessionRef={() => scope().sessionRef}
      sessionId={() => scope().sessionId}
      surfaceId={() => scope().surfaceId}
      paneId={() => props.paneId() ?? ""}
      active={() => true}
      suppressConnectionGate
    >
      <div class="relative size-full">
        <Show when={filesVisited()}>
          <div class="absolute inset-0" classList={{ hidden: !filesSelected() }}>
            <WorkspaceFilesNavigator
              mode={filesMode()}
              active={filesSelected()}
              activePath={activePath()}
              onFileClick={(path, intent) => showInPanel(filesMode(), { kind: "file", path, intent })}
            />
          </div>
        </Show>
        <Show when={processesVisited()}>
          <div class="absolute inset-0" classList={{ hidden: filesSelected() }}>
            <ProcessPaneProvider directory={props.directory} isOpen={() => !filesSelected()}>
              <ProcessesNavigator
                directory={props.directory}
                activeProcessId={activeProcessId()}
                onProcessSelect={(processId) => showInPanel("processes", { kind: "process", processId })}
              />
            </ProcessPaneProvider>
          </div>
        </Show>
      </div>
    </SessionPaneScope>
  )
}

function NavigatorResizeHandle(props: {
  width: Accessor<number>
  onResize: (width: number) => void
  onResizeEnd: () => void
}) {
  const language = useLanguage()
  let resizing = false
  let startX = 0
  let startWidth = 0
  let pendingWidth: number | undefined
  let frame: number | undefined

  const flush = () => {
    frame = undefined
    if (pendingWidth === undefined) return
    props.onResize(pendingWidth)
    pendingWidth = undefined
    emitTerminalFit()
  }
  const move = (event: PointerEvent) => {
    if (!resizing) return
    pendingWidth = startWidth + event.clientX - startX
    if (frame === undefined) frame = requestAnimationFrame(flush)
  }
  const finish = () => {
    if (!resizing) return
    resizing = false
    if (frame !== undefined) cancelAnimationFrame(frame)
    flush()
    props.onResizeEnd()
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", finish)
    window.removeEventListener("pointercancel", finish)
  }
  const start = (event: PointerEvent) => {
    resizing = true
    startX = event.clientX
    startWidth = props.width()
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", finish)
    event.preventDefault()
  }
  const keyStep = (event: KeyboardEvent) => {
    const delta = event.key === "ArrowRight" ? RESIZE_KEY_STEP : event.key === "ArrowLeft" ? -RESIZE_KEY_STEP : 0
    if (delta === 0) return
    event.preventDefault()
    props.onResize(props.width() + delta)
    props.onResizeEnd()
    emitTerminalFit()
  }
  onCleanup(finish)

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={language.t("navigator.sidebar.resize")}
      aria-valuemin={NAVIGATOR_MIN_WIDTH}
      aria-valuemax={NAVIGATOR_MAX_WIDTH}
      aria-valuenow={props.width()}
      tabIndex={0}
      data-testid="navigator-sidebar-resize"
      class="claxedo-navigator-sidebar-handle absolute top-0 bottom-0 right-[-4px] z-[90] w-2 cursor-col-resize"
      onPointerDown={start}
      onKeyDown={keyStep}
    >
      <div class="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-100" />
    </div>
  )
}
