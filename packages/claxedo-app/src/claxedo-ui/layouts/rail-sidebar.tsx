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

import { For, Show, Switch, Match, createMemo, createSignal, onCleanup, onMount, createEffect, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useClaxedoLayout } from "../context/claxedo-layout"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { useGlobalSDK, useLanguage, useGlobalSync, usePlatform, useServer } from "@opencode-ai/claxedo-app"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { StatusPopover } from "../../overrides/components/status-popover"
import { DialogEditProject } from "../components/dialog-edit-project"
import { DialogProcessDiagnostics } from "../components/dialog-process-diagnostics"
import { AddProcessDialog } from "../components/add-process-dialog"
import { getFilename } from "@opencode-ai/util/path"
import { createProcessClient } from "@claxedo/process/client"
import type { Process } from "@claxedo/process/process"
import type { GlobalSessionItem } from "../../overrides/context/global-sync/types"
import { loadProcessView, mergeProcessEvent, processAction, processRows, processTone, showCloud, showEmpty } from "./rail-sidebar.logic"
import { getClaxedoServerUrl } from "../../utils/api"

const VIEW_KEY = "claxedo.session-view.v1"
const GLOBAL_TAG = "global"
const GLOBAL_SHOW_TAG = "global:default"

type Group = "project"
type Archive = "active" | "all" | "archived"
type ProcessMode = "show" | "hide"

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
  onProjectSelect?: (project: ProjectItem) => void
  onWorkspaceSelect?: (project: ProjectItem, workspaceDir: string) => void
  onSessionSelect?: (workspaceDir: string, sessionId: string) => void
  onNewSession?: (workspaceDir: string) => void
  onNewWorkspace?: (project: ProjectItem) => void
  onNewProject?: () => void
  onRemoveProject?: (project: ProjectItem) => void
  onDeleteWorkspace?: (workspace: WorkspaceItem) => void
  onDeleteSession?: (session: SessionItem) => void
  onArchiveSession?: (session: SessionItem) => void
  onSettings?: () => void
  onHelp?: () => void
  onOpenWorkGraph?: () => void
  workgraphEnabled?: boolean
  hasActiveTabs?: boolean
  homedir?: string
  children?: JSX.Element
  trafficLightPad?: boolean
  workspaceSelector?: JSX.Element
}

type View = {
  group: Group
  processes: ProcessMode
  status: string[]
  environment: string[]
  git: string[]
  archived: Archive
}

