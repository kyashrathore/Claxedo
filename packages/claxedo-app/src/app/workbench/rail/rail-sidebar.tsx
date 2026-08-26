import {
  SIDEBAR_SESSION_STATUS_FRESH_MS,
  abortSidebarSessionStatusBatches,
  dropSidebarSessionStatusBatches,
  invalidateSidebarSessionStatusGroupsForSession,
  relativeTime,
  sameRequestIds,
  pruneSidebarSessionStatusBatches,
  publishFocusedRailSessionMeta,
  railBatchData,
  sidebarRequestDebug,
  sidebarSessionStatusBatches,
} from "./rail-sidebar-status"
import { markRendererPhase, measureRendererPhase } from "@/platform/performance/renderer-trace"

// RETAINED INSTRUMENTATION — do not delete individual marks. Consumer:
// `perf-harness/src/agent-claxedo-launcher.ts` reads marks WHOLESALE; see the
// full note in `app/entry/app.tsx`.
function perfDiag(name: string, detail?: unknown) {
  try {
    performance.mark(name, detail === undefined ? undefined : { detail })
  } catch {}
}
let railBodyMarked = false
let workspaceBlockMarked = false
let groupsMarked = false
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

import { For, Show, Switch, Match, createMemo, createSelector, createSignal, onCleanup, onMount, createEffect, on, type JSX } from "solid-js"
import { GlobalNavigation } from "./global-navigation"
import { useQuery } from "@tanstack/solid-query"
import { useClaxedoState, type ContentMeta } from "../state/index"
import { NEW_TERMINAL_ID } from "@/features/terminal/core/terminal-surface-id"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/platform/i18n/provider"
import { useServer } from "@/app/connection/server"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { usePermission } from "@/features/session/providers/permission"
import { useOptionalTerminal } from "@/features/terminal/providers/provider"
import { DialogEditProject } from "../../../features/workspaces/ui/dialog-edit-project"
import { RailAccountMenu, RailAccountSubmenu } from "./rail-account-menu"
import { getFilename } from "@/lib/path"
import type { SessionInventoryRow } from "../../../features/session/data/query/types"
import { projectWorkspaceDirectories, workspaceDisplayName, workspaceIsCloud } from "../../../features/workspaces/lib/workspace-display"
import { getTerminalCommands } from "../../../features/settings/ui/terminals"
import {
  activateDisclosureFromKeyboard,
  isRootWorktreeRef,
  railProjectCaptionFromName,
  railProjectLabel,
  sessionProjectSort,
  shouldAutoOpenWorkspaceSection,
  shouldHydrateSidebarRuntime,
  workspaceInventoryGroupFor,
} from "./rail-sidebar.logic"
import { queryClient } from "@/platform/query/query-client"
import {
  emptySessionInventory,
  sessionInventoryQueryOptions,
} from "../../../features/session/data/sync/queries"
import { createSidebarStatusPoll } from "./rail-sidebar-status-poll"
import {
  pruneRailSessionActivityMap,
  railSessionStatusBatchKey,
  railSessionStatusTarget,
  railSessionStatusTargetChain,
} from "./rail-session-status-target"
import { subscribeSessionActivity } from "@/features/session/store/session-status-dispatcher"
import { applyDirectorySessionMeta } from "@/features/session/store/directory-session-meta"
import { localWorkspaceShareTarget, registerUserHostedWorkspace, workspaceShareUrl } from "@/features/workspaces/data/share-workspace"
import { Can, can } from "@/platform/auth/role"
import { isWorkspaceReady, workspacePlacement } from "../../../features/workspaces/data/workspace-connection"
import { getSessionPrefetch, SESSION_PREFETCH_TTL, type SessionPrefetchDirectory } from "@/platform/sync/session-prefetch"
import { centralSessionRef, sessionRefForWorkspaceSession, type SessionRef, type WorkspaceSessionBacking } from "@/platform/identity/session-ref"
import { USER_HOSTED_WORKSPACE_KIND } from "@/platform/runtime/agent/workspace-kind"
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client"
import {
  nextUnseenDone,
  sessionSurfaceActive as sessionRowActive,
  sessionSurfaceStatus,
} from "../compact-switcher/surface-status"
import type { SwitcherStatus } from "../compact-switcher/switcher-items"
import { fastSessionSwitchAnyQuietDelay, markFastSessionSwitch } from "@/platform/runtime/session-switch"
import { useSessionTitleProjection } from "@/features/session/providers/session-title-projection-provider"
import { sessionRoute, workspaceSessionRoute } from "@/platform/identity/route"
import {
  appendSessionListPageQueryData,
  sessionListQueryOptions,
  type SessionListQuery,
  type SessionListResponse,
} from "../../../features/session/data/query/session-list"
import {
  deriveTerminalSurfaceRows,
  reconcileSessionRowsAfterArchive,
  type SessionNavigationRow,
  type TerminalSurfaceRow,
} from "../../../features/session/ui/navigation/session-navigation"
import {
  SessionNavigation,
  type SessionNavigationDisplayRow,
} from "../../../features/session/ui/navigation/session-navigation-list"
import { TerminalSurfaceNavigation } from "../../../features/terminal/ui/navigation/terminal-surface-navigation"
export { parseOwnerRepo } from "./rail-git-remote"
import type { ProjectItem, RuntimeKind, SessionItem, WorkspaceInfo, WorkspaceItem } from "./domain-types"
import { urlRoutingEnabled } from "@/lib/runtime-mode"
import { resolveSessionTitle } from "@/features/session/lib/session-title-sync"
import { createRailSessionMessagePrefetch } from "./rail-session-message-prefetch"
import { createHoverEngagement, railHeaderActionsBox } from "./rail-hover-engagement"
export type { ProjectItem, RuntimeKind, SessionItem, WorkspaceInfo, WorkspaceItem } from "./domain-types"

const VIEW_KEY = "claxedo.session-view.v1"
const GLOBAL_TAG = "global"
const GLOBAL_SHOW_TAG = "global:default"
const SESSION_GROUP_PAGE_SIZE = 5
type SessionListNoticeVariant = "loading" | "error" | "empty" | "done"

export function SessionListNotice(props: {
  variant: SessionListNoticeVariant
  children: JSX.Element
  actionLabel?: string
  onAction?: () => void | Promise<unknown>
}) {
  return (
    <div
      data-testid={`rail-sidebar-session-list-${props.variant}`}
      class="flex items-center gap-2 pl-9 pr-2.5 py-1 text-xs"
      classList={{
        "text-text-weaker": props.variant !== "error",
        "text-text-base": props.variant === "error",
      }}
    >
      <Show when={props.variant === "error"}>
        <Icon name="warning" size="small" class="shrink-0 text-icon-critical-base" />
      </Show>
      <span class="min-w-0 flex-1">{props.children}</span>
      <Show when={props.actionLabel && props.onAction}>
        <button
          type="button"
          class="shrink-0 text-xs text-text-weak hover:text-text-base transition-colors duration-100"
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            void props.onAction?.()
          }}
        >
          {props.actionLabel}
        </button>
      </Show>
    </div>
  )
}

type Group = "project" | "workspace"
type Archive = "active" | "all" | "archived"

function showCloud(input: {
  worktree: string
  workspaces?: Record<string, { kind: RuntimeKind }>
  workspaceDir?: string
  local: boolean
}) {
  const dir = input.workspaceDir ?? input.worktree
  if (dir === input.worktree) return input.workspaces?.[dir]?.kind === "cloud" || !input.local
  const ws = input.workspaces?.[dir]
  if (ws) return ws.kind === "cloud"
  return false
}

