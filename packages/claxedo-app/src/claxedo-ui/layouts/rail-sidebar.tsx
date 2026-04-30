/**
 * Rail Sidebar Component
 *
 * Collapsible sidebar with Project > Session flat list.
 * - Collapsed: 56px wide, icons only
 * - Expanded: 260px wide, full list
 * - Shows 5 sessions per project by default, with "Load more" button
 *
 * Hover behavior:
 * - Mouse enters leftmost 12px: expand after 100ms
 * - Mouse leaves rail: collapse after 100ms
 * - Can be pinned open via toggle button
 */

import { For, Show, Switch, Match, createMemo, createSignal, onCleanup, onMount, createEffect, on, type JSX } from "solid-js"
import { useClaxedoState, type ContentMeta } from "../state"
import { WORKBENCH_DRAG_MIME } from "../layout"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { useLanguage, useGlobalSync, useServer } from "@opencode-ai/claxedo-app"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { usePermission } from "@/context/permission"
import { useOptionalTerminal } from "@/context/terminal"
import { StatusPopover } from "../../overrides/components/status-popover"
import { DialogEditProject } from "../components/dialog-edit-project"
import { DialogProcessDiagnostics } from "../components/dialog-process-diagnostics"
import { getFilename } from "@opencode-ai/util/path"
import type { GlobalSessionItem } from "../../overrides/context/global-sync/types"
import { buildSidebarInventoryFromState } from "../sidebar/sidebar-inventory"
import { workspaceDisplayName } from "../utils/workspace-display"
import { getTerminalCommands } from "../../components/settings-terminals"
import { sessionPermissionRequest, sessionQuestionRequest } from "@/pages/session/composer/session-request-tree"

const VIEW_KEY = "claxedo.session-view.v1"
const GLOBAL_TAG = "global"
const GLOBAL_SHOW_TAG = "global:default"

type Group = "project"
type Archive = "active" | "all" | "archived"

function showCloud(input: {
  worktree: string
  workspaces?: Record<string, { kind: "local" | "cloud" }>
  workspaceDir?: string
  local: boolean
}) {
  const dir = input.workspaceDir ?? input.worktree
  if (dir === input.worktree) return input.workspaces?.[dir]?.kind === "cloud" || !input.local
  const ws = input.workspaces?.[dir]
  if (ws) return ws.kind === "cloud"
  return false
}

export type SessionItem = {
  id: string
  title?: string
  time?: number
  directory?: string
  projectID?: string
  projectName?: string
  workspaceName?: string
  tags?: string[]
  attachments?: Array<{ kind: string; targetID: string }>
  environment?: { kind?: string; provider?: string }
  git?: { repo?: string; branch?: string; remote?: string }
}

export type WorkspaceItem = {
  id: string
  directory: string
  name?: string
  isMain?: boolean
  projectWorktree?: string
  isCloud?: boolean
  canDelete?: boolean
  available?: boolean
}

export type WorkspaceInfo = {
  id: string
  workspace_name?: string
  directory: string
  kind: "local" | "cloud"
  available?: boolean
  provider?: string
  status?: string
  sandbox_id?: string
  remote_directory?: string
  repo_url?: string
}

export type ProjectItem = {
  id: string
  worktree: string
  name?: string
  icon?: {
    url?: string
    override?: string
    color?: string
  }
  expanded?: boolean
  sandboxes?: string[]
  workspaces?: Record<string, WorkspaceInfo>
  commands?: { start?: string }
}

export type RailSidebarProps = {
  projects: ProjectItem[]
  activeProjectId?: string
  activeWorkspaceId?: string
  activeSessionId?: string
  activeGlobal?: boolean
  globalChatEnabled?: boolean
  headerTitle?: string
  headerSubtitle?: string
  onWorkspaceSelect?: (project: ProjectItem, workspaceDir: string) => void
  onSessionSelect?: (workspaceDir: string, sessionId: string) => void
  onNewSession?: (workspaceDir: string) => void
  onNewTerminal?: (workspaceDir: string, command?: string, title?: string) => void
  onNewWorkspace?: (project: ProjectItem) => void
  onNewProject?: () => void
  onRemoveProject?: (project: ProjectItem) => void
  onDeleteWorkspace?: (workspace: WorkspaceItem) => void
  onDeleteSession?: (session: SessionItem) => void
  onArchiveSession?: (session: SessionItem) => void
  onSettings?: () => void
  onHelp?: () => void
  onOpenWorkGraph?: () => void
  onTabSelect?: (tab: ContentMeta) => void
  workgraphEnabled?: boolean
  hasActiveTabs?: boolean
  homedir?: string
  children?: JSX.Element
  trafficLightPad?: boolean
  workspaceSelector?: JSX.Element
}

type View = {
  group: Group
  status: string[]
  environment: string[]
  git: string[]
  archived: Archive
}

type Row = SessionItem & {
  project: ProjectItem
  archived?: boolean
  status: string[]
  active?: boolean
}

type Section = {
  id: string
  label: string
  rows: Row[]
  project: ProjectItem
  workspaceDir: string
}

type Cluster = {
  id: string
  label: string
  project: ProjectItem
  items: Section[]
}

type GlobalSection = {
  id: string
  label: string
  rows: Row[]
}

type SidebarStatus = "idle" | "working" | "permission" | "done"

const activeRowStyle = (active: boolean): JSX.CSSProperties =>
  active
    ? {
        background: "color-mix(in srgb, var(--text-base) 7%, transparent)",
      }
    : {}

const SidebarStatusDot = (props: { status: SidebarStatus; active?: boolean }) => (
  <span
    data-sidebar-status={props.status}
    class="shrink-0 rounded-full transition-[background-color,box-shadow,width,height] duration-100"
    classList={{
      "size-2": props.active,
      "size-1.5": !props.active,
      "bg-icon-warning-base": props.status === "working",
      "bg-icon-critical-base": props.status === "permission",
      "bg-icon-success-base": props.status === "done",
      "bg-transparent": props.status === "idle",
    }}
  />
)