type Row = SessionItem & {
  project: ProjectItem
  archived?: boolean
  status: string[]
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

function loadView() {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(VIEW_KEY)
    if (!raw) return
    const row = JSON.parse(raw) as Partial<View>
    const archived = row.archived
    return {
      group: "project",
      processes: loadProcessView(row),
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
  const claxedo = useClaxedoLayout()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const server = useServer()
  const dialog = useDialog()
  let railRef: HTMLElement | undefined

  const expanded = createMemo(() => !claxedo.rail.collapsed() || claxedo.rail.pinned())
  const width = createMemo(() => claxedo.rail.width())
  const [clock, setClock] = createSignal(Date.now())

  onMount(() => {
    const timer = setInterval(() => setClock(Date.now()), 10000)
    onCleanup(() => clearInterval(timer))
  })

  const [processLimits, setProcessLimits] = createSignal<Record<string, number>>({})
  const getProcessLimit = (dir: string) => processLimits()[dir] ?? 5
  const [processStore, setProcessStore] = createStore<Record<string, {
    configs: Process.ProcessConfig[]
    processes: Record<string, Process.ManagedProcess>
  }>>({})

  const [view, setView] = createSignal<View>(loadView() ?? {
    group: "project",
    processes: "show",
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
    if (dir === project.worktree) return "main"
    const ws = project.workspaces?.[dir]
    if (ws?.workspace_name) return ws.kind === "cloud" ? `${ws.workspace_name} (cloud)` : ws.workspace_name
    return getFilename(dir)
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
    if (props.activeProjectId === project.id && props.activeWorkspaceId) all.add(props.activeWorkspaceId)
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
    claxedo.rail.trackPosition(e.clientX, e.clientY, { top: rect.top, right: rect.right, bottom: rect.bottom })
  }

  const handleMouseLeave = (e: MouseEvent) => {
    claxedo.rail.handleMouseLeave(e)
  }

  const handleMouseEnter = () => {
    claxedo.rail.cancelCollapse()
  }

  const activeDirectory = createMemo(() => {
    if (props.activeWorkspaceId) return props.activeWorkspaceId
    const activeProject = props.projects.find((project) => project.id === props.activeProjectId)
    return activeProject?.worktree ?? props.projects[0]?.worktree
  })
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

  const processDirs = createMemo(() =>
    [
      ...new Set(
        props.projects.flatMap((project) =>
          dirs(project).filter((dir) => !sectionCloud(project, dir)),
        ),
      ),
    ],
  )

  const reloadProcesses = async (dir: string) => {
    const baseUrl = getClaxedoServerUrl()
    const fetch = platform.fetch ?? globalThis.fetch
    const client = createProcessClient({ baseUrl, directory: dir, fetch })
    try {
      const data = await client.list()
      setProcessStore(dir, {
        configs: data.configs,
        processes: Object.fromEntries(data.processes.map((item) => [item.configId, item])),
      })
    } catch {
      setProcessStore(dir, { configs: [], processes: {} })
    }
  }

  createEffect(() => {
    for (const dir of processDirs()) void reloadProcesses(dir)
  })

  createEffect(() => {
    const unsubs = processDirs().map((dir) =>
      globalSDK.event.on(dir, (event: { type: string; properties?: Record<string, unknown> }) => {
        const props = event.properties
        if (!props) return
        if (event.type === "process.config.changed") {
          const configs = Array.isArray(props.configs) ? props.configs as Process.ProcessConfig[] : []
          const keep = new Set(configs.map((item) => item.id))
          const next = Object.fromEntries(
            Object.entries(processStore[dir]?.processes ?? {}).filter(([id]) => keep.has(id)),
          )
          setProcessStore(dir, { configs, processes: next })
          return
        }

        const configId = typeof props.configId === "string" ? props.configId : undefined
        if (!configId) return
        if (
          event.type !== "process.started" &&
          event.type !== "process.stopped" &&
          event.type !== "process.crashed" &&
          event.type !== "process.status"
        ) return

        const next = mergeProcessEvent(processStore[dir]?.processes?.[configId], {
          type: event.type,
          configId,
          status: typeof props.status === "string" ? props.status as Process.Status : undefined,
          ptyId: typeof props.ptyId === "string" ? props.ptyId : undefined,
          exitCode: typeof props.exitCode === "number" ? props.exitCode : undefined,
          restartCount: typeof props.restartCount === "number" ? props.restartCount : undefined,
        })
        if (next) {
          setProcessStore(dir, "processes", configId, next)
        }
        if (event.type === "process.crashed") {
          void reloadProcesses(dir)
        }
      })
    )
    onCleanup(() => {
      for (const unsub of unsubs) unsub()
    })
  })

  const setArchive = (archived: Archive) => setView((prev) => ({ ...prev, archived }))
  const setProcesses = (processes: ProcessMode) => setView((prev) => ({ ...prev, processes }))
  const toggle = (key: "status" | "environment" | "git", value: string) =>
    setView((prev) => ({
      ...prev,
      [key]: prev[key].includes(value)
        ? prev[key].filter((item) => item !== value)
        : [...prev[key], value],
    }))

  const FilterMenu = () => {
    return (
      <DropdownMenu onOpenChange={(open) => open ? claxedo.rail.lock() : claxedo.rail.unlock()}>
        <Tooltip placement="top" value="Filter & Sort">
          <DropdownMenu.Trigger class="flex items-center justify-center h-7 w-7 rounded-md text-text-weak/40 hover:text-text-base transition-colors cursor-pointer border-none bg-transparent">
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

            <DropdownMenu.Separator />

            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel>Sidebar items</DropdownMenu.GroupLabel>
              <DropdownMenu.CheckboxItem
                checked={view().processes === "show"}
                onChange={() => setProcesses(view().processes === "show" ? "hide" : "show")}
                closeOnSelect={false}
              >
                <span class="flex-1">Show processes</span>
                <Show when={view().processes === "show"}>
                  <span class="text-text-weak/50">&#10003;</span>
                </Show>
              </DropdownMenu.CheckboxItem>
            </DropdownMenu.Group>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    )
  }

  const SessionRow = (session: Row) => {
    const isSessionActive = createMemo(() => props.activeSessionId === session.id)
    const hasNonGeneralStatus = createMemo(() => session.status.some((s) => s !== "general"))
    const timeLabel = createMemo(() => {
      clock()
      return session.time ? relativeTime(session.time) : undefined
    })

    return (
      <div class="group/session">
        <button
          type="button"
          class="w-full flex items-center gap-2 py-1 pl-7 pr-2.5 text-left outline-none rounded-md hover:bg-surface-base-hover/40 transition-colors duration-100"
          onClick={() => {
            props.onSessionSelect?.(session.directory ?? session.project.worktree, session.id)
          }}
        >
          {/* Left: status indicator */}
          <Show when={hasNonGeneralStatus()}>
            <div class="shrink-0 size-1.5 rounded-full bg-text-interactive-base" />
          </Show>

          {/* Title */}
          <span
            class="text-[13px] leading-tight truncate flex-1 min-w-0"
            classList={{
              "text-text-base font-medium": isSessionActive(),
              "text-text-weak": !isSessionActive(),
            }}
          >
            {session.title}
          </span>

          {/* Right: time (default) / archive (hover) */}
          <div class="shrink-0 relative flex items-center justify-end self-stretch" style={{ "min-width": "28px" }}>
            <span class="text-[11px] text-text-weak/50 group-hover/session:opacity-0 transition-opacity duration-100">
              {timeLabel()}
            </span>
            <span
              class="absolute inset-0 flex items-center justify-center opacity-0 group-hover/session:opacity-100 transition-opacity duration-100"
              onClick={(e) => {
                e.stopPropagation()
                props.onArchiveSession?.(session)
              }}
            >
              <span class="p-0.5 rounded-md text-icon-weak-base hover:text-icon-base hover:bg-surface-base-active transition-colors cursor-pointer">
                <Icon name="archive" size="small" />
              </span>
            </span>
          </div>
        </button>
      </div>
    )
  }

  const ProcessRow = (input: {
    item: { id: string; title: string; attention: boolean; status: Process.Status }
    active: boolean
    onActivate: (id: string) => void
    onAction: (id: string) => void
  }) => {
    const action = createMemo(() => processAction(input.item.status))
    const tone = createMemo(() => processTone(input.item.status))
    return (
      <div
        data-status={input.item.status}
        class="w-full flex items-center gap-2 py-1 pl-10 pr-2.5 text-left outline-none hover:bg-surface-base-hover/40 transition-colors duration-100 group/process-row"
      >
        <button
          type="button"
          class="flex items-center gap-2 flex-1 min-w-0 text-left"
          onClick={() => input.onActivate(input.item.id)}
        >
          <div
            class="size-1.5 rounded-full shrink-0"
            data-testid="process-status"
            classList={{
              "bg-icon-success-base": tone() === "good",
              "bg-icon-warning-base": tone() === "warn",
              "bg-icon-critical-base": tone() === "bad",
              "bg-border-weak-base/60": tone() === "idle",
            }}
          />
          <span class="text-[13px] truncate flex-1 min-w-0 text-text-weak">
            {input.item.title || "Process"}
          </span>
          <Show when={input.item.attention}>
            <div class="size-1.5 rounded-full bg-text-interactive-base shrink-0" />
          </Show>
        </button>
        <Tooltip placement="top" value={action().title}>
          <button
            type="button"
            class="flex items-center justify-center size-5 rounded text-text-weak/50 hover:text-text-base hover:bg-surface-base-active transition-colors opacity-0 group-hover/process-row:opacity-100"
            aria-label={`${action().title}: ${input.item.title || "Process"}`}
            onClick={(e) => {
              e.stopPropagation()
              void input.onAction(input.item.id)
            }}
          >
            <Icon
              name={action().icon}
              size="small"
              classList={{
                "text-red-500": input.item.status === "crashed",
              }}
            />
          </button>
        </Tooltip>
      </div>
    )
  }

  const GlobalBlock = (section: GlobalSection) => {
    const [open, setOpen] = createSignal(true)

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
                class="text-icon-weak shrink-0 absolute inset-0 m-auto scale-[0.85] group-hover/header:opacity-0 transition-opacity duration-100"
              />
              <Icon
                name={open() ? "chevron-down" : "chevron-right"}
                size="small"
                class="text-icon-weak/60 shrink-0 absolute inset-0 m-auto opacity-0 group-hover/header:opacity-100 transition-opacity duration-100"
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

  const WorkspaceBlock = (section: Section & { hideHeader?: boolean }) => {
    const active = createMemo(() => props.activeWorkspaceId === section.workspaceDir)
    const [_open, setOpen] = createSignal(true)
    const open = createMemo(() => section.hideHeader || _open())
    const [processOpen, setProcessOpen] = createSignal(false)

    createEffect(() => {
      if (active()) setOpen(true)
    })

    const more = createMemo(() =>
      globalSync.globalSessions.store.workspaceState[section.workspaceDir]?.hasMore ?? false,
    )
    const count = createMemo(() =>
      globalSync.globalSessions.store.byWorkspace[section.workspaceDir]?.total ?? section.rows.length,
    )
    const processes = createMemo(() =>
      view().processes === "hide"
        ? []
        : processRows(processStore[section.workspaceDir]?.configs ?? [], processStore[section.workspaceDir]?.processes ?? {}),
    )
    const visible = createMemo(() => processes().slice(0, getProcessLimit(section.workspaceDir)))
    const moreProcesses = createMemo(() => processes().length > visible().length)
    const state = createMemo(() => {
      const rows = processes()
      const active = rows.some((item) => {
        const proc = processStore[section.workspaceDir]?.processes[item.id]
        const status = proc?.conflict ? "crashed" : proc?.status
        return status === "running" || status === "starting" || status === "restarting" || status === "stopping"
      })
      const crashed = rows.some((item) => {
        const proc = processStore[section.workspaceDir]?.processes[item.id]
        return proc?.status === "crashed" || !!proc?.conflict
      })
      if (crashed) return "crashed" as const
      if (active) return "running" as const
      return "idle" as const
    })
    const auto = createMemo(() =>
      (processStore[section.workspaceDir]?.configs ?? []).filter((cfg) => cfg.autoStart).map((cfg) => cfg.id),
    )
    const processActive = createMemo(() =>
      claxedo
        .split
        .groups()
        .some((group) => {
          const tabs = claxedo.groupTabs(group.id)
          const id = tabs.activeId?.()
          if (!id) return false
          const item = tabs.items().find((tab) => tab.id === id)
          return item?.type === "process" && item.directory === section.workspaceDir
        }),
    )

    createEffect(() => {
      if (processActive()) setProcessOpen(true)
    })

    const loadMoreProcesses = () => {
      setProcessLimits((prev) => ({ ...prev, [section.workspaceDir]: getProcessLimit(section.workspaceDir) + 5 }))
    }

    const revealProcess = (tabId: string, processId: string, tries = 12) => {
      const leaf = claxedo
        .select
        .multiPaneLeafView(tabId)
        .find((item) => item.content?.type === "process" && item.content.processId === processId)
      if (!leaf) {
        if (tries <= 0) return
        setTimeout(() => revealProcess(tabId, processId, tries - 1), 16)
        return
      }
      claxedo.multiPane.focus(tabId, leaf.id)
      const pane = document.querySelector(`[data-pane="${leaf.id}"]`)
      if (pane instanceof HTMLElement && typeof pane.scrollIntoView === "function") {
        pane.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" })
        return
      }
      if (tries <= 0) return
      setTimeout(() => revealProcess(tabId, processId, tries - 1), 16)
    }

    const activateProcess = (id: string) => {
      const existing = claxedo
        .split
        .groups()
        .flatMap((group) => claxedo.groupTabs(group.id).items().map((tab) => ({ group, tab })))
        .find((row) => row.tab.type === "process" && row.tab.directory === section.workspaceDir)
      if (existing) {
        claxedo.processPane.setTargetDirectory?.(section.workspaceDir)
        claxedo.groupTabs(existing.group.id).setActive(existing.tab.id)
        claxedo.split.setFocus(existing.group.id)
        revealProcess(existing.tab.id, id)
        return
      }
      const groupId = claxedo.split.focusedId() ?? claxedo.split.groups()[0]?.id
      if (!groupId) return
      claxedo.processPane.setTargetDirectory?.(section.workspaceDir)
      const tabId = claxedo.groupTabs(groupId).addProcess(section.workspaceDir)
      claxedo.split.setFocus(groupId)
      if (tabId) revealProcess(tabId, id)
    }

    const addProcess = () => {
      dialog.show(() => (
        <AddProcessDialog
          directory={section.workspaceDir}
          onDone={() => void reloadProcesses(section.workspaceDir)}
        />
      ))
    }

    const toggleProcessState = async () => {
      const baseUrl = getClaxedoServerUrl()
      const fetch = platform.fetch ?? globalThis.fetch
      const client = createProcessClient({ baseUrl, directory: section.workspaceDir, fetch })
      if (state() === "running") {
        await Promise.all(
          processes().map((item) => {
            const proc = processStore[section.workspaceDir]?.processes[item.id]
            if (!proc) return Promise.resolve(false)
            if (!["running", "starting", "restarting", "stopping"].includes(proc.status)) return Promise.resolve(false)
            return client.stop(item.id)
          }),
        )
        await reloadProcesses(section.workspaceDir)
        return
      }
      const ids = processes()
        .map((item) => item.id)
        .filter((id) => auto().includes(id))
      await Promise.all(ids.map((id) => client.start(id, { interactive: true })))
      await reloadProcesses(section.workspaceDir)
    }

    const toggleProcess = async (id: string) => {
      const baseUrl = getClaxedoServerUrl()
      const fetch = platform.fetch ?? globalThis.fetch
      const client = createProcessClient({ baseUrl, directory: section.workspaceDir, fetch })
      const proc = processStore[section.workspaceDir]?.processes[id]
      const mode = processAction(proc?.conflict ? "crashed" : proc?.status).mode
      if (mode === "stop") {
        await client.stop(id)
        await reloadProcesses(section.workspaceDir)
        return
      }
      if (mode === "restart") {
        await client.restart(id)
        await reloadProcesses(section.workspaceDir)
        return
      }
      await client.start(id, { interactive: true })
      await reloadProcesses(section.workspaceDir)
    }

    const action = createMemo(() => {
      const canStart = auto().length > 0
      if (state() === "running") {
        return {
          icon: "stop" as const,
          title: "Stop running processes",
          disabled: false,
        }
      }
      return {
        icon: "play" as const,
        title: canStart ? "Start auto-start processes" : "No auto-start processes",
        disabled: !canStart,
      }
    })

    return (
      <div>
        <Show when={!section.hideHeader}>
          <div
            data-testid="workspace-header"
            data-workspace-id={section.workspaceDir}
            class="flex items-start gap-2 pl-3 pr-2.5 py-1.5 group/header cursor-pointer hover:bg-surface-base-hover/30 rounded-md transition-colors duration-100"
            onClick={() => setOpen(!_open())}
          >
            <div class="flex flex-col gap-0 min-w-0 flex-1">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="size-4 shrink-0 flex items-center justify-center relative">
                  <Icon
                    name={sectionCloud(section.project, section.workspaceDir) ? "cloud" : "laptop"}
                    size="small"
                    class="text-icon-weak shrink-0 absolute inset-0 m-auto scale-[0.85] group-hover/header:opacity-0 transition-opacity duration-100"
                    data-testid="section-kind-icon"
                    data-section-id={section.id}
                  />
                  <Icon
                    name={open() ? "chevron-down" : "chevron-right"}
                    size="small"
                    class="text-icon-weak/60 shrink-0 absolute inset-0 m-auto opacity-0 group-hover/header:opacity-100 transition-opacity duration-100"
                  />
                </span>
                <Tooltip placement="top" value={section.workspaceDir}>
                  <span class="text-[12px] font-medium text-text-base/80 truncate">{section.label}</span>
                </Tooltip>
              </div>
            </div>
            <div class="flex items-start opacity-0 group-hover/header:opacity-100 transition-opacity duration-150" onClick={(e: MouseEvent) => e.stopPropagation()}>
              <Tooltip placement="top" value="New Session">
                <button
                  type="button"
                  class="p-0.5 rounded text-text-weak/40 hover:text-text-base hover:bg-surface-base-active transition-colors duration-100 flex items-center justify-center"
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation()
                    props.onNewSession?.(section.workspaceDir)
                  }}
                >
                  <Icon name="plus" size="small" />
                </button>
              </Tooltip>
              <DropdownMenu onOpenChange={(open) => open ? claxedo.rail.lock() : claxedo.rail.unlock()}>
                <DropdownMenu.Trigger class="p-0.5 rounded text-text-weak/40 hover:text-text-base hover:bg-surface-base-active transition-colors cursor-pointer flex items-center justify-center border-none bg-transparent">
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
                    <DropdownMenu.Item onSelect={() => props.onNewSession?.(section.workspaceDir)}>
                      <Icon name="plus" size="small" />
                      New Session
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
        </Show>

        <Show when={open()}>
          <div class="flex flex-col pb-1">
            <Show when={section.rows.length > 0 || more()}>
              <div class="pl-7 pr-2.5 pt-1.5 pb-0.5">
                <span class="text-[10px] uppercase tracking-wider text-text-weak/40 font-medium">Sessions</span>
              </div>
            </Show>
            <For each={section.rows}>
              {(session) => <SessionRow {...session} />}
            </For>
            <Show when={more()}>
              <button
                type="button"
                class="text-[12px] text-text-weak/40 hover:text-text-weak/70 pl-7 pr-2.5 py-1 text-left transition-colors duration-100"
                onClick={(e: MouseEvent) => {
                  void loadMoreWorkspaceSessions(section.workspaceDir)
                  ;(e.currentTarget as HTMLButtonElement).blur()
                }}
              >
                {language.t("common.loadMore")}
              </button>
            </Show>
            <Show when={visible().length > 0}>
              <div class="mt-1" data-testid="process-section">
                <div class="w-full flex items-center gap-1 pl-7 pr-2.5 py-0.5 rounded-md hover:bg-surface-base-hover/30 transition-colors duration-100 group/process" classList={{ "bg-surface-base-hover/30": processActive() }}>
                  <button
                    type="button"
                    class="flex items-center gap-1.5 flex-1 min-w-0 text-left"
                    onClick={() => setProcessOpen(!processOpen())}
                  >
                    <span class="text-[10px] uppercase tracking-wider text-text-weak/40 font-medium">
                      Processes
                    </span>
                    <span class="text-[10px] text-text-weak/30">
                      {processes().length}
                    </span>
                  </button>
                  <Tooltip placement="top" value={action().title}>
                    <button
                      type="button"
                      class="flex items-center justify-center size-5 rounded text-text-weak/50 hover:text-text-base hover:bg-surface-base-active transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-weak/50"
                      onClick={(e) => {
                        e.stopPropagation()
                        void toggleProcessState()
                      }}
                      aria-label={action().title}
                      disabled={action().disabled}
                    >
                      <Icon
                        name={action().icon}
                        size="small"
                        classList={{ "text-red-500": state() === "crashed" }}
                      />
                    </button>
                  </Tooltip>
                  <Tooltip placement="top" value="Add process">
                    <button
                      type="button"
                      class="flex items-center justify-center size-5 rounded text-text-weak/50 hover:text-text-base hover:bg-surface-base-active transition-colors"
                      onClick={(e) => {
                        e.stopPropagation()
                        addProcess()
                      }}
                      aria-label="Add process"
                    >
                      <Icon name="plus-small" size="small" />
                    </button>
                  </Tooltip>
                </div>
                <Show when={processOpen()}>
                  <>
                    <For each={visible()}>
                      {(item) => <ProcessRow item={item} active={false} onActivate={activateProcess} onAction={toggleProcess} />}
                    </For>
                    <Show when={moreProcesses()}>
                      <button
                        type="button"
                        class="text-[12px] text-text-weak/40 hover:text-text-weak/70 px-5 py-1 text-left transition-colors duration-100"
                        onClick={(e: MouseEvent) => {
                          loadMoreProcesses()
                          ;(e.currentTarget as HTMLButtonElement).blur()
                        }}
                      >
                        {language.t("common.loadMore")}
                      </button>
                    </Show>
                  </>
                </Show>
              </div>
            </Show>
            <Show when={showEmpty(section.rows.length, count(), more(), processes().length)}>
              <div class="pl-7 pr-2.5 py-2">
                <div class="text-[12px] text-text-weak/45">
                  No sessions yet.
                </div>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={!section.hideHeader}>
          <div class="h-px bg-border-weak-base/15 mx-3 my-0.5" />
        </Show>
      </div>
    )
  }

  const ProjectBlock = (group: Cluster) => {
    const active = createMemo(() => props.activeProjectId === group.project.id)
    const [open, setOpen] = createSignal(true)
    const singleWorkspace = createMemo(() => group.items.length === 1 ? group.items[0] : undefined)

    createEffect(() => {
      if (active()) setOpen(true)
    })

    return (
      <div>
        <div
          data-testid="project-header"
          data-project-id={group.project.id}
          class="flex items-center gap-2 pl-3 pr-2.5 py-1.5 group/project cursor-pointer hover:bg-surface-base-hover/30 rounded-md transition-colors duration-100"
          onClick={() => setOpen(!open())}
        >
          <div class="flex items-center gap-1.5 min-w-0 flex-1">
            <span class="size-4 shrink-0 flex items-center justify-center relative">
              <Icon
                name="folder"
                size="small"
                class="text-icon-weak shrink-0 absolute inset-0 m-auto scale-[0.85] group-hover/project:opacity-0 transition-opacity duration-100"
              />
              <Icon
                name={open() ? "chevron-down" : "chevron-right"}
                size="small"
                class="text-icon-weak/60 shrink-0 absolute inset-0 m-auto opacity-0 group-hover/project:opacity-100 transition-opacity duration-100"
              />
            </span>
            <Tooltip placement="top" value={singleWorkspace()?.workspaceDir ?? group.project.worktree}>
              <span class="text-[12px] font-medium text-text-base truncate">{group.label}</span>
            </Tooltip>
          </div>
          {/* Workspace label for single-workspace projects */}
          <Show when={singleWorkspace()}>
            {(ws) => (
              <span class="text-[10px] text-text-weak/40 shrink-0">
                {ws().label}
              </span>
            )}
          </Show>
          {/* Action buttons for single-workspace (hover-visible) */}
          <Show when={singleWorkspace()}>
            {(ws) => (
              <div class="flex items-center opacity-0 group-hover/project:opacity-100 transition-opacity duration-150" onClick={(e: MouseEvent) => e.stopPropagation()}>
                <Tooltip placement="top" value="New Session">
                  <button
                    type="button"
                    class="p-0.5 rounded text-text-weak/40 hover:text-text-base hover:bg-surface-base-active transition-colors duration-100 flex items-center justify-center"
                    onClick={(e: MouseEvent) => {
                      e.stopPropagation()
                      props.onNewSession?.(ws().workspaceDir)
                    }}
                  >
                    <Icon name="plus" size="small" />
                  </button>
                </Tooltip>
                <DropdownMenu onOpenChange={(menuOpen) => menuOpen ? claxedo.rail.lock() : claxedo.rail.unlock()}>
                  <DropdownMenu.Trigger class="p-0.5 rounded text-text-weak/40 hover:text-text-base hover:bg-surface-base-active transition-colors cursor-pointer flex items-center justify-center border-none bg-transparent">
                    <Icon name="kebab" size="small" class="rotate-90" />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content class="z-[200]">
                      <DropdownMenu.Item
                        onSelect={() => {
                          const item = {
                            ...group.project,
                            expanded: group.project.expanded ?? false,
                          }
                          dialog.show(() => <DialogEditProject project={item} />)
                        }}
                      >
                        <Icon name="pencil-line" size="small" />
                        Edit
                      </DropdownMenu.Item>
                      <DropdownMenu.Item onSelect={() => props.onNewSession?.(ws().workspaceDir)}>
                        <Icon name="plus" size="small" />
                        New Session
                      </DropdownMenu.Item>
                      <Show when={workspace(group.project, ws().workspaceDir).canDelete}>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item onSelect={() => props.onDeleteWorkspace?.(workspace(group.project, ws().workspaceDir))}>
                          <Icon name="trash" size="small" />
                          Delete workspace
                        </DropdownMenu.Item>
                      </Show>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
              </div>
            )}
          </Show>
        </div>
        <Show when={open()}>
          <div class="pb-1">
            <For each={group.items}>
              {(section) => <WorkspaceBlock {...section} hideHeader={!!singleWorkspace()} />}
            </For>
          </div>
        </Show>
        <div class="h-px bg-border-weak-base/15 mx-3 my-0.5" />
      </div>
    )
  }

  return (
    <nav
      ref={railRef}
      data-sidebar
      data-pinned={claxedo.rail.pinned() ? "" : undefined}
      class={`h-full flex flex-col bg-background-base overflow-hidden z-[50] pointer-events-auto border-r border-border-weak-base/50
        transition-all duration-200 ease-out
        max-md:!w-[280px] max-md:opacity-100 max-md:pointer-events-auto max-md:translate-x-0
        ${claxedo.rail.pinned() || expanded()
          ? "opacity-100 translate-x-0"
          : "md:opacity-0 md:-translate-x-2 md:pointer-events-none"}
      `}
      style={{ width: `${width()}px` }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      aria-label={language.t("sidebar.nav.projectsAndSessions")}
    >
      {/* Header - fixed at top, h-9 matches workspace bar height so borders align */}
      <div
        class={`h-9 flex items-center border-b border-border-weak-base/50 shrink-0 ${props.workspaceSelector ? "pl-2 pr-1 gap-1" : "px-3 gap-2"}`}
        style={{ "padding-left": props.trafficLightPad ? "78px" : undefined }}
      >
        <Tooltip placement="bottom" value="Pin sidebar">
          <div class="max-md:hidden shrink-0">
            <IconButton
              icon="layout-left-partial"
              variant="ghost"
              class="rounded"
              onClick={() => claxedo.rail.toggle()}
              aria-label="Pin sidebar"
            />
          </div>
        </Tooltip>
        <Show
          when={props.activeGlobal}
          fallback={
            <Show when={props.projects.find((p) => p.id === props.activeProjectId) ?? props.projects[0]}>
              {(project) => {
                const wsName = createMemo(() => {
                  const dir = props.activeWorkspaceId
                  if (!dir) return undefined
                  return workspaceName(dir, project())
                })
                const title = createMemo(() => props.headerTitle ?? wsName() ?? projectLabel(project()))
                const subtitle = createMemo(() => props.headerSubtitle ?? (wsName() ? projectLabel(project()) : undefined))
                return (
                  <div class="flex-1 min-w-0 flex items-baseline gap-1">
                    <span class="text-[13px] font-medium text-text-base truncate">{title()}</span>
                    <Show when={subtitle()}>
                      <span class="text-[9px] text-text-weak/50">·</span>
                      <span class="text-[10px] text-text-weak/50 truncate">{subtitle()}</span>
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
            class="w-full flex items-center justify-center gap-1.5 h-8 rounded-lg text-[13px] font-medium text-text-base bg-surface-base-hover/50 hover:bg-surface-base-hover border border-border-weak-base/40 hover:border-border-weak-base/60 transition-all duration-150"
            onClick={() => props.onNewProject?.()}
          >
            <Icon name="plus" size="small" />
            <span>{language.t("workspace.new")}</span>
          </button>
          <Show when={props.workgraphEnabled}>
            <button
              type="button"
              class="w-full flex items-center justify-center gap-1.5 h-8 rounded-lg text-[13px] font-medium text-text-base bg-surface-base-hover/50 hover:bg-surface-base-hover border border-border-weak-base/40 hover:border-border-weak-base/60 transition-all duration-150"
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
                    class="h-7 w-7 rounded-md text-text-weak/40 hover:text-text-base"
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
                    class="h-7 w-7 rounded-md text-text-weak/40 hover:text-text-base"
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
                    class="h-7 w-7 rounded-md text-text-weak/40 hover:text-text-base"
                  />
                </div>
              </Tooltip>
            </div>
            <div class="flex-1" />
            <StatusPopover
              directory={props.activeWorkspaceId}
              triggerClass="h-7 rounded-md border-none shadow-none px-1.5 text-text-weak/40 hover:text-text-base"
              placement="right-start"
              onOpenChange={(open) => open ? claxedo.rail.lock() : claxedo.rail.unlock()}
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