// `railRect` is a GETTER: measuring it forces layout and only one branch of the
// policy reads it (app/layout/state.ts). Measured up front, the mousemove
// Chromium delivers with a click forced layout inside the session activation.
type RailTrackPosition = (clientX: number, clientY: number, railRect: () => { top: number; right: number; bottom: number }) => void
export type RailSidebarProps = {
  projects: ProjectItem[]
  activeProjectId?: string
  activeDirectory?: string
  activeSessionId?: string
  activeGlobal?: boolean
  globalChatEnabled?: boolean
  headerTitle?: string
  headerSubtitle?: string
  onWorkspaceSelect?: (project: ProjectItem, workspaceDir: string) => void
  onSessionSelect?: (workspaceDir: string, sessionId: string) => void
  onNewSession?: (workspaceDir: string) => void
  onNewTerminal?: (workspaceDir: string, command?: string, title?: string) => void
  onNewProject?: () => void
  onRemoveProject?: (project: ProjectItem) => void
  onDeleteWorkspace?: (workspace: WorkspaceItem) => void
  onDeleteSession?: (session: SessionItem) => void
  onArchiveSession?: (session: SessionItem) => boolean | Promise<boolean>
  onDiagnostics?: () => void
  onSettings?: () => void
  onUsage?: () => void
  onHelp?: () => void
  onOpenMarketplace?: () => void
  onOpenWorkGraph?: () => void
  onOpenPages?: () => void
  onRailCancelCollapse: () => void
  onRailLockChange: (locked: boolean) => void
  onRailMouseLeave: () => void
  onRailTrackPosition: RailTrackPosition
  onToggleSidebar: () => void
  railDocked: boolean
  railExpanded: boolean
  railWidth: number
  onTabSelect?: (tab: ContentMeta) => void
  hasActiveTabs?: boolean
  homedir?: string
  children?: JSX.Element
  trafficLightPad?: boolean
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

type ProjectSection = {
  id: string
  label: string
  rows: Row[]
  project: ProjectItem
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

const sessionRowTitle = (title?: string, provisionalTitle?: string, updatedAt?: number) =>
  resolveSessionTitle({ inventoryTitle: title, inventoryUpdatedAt: updatedAt, provisionalTitle }) ?? "Untitled session"

function sessionNavigationRefForRow(session: Row) {
  if (session.sessionRef) return session.sessionRef
  const directory = session.directory ?? session.project.worktree
  const workspace = workspaceSessionBacking(session, directory)
  if (workspace) return `workspace:${workspace.workspaceId}:session:${session.id}`
  return `local:${directory}:session:${session.id}`
}

function workspaceSessionBacking(
  session: Pick<Row, "workspaceId" | "environment" | "project">,
  directory: string,
): WorkspaceSessionBacking | undefined {
  const kind = session.environment?.kind
  if (kind !== "cloud" && kind !== "user-hosted") return
  const workspace = projectWorkspaceInfo(session.project, directory)
  const workspaceId = session.workspaceId ?? workspace?.workspaceId ?? workspace?.id
  if (!workspaceId) return
  return {
    workspaceId,
    kind,
  }
}

function projectWorkspaceInfo(project: ProjectItem, directory: string): WorkspaceInfo | undefined {
  return project.workspaces?.[directory] ??
    Object.values(project.workspaces ?? {}).find((workspace) =>
      workspace.directory === directory ||
      workspace.id === directory ||
      workspace.workspaceId === directory
    )
}

function sessionRuntimeDisplayKind(session: Pick<Row, "environment" | "project">, directory: string): RuntimeKind {
  const environmentKind = session.environment?.kind
  if (environmentKind === "cloud" || environmentKind === "user-hosted" || environmentKind === "local") return environmentKind
  const workspaceKind = projectWorkspaceInfo(session.project, directory)?.kind
  if (workspaceKind === "cloud" || workspaceKind === "user-hosted" || workspaceKind === "local") return workspaceKind
  return "local"
}

function workspaceRuntimeKind(project: ProjectItem, directory: string, mainIsCloud?: boolean): RuntimeKind {
  const workspaceKind = projectWorkspaceInfo(project, directory)?.kind
  if (workspaceKind === "cloud" || workspaceKind === "user-hosted" || workspaceKind === "local") return workspaceKind
  if (directory === project.worktree && mainIsCloud) return "cloud"
  return "local"
}

function runtimeIcon(kind: RuntimeKind): "cloud" | "server" | "laptop" {
  if (kind === "cloud") return "cloud"
  if (kind === "user-hosted") return "server"
  return "laptop"
}

function runtimeLabel(kind: RuntimeKind) {
  if (kind === "cloud") return "Cloud VM"
  if (kind === "user-hosted") return "User-hosted"
  return "Local"
}

function workspaceStatusLabel(workspace: WorkspaceInfo | undefined) {
  if (workspace?.available === false) return "offline"
  return workspace?.status
}

function groupFromStorage(input: unknown): Group {
  return input === "workspace" ? "workspace" : "project"
}

function loadView() {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(VIEW_KEY)
    if (!raw) return
    const row = JSON.parse(raw) as Partial<View>
    const archived = row.archived
    return {
      group: groupFromStorage(row.group),
      status: Array.isArray(row.status) ? row.status.filter((item): item is string => typeof item === "string") : [],
      environment: Array.isArray(row.environment) ? row.environment.filter((item): item is string => typeof item === "string") : [],
      git: Array.isArray(row.git) ? row.git.filter((item): item is string => typeof item === "string") : [],
      archived: archived === "all" || archived === "archived" ? archived : "active",
    } satisfies View
  } catch {
    return
  }
}

function defaultView(): View {
  return {
    group: "project",
    status: [],
    environment: [],
    git: [],
    archived: "active",
  }
}

function saveView(input: View) {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(VIEW_KEY, JSON.stringify(input))
}

function uniq(input: string[]) {
  return [...new Set(input)].sort((a, b) => a.localeCompare(b))
}

function title(input: string) {
  if (input === "review" || input === "page" || input === "planner") return input[0].toUpperCase() + input.slice(1)
  if (input === "general") return "General"
  if (input === "local") return "Local"
  if (input === "cloud") return "Cloud"
  if (input === "user-hosted") return "User-hosted"
  return input.replace(/^repo:/, "").replace(/^branch:/, "").replace(/^provider:/, "")
}

function state(input: Pick<SessionItem, "tags" | "attachments"> | Pick<SessionInventoryRow, "tags" | "attachments">) {
  const all = uniq([
    ...(input.tags ?? []).filter((item) => item !== GLOBAL_TAG && item !== GLOBAL_SHOW_TAG),
    ...(input.attachments ?? []).map((item) => item.kind),
  ])
  if (all.length) return all
  return ["general"]
}

function env(input: Pick<SessionItem, "environment"> | Pick<SessionInventoryRow, "environment">) {
  const all = [
    input.environment?.kind,
    input.environment?.driver ? `driver:${input.environment.driver}` : undefined,
  ].filter((item): item is string => !!item)
  return uniq(all)
}

function git(input: Pick<SessionItem, "git"> | Pick<SessionInventoryRow, "git">) {
  const all = [
    input.git?.repo ? `repo:${input.git.repo}` : undefined,
    input.git?.branch ? `branch:${input.git.branch}` : undefined,
  ].filter((item): item is string => !!item)
  return uniq(all)
}

function replaceSessionUrl(session: Row) {
  if (typeof window === "undefined") return
  // Desktop routes with MemoryRouter over a file:// document: writing the route
  // here left the window at `file:///w/<dir>/<session>`, which reloads into a
  // blank error page. See `urlRoutingEnabled`.
  if (!urlRoutingEnabled()) return
  const directory = session.directory ?? session.project.worktree
  const route = sessionNavigationRefForRow(session).startsWith("central:")
    ? sessionRoute(session.id)
    : workspaceSessionRoute(directory, session.id)
  if (window.location.pathname === route) return
  window.history.replaceState(window.history.state, "", route)
}
export function RailSidebar(props: RailSidebarProps) {
  if (!railBodyMarked) {
    railBodyMarked = true
    perfDiag("diag.rail.sidebarBody", { projects: props.projects.length })
  }
  const claxedoState = useClaxedoState()
  const language = useLanguage()
  const sessionTitles = useSessionTitleProjection()
  const projectedSessionTitleSelection = (input: {
    sessionId: string
    directory?: string
    workspaceId?: string
    central?: boolean
  }) => sessionTitles.select({
    sessionId: input.sessionId,
    ...(input.central ? {} : {
      ...(input.directory ? { directory: input.directory } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    }),
  })

  const openWorkspacePanel = (directory: string) => {
    claxedoState.workspacePanel.open("review", {
      workspaceDir: directory,
    })
  }
  const globalSDK = useGlobalSDK()
  const server = useServer()
  const dialog = useDialog()
  const permission = usePermission()
  const terminal = useOptionalTerminal()
  let railRef: HTMLElement | undefined
  const sessionInventoryQuery = useQuery(() =>
    sessionInventoryQueryOptions<SessionInventoryRow>({
      baseUrl: globalSDK.url,
    }),
  )
  const sessionInventory = createMemo(() =>
    sessionInventoryQuery.data ?? emptySessionInventory<SessionInventoryRow>(),
  )

  const expanded = createMemo(() => props.railExpanded)
  const docked = createMemo(() => props.railDocked)
  const width = createMemo(() => props.railWidth)
  const [clock, setClock] = createSignal(Date.now())
  const [sessionStatuses, setSessionStatuses] = createSignal<Record<string, string | undefined>>({})
  const [sessionRequests, setSessionRequests] = createSignal<
    Record<string, { permissions: PermissionRequest[]; questions: QuestionRequest[] } | undefined>
  >({})
  const prefetchSidebarSessionMessages = createRailSessionMessagePrefetch({
    client: globalSDK.client.session,
    claxedoServerUrl: globalSDK.url,
    workspaceReachable: isWorkspaceReady,
  })
  let sessionActivationSerial = 0
  const projectMatches = (project: ProjectItem) =>
    props.activeProjectId === project.id || props.activeProjectId === project.worktree

  const showSessionContent = (contentId: string) => {
    claxedoState.wb.navigation.show(contentId)
  }

  onMount(() => {
    const timer = setInterval(() => setClock(Date.now()), 10000)
    onCleanup(() => {
      clearInterval(timer)
    })
  })

  const [view, setView] = createSignal<View>(loadView() ?? defaultView())

  createEffect(() => {
    saveView(view())
  })

  const sessionFilter = createMemo(() => ({
    archived: view().archived,
    status: view().status,
    environment: view().environment,
    git: view().git,
  }))

  const hasFreshMessagePrefetch = (directory: SessionPrefetchDirectory, sessionID: string) => {
    const info = getSessionPrefetch(directory, sessionID)
    return !!info?.page?.messages.length && Date.now() - info.at < SESSION_PREFETCH_TTL
  }

  const sectionCloud = (project: ProjectItem, workspaceDir?: string) =>
    workspaceDir
      ? workspaceIsCloud(project, workspaceDir, { mainIsCloud: showCloud({
        worktree: project.worktree,
        workspaces: project.workspaces,
        workspaceDir,
        local: server.isLocal(),
      }) })
      : showCloud({
        worktree: project.worktree,
        workspaces: project.workspaces,
        workspaceDir,
        local: server.isLocal(),
      })

  const workspaceName = (dir: string, project: ProjectItem) => {
    return workspaceDisplayName(project, dir, { cloud: sectionCloud(project, dir) })
  }

  const projectLabel = (project: ProjectItem) => railProjectLabel(project)

  const projectCaption = (project: ProjectItem) => railProjectCaptionFromName(project)

  const workspace = (project: ProjectItem, dir: string): WorkspaceItem => {
    const main = dir === project.worktree
    const ws = projectWorkspaceInfo(project, dir)
    const cloud = sectionCloud(project, dir)
    return {
      id: dir,
      workspaceId: cloud ? (ws?.workspaceId ?? ws?.id ?? dir) : undefined,
      workspaceName: ws?.workspace_name ?? undefined,
      directory: ws?.directory ?? dir,
      name: workspaceName(dir, project),
      isMain: main,
      projectWorktree: project.worktree,
      isCloud: cloud,
      canDelete: main ? cloud : true,
      available: ws?.available ?? true,
    }
  }

  const rows = createMemo<Row[]>(() =>
    props.projects.flatMap((project) =>
      (sessionInventory().byProject[project.id] ?? []).map((item) => {
        const projectedTitle = projectedSessionTitleSelection({
          sessionId: item.id,
          directory: item.directory,
          workspaceId: item.workspaceId,
        })
        const title = createMemo(() => sessionRowTitle(item.title, projectedTitle.title(), item.time.updated))
        return {
          id: item.id,
          get title() { return title() },
          time: item.time.updated ?? item.time.created,
          directory: item.directory,
          workspaceId: item.workspaceId,
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
        }
      }),
    ),
  )

  const globalRows = createMemo<Row[]>(() =>
    props.globalChatEnabled
      ? sessionInventory().global.map((item) => {
        const projectedTitle = projectedSessionTitleSelection({ sessionId: item.id, central: true })
        const title = createMemo(() => sessionRowTitle(
            item.title,
            projectedTitle.title(),
            item.time.updated,
          ))
        return {
          id: item.id,
          get title() { return title() },
          time: item.time.updated ?? item.time.created,
          directory: item.directory,
          workspaceId: item.workspaceId,
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
        }
      })
      : [],
  )

  const row = (item: SessionInventoryRow, project: ProjectItem, directory?: string): Row => {
    const projectedTitle = projectedSessionTitleSelection({
      sessionId: item.id,
      directory: directory ?? item.directory,
      workspaceId: item.workspaceId,
    })
    const title = createMemo(() => sessionRowTitle(item.title, projectedTitle.title(), item.time.updated))
    return {
      id: item.id,
      get title() { return title() },
      time: item.time.updated ?? item.time.created,
      directory: directory ?? item.directory,
      workspaceId: item.workspaceId,
      projectID: item.projectID,
      projectName: projectLabel(project),
      workspaceName: item.workspaceName ?? workspaceName(item.workspaceId ?? item.directory, project),
      tags: item.tags,
      attachments: item.attachments,
      environment: item.environment,
      git: item.git,
      archived: item.archived,
      status: state(item),
      project,
    }
  }

  const navigationSessionRow = (
    item: SessionNavigationRow,
    project: ProjectItem,
    directory: string,
  ): Row => {
    const resolvedDirectory = item.directory ?? directory
    const projectedTitle = projectedSessionTitleSelection({
      sessionId: item.sessionId,
      directory: resolvedDirectory,
      workspaceId: item.workspaceId,
      central: item.sessionRef.startsWith("central:"),
    })
    const title = createMemo(() => sessionRowTitle(item.title, projectedTitle.title(), item.updatedAt))
    const attachments = item.attachments.map((attachment) => ({
      kind: attachment.kind,
      targetID: attachment.targetId ?? "",
    }))
    return {
      id: item.sessionId,
      sessionRef: item.sessionRef,
      get title() { return title() },
      time: item.updatedAt ?? item.createdAt,
      directory: resolvedDirectory,
      workspaceId: item.workspaceId,
      projectID: item.projectId,
      projectName: projectLabel(project),
      workspaceName: workspaceName(resolvedDirectory, project),
      tags: item.tags,
      attachments,
      environment: item.environment,
      git: item.git,
      archived: !!item.archivedAt,
      status: state({
        tags: item.tags,
        attachments,
      }),
      project,
    }
  }

  const uniqueRows = (rows: Row[]) => {
    const seen = new Set<string>()
    return rows.filter((session) => {
      const key = sessionNavigationRefForRow(session)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

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
    const all = new Set<string>(projectWorkspaceDirectories(project))
    if (projectMatches(project) && props.activeDirectory) {
      all.add(projectWorkspaceInfo(project, props.activeDirectory)?.directory ?? props.activeDirectory)
    }
    return [...all]
  }

  const globals = createMemo<GlobalSection[]>(() => {
    const rows = globalRows()
      .filter(match)
      .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    if (!props.globalChatEnabled && !rows.length) return []
    return [{
      id: "global",
      label: "Global Chat",
      rows,
    }]
  })

  const projectGroups = createMemo<ProjectSection[]>(() =>
    props.projects.map((project) => ({
      id: project.id,
      label: projectLabel(project),
      rows: (sessionInventory().byProject[project.id] ?? [])
        .map((item) => row(item, project))
        .filter(match)
        .sort(sessionProjectSort),
      project,
    })),
  )

  const groups = createMemo<Cluster[]>(() => {
    const wsStore = sessionInventory().byWorkspace
    if (!groupsMarked && props.projects.length > 0) {
      groupsMarked = true
      perfDiag("diag.rail.groupsFirstNonEmpty", { projects: props.projects.length })
    }
    return props.projects.map((project) => ({
      id: project.id,
      label: projectLabel(project),
      project,
      items: dirs(project).map((dir) => {
        const group = workspaceInventoryGroupFor({
          groups: wsStore,
          workspaceDir: dir,
          workspace: projectWorkspaceInfo(project, dir),
        })
        return {
          id: dir,
          label: workspaceName(dir, project),
          rows: (group?.sessions ?? [])
            .map((item) => row(item, project, group?.directory ?? dir))
            .filter(match)
            .sort((a, b) => (b.time ?? 0) - (a.time ?? 0)),
          project,
          workspaceDir: dir,
        }
      }),
    }))
  })

  const [visibleSessionRowsBySection, setVisibleSessionRowsBySection] = createSignal<Record<string, Row[]>>({})
  const registerVisibleSessionRows = (key: string, rows: Row[]) => {
    setVisibleSessionRowsBySection((current) => {
      if (current[key] === rows) return current
      return { ...current, [key]: rows }
    })
  }
  const clearVisibleSessionRows = (key: string, rows: Row[]) => {
    queueMicrotask(() => {
      setVisibleSessionRowsBySection((current) => {
        if (current[key] !== rows) return current
        const next = { ...current }
        delete next[key]
        return next
      })
    })
  }
  const visibleSessionRows = createMemo(() => Object.values(visibleSessionRowsBySection()).flat())

  const focusedSessionContent = createMemo(() => {
    const id = claxedoState.wb.selectors.focusedContent()
    const content = id ? claxedoState.meta.get(id) : undefined
    return content?.type === "session" ? content : undefined
  })
  const allSessionStatusTargets = createMemo(() =>
    visibleSessionRows().map((session) => {
      const directory = session.directory ?? session.project.worktree
      const key = sessionNavigationRefForRow(session)
      return railSessionStatusTarget({
        key,
        directory,
        sessionID: session.id,
        sessionRef: key,
        workspaceId: session.workspaceId ?? workspaceSessionBacking(session, directory)?.workspaceId,
      })
    }))
  const statusChain = railSessionStatusTargetChain({
    targets: allSessionStatusTargets,
    focusedSessionRef: () => focusedSessionContent()?.content?.sessionRef,
    activeSessionID: () => props.activeSessionId,
    activeDirectory: () => props.activeDirectory,
  })
  // The focused pane's own row: it takes batch priority, and it is the only row
  // whose canonical session entries this rail may publish (see the batch below).
  const focusedSessionStatusTarget = createMemo(statusChain.focused)
  const sessionStatusTargets = createMemo(statusChain.bounded)
  const sessionStatusTargetGroups = createMemo(statusChain.groups)
  const sessionStatusTargetSignature = createMemo(statusChain.signature)
  const sidebarSessionStatusInputs = createMemo(() => {
    const statuses = sessionStatuses()
    const requests = sessionRequests()
    return new Map(sessionStatusTargets().map((target) => [
      target.key,
      {
        directory: target.directory,
        statusType: statuses[target.key],
        requests: requests[target.key],
      },
    ] as const))
  })
  const primeSidebarStatusTargets = (directory: string) => {
    dropSidebarSessionStatusBatches(sessionStatusTargetGroups().filter((group) => group.directory === directory))
    refreshSidebarStatusTargets()
  }
  let sidebarStatusPrimeTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleSidebarStatusPrime = (directory: string) => {
    if (sidebarStatusPrimeTimer) clearTimeout(sidebarStatusPrimeTimer)
    sidebarStatusPrimeTimer = setTimeout(() => {
      sidebarStatusPrimeTimer = undefined
      primeSidebarStatusTargets(directory)
    }, 650)
  }
  onCleanup(() => {
    if (sidebarStatusPrimeTimer) clearTimeout(sidebarStatusPrimeTimer)
  })

  let refreshSidebarStatusTargets: VoidFunction = () => undefined
  let sidebarActivityRefreshQueued = false
  const scheduleSidebarActivityRefresh = () => {
    if (sidebarActivityRefreshQueued) return
    sidebarActivityRefreshQueued = true
    queueMicrotask(() => {
      sidebarActivityRefreshQueued = false
      refreshSidebarStatusTargets()
    })
  }
  let lastSessionStatusTargetSignature = ""
  createEffect(
    on(sessionStatusTargetSignature, (signature) => {
      if (signature === lastSessionStatusTargetSignature) return
      lastSessionStatusTargetSignature = signature
      const groups = sessionStatusTargetGroups()
      const sessionIDs = new Set(groups.flatMap((group) => group.targets.map((target) => target.sessionID)))
      const releases = [...sessionIDs].map((sessionID) => subscribeSessionActivity(sessionID, () => {
        // The event carries only an opaque id, so it cannot identify which of
        // several workspace placements changed. Never copy its id-keyed cache
        // value into placement-local rows; ask each placement authority.
        if (invalidateSidebarSessionStatusGroupsForSession(groups, sessionID) > 0) scheduleSidebarActivityRefresh()
      }))
      sidebarRequestDebug("target-groups", groups.map((group) => ({
        directory: group.directory,
        sessions: group.targets.map((target) => target.sessionID),
      })))
      const run = () => {
        if (fastSessionSwitchAnyQuietDelay() > 0) return
        // Every membership change mints a new batch key and strands the old
        // one; this is the poll that observes those changes, so it is where
        // the inert entries get collected.
        pruneSidebarSessionStatusBatches()
        for (const group of groups) {
          const batchKey = railSessionStatusBatchKey(group)
          const cached = sidebarSessionStatusBatches.get(batchKey)
          const now = Date.now()
          if (cached?.inFlight) {
            sidebarRequestDebug("skip-in-flight", group.directory, group.targets.length)
            continue
          }
          if (now - (cached?.updatedAt ?? 0) < SIDEBAR_SESSION_STATUS_FRESH_MS) {
            sidebarRequestDebug("skip-fresh", group.directory, group.targets.length)
            continue
          }
          const client = globalSDK.createClient({
            directory: group.directory,
            ...(group.workspaceId ? { workspaceId: group.workspaceId } : {}),
          })
          sidebarRequestDebug("fetch-group", group.directory, group.targets.length)
          const controller = new AbortController()
          const request = Promise
            .all([
              client.session.status(undefined, { signal: controller.signal }).then(railBatchData("session status")),
              client.permission.list(undefined, { signal: controller.signal }).then(railBatchData("permissions")),
              client.question.list(undefined, { signal: controller.signal }).then(railBatchData("questions")),
            ])
            .then(([statuses, permissions, questions]) => {
              if (controller.signal.aborted) return
              const nextStatuses: Record<string, string | undefined> = {}
              const nextRequests: Record<string, { permissions: PermissionRequest[]; questions: QuestionRequest[] }> = {}
              for (const target of group.targets) {
                // Absence IS idle: `/session/status` lists only active sessions. `railBatchData` keeps a FAILED read out of that assertion.
                const status = statuses[target.sessionID]
                const requests = {
                  permissions: permissions.filter((item) => item.sessionID === target.sessionID),
                  questions: questions.filter((item) => item.sessionID === target.sessionID),
                }
                nextStatuses[target.key] = status?.type
                nextRequests[target.key] = requests
              }
              setSessionStatuses((current) => {
                const changed = Object.entries(nextStatuses).some(([key, value]) => current[key] !== value)
                if (!changed) return current
                return { ...current, ...nextStatuses }
              })
              setSessionRequests((current) => {
                const changed = group.targets.some((target) => {
                  const previous = current[target.key]
                  const next = nextRequests[target.key]
                  return !sameRequestIds(previous?.permissions, next.permissions) ||
                    !sameRequestIds(previous?.questions, next.questions)
                })
                if (!changed) return current
                return { ...current, ...nextRequests }
              })
              publishFocusedRailSessionMeta({
                focused: focusedSessionStatusTarget(),
                group,
                statuses,
                permissions,
                questions,
                apply: applyDirectorySessionMeta,
              })
              // Recorded AFTER the publish on purpose. Publishing notifies this
              // rail's own activity listener, which deletes this entry and
              // queues a refresh in a microtask; writing the fresh timestamp
              // here means that refresh finds the batch fresh and skips,
              // instead of refetching what was just fetched.
              sidebarSessionStatusBatches.set(batchKey, { updatedAt: Date.now() })
              sidebarRequestDebug("complete-group", group.directory, group.targets.length)
            })
            .catch(() => {})
            .finally(() => {
              const latest = sidebarSessionStatusBatches.get(batchKey)
              if (latest?.inFlight === request) {
                sidebarSessionStatusBatches.set(batchKey, { updatedAt: latest.updatedAt })
              }
            })
          sidebarSessionStatusBatches.set(batchKey, {
            updatedAt: cached?.updatedAt ?? 0,
            inFlight: request,
            controller,
          })
          void request
        }
      }
      // Poll rather than fire once: `run` self-skips when the batch is fresh or
      // in flight, and the server does not push `session.status` for harness
      // sessions — a single shot left the rail showing `idle` for a session the
      // server reported as `busy`. The quiet-window check moves inside the gate
      // so a fast switch skips a tick instead of killing the loop.
      const poll = createSidebarStatusPoll({
        run,
        schedule: (fn, ms) => setTimeout(fn, ms),
        clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        shouldRun: () =>
          fastSessionSwitchAnyQuietDelay() <= 0 &&
          (typeof document === "undefined" || document.visibilityState !== "hidden"),
      })
      refreshSidebarStatusTargets = run
      poll.start()
      onCleanup(() => {
        for (const release of releases) release()
        if (refreshSidebarStatusTargets === run) refreshSidebarStatusTargets = () => undefined
        poll.stop()
      })
    }),
  )

  const sidebarSessionActivity = createMemo(() => {
    const inputs = sidebarSessionStatusInputs()
    return new Map(sessionStatusTargets().map((target) => [
      target.key,
      sessionRowActive({
        statusType: inputs.get(target.key)?.statusType,
        requests: inputs.get(target.key)?.requests,
        directory: inputs.get(target.key)?.directory ?? target.directory,
        autoResponds: (request, directory) => permission.autoResponds(request, directory),
      }),
    ] as const))
  })
  const [sidebarSessionUnseenDone, setSidebarSessionUnseenDone] = createSignal<Record<string, true | undefined>>({})
  let previousSidebarSessionActivity = new Map<string, boolean>()
  createEffect(() => {
    const activity = sidebarSessionActivity()
    const targets = sessionStatusTargets()
    const targetKeys = new Set(targets.map((target) => target.key))
    setSessionStatuses((current) => pruneRailSessionActivityMap(current, targets))
    setSessionRequests((current) => pruneRailSessionActivityMap(current, targets))
    const focusedContent = focusedSessionContent()
    const focusedKeys = new Set(targets.flatMap((target) => {
      if (focusedContent?.sessionId !== target.sessionID) return []
      if (focusedContent.directory && focusedContent.directory !== target.directory) return []
      return [target.key]
    }))

    setSidebarSessionUnseenDone((current) => {
      const next: Record<string, true | undefined> = {}
      let changed = false
      for (const key of Object.keys(current)) {
        if (!targetKeys.has(key)) {
          changed = true
          continue
        }
        next[key] = current[key]
      }
      for (const target of targets) {
        const value = nextUnseenDone({
          active: activity.get(target.key) ?? false,
          previousActive: previousSidebarSessionActivity.get(target.key),
          focused: focusedKeys.has(target.key),
          current: !!next[target.key],
        })
        if (value) next[target.key] = true
        else delete next[target.key]
        if (!!current[target.key] !== value) changed = true
      }
      return changed ? next : current
    })
    previousSidebarSessionActivity = new Map(activity)
  })

  const handleMouseMove = (e: MouseEvent) => {
    const element = railRef
    if (!element) return
    props.onRailTrackPosition(e.clientX, e.clientY, () => element.getBoundingClientRect())
  }

  const handleMouseLeave = () => props.onRailMouseLeave()

  const handleMouseEnter = () => props.onRailCancelCollapse()

  const handleRailMenuOpenChange = (open: boolean) => {
    props.onRailLockChange(open)
  }

  const activeDirectory = createMemo(() => {
    if (props.activeDirectory) return props.activeDirectory
    const activeProject = props.projects.find((project) => projectMatches(project))
    return activeProject?.worktree ?? props.projects[0]?.worktree
  })

  const sessionStatus = (session: Row): SwitcherStatus => {
    const directory = session.directory ?? session.project.worktree
    const key = sessionNavigationRefForRow(session)
    const input = sidebarSessionStatusInputs().get(key)
    return sessionSurfaceStatus({
      statusType: input?.statusType,
      requests: input?.requests,
      directory: input?.directory ?? directory,
      unseenDone: !!sidebarSessionUnseenDone()[key],
      autoResponds: (request, dir) => permission.autoResponds(request, dir),
    })
  }

  const isActiveTerminalContent = createSelector<string | null, string>(
    () => claxedoState.wb.selectors.focusedContent(),
  )
  const terminalSurfaceRows = (input: { directory?: string; directories?: readonly string[] }) => {
    const directories = input.directories ? new Set(input.directories) : undefined
    const metas = claxedoState.meta.idsOfType("terminal").flatMap((id) => {
      const meta = claxedoState.meta.get(id)
      if (!meta) return []
      if (input.directory) return meta.directory === input.directory
        ? [meta]
        : []
      if (directories) return meta.directory && directories.has(meta.directory) ? [meta] : []
      return [meta]
    })
    const terminalIds = metas.flatMap((meta) => meta.type === "terminal" && meta.terminalId ? [meta.terminalId] : [])
    return deriveTerminalSurfaceRows({
      metas,
      ...(input.directory ? { directory: input.directory } : {}),
      isActive: isActiveTerminalContent,
      agentStatus: Object.fromEntries(terminalIds.map((id) => [id, claxedoState.terminal.agentStatus(id)])),
      agentSeen: Object.fromEntries(terminalIds.map((id) => [id, claxedoState.terminal.seen(id) ? true : undefined])),
      lifecycle: Object.fromEntries(terminalIds.map((id) => [id, claxedoState.terminal.lifecycle(id)])),
    })
  }

  // Both "is this row the active one?" sources are broadcast signals (the
  // focused workbench surface, the route's active session). `createSelector`
  // gives each row a per-key subscription, so a session switch re-runs the
  // bindings of the TWO affected rows instead of every row in every section.
  const workbenchActiveSessionKey = createMemo(() => {
    const focusedId = claxedoState.wb.selectors.focusedContent()
    const focused = focusedId ? claxedoState.meta.get(focusedId) : undefined
    if (!focused || (focused.type !== "session" && focused.type !== "context")) return undefined
    return `${focused.directory}\0${focused.sessionId}`
  })
  const isWorkbenchActiveSession = createSelector<string | undefined, string>(workbenchActiveSessionKey)
  const sessionActiveInWorkbench = (session: Row, directory: string) =>
    isWorkbenchActiveSession(`${directory}\0${session.id}`)
  const isRouteActiveSession = createSelector<string | undefined, string>(
    () => (props.activeSessionId ? `${props.activeDirectory}\0${props.activeSessionId}` : undefined),
  )

  const sessionDirectory = (session: Row) => session.directory ?? session.project.worktree
  const sessionWorkbenchRef = (session: Row) => {
    const directory = sessionDirectory(session)
    if (sessionNavigationRefForRow(session).startsWith("central:")) {
      return centralSessionRef({ sessionId: session.id, workspaceId: session.workspaceId })
    }
    return sessionRefForWorkspaceSession({
      sessionId: session.id,
      directory,
      workspace: workspaceSessionBacking(session, directory),
    })
  }
  const sessionSourceRow = (session: Row): SessionNavigationRow => {
    const directory = sessionDirectory(session)
    const time = session.time ?? 0
    return {
      type: "session",
      sessionRef: sessionNavigationRefForRow(session),
      sessionId: session.id,
      get title() {
        return sessionRowTitle(session.title)
      },
      directory,
      ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
      ...(session.projectID ? { projectId: session.projectID } : {}),
      createdAt: time,
      updatedAt: time,
      ...(session.archived ? { archivedAt: time } : {}),
      tags: session.tags ?? [],
      attachments: (session.attachments ?? []).map((attachment) => ({
        kind: attachment.kind,
        ...(attachment.targetID ? { targetId: attachment.targetID } : {}),
      })),
      ...(session.environment ? { environment: session.environment } : {}),
      ...(session.git ? { git: session.git } : {}),
    }
  }
  const sessionMetadata = (session: Row, showMetadata?: boolean): SessionNavigationDisplayRow["metadata"] => {
    if (!showMetadata) return
    const directory = sessionDirectory(session)
    const kind = sessionRuntimeDisplayKind(session, directory)
    const workspace = projectWorkspaceInfo(session.project, directory)
    const worktreeDir = workspace?.directory ?? directory
    const rootWorktree = isRootWorktreeRef({
      dir: directory,
      projectWorktree: session.project.worktree,
      workspace,
    })
    const workspaceLabel = session.workspaceName ?? workspace?.workspace_name ?? workspaceName(directory, session.project)
    const showWorkspace = !!workspaceLabel && (
      workspaceLabel !== "main" ||
      directory !== session.project.worktree ||
      kind !== "local"
    )
    const label = [
      kind === "local" ? undefined : runtimeLabel(kind),
      showWorkspace ? workspaceLabel : undefined,
    ].filter((item): item is string => !!item).join(" · ")
    if (kind === "cloud" || kind === "user-hosted") {
      return {
        icon: runtimeIcon(kind),
        label: label || runtimeLabel(kind),
      }
    }
    if (!showWorkspace || rootWorktree) return
    const worktreeName = workspace?.workspace_name ?? (workspaceLabel === directory ? getFilename(worktreeDir) : workspaceLabel)
    return {
      icon: "worktree",
      label: [
        `Worktree: ${session.projectName || projectLabel(session.project)} / ${worktreeName}`,
        worktreeDir && worktreeDir !== worktreeName ? worktreeDir : undefined,
      ].filter((item): item is string => !!item).join(" · "),
    }
  }
  const sessionDisplayRow = (session: Row, input?: {
    nested?: boolean
    showMetadata?: boolean
    /** Lazy for the same reason as `timeLabel` below — see `get active()`. */
    active?: () => boolean
  }): SessionNavigationDisplayRow => {
    const metadata = sessionMetadata(session, input?.showMetadata)
    const time = session.time
    const inputActive = input?.active
    return {
      source: sessionSourceRow(session),
      get title() {
        return sessionRowTitle(session.title)
      },
      directory: sessionDirectory(session),
      // `active` is read HERE, lazily, for the same reason as `timeLabel`:
      // the activation sources (route active session, focused workbench
      // surface) change on EVERY session switch, and reading them while
      // BUILDING the row invalidated the whole rows array — every row object
      // in every section was rebuilt so that TWO rows could change. As an
      // accessor over `createSelector` keys, a switch re-runs only the
      // active-reading bindings of the outgoing and incoming rows.
      // Must stay an accessor: spreading this object would evaluate it
      // eagerly and restore the whole-list invalidation.
      get active() {
        return (inputActive ? inputActive() : false) ||
          !!session.active ||
          isRouteActiveSession(`${sessionDirectory(session)}\0${session.id}`)
      },
      ...(input?.nested ? { nested: true } : {}),
      status: sessionStatus(session),
      // `clock()` is read HERE, lazily, instead of at the top of this builder.
      // The rail's 10 s clock exists only to refresh this one label, but reading
      // it while BUILDING the row made every tick invalidate all six derived
      // fields for every session — and for anything older than a day the label
      // does not even change. As an accessor the subscription belongs to
      // whichever binding renders the label, so a tick re-runs that binding
      // alone and leaves the row object itself referentially stable.
      // Must stay an accessor: spreading this object would evaluate it eagerly
      // and restore the old whole-row invalidation.
      get timeLabel() {
        if (!time) return undefined
        clock()
        return relativeTime(time)
      },
      ...(metadata ? { metadata } : {}),
    }
  }
  const rowForNavigation = (rows: readonly Row[], item: SessionNavigationDisplayRow) =>
    rows.find((session) => session.id === item.source.sessionId && sessionNavigationRefForRow(session) === item.source.sessionRef)
  const existingSessionContentId = (session: Row) => {
    const directory = sessionDirectory(session)
    const meta = claxedoState.meta.find(
      (item) => item.type === "session" && item.directory === directory && item.sessionId === session.id,
    )
    return meta?.id
  }
  const paneIdForContent = (contentId: string | undefined) =>
    contentId ? claxedoState.wb.state.panes.find((pane) => pane.contentId === contentId)?.id : undefined
  const currentWorkspacePanelSessionId = () => focusedSessionContent()?.sessionId ?? props.activeSessionId
  const restoreWorkspacePanelSession = (session: Row, contentId: string | undefined, directory: string) => {
    claxedoState.workspacePanel.restoreSession(session.id, {
      workspaceDir: directory,
      targetPaneId: paneIdForContent(contentId) ?? claxedoState.wb.state.focusedPaneId ?? undefined,
    })
  }
  const afterVisibleActivation = (task: () => void) => setTimeout(task, fastSessionSwitchAnyQuietDelay({ baseDelay: 80 }) + 100)
  const activateSession = (session: Row) => {
    const measure = measureRendererPhase
    const directory = sessionDirectory(session)
    abortSidebarSessionStatusBatches()
    // A click-owned read has no reason to survive a different activation. Do
    // this before either the mounted or cold navigation branch so stale JSON
    // cannot parse in the next session's foreground task.
    prefetchSidebarSessionMessages.supersede(directory, session.id)
    // `activateSession` owns navigation; this notification only closes the
    // mobile drawer and must not open the session again.
    measure("sessionActivate.onSessionSelect", () => props.onSessionSelect?.(sessionDirectory(session), session.id))
    const existingId = measure("sessionActivate.findContent", () => existingSessionContentId(session))
    if (existingId) {
      const serial = ++sessionActivationSerial
      measure("sessionActivate.markFastSwitch", () => markFastSessionSwitch(session.id, Date.now(), {
        networkQuiet: hasFreshMessagePrefetch(directory, session.id),
      }))
      // Keep selection in the trusted action; a timer adds a task boundary
      // where unrelated work can delay the first useful frame.
      const previousWorkspacePanelSessionId = currentWorkspacePanelSessionId()
      measure("sessionActivate.showContent", () => showSessionContent(existingId))
      measure("sessionActivate.replaceUrl", () => replaceSessionUrl(session))
      afterVisibleActivation(() => {
        if (serial !== sessionActivationSerial) return
        claxedoState.workspacePanel.rememberSession(previousWorkspacePanelSessionId)
        scheduleSidebarStatusPrime(directory)
        restoreWorkspacePanelSession(session, existingId, directory)
        const meta = claxedoState.meta.get(existingId)
        if (meta) props.onTabSelect?.(meta)
      })
      return
    }
    const previousWorkspacePanelSessionId = measure("sessionActivate.currentWorkspacePanel", currentWorkspacePanelSessionId)
    const backing = workspaceSessionBacking(session, directory)
    markFastSessionSwitch(session.id, Date.now(), { networkQuiet: false })
    const firstFoldReadyOrLoading = measure("sessionActivate.prefetch", () => prefetchSidebarSessionMessages.start(directory, session.id, { bypassQuiet: true, sessionRef: sessionWorkbenchRef(session), ...(backing ? { workspaceKind: backing.kind, workspaceId: backing.workspaceId } : {}) }))
    const serial = ++sessionActivationSerial
    measure("sessionActivate.markFastSwitch", () => markFastSessionSwitch(session.id, Date.now(), {
      networkQuiet: firstFoldReadyOrLoading,
    }))
    const contentId = measure("sessionActivate.openSession", () => claxedoState.layout.openSession(directory, session.id, sessionRowTitle(session.title), {
      sessionRef: sessionWorkbenchRef(session),
    }))
    measure("sessionActivate.replaceUrl", () => replaceSessionUrl(session))
    measure("sessionActivate.afterVisible", () => afterVisibleActivation(() => {
      if (serial !== sessionActivationSerial) return
      claxedoState.workspacePanel.rememberSession(previousWorkspacePanelSessionId)
      scheduleSidebarStatusPrime(directory)
      restoreWorkspacePanelSession(session, contentId, directory)
      const meta = claxedoState.meta.get(contentId)
      if (meta) props.onTabSelect?.(meta)
    }))
  }
  const prepareSessionDrag = (session: Row) => {
    const sessionRef = () => sessionWorkbenchRef(session)
    return existingSessionContentId(session) ?? claxedoState.layout.openSession(
      sessionDirectory(session),
      session.id,
      sessionRowTitle(session.title),
      { focus: false, sessionRef: sessionRef() },
    )
  }
  const activateSessionFromRows = (rows: readonly Row[], item: SessionNavigationDisplayRow) => {
    const session = rowForNavigation(rows, item)
    if (session) activateSession(session)
  }
  const prepareSessionActivationFromRows = (rows: readonly Row[], item: SessionNavigationDisplayRow) => {
    markRendererPhase("sessionActivate.pointerPrepare.start")
    const session = rowForNavigation(rows, item)
    if (!session) {
      markRendererPhase("sessionActivate.pointerPrepare.skip")
      return
    }
    abortSidebarSessionStatusBatches()
    if (existingSessionContentId(session)) {
      markRendererPhase("sessionActivate.pointerPrepare.skip")
      return
    }
    const directory = sessionDirectory(session)
    const backing = workspaceSessionBacking(session, directory)
    prefetchSidebarSessionMessages.start(directory, session.id, {
      bypassQuiet: true,
      sessionRef: sessionWorkbenchRef(session),
      ...(backing ? { workspaceKind: backing.kind, workspaceId: backing.workspaceId } : {}),
    })
    markRendererPhase("sessionActivate.pointerPrepare.end")
  }
  const archiveSessionFromRows = async (
    rows: readonly Row[],
    item: SessionNavigationDisplayRow,
    reconcile?: (item: SessionNavigationDisplayRow) => void,
  ) => {
    const session = rowForNavigation(rows, item)
    if (!session) return
    const archived = await props.onArchiveSession?.(session)
    if (archived !== true) return
    reconcile?.(item)
  }
  const prepareSessionDragFromRows = (rows: readonly Row[], item: SessionNavigationDisplayRow) => {
    const session = rowForNavigation(rows, item)
    return session ? prepareSessionDrag(session) : undefined
  }
  const activateTerminal = (item: { contentId: string }) => {
    const meta = claxedoState.meta.get(item.contentId)
    if (meta) {
      claxedoState.wb.navigation.show(item.contentId)
      props.onTabSelect?.(meta)
      return
    }
  }

  const closeTerminal = (item: { contentId: string; terminalId?: string }) => {
    const ids = new Set(
      [item.terminalId].filter(
        (id): id is string => typeof id === "string" && id.length > 0 && !id.startsWith("pending-"),
      ),
    )
    const meta = claxedoState.meta.get(item.contentId)
    if (meta) {
      claxedoState.layout.closeContent(item.contentId)
    }
    ids.forEach((id) => {
      void terminal?.close(id)
    })
  }

  onMount(() => {
    document.addEventListener("mousemove", handleMouseMove)
    onCleanup(() => {
      document.removeEventListener("mousemove", handleMouseMove)
    })
  })

  const setArchive = (archived: Archive) => setView((prev) => ({ ...prev, archived }))
  const setGroup = (group: Group) => setView((prev) => ({ ...prev, group }))
  const toggle = (key: "status" | "environment" | "git", value: string) =>
    setView((prev) => ({
      ...prev,
      [key]: prev[key].includes(value)
        ? prev[key].filter((item) => item !== value)
        : [...prev[key], value],
    }))

  const FilterMenu = () => {
    return (
      <RailAccountSubmenu icon="sliders" label="View options" contentStyle={{ "z-index": 220, "min-width": "200px" }}>
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel>Group by</DropdownMenu.GroupLabel>
              <DropdownMenu.RadioGroup value={view().group} onChange={(value) => setGroup(groupFromStorage(value))}>
                <DropdownMenu.RadioItem value="project" closeOnSelect={false}>
                  <span class="flex-1">Project</span>
                  <Show when={view().group === "project"}>
                    <span class="text-text-weak/50">&#10003;</span>
                  </Show>
                </DropdownMenu.RadioItem>
                <DropdownMenu.RadioItem value="workspace" closeOnSelect={false}>
                  <span class="flex-1">Workspace</span>
                  <Show when={view().group === "workspace"}>
                    <span class="text-text-weak/50">&#10003;</span>
                  </Show>
                </DropdownMenu.RadioItem>
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Group>

            <DropdownMenu.Separator />

            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel>Show</DropdownMenu.GroupLabel>

              <Show when={statusOptions().length > 0}>
                <DropdownMenu.Group>
                  <DropdownMenu.GroupLabel>Status</DropdownMenu.GroupLabel>
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
                </DropdownMenu.Group>
              </Show>

              <Show when={environmentOptions().length > 0}>
                <DropdownMenu.Group>
                  <DropdownMenu.GroupLabel>Environment</DropdownMenu.GroupLabel>
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
                </DropdownMenu.Group>
              </Show>

              <Show when={gitOptions().length > 0}>
                <DropdownMenu.Group>
                  <DropdownMenu.GroupLabel>Git</DropdownMenu.GroupLabel>
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
                </DropdownMenu.Group>
              </Show>

              <DropdownMenu.Group>
                <DropdownMenu.GroupLabel>Archived</DropdownMenu.GroupLabel>
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
              </DropdownMenu.Group>
            </DropdownMenu.Group>
      </RailAccountSubmenu>
    )
  }

  const HeaderActions = (input: {
    project: ProjectItem
    workspaceDir: string
    label: string
    /**
     * Whether the header this cluster belongs to is currently the pointer's or
     * the keyboard's target. The cluster is invisible otherwise, so it is not
     * mounted otherwise either — see `createHoverEngagement`.
     */
    engaged: () => boolean
    /**
     * Which header this row is. A `workspace` header names exactly one
     * directory, so its buttons can spawn straight into it. A `project` header
     * spans every worktree in the project and only has `projectActionDirectory()`
     * — a fallback guess (`activeDirectory ?? directories()[0] ?? worktree`) the
     * user never made and cannot see. So the project header offers no
     * spawn-in-place shortcuts at all; its one terminal button opens the creator,
     * which asks where before starting anything.
     */
    scope: "project" | "workspace"
  }) => {
    const [sharing, setSharing] = createSignal(false)
    const createTerminal = (command?: string, title?: string) => {
      props.onNewTerminal?.(input.workspaceDir, command, title)
    }
    // Opened directly rather than through `onNewTerminal`: the creator is a
    // surface, not a pty, so it needs none of that action's pty plumbing.
    const openTerminalCreator = () => {
      claxedoState.layout.openTerminal(input.workspaceDir, NEW_TERMINAL_ID, "New Terminal")
    }
    const mainWorkspace = () => input.workspaceDir === input.project.worktree
    const shareTarget = createMemo(() => localWorkspaceShareTarget({
      project: input.project,
      directory: input.workspaceDir,
    }))
    const canMutateWorkspace = () => !workspace(input.project, input.workspaceDir).workspaceId || can("mutate.workspace", workspacePlacement(workspace(input.project, input.workspaceDir).workspaceId))
    const copyShareUrl = async (url: string) => {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
      if (!clipboard?.writeText) return false
      return await clipboard.writeText(url).then(
        () => true,
        () => false,
      )
    }
    const shareWorkspace = async () => {
      const target = shareTarget()
      if (!target || sharing()) return
      setSharing(true)
      try {
        await registerUserHostedWorkspace({
          workspaceId: target.workspaceId,
          displayName: input.label,
        })
        const url = workspaceShareUrl({ workspaceId: target.workspaceId })
        const copied = await copyShareUrl(url)
        showToast({
          variant: "success",
          title: "Workspace shared",
          description: copied ? "Workspace link copied to clipboard." : url,
        })
      } catch (err) {
        showToast({
          variant: "error",
          title: "Failed to share workspace",
          description: err instanceof Error ? err.message : String(err),
        })
      } finally {
        setSharing(false)
      }
    }

    // The cluster's buttons are `size-6` in a `gap-0.5` row: two of them on a
    // project header (new session, new terminal) plus the menu, and two more
    // agent shortcuts on a workspace header.
    const actionCount = () => (input.scope === "workspace" ? 5 : 3)
    // Holds the cluster mounted while its own menu is open: the menu content is
    // portaled out of this header, so the pointer travelling to it fires
    // `pointerleave` here and the trigger would otherwise be unmounted from
    // under the open menu.
    const [menuOpen, setMenuOpen] = createSignal(false)

    return (
      <div
        data-icon-interaction="row-actions"
        class="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/header:opacity-100 focus-within:opacity-100 transition-opacity duration-150"
        // The idle cluster still reserves exactly the box its buttons occupy,
        // so neither the truncated title beside it nor the header's own height
        // changes when they mount.
        style={railHeaderActionsBox(actionCount())}
        onClick={(e: MouseEvent) => e.stopPropagation()}
      >
        <Show when={input.engaged() || menuOpen()}>
          <Tooltip placement="top" value="New session">
            <button
              type="button"
              class="flex items-center justify-center size-6 rounded text-icon-base hover:text-text-base hover:bg-surface-base-active transition-colors"
              aria-label={`New session in ${input.label}`}
              onClick={(e) => {
                e.stopPropagation()
                props.onNewSession?.(input.workspaceDir)
              }}
            >
              <Icon name="plus-small" size="small" />
            </button>
          </Tooltip>
          <Tooltip placement="top" value={input.scope === "project" ? "New terminal…" : "New terminal"}>
            <button
              type="button"
              class="flex items-center justify-center size-6 rounded text-icon-base hover:text-text-base hover:bg-surface-base-active transition-colors"
              aria-label={
                input.scope === "project"
                  ? `New terminal in ${input.label}…`
                  : `New terminal in ${input.label}`
              }
              data-testid="rail-new-terminal"
              data-scope={input.scope}
              onClick={(e) => {
                e.stopPropagation()
                if (input.scope === "project") {
                  openTerminalCreator()
                  return
                }
                createTerminal()
              }}
            >
              <Icon name="terminal" size="small" />
            </button>
          </Tooltip>
          {/* Agent shortcuts are workspace-header only. On a project header they
              would spawn an agent into the guessed directory, which is the exact
              failure the creator exists to prevent — there, the creator lists the
              same agents once a workspace has actually been chosen. */}
          <Show when={input.scope === "workspace"}>
            <Tooltip placement="top" value="New Claude terminal">
              <button
                type="button"
                class="flex items-center justify-center size-6 rounded-sm text-icon-base hover:text-text-base hover:bg-surface-base-active transition-colors"
                aria-label={`New Claude terminal in ${input.label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  createTerminal(getTerminalCommands().claude, "Claude")
                }}
              >
                <Icon name="claude" size="small" />
              </button>
            </Tooltip>
            <Tooltip placement="top" value="New Codex terminal">
              <button
                type="button"
                class="flex items-center justify-center size-6 rounded-sm text-icon-base hover:text-text-base hover:bg-surface-base-active transition-colors"
                aria-label={`New Codex terminal in ${input.label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  createTerminal(getTerminalCommands().codex, "Codex")
                }}
              >
                <Icon name="openai" size="small" />
              </button>
            </Tooltip>
          </Show>
          <DropdownMenu
            onOpenChange={(open) => {
              setMenuOpen(open)
              handleRailMenuOpenChange(open)
            }}
          >
            <DropdownMenu.Trigger
              aria-label={`More options for ${input.label}`}
              class="flex items-center justify-center size-6 rounded text-icon-base hover:text-text-base hover:bg-surface-base-active transition-colors cursor-pointer border-none bg-transparent"
            >
              <Icon name="kebab" size="small" class="rotate-90" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="z-[200]">
                <DropdownMenu.Item
                  onSelect={() => {
                    const item = {
                      ...input.project,
                      expanded: input.project.expanded ?? false,
                    }
                    dialog.show(() => <DialogEditProject project={item} />)
                  }}
                >
                  <Icon name="pencil-line" size="small" />
                  Edit
                </DropdownMenu.Item>
                <Can do="share.workspace">
                  <DropdownMenu.Item
                    disabled={!shareTarget() || sharing()}
                    onSelect={() => void shareWorkspace()}
                  >
                    <Icon name="share" size="small" />
                    {sharing() ? "Sharing..." : "Share workspace"}
                  </DropdownMenu.Item>
                </Can>
                <Show when={workspace(input.project, input.workspaceDir).canDelete && canMutateWorkspace()}>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item onSelect={() => props.onDeleteWorkspace?.(workspace(input.project, input.workspaceDir))}>
                    <Icon name="trash" size="small" />
                    Delete workspace
                  </DropdownMenu.Item>
                </Show>
                <Show when={mainWorkspace()}>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item onSelect={() => props.onRemoveProject?.(input.project)}>
                    <Icon name="trash" size="small" />
                    Remove project
                  </DropdownMenu.Item>
                </Show>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </Show>
      </div>
    )
  }

  const GlobalBlock = (section: GlobalSection) => {
    const [open, setOpen] = createSignal(true)
    const globalSessionListQuery = createMemo<SessionListQuery>(() => ({
      scope: "global",
      groupBy: "none",
      archived: view().archived,
      status: view().status,
      environment: view().environment,
      git: view().git,
      limit: SESSION_GROUP_PAGE_SIZE,
    }))
    const globalSessionListSignature = createMemo(() => JSON.stringify(globalSessionListQuery()))
    const globalSessionList = useQuery(() =>
      sessionListQueryOptions({
        baseUrl: globalSDK.url,
        query: globalSessionListQuery(),
      })
    )
    const [sessionListRows, setSessionListRows] = createSignal<SessionNavigationRow[]>([])
    const [sessionListNextCursor, setSessionListNextCursor] = createSignal<string | undefined>()
    const [sessionListTotal, setSessionListTotal] = createSignal<number | undefined>()
    const [sessionListLoadedSignature, setSessionListLoadedSignature] = createSignal<string | undefined>()
    const [sessionListLoadingMore, setSessionListLoadingMore] = createSignal(false)
    const [sessionListPageError, setSessionListPageError] = createSignal(false)
    let sessionListLoadingCursor: string | undefined

    createEffect(() => {
      const data = globalSessionList.data
      if (!data) return
      setSessionListRows(data.items ?? [])
      setSessionListNextCursor(data.nextCursor)
      setSessionListTotal(data.totalKnown)
      setSessionListLoadedSignature(globalSessionListSignature())
      setSessionListPageError(false)
    })

    const sessionListLoaded = createMemo(() => sessionListLoadedSignature() === globalSessionListSignature())
    const globalProject = createMemo<ProjectItem>(() => section.rows[0]?.project ?? {
      id: "global",
      worktree: "global",
      name: "Global Chat",
    })
    const sectionRows = createMemo(() => {
      if (sessionListLoaded()) {
        return sessionListRows().map((item) => navigationSessionRow(item, globalProject(), "global"))
      }
      return []
    })
    let visibleRows = sectionRows()
    createEffect(() => {
      visibleRows = open() ? sectionRows() : []
      registerVisibleSessionRows("global", visibleRows)
    })
    onCleanup(() => clearVisibleSessionRows("global", visibleRows))
    const more = createMemo(() => sessionListLoaded()
      ? !!sessionListNextCursor()
      : false)
    const count = createMemo(() => sessionListLoaded()
      ? sessionListTotal() ?? sectionRows().length
      : 0)
    const loadingInitial = createMemo(() => !sessionListLoaded() && globalSessionList.isFetching && sectionRows().length === 0)
    const errorInitial = createMemo(() => globalSessionList.isError && !globalSessionList.isFetching)
    const emptyLoaded = createMemo(() => sessionListLoaded() && sectionRows().length === 0)
    const doneLoaded = createMemo(() =>
      sessionListLoaded() && sectionRows().length > 0 && !more() && count() <= sectionRows().length && count() > SESSION_GROUP_PAGE_SIZE
    )
    const loadMoreGlobalSessionList = async () => {
      const cursor = sessionListNextCursor()
      if (!cursor || sessionListLoadingCursor === cursor) return
      const signature = globalSessionListSignature()
      sessionListLoadingCursor = cursor
      setSessionListLoadingMore(true)
      setSessionListPageError(false)
      try {
        const page = await queryClient.fetchQuery(sessionListQueryOptions({
          baseUrl: globalSDK.url,
          query: {
            ...globalSessionListQuery(),
            cursor,
          },
        })) as SessionListResponse
        if (signature !== globalSessionListSignature()) return
        const next = appendSessionListPageQueryData({
          baseUrl: globalSDK.url,
          query: globalSessionListQuery(),
          page,
        })
        setSessionListRows(next.items ?? [])
        setSessionListNextCursor(next.nextCursor)
        setSessionListTotal(next.totalKnown)
        setSessionListLoadedSignature(signature)
      } catch {
        if (signature === globalSessionListSignature()) setSessionListPageError(true)
      } finally {
        if (sessionListLoadingCursor === cursor) sessionListLoadingCursor = undefined
        setSessionListLoadingMore(false)
      }
    }
    const reconcileArchivedSessionListRow = (item: SessionNavigationDisplayRow) => {
      const current = sessionListRows()
      const next = reconcileSessionRowsAfterArchive({
        rows: current,
        sessionRef: item.source.sessionRef,
        archivedAt: Date.now(),
        archiveView: view().archived,
      })
      setSessionListRows(next)
      if (view().archived === "active" && next.length < current.length) {
        setSessionListTotal((total) => total === undefined ? total : Math.max(0, total - (current.length - next.length)))
      }
    }

    return (
      <div class="flex flex-col gap-0.5">
        <div
          class="flex items-start gap-2 pl-3 pr-2.5 py-1.5 mx-1 group/header cursor-pointer hover:bg-surface-base-hover/30 rounded-md transition-colors duration-100"
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
              <span class="text-sm font-medium text-text-base/80 truncate">{section.label}</span>
            </div>
          </div>
        </div>
        <Show when={open()}>
          <div class="flex flex-col gap-0.5 pb-1">
            <SessionNavigation
              rows={sectionRows().map((session) => sessionDisplayRow(session))}
              onPrepareActivate={(item) => prepareSessionActivationFromRows(sectionRows(), item)}
              onActivate={(item) => activateSessionFromRows(sectionRows(), item)}
              onArchive={(item) => archiveSessionFromRows(sectionRows(), item, reconcileArchivedSessionListRow)}
              onPrepareDrag={(item) => prepareSessionDragFromRows(sectionRows(), item)}
            />
            <Show when={loadingInitial()}>
              <SessionListNotice variant="loading">Loading sessions...</SessionListNotice>
            </Show>
            <Show when={errorInitial()}>
              <SessionListNotice
                variant="error"
                actionLabel="Retry"
                onAction={() => globalSessionList.refetch()}
              >
                Could not load sessions.
              </SessionListNotice>
            </Show>
            <Show when={emptyLoaded()}>
              <SessionListNotice variant="empty">No sessions match the current view.</SessionListNotice>
            </Show>
            <Show when={more()}>
              <button
                data-testid="rail-sidebar-session-load-more"
                type="button"
                class="text-sm text-text-weaker hover:text-text-weak pl-9 pr-2.5 py-1 text-left transition-colors duration-100"
                disabled={sessionListLoadingMore()}
                classList={{ "opacity-60": sessionListLoadingMore() }}
                onClick={(e: MouseEvent) => {
                  void loadMoreGlobalSessionList()
                  ;(e.currentTarget as HTMLButtonElement).blur()
                }}
              >
                {sessionListLoadingMore() ? `${language.t("common.loading")}...` : language.t("common.loadMore")}
              </button>
            </Show>
            <Show when={sessionListPageError()}>
              <SessionListNotice
                variant="error"
                actionLabel="Retry"
                onAction={loadMoreGlobalSessionList}
              >
                Could not load more sessions.
              </SessionListNotice>
            </Show>
            <Show when={count() > sectionRows().length && !more()}>
              <span class="pl-9 pr-2.5 py-1 text-2xs text-text-weaker tabular-nums">
                {count()} total
              </span>
            </Show>
            <Show when={doneLoaded()}>
              <SessionListNotice variant="done">All sessions loaded.</SessionListNotice>
            </Show>
          </div>
        </Show>
        <div class="h-px bg-border-weak-base/15 mx-3 my-0.5" />
      </div>
    )
  }

  const WorkspaceBlock = (section: Section) => {
    if (!workspaceBlockMarked) {
      workspaceBlockMarked = true
      perfDiag("diag.rail.workspaceBlockFirstMount", { workspaceDir: section.workspaceDir })
    }
    // Matches the action cluster's own `transition-opacity duration-150`, so it
    // stays mounted for exactly as long as it is still fading out.
    const headerEngagement = createHoverEngagement({ releaseDelayMs: 150 })
    const active = createMemo(() => props.activeDirectory === section.workspaceDir)
    const runtime = createMemo(() => workspaceRuntimeKind(section.project, section.workspaceDir, sectionCloud(section.project, section.workspaceDir)))
    const workspaceItem = createMemo(() => workspace(section.project, section.workspaceDir))
    const workspaceMeta = createMemo(() => {
      const workspace = projectWorkspaceInfo(section.project, section.workspaceDir)
      return [
        workspaceStatusLabel(workspace),
      ].filter((item): item is string => !!item)
    })
    const sessionListQuery = createMemo<SessionListQuery>(() => ({
      scope: "workspace",
      ...(workspaceItem().workspaceId ? { workspaceId: workspaceItem().workspaceId } : {}),
      directory: workspaceItem().directory,
      groupBy: "none",
      archived: view().archived,
      status: view().status,
      environment: view().environment,
      git: view().git,
      limit: SESSION_GROUP_PAGE_SIZE,
    }))
    const sessionListSignature = createMemo(() => JSON.stringify(sessionListQuery()))
    const [_open, setOpen] = createSignal(section.rows.length > 0)
    const [autoOpened, setAutoOpened] = createSignal(section.rows.length > 0)
    const [manuallyToggled, setManuallyToggled] = createSignal(false)
    const [runtimeRequested, setRuntimeRequested] = createSignal(false)
    const open = createMemo(() => _open())
    const workspaceSessionListQuery = useQuery(() =>
      ({
        ...sessionListQueryOptions({
          baseUrl: globalSDK.url,
          query: sessionListQuery(),
        }),
        enabled: open(),
      })
    )
    const [sessionListRows, setSessionListRows] = createSignal<SessionNavigationRow[]>([])
    const [sessionListNextCursor, setSessionListNextCursor] = createSignal<string | undefined>()
    const [sessionListTotal, setSessionListTotal] = createSignal<number | undefined>()
    const [sessionListLoadedSignature, setSessionListLoadedSignature] = createSignal<string | undefined>()
    const [sessionListLoadingMore, setSessionListLoadingMore] = createSignal(false)
    const [sessionListPageError, setSessionListPageError] = createSignal(false)
    let sessionListLoadingCursor: string | undefined

    createEffect(() => {
      const data = workspaceSessionListQuery.data
      if (!data) return
      setSessionListRows(data.items ?? [])
      setSessionListNextCursor(data.nextCursor)
      setSessionListTotal(data.totalKnown)
      setSessionListLoadedSignature(sessionListSignature())
      setSessionListPageError(false)
    })

    const sessionListLoaded = createMemo(() => sessionListLoadedSignature() === sessionListSignature())
    const sectionRows = createMemo(() => {
      if (sessionListLoaded()) {
        return sessionListRows().map((item) => navigationSessionRow(item, section.project, section.workspaceDir))
      }
      return []
    })
    const visibleRowsKey = `workspace:${section.workspaceDir}`
    let visibleRows = sectionRows()
    createEffect(() => {
      visibleRows = open() ? sectionRows() : []
      registerVisibleSessionRows(visibleRowsKey, visibleRows)
    })
    onCleanup(() => clearVisibleSessionRows(visibleRowsKey, visibleRows))
    const shouldHydrateRuntime = () => shouldHydrateSidebarRuntime({
      open: open(),
      active: active(),
      requested: runtimeRequested(),
    })

    createEffect(() => {
      if (active()) setOpen(true)
    })

    const more = createMemo(() => sessionListLoaded()
      ? !!sessionListNextCursor()
      : false)
    const count = createMemo(() =>
      sessionListLoaded()
        ? sessionListTotal() ?? sectionRows().length
        : 0,
    )
    const loadingInitial = createMemo(() => !sessionListLoaded() && workspaceSessionListQuery.isFetching && sectionRows().length === 0)
    const errorInitial = createMemo(() => workspaceSessionListQuery.isError && !workspaceSessionListQuery.isFetching)
    const emptyLoaded = createMemo(() => sessionListLoaded() && sectionRows().length === 0)
    const doneLoaded = createMemo(() =>
      sessionListLoaded() && sectionRows().length > 0 && !more() && count() <= sectionRows().length && count() > SESSION_GROUP_PAGE_SIZE
    )
    const loadMoreWorkspaceSessionList = async () => {
      const cursor = sessionListNextCursor()
      if (!cursor || sessionListLoadingCursor === cursor) return
      const signature = sessionListSignature()
      sessionListLoadingCursor = cursor
      setSessionListLoadingMore(true)
      setSessionListPageError(false)
      try {
        const page = await queryClient.fetchQuery(sessionListQueryOptions({
          baseUrl: globalSDK.url,
          query: {
            ...sessionListQuery(),
            cursor,
          },
        })) as SessionListResponse
        if (signature !== sessionListSignature()) return
        const next = appendSessionListPageQueryData({
          baseUrl: globalSDK.url,
          query: sessionListQuery(),
          page,
        })
        setSessionListRows(next.items ?? [])
        setSessionListNextCursor(next.nextCursor)
        setSessionListTotal(next.totalKnown)
        setSessionListLoadedSignature(signature)
      } catch {
        if (signature === sessionListSignature()) setSessionListPageError(true)
      } finally {
        if (sessionListLoadingCursor === cursor) sessionListLoadingCursor = undefined
        setSessionListLoadingMore(false)
      }
    }
    const reconcileArchivedSessionListRow = (item: SessionNavigationDisplayRow) => {
      const current = sessionListRows()
      const next = reconcileSessionRowsAfterArchive({
        rows: current,
        sessionRef: item.source.sessionRef,
        archivedAt: Date.now(),
        archiveView: view().archived,
      })
      setSessionListRows(next)
      if (view().archived === "active" && next.length < current.length) {
        setSessionListTotal((total) => total === undefined ? total : Math.max(0, total - (current.length - next.length)))
      }
    }
    const terminalItems = createMemo(() => terminalSurfaceRows({ directory: section.workspaceDir }))

    createEffect(() => {
      if (!shouldAutoOpenWorkspaceSection({
        rows: sectionRows().length,
        terminals: terminalItems().length,
        autoOpened: autoOpened(),
        manuallyToggled: manuallyToggled(),
      })) return
      setOpen(true)
      setAutoOpened(true)
    })

    return (
      <div class="flex flex-col gap-0.5">
        <div>
          <div
            data-testid="workspace-header"
            data-workspace-id={section.workspaceDir}
            class="flex items-center gap-2 min-h-8 pl-3 pr-2.5 py-1 mx-1 group/header cursor-pointer hover:bg-surface-base-hover/30 rounded-md transition-[background-color,box-shadow,color] duration-100"
            {...headerEngagement.handlers}
            onClick={() => {
              setOpen(true)
              setRuntimeRequested(true)
              openWorkspacePanel(section.workspaceDir)
            }}
          >
            <span
              class="size-4 shrink-0 flex items-center justify-center relative" role="button" tabIndex={0}
              aria-label={open() ? "Collapse workspace" : "Expand workspace"} aria-expanded={open()}
              onClick={(e: MouseEvent) => {
                e.stopPropagation()
                setManuallyToggled(true)
                setRuntimeRequested(true)
                setOpen(!_open())
              }}
              onKeyDown={(e: KeyboardEvent) => activateDisclosureFromKeyboard(e, () => {
                setManuallyToggled(true)
                setRuntimeRequested(true)
                setOpen(!_open())
              })}
            >
              <Icon
                name={runtimeIcon(runtime())}
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
            <div class="flex items-baseline gap-1.5 min-w-0 flex-1 overflow-hidden">
              <span
                title={section.workspaceDir}
                class="text-compact font-medium truncate flex-1 min-w-0"
                classList={{
                  "text-text-strong": active(),
                  "text-text-base/80": !active(),
                }}
              >
                {section.label}
              </span>
              <Show when={workspaceMeta().length > 0}>
                <span class="text-2xs text-text-weaker truncate shrink-0 max-w-[42%]">
                  {workspaceMeta().join(" · ")}
                </span>
              </Show>
            </div>
            <HeaderActions
              project={section.project}
              workspaceDir={section.workspaceDir}
              label={section.label}
              scope="workspace"
              engaged={headerEngagement.engaged}
            />
          </div>
        </div>

        <Show when={open()}>
          {/* B2: terminals first, then sessions, no sub-headers. The
              workspace header above hosts the +session/+terminal/+Claude
              /+Codex buttons. */}
          <div class="flex flex-col gap-0.5 pb-1">
            <TerminalSurfaceNavigation
              rows={terminalItems()}
              nested
              onActivate={activateTerminal}
              onClose={closeTerminal}
            />
            <SessionNavigation
              rows={sectionRows().map((session) => sessionDisplayRow(session, {
                nested: true,
                // Thunk, not a value: evaluating the workbench-focus read here
                // would subscribe this whole rows map to every focus change.
                active: () => sessionActiveInWorkbench(session, section.workspaceDir),
              }))}
              onPrepareActivate={(item) => prepareSessionActivationFromRows(sectionRows(), item)}
              onActivate={(item) => activateSessionFromRows(sectionRows(), item)}
              onArchive={(item) => archiveSessionFromRows(sectionRows(), item, reconcileArchivedSessionListRow)}
              onPrepareDrag={(item) => prepareSessionDragFromRows(sectionRows(), item)}
            />
            <Show when={loadingInitial()}>
              <SessionListNotice variant="loading">Loading sessions...</SessionListNotice>
            </Show>
            <Show when={errorInitial()}>
              <SessionListNotice
                variant="error"
                actionLabel="Retry"
                onAction={() => workspaceSessionListQuery.refetch()}
              >
                Could not load sessions.
              </SessionListNotice>
            </Show>
            <Show when={emptyLoaded()}>
              <SessionListNotice variant="empty">No sessions match the current view.</SessionListNotice>
            </Show>
            <Show when={more()}>
              <button
                data-testid="rail-sidebar-session-load-more"
                type="button"
                class="text-sm text-text-weaker hover:text-text-weak pl-9 pr-2.5 py-1 text-left transition-colors duration-100"
                disabled={sessionListLoadingMore()}
                classList={{ "opacity-60": sessionListLoadingMore() }}
                onClick={(e: MouseEvent) => {
                  void loadMoreWorkspaceSessionList()
                  ;(e.currentTarget as HTMLButtonElement).blur()
                }}
              >
                {sessionListLoadingMore() ? `${language.t("common.loading")}...` : language.t("common.loadMore")}
              </button>
            </Show>
            <Show when={sessionListPageError()}>
              <SessionListNotice
                variant="error"
                actionLabel="Retry"
                onAction={loadMoreWorkspaceSessionList}
              >
                Could not load more sessions.
              </SessionListNotice>
            </Show>
            <Show when={count() > sectionRows().length && !more()}>
              <span class="pl-9 pr-2.5 py-1 text-2xs text-text-weaker tabular-nums">
                {count()} total
              </span>
            </Show>
            <Show when={doneLoaded()}>
              <SessionListNotice variant="done">All sessions loaded.</SessionListNotice>
            </Show>
          </div>
        </Show>

      </div>
    )
  }

  const ProjectBlock = (section: ProjectSection) => {
    // See `WorkspaceBlock`: the cluster fades out over 150ms, so it unmounts
    // 150ms after the header stops being the pointer/keyboard target.
    const headerEngagement = createHoverEngagement({ releaseDelayMs: 150 })
    const directories = createMemo(() => dirs(section.project))
    const [open, setOpen] = createSignal(section.rows.length > 0 || projectMatches(section.project))
    const active = createMemo(() => projectMatches(section.project))
    const projectSessionListQuery = createMemo<SessionListQuery>(() => ({
      scope: "project",
      projectId: section.project.id,
      groupBy: "none",
      archived: view().archived,
      status: view().status,
      environment: view().environment,
      git: view().git,
      limit: SESSION_GROUP_PAGE_SIZE,
    }))
    const projectSessionListSignature = createMemo(() => JSON.stringify(projectSessionListQuery()))
    const projectSessionList = useQuery(() =>
      ({
        ...sessionListQueryOptions({
          baseUrl: globalSDK.url,
          query: projectSessionListQuery(),
        }),
        enabled: open(),
      })
    )
    const [sessionListRows, setSessionListRows] = createSignal<SessionNavigationRow[]>([])
    const [sessionListNextCursor, setSessionListNextCursor] = createSignal<string | undefined>()
    const [sessionListTotal, setSessionListTotal] = createSignal<number | undefined>()
    const [sessionListLoadedSignature, setSessionListLoadedSignature] = createSignal<string | undefined>()
    const [sessionListLoadingMore, setSessionListLoadingMore] = createSignal(false)
    const [sessionListPageError, setSessionListPageError] = createSignal(false)
    let sessionListLoadingCursor: string | undefined

    createEffect(() => {
      const data = projectSessionList.data
      if (!data) return
      setSessionListRows(data.items ?? [])
      setSessionListNextCursor(data.nextCursor)
      setSessionListTotal(data.totalKnown)
      setSessionListLoadedSignature(projectSessionListSignature())
      setSessionListPageError(false)
    })

    const sessionListLoaded = createMemo(() => sessionListLoadedSignature() === projectSessionListSignature())
    const sectionRows = createMemo(() => {
      if (sessionListLoaded()) {
        return sessionListRows().map((item) => navigationSessionRow(item, section.project, section.project.worktree))
      }
      return []
    })
    const visibleRowsKey = `project:${section.project.id}`
    let visibleRows = sectionRows()
    createEffect(() => {
      visibleRows = open() ? sectionRows() : []
      registerVisibleSessionRows(visibleRowsKey, visibleRows)
    })
    onCleanup(() => clearVisibleSessionRows(visibleRowsKey, visibleRows))
    const terminalItems = createMemo(() => terminalSurfaceRows({ directories: directories() }))
    const projectActionDirectory = createMemo(() => {
      if (props.activeDirectory && directories().some((directory) =>
        directory === props.activeDirectory ||
        projectWorkspaceInfo(section.project, directory)?.workspaceId === props.activeDirectory
      )) return props.activeDirectory
      return directories()[0] ?? section.project.worktree
    })
    const projectActionLabel = createMemo(() => workspaceName(projectActionDirectory(), section.project))
    // Cloud workspaces are lazily connected: dim the entry until its runtime
    // is ready so the rail honestly shows what is reachable NOW. Clicking
    // still connects (the select handler drives the connection), and the
    // connect surface then narrates restore/resume/cold-start. Local and
    // user-hosted entries never dim — local has nothing to connect, and
    // user-hosted readiness is the host machine's business, reported in-pane.
    const dimmedCloud = createMemo(() => {
      const directory = projectActionDirectory()
      if (!sectionCloud(section.project, directory)) return false
      const workspaceId = projectWorkspaceInfo(section.project, directory)?.workspaceId ?? directory
      return !isWorkspaceReady(workspaceId)
    })
    const more = createMemo(() => sessionListLoaded()
      ? !!sessionListNextCursor()
      : false)
    const count = createMemo(() => sessionListLoaded()
      ? sessionListTotal() ?? sectionRows().length
      : 0)
    const loadingInitial = createMemo(() => !sessionListLoaded() && projectSessionList.isFetching && sectionRows().length === 0)
    const errorInitial = createMemo(() => projectSessionList.isError && !projectSessionList.isFetching)
    const emptyLoaded = createMemo(() => sessionListLoaded() && sectionRows().length === 0)
    const doneLoaded = createMemo(() =>
      sessionListLoaded() && sectionRows().length > 0 && !more() && count() <= sectionRows().length && count() > SESSION_GROUP_PAGE_SIZE
    )
    const loadMoreProjectSessionList = async () => {
      const cursor = sessionListNextCursor()
      if (!cursor || sessionListLoadingCursor === cursor) return
      const signature = projectSessionListSignature()
      sessionListLoadingCursor = cursor
      setSessionListLoadingMore(true)
      setSessionListPageError(false)
      try {
        const page = await queryClient.fetchQuery(sessionListQueryOptions({
          baseUrl: globalSDK.url,
          query: {
            ...projectSessionListQuery(),
            cursor,
          },
        })) as SessionListResponse
        if (signature !== projectSessionListSignature()) return
        const next = appendSessionListPageQueryData({
          baseUrl: globalSDK.url,
          query: projectSessionListQuery(),
          page,
        })
        setSessionListRows(next.items ?? [])
        setSessionListNextCursor(next.nextCursor)
        setSessionListTotal(next.totalKnown)
        setSessionListLoadedSignature(signature)
      } catch {
        if (signature === projectSessionListSignature()) setSessionListPageError(true)
      } finally {
        if (sessionListLoadingCursor === cursor) sessionListLoadingCursor = undefined
        setSessionListLoadingMore(false)
      }
    }
    const reconcileArchivedSessionListRow = (item: SessionNavigationDisplayRow) => {
      const current = sessionListRows()
      const next = reconcileSessionRowsAfterArchive({
        rows: current,
        sessionRef: item.source.sessionRef,
        archivedAt: Date.now(),
        archiveView: view().archived,
      })
      setSessionListRows(next)
      if (view().archived === "active" && next.length < current.length) {
        setSessionListTotal((total) => total === undefined ? total : Math.max(0, total - (current.length - next.length)))
      }
    }

    createEffect(() => {
      if (projectMatches(section.project)) setOpen(true)
    })

    createEffect(() => {
      if (terminalItems().length > 0) setOpen(true)
    })

    return (
      <div data-testid="project-group" data-project-id={section.project.id} class="flex flex-col gap-0.5">
        <div
          data-testid="project-header"
          data-slot="project-header"
          data-active={active() ? "true" : "false"}
          data-cloud-disconnected={dimmedCloud() ? "true" : undefined}
          class="flex items-center gap-2 min-h-8 pl-3 pr-2.5 py-1 mx-1 group/header cursor-pointer hover:bg-surface-base-hover/30 rounded-md transition-[colors,opacity] duration-100"
          classList={{ "opacity-60 hover:opacity-100": dimmedCloud() }}
          {...headerEngagement.handlers}
          onClick={() => {
            setOpen(true)
            props.onWorkspaceSelect?.(section.project, projectActionDirectory())
          }}
        >
          <div class="flex items-center gap-1.5 min-w-0 flex-1">
            <span
              data-icon-interaction="binary"
              data-icon-state={open() ? "open" : "closed"}
              class="size-4 shrink-0 flex items-center justify-center relative" role="button" tabIndex={0}
              classList={{
                "text-text-strong": active(),
                "text-text-base/85": !active(),
              }}
              aria-label={open() ? "Collapse project" : "Expand project"} aria-expanded={open()}
              onClick={(e: MouseEvent) => {
                e.stopPropagation()
                setOpen(!open())
              }}
              onKeyDown={(e: KeyboardEvent) => activateDisclosureFromKeyboard(e, () => setOpen(!open()))}
            >
              <Icon
                name={open() ? "folder-open" : "folder"}
                size="small"
                class="shrink-0 absolute inset-0 m-auto transition-colors duration-100"
              />
            </span>
            <span
              title={projectCaption(section.project)}
              class="text-compact font-medium truncate min-w-0"
              classList={{
                "text-text-strong": active(),
                "text-text-base/85": !active(),
              }}
            >
              {section.label}
            </span>
          </div>
          <HeaderActions
            project={section.project}
            workspaceDir={projectActionDirectory()}
            label={projectActionLabel()}
            scope="project"
            engaged={headerEngagement.engaged}
          />
        </div>
        <Show when={open()}>
          <div class="flex flex-col gap-0.5 pb-1">
            <TerminalSurfaceNavigation
              rows={terminalItems()}
              nested
              onActivate={activateTerminal}
              onClose={closeTerminal}
            />
            <SessionNavigation
              rows={sectionRows().map((session) => sessionDisplayRow(session, {
                nested: true,
                showMetadata: true,
              }))}
              onPrepareActivate={(item) => prepareSessionActivationFromRows(sectionRows(), item)}
              onActivate={(item) => activateSessionFromRows(sectionRows(), item)}
              onArchive={(item) => archiveSessionFromRows(sectionRows(), item, reconcileArchivedSessionListRow)}
              onPrepareDrag={(item) => prepareSessionDragFromRows(sectionRows(), item)}
            />
            <Show when={loadingInitial()}>
              <SessionListNotice variant="loading">Loading sessions...</SessionListNotice>
            </Show>
            <Show when={errorInitial()}>
              <SessionListNotice
                variant="error"
                actionLabel="Retry"
                onAction={() => projectSessionList.refetch()}
              >
                Could not load sessions.
              </SessionListNotice>
            </Show>
            <Show when={emptyLoaded()}>
              <SessionListNotice variant="empty">No sessions match the current view.</SessionListNotice>
            </Show>
            <Show when={more()}>
              <button
                data-testid="rail-sidebar-session-load-more"
                type="button"
                class="text-sm text-text-weaker hover:text-text-weak pl-9 pr-2.5 py-1 text-left transition-colors duration-100"
                disabled={sessionListLoadingMore()}
                classList={{ "opacity-60": sessionListLoadingMore() }}
                onClick={(e: MouseEvent) => {
                  void loadMoreProjectSessionList()
                  ;(e.currentTarget as HTMLButtonElement).blur()
                }}
              >
                {sessionListLoadingMore() ? `${language.t("common.loading")}...` : language.t("common.loadMore")}
              </button>
            </Show>
            <Show when={sessionListPageError()}>
              <SessionListNotice
                variant="error"
                actionLabel="Retry"
                onAction={loadMoreProjectSessionList}
              >
                Could not load more sessions.
              </SessionListNotice>
            </Show>
            <Show when={count() > sectionRows().length && !more()}>
              <span class="pl-9 pr-2.5 py-1 text-2xs text-text-weaker tabular-nums">
                {count()} total
              </span>
            </Show>
            <Show when={doneLoaded()}>
              <SessionListNotice variant="done">All sessions loaded.</SessionListNotice>
            </Show>
          </div>
        </Show>
      </div>
    )
  }

  const WorkspaceGroupBlock = (group: Cluster) => {
    const [open, setOpen] = createSignal(projectMatches(group.project) || group.items.some((item) => item.rows.length > 0))
    const active = createMemo(() => projectMatches(group.project))

    createEffect(() => {
      if (projectMatches(group.project)) setOpen(true)
    })

    return (
      <div data-testid="workspace-project-group" data-project-id={group.project.id} class="flex flex-col gap-0.5">
        <div
          data-testid="workspace-project-header"
          data-slot="project-header"
          data-active={active() ? "true" : "false"}
          class="flex items-center gap-2 min-h-8 pl-3 pr-2.5 py-1 mx-1 group/header cursor-pointer hover:bg-surface-base-hover/30 rounded-md transition-colors duration-100"
          onClick={() => {
            setOpen(true)
            props.onWorkspaceSelect?.(group.project, dirs(group.project)[0] ?? group.project.worktree)
          }}
        >
          <div class="flex items-center gap-1.5 min-w-0 flex-1">
            <span
              data-icon-interaction="binary"
              data-icon-state={open() ? "open" : "closed"}
              class="size-4 shrink-0 flex items-center justify-center relative" role="button" tabIndex={0}
              classList={{
                "text-text-strong": active(),
                "text-text-base/85": !active(),
              }}
              aria-label={open() ? "Collapse project" : "Expand project"} aria-expanded={open()}
              onClick={(e: MouseEvent) => {
                e.stopPropagation()
                setOpen(!open())
              }}
              onKeyDown={(e: KeyboardEvent) => activateDisclosureFromKeyboard(e, () => setOpen(!open()))}
            >
              <Icon
                name={open() ? "folder-open" : "folder"}
                size="small"
                class="shrink-0 absolute inset-0 m-auto transition-colors duration-100"
              />
            </span>
            <span
              title={projectCaption(group.project)}
              class="text-compact font-medium truncate min-w-0"
              classList={{
                "text-text-strong": active(),
                "text-text-base/85": !active(),
              }}
            >
              {group.label}
            </span>
          </div>
        </div>
        <Show when={open()}>
          <div class="flex flex-col gap-0.5 pb-1">
            <For each={group.items.map((section) => section.id)}>
              {(sectionId) => <WorkspaceBlock {...group.items.find((section) => section.id === sectionId)!} />}
            </For>
          </div>
        </Show>
      </div>
    )
  }

  return (
    <nav
      ref={railRef}
      data-sidebar
      data-claxedo-compact-touch
      data-pinned={docked() ? "" : undefined}
      data-open={docked() || expanded() ? "true" : "false"}
      class={`h-full flex flex-col bg-background-base overflow-hidden z-[50] pointer-events-auto
        claxedo-rail-sidebar-panel transition-[opacity,transform] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)]
        max-md:!w-[280px] max-md:opacity-100 max-md:pointer-events-auto
        ${docked() || expanded()
          ? "opacity-100"
          : "md:opacity-0 md:pointer-events-none"}
      `}
      style={{
        width: `${width()}px`,
        "border-right": "1px solid var(--shell-border-sidebar, var(--border-weaker-base))",
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      data-testid="rail-sidebar"
      data-surface="sidebar"
      aria-label={language.t("sidebar.nav.projectsAndSessions")}
    >
      <div
        class="flex h-9 shrink-0 items-center gap-2 border-b border-border-weaker-base bg-background-base px-3"
        style={{ "padding-left": props.trafficLightPad ? "78px" : undefined }}
      >
        <Show when={docked()}>
          <Tooltip placement="bottom" value="Hide Sidebar">
            <div class="max-md:hidden shrink-0">
              <IconButton
                icon="layout-left-full"
                variant="ghost"
                class="h-7 w-7 rounded-md text-icon-weak-base hover:text-icon-base"
                onClick={props.onToggleSidebar}
                aria-label="Hide Sidebar"
                aria-pressed="true"
                data-icon-interaction="binary"
                data-testid="sidebar-toggle"
              />
            </div>
          </Tooltip>
        </Show>
        <div class="flex-1" />
      </div>

      {/* Scrollable content area */}
      <div
        class="flex-1 flex flex-col min-h-0 overflow-y-auto overflow-x-hidden rail-sidebar-scroll"
        style={{
          "scrollbar-width": "thin",
          "scrollbar-color": "var(--scrollbar-thumb) transparent",
        }}
      >
        <GlobalNavigation
          newProjectLabel={language.t("workspace.new")}
          onNewProject={props.onNewProject}
          onOpenPages={props.onOpenPages}
          onOpenMarketplace={props.onOpenMarketplace}
          onOpenWorkGraph={props.onOpenWorkGraph}
        />

        {/* Projects list */}
        <div class="flex-1 flex flex-col py-1.5 gap-0.5">
          <Show
            when={props.projects.length > 0 || globals().length > 0}
            fallback={
              <div class="flex px-4 py-8 text-compact text-text-weak">
                No sessions match the current view.
              </div>
            }
          >
            <div data-slot="rail-section-label" class="px-4 pt-1 pb-1 text-xs font-medium uppercase tracking-normal text-text-weaker">
              {view().group === "project" ? "Projects" : "Workspaces"}
            </div>
            <For each={globals().map((section) => section.id)}>
              {(sectionId) => <GlobalBlock {...globals().find((section) => section.id === sectionId)!} />}
            </For>
            <Switch>
              <Match when={view().group === "project"}>
                <For each={projectGroups().map((group) => group.id)}>
                  {(groupId) => <ProjectBlock {...projectGroups().find((group) => group.id === groupId)!} />}
                </For>
              </Match>
              <Match when={view().group === "workspace"}>
                <For each={groups().map((group) => group.id)}>
                  {(groupId) => <WorkspaceGroupBlock {...groups().find((group) => group.id === groupId)!} />}
                </For>
              </Match>
            </Switch>
          </Show>
        </div>

        {/* Custom content slot */}
        <Show when={props.children}>
          <div>{props.children}</div>
        </Show>
      </div>

      {/* Footer - fixed at bottom. The inset rule is the inner box's own
          `border-t`, so the padding wrapper and the ruled box stay two
          elements; the third `flex flex-col` around them wrapped a single
          block child and only added an element to every style pass. */}
      <div class="px-2.5 py-2">
        <div class="border-t border-border-weak-base/15 pt-2">
          <RailAccountMenu
            onRailLockChange={handleRailMenuOpenChange}
            onDiagnostics={props.onDiagnostics}
            onSettings={props.onSettings}
            onUsage={props.onUsage}
            onHelp={props.onHelp}
            utilities={() => <FilterMenu />}
          />
        </div>
      </div>
    </nav>
  )
}