function loadView() {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(VIEW_KEY)
    if (!raw) return
    const row = JSON.parse(raw) as Partial<View>
    const archived = row.archived
    return {
      group: "project",
      status: Array.isArray(row.status) ? row.status.filter((item): item is string => typeof item === "string") : [],
      environment: Array.isArray(row.environment) ? row.environment.filter((item): item is string => typeof item === "string") : [],
      git: Array.isArray(row.git) ? row.git.filter((item): item is string => typeof item === "string") : [],
      archived: archived === "all" || archived === "archived" ? archived : "active",
    } satisfies View
  } catch {
    return
  }
}

function saveView(input: View) {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(VIEW_KEY, JSON.stringify(input))
}

function uniq(input: string[]) {
  return [...new Set(input)].sort((a, b) => a.localeCompare(b))
}

export function parseOwnerRepo(remote: string | undefined): string | undefined {
  if (!remote) return
  const ssh = remote.match(/[:\/]([^/]+\/[^/]+?)(?:\.git)?$/)
  if (ssh?.[1]) return ssh[1]
  return
}

function title(input: string) {
  if (input === "review" || input === "page" || input === "planner") return input[0]!.toUpperCase() + input.slice(1)
  if (input === "general") return "General"
  if (input === "local") return "Local"
  if (input === "cloud") return "Cloud"
  return input.replace(/^repo:/, "").replace(/^branch:/, "").replace(/^provider:/, "")
}

function state(input: Pick<SessionItem, "tags" | "attachments"> | Pick<GlobalSessionItem, "tags" | "attachments">) {
  const all = uniq([
    ...(input.tags ?? []).filter((item) => item !== GLOBAL_TAG && item !== GLOBAL_SHOW_TAG),
    ...(input.attachments ?? []).map((item) => item.kind),
  ])
  if (all.length) return all
  return ["general"]
}

function env(input: Pick<SessionItem, "environment"> | Pick<GlobalSessionItem, "environment">) {
  const all = [
    input.environment?.kind,
    input.environment?.provider ? `provider:${input.environment.provider}` : undefined,
  ].filter((item): item is string => !!item)
  return uniq(all)
}

function git(input: Pick<SessionItem, "git"> | Pick<GlobalSessionItem, "git">) {
  const all = [
    input.git?.repo ? `repo:${input.git.repo}` : undefined,
    input.git?.branch ? `branch:${input.git.branch}` : undefined,
  ].filter((item): item is string => !!item)
  return uniq(all)
}

function relativeTime(ts: number) {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 10) return "now"
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo`
  return `${Math.floor(mo / 12)}y`
}

export function RailSidebar(props: RailSidebarProps) {
  const claxedoState = useClaxedoState()
  const language = useLanguage()

  const openWorkspacePanel = (directory: string) => {
    claxedoState.workspacePanel.open("review", {
      workspaceDir: directory,
    })
  }
  const globalSync = useGlobalSync()
  const server = useServer()
  const dialog = useDialog()
  const permission = usePermission()
  const terminal = useOptionalTerminal()
  let railRef: HTMLElement | undefined

  const expanded = createMemo(() => !claxedoState.rail.collapsed() || claxedoState.rail.pinned())
  const width = createMemo(() => claxedoState.rail.width())
  const [clock, setClock] = createSignal(Date.now())
  const projectMatches = (project: ProjectItem) =>
    props.activeProjectId === project.id || props.activeProjectId === project.worktree

  onMount(() => {
    const timer = setInterval(() => setClock(Date.now()), 10000)
    onCleanup(() => clearInterval(timer))
  })

  const [view, setView] = createSignal<View>(loadView() ?? {
    group: "project",
    status: [],
    environment: [],
    git: [],
    archived: "active",
  })

  createEffect(() => {
    saveView(view())
  })

  const sessionFilter = createMemo(() => ({
    archived: view().archived,
    status: view().status,
    environment: view().environment,
    git: view().git,
  }))

  const sectionCloud = (project: ProjectItem, workspaceDir?: string) =>
    showCloud({
      worktree: project.worktree,
      workspaces: project.workspaces,
      workspaceDir,
      local: server.isLocal(),
    })

  const workspaceName = (dir: string, project: ProjectItem) => {
    return workspaceDisplayName(project, dir, { cloud: sectionCloud(project, dir) })
  }

  const projectRepoName = (project: ProjectItem) => {
    const sessions = globalSync.globalSessions.store.byProject[project.id]
    const remote = sessions?.find((s) => s.git?.remote)?.git?.remote
    return parseOwnerRepo(remote)
  }

  const projectLabel = (project: ProjectItem) => {
    return projectRepoName(project) ?? project.name ?? getFilename(project.worktree)
  }

  const workspace = (project: ProjectItem, dir: string): WorkspaceItem => {
    const main = dir === project.worktree
    const ws = project.workspaces?.[dir]
    const cloud = sectionCloud(project, dir)
    return {
      id: dir,
      directory: dir,
      name: main ? "main" : workspaceName(dir, project),
      isMain: main,
      projectWorktree: project.worktree,
      isCloud: cloud,
      canDelete: main ? cloud : true,
      available: ws?.available ?? true,
    }
  }

  const rows = createMemo<Row[]>(() =>
    props.projects.flatMap((project) =>
      (globalSync.globalSessions.store.byProject[project.id] ?? []).map((item) => ({
        id: item.id,
        title: item.title,
        time: item.time.updated ?? item.time.created,
        directory: item.directory,
        projectID: item.projectID,
        projectName: projectLabel(project),
        workspaceName: workspaceName(item.directory, project),
        tags: item.tags,
        attachments: item.attachments,
        environment: item.environment,
        git: item.git,
        archived: item.archived,
        status: state(item),
        project,
      })),
    ),
  )

  const globalRows = createMemo<Row[]>(() =>
    props.globalChatEnabled
      ? globalSync.globalSessions.store.global.map((item) => ({
        id: item.id,
        title: item.title,
        time: item.time.updated ?? item.time.created,
        directory: item.directory,
        projectID: item.projectID,
        projectName: "Global Chat",
        workspaceName: "Global Chat",
        tags: item.tags,
        attachments: item.attachments,
        environment: item.environment,
        git: item.git,
        archived: item.archived,
        status: state(item),
        project: {
          id: "global",
          worktree: item.directory,
          name: "Global Chat",
        },
      }))
      : [],
  )

  const row = (item: GlobalSessionItem, project: ProjectItem): Row => ({
    id: item.id,
    title: item.title,
    time: item.time.updated ?? item.time.created,
    directory: item.directory,
    projectID: item.projectID,
    projectName: projectLabel(project),
    workspaceName: workspaceName(item.directory, project),
    tags: item.tags,
    attachments: item.attachments,
    environment: item.environment,
    git: item.git,
    archived: item.archived,
    status: state(item),
    project,
  })

  const allRows = createMemo(() => [...rows(), ...globalRows()])
  const statusOptions = createMemo(() => uniq(allRows().flatMap((item) => item.status).filter((item) => item !== "general")))
  const environmentOptions = createMemo(() => uniq(allRows().flatMap((item) => env(item))))
  const gitOptions = createMemo(() => uniq(allRows().flatMap((item) => git(item))))

  const match = (item: Row) => {
    if (view().archived === "active" && item.archived) return false
    if (view().archived === "archived" && !item.archived) return false
    if (view().status.length && !view().status.some((hit) => item.status.includes(hit))) return false
    if (view().environment.length && !view().environment.some((hit) => env(item).includes(hit))) return false
    if (view().git.length && !view().git.some((hit) => git(item).includes(hit))) return false
    return true
  }

  const dirs = (project: ProjectItem) => {
    const all = new Set<string>([
      project.worktree,
      ...(project.sandboxes ?? []),
      ...Object.keys(project.workspaces ?? {}),
    ])
    if (projectMatches(project) && props.activeWorkspaceId) all.add(props.activeWorkspaceId)
    return [...all]
  }

  const globals = createMemo<GlobalSection[]>(() => {
    const rows = globalRows()
      .filter(match)
      .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    if (!rows.length) return []
    return [{
      id: "global",
      label: "Global Chat",
      rows,
    }]
  })

  const groups = createMemo<Cluster[]>(() => {
    const wsStore = globalSync.globalSessions.store.byWorkspace
    return props.projects.map((project) => ({
      id: project.id,
      label: projectLabel(project),
      project,
      items: dirs(project).map((dir) => ({
        id: dir,
        label: workspaceName(dir, project),
        rows: (wsStore[dir]?.sessions ?? [])
          .map((item) => row(item, project))
          .filter(match)
          .sort((a, b) => (b.time ?? 0) - (a.time ?? 0)),
        project,
        workspaceDir: dir,
      })),
    }))
  })

  // Load more sessions for a workspace directory
  const loadMoreWorkspaceSessions = async (directory: string) => {
    await globalSync.globalSessions.loadMoreWorkspace(directory, sessionFilter())
  }

  // Handle hot zone detection + floating collapse via unified position tracking
  const handleMouseMove = (e: MouseEvent) => {
    if (!railRef) return
    const rect = railRef.getBoundingClientRect()
    claxedoState.rail.trackPosition(e.clientX, e.clientY, { top: rect.top, right: rect.right, bottom: rect.bottom })
  }

  const handleMouseLeave = (e: MouseEvent) => {
    claxedoState.rail.handleMouseLeave(e)
  }

  const handleMouseEnter = () => {
    claxedoState.rail.cancelCollapse()
  }

  const activeDirectory = createMemo(() => {
    if (props.activeWorkspaceId) return props.activeWorkspaceId
    const activeProject = props.projects.find((project) => projectMatches(project))
    return activeProject?.worktree ?? props.projects[0]?.worktree
  })

  const sessionStatus = (session: Row): SidebarStatus => {
    const directory = session.directory ?? session.project.worktree

    const [store] = globalSync.child(directory)
    const perm = sessionPermissionRequest(store.session, store.permission, session.id, (item) => {
      return !permission.autoResponds(item, directory)
    })
    const question = sessionQuestionRequest(store.session, store.question, session.id)
    if (perm || question) return "permission"

    const runtimeStatus = store.session_status[session.id]
    if (runtimeStatus?.type === "busy" || runtimeStatus?.type === "retry") return "working"
    return "idle"
  }

  const terminalStatus = (item: { paneId: string; terminalId: string }): SidebarStatus => {
    const rawAgentStatus = claxedoState.terminal.agentStatus(item.terminalId)
    if (rawAgentStatus === "permission") return "permission"
    if (rawAgentStatus === "working") return "working"
    if (claxedoState.terminal.seen(item.terminalId)) return "done"
    return "idle"
  }

  const openDiagnostics = () => {
    dialog.show(() => <DialogProcessDiagnostics directory={activeDirectory()} />)
  }

  onMount(() => {
    document.addEventListener("mousemove", handleMouseMove)
    onCleanup(() => {
      document.removeEventListener("mousemove", handleMouseMove)
    })
  })

  createEffect(() => {
    void globalSync.globalSessions.reloadWorkspace(sessionFilter())
  })

  const setArchive = (archived: Archive) => setView((prev) => ({ ...prev, archived }))
  const toggle = (key: "status" | "environment" | "git", value: string) =>
    setView((prev) => ({
      ...prev,
      [key]: prev[key].includes(value)
        ? prev[key].filter((item) => item !== value)
        : [...prev[key], value],
    }))

  const FilterMenu = () => {
    return (
      <DropdownMenu onOpenChange={(open) => open ? claxedoState.rail.lock() : claxedoState.rail.unlock()}>
        <Tooltip placement="top" value="Filter & Sort">
          <DropdownMenu.Trigger class="flex items-center justify-center h-7 w-7 rounded-md text-icon-base hover:text-text-base transition-colors cursor-pointer border-none bg-transparent">
            <Icon name="sliders" size="small" />
          </DropdownMenu.Trigger>
        </Tooltip>
        <DropdownMenu.Portal>
          <DropdownMenu.Content style={{ "z-index": 220, "min-width": "200px" }}>
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel>Group by</DropdownMenu.GroupLabel>
              <DropdownMenu.RadioGroup value={view().group}>
                <DropdownMenu.RadioItem value="project" closeOnSelect={false}>
                  <span class="flex-1">Project</span>
                  <Show when={view().group === "project"}>
                    <span class="text-text-weak/50">&#10003;</span>
                  </Show>
                </DropdownMenu.RadioItem>
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Group>

            <DropdownMenu.Separator />

            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel>Show</DropdownMenu.GroupLabel>

              <Show when={statusOptions().length > 0}>
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger>
                    <span class="flex-1">Status</span>
                    <Icon name="chevron-right" size="small" class="opacity-30" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent style={{ "z-index": 220 }}>
                      <For each={statusOptions()}>
                        {(item) => (
                          <DropdownMenu.CheckboxItem
                            checked={view().status.includes(item)}
                            onChange={() => toggle("status", item)}
                            closeOnSelect={false}
                          >
                            <span class="flex-1">{title(item)}</span>
                            <Show when={view().status.includes(item)}>
                              <span class="text-text-weak/50">&#10003;</span>
                            </Show>
                          </DropdownMenu.CheckboxItem>
                        )}
                      </For>
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              </Show>

              <Show when={environmentOptions().length > 0}>
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger>
                    <span class="flex-1">Environment</span>
                    <Icon name="chevron-right" size="small" class="opacity-30" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent style={{ "z-index": 220 }}>
                      <For each={environmentOptions()}>
                        {(item) => (
                          <DropdownMenu.CheckboxItem
                            checked={view().environment.includes(item)}
                            onChange={() => toggle("environment", item)}
                            closeOnSelect={false}
                          >
                            <span class="flex-1">{title(item)}</span>
                            <Show when={view().environment.includes(item)}>
                              <span class="text-text-weak/50">&#10003;</span>
                            </Show>
                          </DropdownMenu.CheckboxItem>
                        )}
                      </For>
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              </Show>

              <Show when={gitOptions().length > 0}>
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger>
                    <span class="flex-1">Git</span>
                    <Icon name="chevron-right" size="small" class="opacity-30" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent style={{ "z-index": 220 }}>
                      <For each={gitOptions()}>
                        {(item) => (
                          <DropdownMenu.CheckboxItem
                            checked={view().git.includes(item)}
                            onChange={() => toggle("git", item)}
                            closeOnSelect={false}
                          >
                            <span class="flex-1">{title(item)}</span>
                            <Show when={view().git.includes(item)}>
                              <span class="text-text-weak/50">&#10003;</span>
                            </Show>
                          </DropdownMenu.CheckboxItem>
                        )}
                      </For>
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              </Show>

              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger>
                  <span class="flex-1">Archived</span>
                  <Icon name="chevron-right" size="small" class="opacity-30" />
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent style={{ "z-index": 220 }}>
                    <DropdownMenu.RadioGroup value={view().archived} onChange={(v) => setArchive(v as Archive)}>
                      <DropdownMenu.RadioItem value="active" closeOnSelect={false}>
                        <span class="flex-1">Active</span>
                        <Show when={view().archived === "active"}>
                          <span class="text-text-weak/50">&#10003;</span>
                        </Show>
                      </DropdownMenu.RadioItem>
                      <DropdownMenu.RadioItem value="all" closeOnSelect={false}>
                        <span class="flex-1">All</span>
                        <Show when={view().archived === "all"}>
                          <span class="text-text-weak/50">&#10003;</span>
                        </Show>
                      </DropdownMenu.RadioItem>
                      <DropdownMenu.RadioItem value="archived" closeOnSelect={false}>
                        <span class="flex-1">Archived</span>
                        <Show when={view().archived === "archived"}>
                          <span class="text-text-weak/50">&#10003;</span>
                        </Show>
                      </DropdownMenu.RadioItem>
                    </DropdownMenu.RadioGroup>
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            </DropdownMenu.Group>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    )
  }

  const SessionRow = (session: Row) => {
    const status = createMemo(() => sessionStatus(session))
    const directory = () => session.directory ?? session.project.worktree
    const isSessionActive = createMemo(() =>
      !!session.active || (props.activeWorkspaceId === directory() && props.activeSessionId === session.id),
    )
    // Look up an existing meta entry for this session — used both for
    // activation (focus existing) and drag (use the contentId as the
    // workbench drag payload).
    const existingMetaId = () => {
      const meta = claxedoState.meta.find(
        (m) => m.type === "session" && m.directory === directory() && m.sessionId === session.id,
      )
      return meta?.id
    }
    const timeLabel = createMemo(() => {
      clock()
      return session.time ? relativeTime(session.time) : undefined
    })
    const activate = () => {
      const id = existingMetaId()
      if (id) {
        claxedoState.wb.navigation.show(id)
        const meta = claxedoState.meta.get(id)
        if (meta) props.onTabSelect?.(meta)
        return
      }
      props.onSessionSelect?.(directory(), session.id)
    }

    return (
      <div class="group/session">
        <div
          role="button"
          tabIndex={0}
          ref={(el) => el.setAttribute("draggable", "true")}
          class="relative flex items-center gap-2 py-1.5 pl-3 pr-2.5 mx-1 text-left outline-none rounded-md hover:bg-surface-base-hover/40 transition-[background-color,box-shadow,color] duration-100"
          style={activeRowStyle(isSessionActive())}
          onClick={activate}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            activate()
          }}
          onDragStart={(event) => {
            let id = existingMetaId()
            if (!id) {
              id = claxedoState.layout.openSession(
                directory(),
                session.id,
                session.title || "Session",
                { focus: false },
              )
            }
            if (id) event.dataTransfer?.setData(WORKBENCH_DRAG_MIME, id)
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
          }}
        >
          <SidebarStatusDot status={status()} active={isSessionActive()} />

          <span
            class="text-[13px] leading-tight truncate flex-1 min-w-0"
            classList={{
              "text-text-strong font-semibold": isSessionActive(),
              "text-text-weak": !isSessionActive(),
            }}
          >
            {session.title}
          </span>

          <div class="shrink-0 relative flex items-center justify-end self-stretch" style={{ "min-width": "28px" }}>
            <span
              class="text-[11px] tabular-nums group-hover/session:opacity-0 transition-opacity duration-100"
              classList={{
                "text-text-base/70": isSessionActive(),
                "text-text-weaker": !isSessionActive(),
              }}
            >
              {timeLabel()}
            </span>
            <span
              class="absolute inset-0 flex items-center justify-end opacity-0 group-hover/session:opacity-100 transition-opacity duration-100"
              onClick={(e) => {
                e.stopPropagation()
                props.onArchiveSession?.(session)
              }}
            >
              <span class="text-icon-weak-base hover:text-icon-base transition-colors cursor-pointer">
                <Icon name="archive" size="small" />
              </span>
            </span>
          </div>
        </div>
      </div>
    )
  }

  const TerminalRow = (input: {
    item: { paneId: string; terminalId: string; title: string; active: boolean }
    status: SidebarStatus
    onActivate: (item: { paneId: string }) => void
    onClose: (item: { paneId: string; terminalId: string }) => void
  }) => {
    const activate = () => input.onActivate(input.item)

    return (
      <div
        role="button"
        tabIndex={0}
        ref={(el) => el.setAttribute("draggable", "true")}
        class="group/terminal relative flex items-center gap-2 py-1.5 pl-3 pr-2.5 mx-1 text-left outline-none rounded-md hover:bg-surface-base-hover/40 transition-[background-color,box-shadow,color] duration-100"
        style={activeRowStyle(input.item.active)}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          activate()
        }}
        onDragStart={(event) => {
          // Sidebar inventory carries the Workbench contentId; pass it directly.
          event.dataTransfer?.setData(WORKBENCH_DRAG_MIME, input.item.paneId)
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
        }}
      >
        <SidebarStatusDot status={input.status} active={input.item.active} />
        <span
          class="text-[13px] leading-tight truncate flex-1 min-w-0"
          classList={{
            "text-text-strong font-semibold": input.item.active,
            "text-text-weak": !input.item.active,
          }}
        >
          {input.item.title}
        </span>
        <Tooltip placement="top" value="Close terminal">
          <span
            role="button"
            tabIndex={0}
            aria-label={`Close terminal: ${input.item.title}`}
            class="shrink-0 text-icon-base hover:text-icon-strong-base transition-colors cursor-pointer opacity-0 group-hover/terminal:opacity-100 focus:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              input.onClose(input.item)
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return
              e.preventDefault()
              e.stopPropagation()
              input.onClose(input.item)
            }}
          >
            <Icon name="close" size="small" />
          </span>
        </Tooltip>
      </div>
    )
  }

  const GlobalBlock = (section: GlobalSection) => {
    const [open, setOpen] = createSignal(section.rows.length > 0)

    return (
      <div>
        <div
          class="flex items-start gap-2 pl-3 pr-2.5 py-1.5 group/header cursor-pointer hover:bg-surface-base-hover/30 rounded-md transition-colors duration-100"
          onClick={() => setOpen(!open())}
        >
          <div class="flex items-center gap-1.5 min-w-0 flex-1">
            <span class="size-4 shrink-0 flex items-center justify-center relative">
              <Icon
                name="bubble-5"
                size="small"
                class="text-icon-weak-base shrink-0 absolute inset-0 m-auto scale-[0.85] group-hover/header:opacity-0 transition-opacity duration-100"
              />
              <Icon
                name={open() ? "chevron-down" : "chevron-right"}
                size="small"
                class="text-icon-weak-base/60 shrink-0 absolute inset-0 m-auto opacity-0 group-hover/header:opacity-100 transition-opacity duration-100"
              />
            </span>
            <div class="flex flex-col gap-0 min-w-0 flex-1">
              <span class="text-[12px] font-medium text-text-base/80 truncate">{section.label}</span>
            </div>
          </div>
        </div>
        <Show when={open()}>
          <div class="flex flex-col pb-1">
            <For each={section.rows}>
              {(session) => <SessionRow {...session} />}
            </For>
          </div>
        </Show>
        <div class="h-px bg-border-weak-base/15 mx-3 my-0.5" />
      </div>
    )
  }

  const WorkspaceBlock = (section: Section) => {
    const active = createMemo(() => props.activeWorkspaceId === section.workspaceDir)
    const [_open, setOpen] = createSignal(section.rows.length > 0)
    const open = createMemo(() => _open())

    createEffect(() => {
      if (active()) setOpen(true)
    })

    const more = createMemo(() =>
      globalSync.globalSessions.store.workspaceState[section.workspaceDir]?.hasMore ?? false,
    )
    const count = createMemo(() =>
      globalSync.globalSessions.store.byWorkspace[section.workspaceDir]?.total ?? section.rows.length,
    )
    const workspaceInventory = createMemo(() => {
      return buildSidebarInventoryFromState({
        state: claxedoState,
        workspaces: [{
          directory: section.workspaceDir,
          name: section.label,
          sessions: section.rows.map((session) => ({
            sessionId: session.id,
            title: session.title,
          })),
        }],
      })[0]
    })
    const terminalItems = createMemo(() => workspaceInventory()?.terminals ?? [])

    const activateTerminal = (item: { paneId: string }) => {
      const meta = claxedoState.meta.get(item.paneId)
      if (meta) {
        claxedoState.wb.navigation.show(item.paneId)
        props.onTabSelect?.(meta)
        return
      }
    }

    const createTerminal = (command?: string, title?: string) => {
      props.onNewTerminal?.(section.workspaceDir, command, title)
    }

    const closeTerminal = (item: { paneId: string; terminalId?: string }) => {
      const ids = new Set(
        [item.terminalId].filter(
          (id): id is string => typeof id === "string" && id.length > 0 && !id.startsWith("pending-"),
        ),
      )
      const meta = claxedoState.meta.get(item.paneId)
      if (meta) {
        claxedoState.layout.closeContent(item.paneId)
      }
      ids.forEach((id) => {
        void terminal?.close(id)
      })
    }

    return (
      <div>
        <div>
          <div
            data-testid="workspace-header"
            data-workspace-id={section.workspaceDir}
            class="flex items-start gap-2 pl-3 pr-2.5 py-1.5 group/header cursor-pointer hover:bg-surface-base-hover/30 rounded-md transition-[background-color,box-shadow,color] duration-100"
            onClick={() => {
              setOpen(true)
              openWorkspacePanel(section.workspaceDir)
            }}
          >
            <div class="flex flex-col gap-0 min-w-0 flex-1">
              <div class="flex items-center gap-1.5 min-w-0">
                <span
                  class="size-4 shrink-0 flex items-center justify-center relative"
                  role="button"
                  aria-label={open() ? "Collapse workspace" : "Expand workspace"}
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation()
                    setOpen(!_open())
                  }}
                >
                  <Icon
                    name={sectionCloud(section.project, section.workspaceDir) ? "cloud" : "laptop"}
                    size="small"
                    class="text-icon-weak-base shrink-0 absolute inset-0 m-auto scale-[0.85] group-hover/header:opacity-0 transition-opacity duration-100"
                    data-testid="section-kind-icon"
                    data-section-id={section.id}
                  />
                  <Icon
                    name={open() ? "chevron-down" : "chevron-right"}
                    size="small"
                    class="text-icon-weak-base/60 shrink-0 absolute inset-0 m-auto opacity-0 group-hover/header:opacity-100 transition-opacity duration-100"
                  />
                </span>
                <Tooltip placement="top" value={section.workspaceDir}>
	                  <span
	                    class="text-[13px] font-medium truncate"
	                    classList={{
	                      "text-text-strong": active(),
	                      "text-text-base/80": !active(),
	                    }}
	                  >
	                    {section.label}
	                  </span>
                </Tooltip>
              </div>
            </div>
            <div class="flex items-start opacity-0 group-hover/header:opacity-100 transition-opacity duration-150" onClick={(e: MouseEvent) => e.stopPropagation()}>
              <DropdownMenu onOpenChange={(open) => open ? claxedoState.rail.lock() : claxedoState.rail.unlock()}>
                <DropdownMenu.Trigger class="text-icon-base hover:text-text-base transition-colors cursor-pointer flex items-center justify-center border-none bg-transparent">
                  <Icon name="kebab" size="small" class="rotate-90" />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content class="z-[200]">
                    <DropdownMenu.Item
                      onSelect={() => {
                        const item = {
                          ...section.project,
                          expanded: section.project.expanded ?? false,
                        }
                        dialog.show(() => <DialogEditProject project={item} />)
                      }}
                    >
                      <Icon name="pencil-line" size="small" />
                      Edit
                    </DropdownMenu.Item>
                    <Show when={workspace(section.project, section.workspaceDir).canDelete}>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item onSelect={() => props.onDeleteWorkspace?.(workspace(section.project, section.workspaceDir))}>
                        <Icon name="trash" size="small" />
                        Delete workspace
                      </DropdownMenu.Item>
                    </Show>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            </div>
          </div>
        </div>

        <Show when={open()}>
          <div class="flex flex-col pb-1">
            <div class="w-full flex items-center gap-1 pl-3 pr-2.5 pt-1.5 pb-0.5 group/session-label">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-1 text-left"
                onClick={() => openWorkspacePanel(section.workspaceDir)}
                aria-label={`Open sessions panel for ${section.label}`}
              >
                <span class="text-[10px] uppercase tracking-wider text-text-weak font-medium group-hover/session-label:text-text-base transition-colors">
                  Sessions
                </span>
                <Show when={count() > section.rows.length}>
                  <span class="ml-1.5 text-[10px] text-text-weaker tabular-nums">{count()}</span>
                </Show>
                <span class="flex-1" />
                <Icon
                  name="arrow-right"
                  size="small"
                  class="text-icon-base opacity-0 group-hover/session-label:opacity-100 transition-opacity duration-100"
                />
              </button>
              <Tooltip placement="top" value="New session">
                <button
                  type="button"
                  class="flex items-center justify-center size-5 rounded text-icon-base hover:text-text-base hover:bg-surface-base-active transition-colors opacity-0 group-hover/session-label:opacity-100 focus:opacity-100"
                  aria-label={`New session in ${section.label}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onNewSession?.(section.workspaceDir)
                  }}
                >
                  <Icon name="plus-small" size="small" />
                </button>
              </Tooltip>
            </div>
            <For each={section.rows}>
              {(session) => (
                <SessionRow
                  {...session}
                  active={workspaceInventory()?.sessions.some((item) => item.sessionId === session.id && item.active)}
                />
              )}
            </For>
            <Show when={more()}>
              <button
                type="button"
                class="text-[12px] text-text-weaker hover:text-text-weak pl-3 pr-2.5 py-1 text-left transition-colors duration-100"
                onClick={(e: MouseEvent) => {
                  void loadMoreWorkspaceSessions(section.workspaceDir)
                  ;(e.currentTarget as HTMLButtonElement).blur()
                }}
              >
                {language.t("common.loadMore")}
              </button>
            </Show>
            <div class="mt-1" data-testid="terminal-section">
              <div class="w-full flex items-center gap-1 pl-3 pr-2.5 py-0.5 group/terminal-header">
                <span class="text-[10px] uppercase tracking-wider text-text-weak font-medium">
                  Terminals
                </span>
                <span class="text-[10px] text-text-weaker tabular-nums">
                  {terminalItems().length}
                </span>
                <span class="flex-1" />
                <Tooltip placement="top" value="New terminal">
                  <button
                    type="button"
                    class="flex items-center justify-center size-5 rounded text-icon-base hover:text-text-base hover:bg-surface-base-active transition-colors opacity-0 group-hover/terminal-header:opacity-100 focus:opacity-100"
                    aria-label={`New terminal in ${section.label}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      createTerminal()
                    }}
                  >
                    <Icon name="plus-small" size="small" />
                  </button>
                </Tooltip>
                <Tooltip placement="top" value="New Claude terminal">
                  <button
                    type="button"
                    class="flex items-center justify-center size-5 rounded text-[10px] font-semibold text-icon-base hover:text-text-base hover:bg-surface-base-active transition-colors opacity-0 group-hover/terminal-header:opacity-100 focus:opacity-100"
                    aria-label={`New Claude terminal in ${section.label}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      createTerminal(getTerminalCommands().claude, "Claude")
                    }}
                  >
                    C
                  </button>
                </Tooltip>
                <Tooltip placement="top" value="New Codex terminal">
                  <button
                    type="button"
                    class="flex items-center justify-center size-5 rounded text-[10px] font-semibold text-icon-base hover:text-text-base hover:bg-surface-base-active transition-colors opacity-0 group-hover/terminal-header:opacity-100 focus:opacity-100"
                    aria-label={`New Codex terminal in ${section.label}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      createTerminal(getTerminalCommands().codex, "Codex")
                    }}
                  >
                    X
                  </button>
                </Tooltip>
              </div>
              <Show when={terminalItems().length > 0}>
                <For each={terminalItems()}>
                  {(item) => (
                    <TerminalRow
                      item={item}
                      status={terminalStatus(item)}
                      onActivate={activateTerminal}
                      onClose={closeTerminal}
                    />
                  )}
                </For>
              </Show>
            </div>
          </div>
        </Show>

      </div>
    )
  }

  const ProjectBlock = (group: Cluster) => {
    const active = createMemo(() => projectMatches(group.project))
    const [open, setOpen] = createSignal(true)

    createEffect(() => {
      if (active()) setOpen(true)
    })

    return (
      <div>
        <div
          data-testid="project-header"
          data-project-id={group.project.id}
          class="flex items-center gap-1.5 pl-3 pr-2.5 py-1.5 group/project cursor-pointer hover:bg-surface-base-hover/30 rounded-md transition-colors duration-100"
          onClick={() => setOpen(!open())}
        >
          <Tooltip placement="top" value={group.project.worktree}>
            <span
              class="text-[11px] font-semibold uppercase tracking-wider truncate transition-colors duration-100"
              classList={{
                "text-text-strong": active(),
                "text-text-weak group-hover/project:text-text-base": !active(),
              }}
            >
              {group.label}
            </span>
          </Tooltip>
        </div>
        <Show when={open()}>
          <div class="pb-1">
            <For each={group.items}>
              {(section) => <WorkspaceBlock {...section} />}
            </For>
          </div>
        </Show>
        <div class="h-px bg-border-weak-base/15 mx-4 my-2" />
      </div>
    )
  }

  return (
    <nav
      ref={railRef}
      data-sidebar
      data-pinned={claxedoState.rail.pinned() ? "" : undefined}
      class={`h-full flex flex-col bg-background-base overflow-hidden z-[50] pointer-events-auto
        transition-[opacity,transform,width] duration-200 ease-out
        max-md:!w-[280px] max-md:opacity-100 max-md:pointer-events-auto max-md:translate-x-0
        ${claxedoState.rail.pinned() || expanded()
          ? "opacity-100 translate-x-0"
          : "md:opacity-0 md:-translate-x-2 md:pointer-events-none"}
      `}
      style={{
        width: `${width()}px`,
        "border-right": "1px solid var(--border-weaker-base)",
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      aria-label={language.t("sidebar.nav.projectsAndSessions")}
    >
      {/* Header - fixed at top, h-9 matches the workspace toolbar height so borders align */}
      <div
        class={`h-9 flex items-center shrink-0 ${props.workspaceSelector ? "pl-2 pr-1 gap-1" : "px-3 gap-2"}`}
        style={{ "padding-left": props.trafficLightPad ? "78px" : undefined }}
        data-tauri-drag-region
      >
        <Tooltip placement="bottom" value="Pin sidebar">
          <div class="max-md:hidden shrink-0">
            <IconButton
              icon="layout-left-partial"
              variant="ghost"
              class="rounded"
              onClick={() => claxedoState.rail.toggle()}
              aria-label="Pin sidebar"
            />
          </div>
        </Tooltip>
        <Show
          when={props.activeGlobal}
          fallback={
            <Show when={props.projects.find((project) => projectMatches(project)) ?? props.projects[0]}>
              {(project) => {
                const wsName = createMemo(() => {
                  const dir = props.activeWorkspaceId
                  if (!dir) return undefined
                  return workspaceName(dir, project())
                })
                const title = createMemo(() => props.headerTitle ?? wsName() ?? projectLabel(project()))
                const subtitle = createMemo(() => props.headerSubtitle ?? (wsName() ? projectLabel(project()) : undefined))
                let labelRef: HTMLDivElement | undefined
                createEffect(on(() => `${title()}|${subtitle() ?? ""}`, () => {
                  if (!labelRef) return
                  labelRef.classList.remove("claxedo-pop-bounce")
                  void labelRef.offsetWidth
                  labelRef.classList.add("claxedo-pop-bounce")
                }, { defer: true }))
                return (
                  <div ref={labelRef} class="flex-1 min-w-0 flex items-baseline gap-1">
                    <span class="text-[13px] font-medium text-text-base truncate">{title()}</span>
                    <Show when={subtitle()}>
                      <span class="text-[9px] text-text-weaker">·</span>
                      <span class="text-[10px] text-text-weaker truncate">{subtitle()}</span>
                    </Show>
                  </div>
                )
              }}
            </Show>
          }
        >
          <div class="flex-1 min-w-0 flex flex-col justify-center leading-none">
            <span class="text-[12px] font-medium text-text-base truncate">Global</span>
          </div>
        </Show>
        <Show when={props.workspaceSelector}>
          <div class="shrink-0 h-full flex items-center">
            {props.workspaceSelector}
          </div>
        </Show>
      </div>

      {/* Scrollable content area */}
      <div
        class="flex-1 flex flex-col min-h-0 overflow-y-auto overflow-x-hidden rail-sidebar-scroll"
        style={{
          "scrollbar-width": "thin",
          "scrollbar-color": "rgba(128, 128, 128, 0.3) transparent",
        }}
      >
        {/* Projects list */}
        <div class="flex-1 flex flex-col py-1.5 gap-0.5">
          <Show
            when={props.projects.length > 0 || globals().length > 0}
            fallback={
              <div class="flex px-4 py-8 text-[13px] text-text-weak">
                No sessions match the current view.
              </div>
            }
          >
            <For each={globals()}>
              {(section) => <GlobalBlock {...section} />}
            </For>
            <For each={groups()}>
              {(group) => <ProjectBlock {...group} />}
            </For>
          </Show>
        </div>

        {/* Custom content slot */}
        <Show when={props.children}>
          <div>{props.children}</div>
        </Show>
      </div>

      {/* Footer - fixed at bottom */}

      <div class="flex flex-col">
        <div class="flex flex-col gap-1.5 px-2.5 py-2">
          <button
            type="button"
            class="w-full flex items-center justify-center gap-1.5 h-8 rounded-lg text-[13px] font-medium text-text-base bg-surface-base-hover/50 hover:bg-surface-base-hover border border-border-weak-base/40 hover:border-border-weak-base/60 transition-[background-color,border-color,color,scale] duration-150 active:scale-[0.96]"
            onClick={() => props.onNewProject?.()}
          >
            <Icon name="plus-small" size="small" />
            <span>{language.t("workspace.new")}</span>
          </button>
          <Show when={props.workgraphEnabled}>
            <button
              type="button"
              class="w-full flex items-center justify-center gap-1.5 h-8 rounded-lg text-[13px] font-medium text-text-base bg-surface-base-hover/50 hover:bg-surface-base-hover border border-border-weak-base/40 hover:border-border-weak-base/60 transition-[background-color,border-color,color,scale] duration-150 active:scale-[0.96]"
              onClick={() => props.onOpenWorkGraph?.()}
            >
              <Icon name="dot-grid" size="small" />
              <span>{language.t("workspace.workgraph")}</span>
            </button>
          </Show>
        </div>

        <div class="px-2.5 py-2">
          {/* Compact action bar */}
          <div class="flex items-center px-2 py-1.5 border-t border-border-weak-base/15">
            <div class="flex items-center gap-0.5">
              <Tooltip placement="top" value="Diagnostics">
                <div>
                  <IconButton
                    icon="warning"
                    variant="ghost"
                    onClick={openDiagnostics}
                    aria-label="Diagnostics"
                    class="h-7 w-7 rounded-md text-icon-base hover:text-text-base"
                  />
                </div>
              </Tooltip>
              <FilterMenu />
              <Tooltip placement="top" value={language.t("sidebar.settings")}>
                <div>
                  <IconButton
                    icon="settings-gear"
                    variant="ghost"
                    onClick={() => props.onSettings?.()}
                    aria-label={language.t("sidebar.settings")}
                    class="h-7 w-7 rounded-md text-icon-base hover:text-text-base"
                  />
                </div>
              </Tooltip>
              <Tooltip placement="top" value={language.t("sidebar.help")}>
                <div>
                  <IconButton
                    icon="help"
                    variant="ghost"
                    onClick={() => props.onHelp?.()}
                    aria-label={language.t("sidebar.help")}
                    class="h-7 w-7 rounded-md text-icon-base hover:text-text-base"
                  />
                </div>
              </Tooltip>
            </div>
            <div class="flex-1" />
            <StatusPopover
              directory={props.activeWorkspaceId}
              triggerClass="h-7 rounded-md border-none shadow-none px-1.5 text-icon-base hover:text-text-base"
              placement="right-start"
              onOpenChange={(open) => open ? claxedoState.rail.lock() : claxedoState.rail.unlock()}
            >
              {(state: { overallHealthy: boolean; serverHealthy: boolean | undefined }) => (
                <div class="flex items-center gap-1.5">
                  <div
                    classList={{
                      "size-[6px] rounded-full": true,
                      "bg-icon-success-base": state.overallHealthy,
                      "bg-icon-critical-base": !state.overallHealthy && state.serverHealthy !== undefined,
                      "bg-border-weak-base": state.serverHealthy === undefined,
                    }}
                  />
                  <span class="text-[11px]">{language.t("status.popover.trigger")}</span>
                </div>
              )}
            </StatusPopover>
          </div>
        </div>
      </div>
    </nav>
  )
}
