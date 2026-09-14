import {
  SIDEBAR_SESSION_STATUS_FRESH_MS,
  abortSidebarSessionStatusBatches,
  invalidateSidebarSessionStatusGroupsForSession,
  pruneSidebarSessionStatusBatches,
  publishFocusedRailSessionMeta,
  readRailBatchLeg,
  sidebarRequestDebug,
  sidebarSessionStatusBatches,
  syncUnfocusedRailBatchStatusToCache,
} from "./rail-sidebar-status"
import { markRendererPhase, measureRendererPhase } from "@/platform/performance/renderer-trace"
import { sessionPerf } from "@/platform/performance/session-perf"

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

import { For, Show, Switch, Match, Suspense, createMemo, createSelector, createSignal, onCleanup, onMount, createEffect, on, type JSX } from "solid-js"
import { GlobalNavigation } from "./global-navigation"
import { useQuery } from "@tanstack/solid-query"
import { useClaxedoState, type ContentMeta } from "../state/index"
import { NEW_TERMINAL_ID } from "@/features/terminal/core/terminal-surface-id"
import { terminalSessionIdForWorkspace } from "@/features/terminal/core/terminal-session-context"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { useLanguage } from "@/platform/i18n/provider"
import { formatCompactAge } from "@/lib/relative-time"
import { useServer } from "@/app/connection/server"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { usePermission } from "@/features/session/providers/permission"
import { useOptionalTerminal } from "@/features/terminal/providers/provider"
import { DialogEditProject } from "../../../features/workspaces/ui/dialog-edit-project"
import { RailAccountMenu, RailAccountSubmenu } from "./rail-account-menu"
import { RailOrgTeamSwitcher } from "./rail-org-team-switcher"
import { getFilename } from "@opencode-ai/ui/utils/path"
import type { SessionInventoryRow } from "../../../features/session/data/query/types"
import { projectWorkspaceDirectories, workspaceDisplayName, workspaceIsCloud } from "../../../features/workspaces/lib/workspace-display"
import { getTerminalCommands } from "@/features/terminal/core/terminal-commands"
import {
  activateDisclosureFromKeyboard,
  isRootWorktreeRef,
  projectActionDirectory as resolveProjectActionDirectory,
  railWorkspaceSessionBacking,
  railProjectCaptionFromName,
  railProjectLabel,
  railWorkspaceMetaLabels,
  sessionRowLinks,
  sessionRowTitle,
  shouldAutoOpenWorkspaceSection,
  workspaceRowId,
  workspaceRuntimeKind,
  workspaceInventoryGroupFor,
} from "./rail-sidebar.logic"
import { queryClient } from "@/platform/query/query-client"
import {
  emptySessionInventory,
  sessionInventoryQueryOptions,
} from "../../../features/session/data/sync/queries"
import { createSidebarStatusPoll } from "./rail-sidebar-status-poll"
import { createRailSessionActivity } from "./rail-session-activity"
import {
  railSessionStatusBatchKey,
  railSessionStatusTarget,
  railSessionStatusTargetChain,
} from "./rail-session-status-target"
import { promptSessionStatusMeta, subscribeSessionActivity } from "@/features/session/store/session-status-dispatcher"
import { focusComposerWhenReady } from "@/features/session/composer/ui/composer-focus"
import { applyDirectorySessionMeta } from "@/features/session/store/directory-session-meta"
import { useSharedWorkspaceIds } from "@/features/workspaces/data/shared-workspaces"
import { can } from "@/platform/auth/role"
import { isWorkspaceReady, workspacePlacement } from "../../../features/workspaces/data/workspace-connection"
import { getSessionPrefetch, SESSION_PREFETCH_TTL, type SessionPrefetchDirectory } from "@/platform/sync/session-prefetch"
import { sessionRefForWorkspaceSession, type WorkspaceSessionBacking } from "@/platform/identity/session-ref"
import { isRelayBackedWorkspaceKind, workspaceKind as toWorkspaceKind } from "@/platform/runtime/agent/workspace-kind"
import type { AgentRuntimeStatus as SessionStatus } from "@claxedo/agent-runtime-contract"
import { shellDataKeys } from "@/platform/sync/keys"
import { sessionSurfaceStatus } from "../compact-switcher/surface-status"
import type { SwitcherStatus } from "../compact-switcher/switcher-items"
import { fastSessionSwitchAnyQuietDelay, markFastSessionSwitch } from "@/platform/runtime/session-switch"
import { useSessionTitleProjection } from "@/features/session/providers/session-title-projection-provider"
import { sessionRoute, workspaceSessionRoute } from "@/platform/identity/route"
import { workspaceRouteId } from "@/platform/identity/workspace-route"
import { type SessionListQuery } from "../../../features/session/data/query/session-list"
import {
  centralSessionSource,
  projectSessionSource,
  sessionSourceForWorkspace,
} from "../../../features/session/data/sync/session-source"
import { createRailSectionSessionList } from "./rail-section-session-list"
import {
  deriveTerminalSurfaceRows,
  terminalMetaMatchesPlacement,
  type SessionNavigationRow,
} from "../../../features/session/ui/navigation/session-navigation"
import {
  SessionNavigation,
  type SessionNavigationDisplayRow,
} from "../../../features/session/ui/navigation/session-navigation-list"
import { TerminalSurfaceNavigation } from "../../../features/terminal/ui/navigation/terminal-surface-navigation"
export { parseOwnerRepo } from "./rail-git-remote"
import type { ProjectItem, RuntimeKind, SessionItem, WorkspaceInfo, WorkspaceItem } from "./domain-types"
import { projectWorkspaceInfo } from "./rail-project-session-info"
import { writeBrowserRoute } from "@/lib/browser-history"
import { nextSiblingAfterRemoval } from "@/features/session/ui/session-archive"
import { createRailSessionMessagePrefetch } from "./rail-session-message-prefetch"
import { createHoverEngagement, railHeaderActionsBox } from "./rail-hover-engagement"
import { readArray, readField, readString } from "@/lib/record"
export type { ProjectItem, RuntimeKind, SessionItem, WorkspaceInfo, WorkspaceItem } from "./domain-types"

const VIEW_KEY = "claxedo.session-view.v1"
const GLOBAL_TAG = "global"
const GLOBAL_SHOW_TAG = "global:default"
const SESSION_GROUP_PAGE_SIZE = 5
/**
 * The rail's order: the session the reader spoke to most recently first, then
 * the ones they have never prompted, newest created first.
 *
 * A row moves only when the reader sends it a message. Ordering by `updatedAt`
 * moves a row under the pointer aiming at it — "as soon as i click second session
 * it moves to first, feels like auto jumped back this is very bad" — because
 * every actor's turn advances that column: an agent working, a wake, a subagent,
 * a scheduled run, a turn completing. `lastHumanTurnAt` is written only for a
 * turn whose `actorKind` is `human`, which comes from the request's auth claims,
 * so none of those can move a row.
 *
 * Every section requests this, and `reconcileUpdatedSessionListQueryData` reads
 * the sort off the query key, so one order owns every session list surface.
 */
const SESSION_LIST_SORT_DEFAULT = "human_turn_desc" as const
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
          onClick={(e) => {
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

const ARCHIVE_STATES: readonly string[] = ["active", "all", "archived"]

/** The dictionary entry for a workspace role, keyed so the lookup is checked. */
const WORKSPACE_ROLE_LABEL_KEYS = {
  owner: "sidebar.workspace.role.owner",
  admin: "sidebar.workspace.role.admin",
  editor: "sidebar.workspace.role.editor",
  viewer: "sidebar.workspace.role.viewer",
} as const

function workspaceRoleLabelKey(role: string | undefined) {
  const keys: Partial<Record<string, (typeof WORKSPACE_ROLE_LABEL_KEYS)[keyof typeof WORKSPACE_ROLE_LABEL_KEYS]>> =
    WORKSPACE_ROLE_LABEL_KEYS
  return (role === undefined ? undefined : keys[role]) ?? WORKSPACE_ROLE_LABEL_KEYS.viewer
}
const isArchive = (value: unknown): value is Archive => typeof value === "string" && ARCHIVE_STATES.includes(value)

function showCloud(input: {
  worktree: string
  workspaces?: Record<string, { kind?: RuntimeKind }>
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
  activeWorkspaceRouteId?: string
  activeSessionId?: string
  activeGlobal?: boolean
  globalChatEnabled?: boolean
  headerTitle?: string
  headerSubtitle?: string
  onWorkspaceSelect?: (project: ProjectItem, workspaceDir: string) => void
  onSessionSelect?: (workspaceDir: string, sessionId: string) => void
  onNewSession?: (workspaceDir: string, workspaceRouteId?: string) => void
  onNewTerminal?: (workspaceDir: string, command?: string, title?: string, workspaceRouteId?: string) => void
  onNewProject?: () => void
  onRemoveProject?: (project: ProjectItem) => void
  onDeleteWorkspace?: (workspace: WorkspaceItem) => void
  onDeleteSession?: (session: SessionItem) => void
  onArchiveSession?: (session: SessionItem, nextSessionId?: string) => boolean | Promise<boolean>
  onDiagnostics?: () => void
  onSettings?: () => void
  onUsage?: () => void
  onHelp?: () => void
  onOpenMarketplace?: () => void
  onOpenTasks?: () => void
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

/**
 * A section header, not its rows: `count` is how many inventory sessions match
 * the current filters, which is all the header needs to decide whether to open
 * itself. The rows it renders come from its own paginated server query.
 */
type Section = {
  id: string
  label: string
  count: number
  project: ProjectItem
  workspaceDir: string
}

type ProjectSection = {
  id: string
  label: string
  count: number
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
  count: number
  /** The directory Global Chat's own sessions live in, when any have loaded. */
  worktree?: string
}

function sessionNavigationRefForRow(session: Row) {
  if (session.sessionRef) return session.sessionRef
  const directory = session.directory ?? session.project.worktree
  const workspace = workspaceSessionBacking(session, directory)
  if (workspace) return `workspace:${workspace.workspaceId}:session:${session.id}`
  return `local:${directory}:session:${session.id}`
}

function workspaceSessionBacking(
  session: Pick<Row, "sessionRef" | "workspaceId" | "environment" | "project">,
  directory: string,
): WorkspaceSessionBacking | undefined {
  return railWorkspaceSessionBacking({
    directory,
    project: session.project,
    ...(session.sessionRef ? { sessionRef: session.sessionRef } : {}),
    ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
    ...(session.environment?.kind ? { environmentKind: session.environment.kind } : {}),
  })
}

function sessionRuntimeDisplayKind(session: Pick<Row, "environment" | "project">, directory: string): RuntimeKind {
  const environmentKind = toWorkspaceKind(session.environment?.kind)
  if (environmentKind) return environmentKind
  const workspaceKind = toWorkspaceKind(projectWorkspaceInfo(session.project, directory)?.kind)
  if (workspaceKind) return workspaceKind
  return "local"
}

function runtimeIcon(kind: RuntimeKind): "cloud" | "server" | "monitor" {
  if (kind === "cloud") return "cloud"
  if (kind === "user-hosted") return "server"
  return "monitor"
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
    if (!raw) return undefined
    const row: unknown = JSON.parse(raw)
    const archived = readField(row, "archived")
    const strings = (key: string) => readArray(row, key)?.filter((item): item is string => typeof item === "string") ?? []
    return {
      group: groupFromStorage(readString(row, "group")),
      status: strings("status"),
      environment: strings("environment"),
      git: strings("git"),
      archived: archived === "all" || archived === "archived" ? archived : "active",
    } satisfies View
  } catch {
    return undefined
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
  if (input === "review" || input === "page") return input[0].toUpperCase() + input.slice(1)
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
  const workspaceId = workspaceSessionBacking(session, session.directory ?? session.project.worktree)?.workspaceId
  const route = workspaceId ? workspaceSessionRoute(workspaceId, session.id) : sessionRoute(session.id)
  if (window.location.pathname === route) return
  writeBrowserRoute(route, { replace: true, notify: true })
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
    sessionInventoryQueryOptions({
      baseUrl: globalSDK.url,
    }),
  )
  const sessionInventory = createMemo(() =>
    sessionInventoryQuery.data ?? emptySessionInventory(),
  )

  const expanded = createMemo(() => props.railExpanded)
  const docked = createMemo(() => props.railDocked)
  const width = createMemo(() => props.railWidth)
  const [clock, setClock] = createSignal(Date.now())
  const [sessionActivityRevision, bumpSessionActivityRevision] = createSignal(0)
  const prefetchSidebarSessionMessages = createRailSessionMessagePrefetch({
    claxedoServerUrl: globalSDK.url,
    workspaceReachable: isWorkspaceReady,
  })
  let sessionActivationSerial = 0
  const projectMatches = (project: ProjectItem) =>
    props.activeProjectId === project.id || props.activeProjectId === project.worktree

  onMount(() => {
    const timer = setInterval(() => setClock(Date.now()), 10000)
    onCleanup(() => {
      clearInterval(timer)
    })
  })

  const [view, setView] = createSignal(loadView() ?? defaultView())

  createEffect(() => {
    saveView(view())
  })

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
    return workspaceDisplayName(project, dir)
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

  /**
   * Every inventory session in view, as the filter bar and the section counts
   * read them.
   *
   * Inventory rows, not display rows: the lists on screen come from the paginated
   * server query inside each section block, and this side of the rail answers only
   * "how many rows match" and "which status/environment/git values can be filtered
   * on". A display row costs a reactive title memo per session, so building one to
   * answer a count would allocate per session for nothing rendered.
   */
  const inventorySessions = createMemo<SessionInventoryRow[]>(() =>
    props.projects.flatMap((project) => sessionInventory().byProject[project.id] ?? []),
  )

  const globalInventorySessions = createMemo<SessionInventoryRow[]>(() =>
    props.globalChatEnabled ? sessionInventory().global : [],
  )

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
      time: item.createdAt ?? item.updatedAt,
      directory: resolvedDirectory,
      workspaceId: item.workspaceId,
      projectID: item.projectId,
      projectName: projectLabel(project),
      workspaceName: workspaceName(resolvedDirectory, project),
      tags: item.tags,
      attachments,
      environment: item.environment,
      git: item.git,
      ...(item.owner ? { owner: item.owner } : {}),
      archived: !!item.archivedAt,
      status: state({
        tags: item.tags,
        attachments,
      }),
      project,
    }
  }

  const allSessions = createMemo(() => [...inventorySessions(), ...globalInventorySessions()])
  const statusOptions = createMemo(() => uniq(allSessions().flatMap((item) => state(item)).filter((item) => item !== "general")))
  const environmentOptions = createMemo(() => uniq(allSessions().flatMap((item) => env(item))))
  const gitOptions = createMemo(() => uniq(allSessions().flatMap((item) => git(item))))

  const match = (item: SessionInventoryRow) => {
    if (view().archived === "active" && item.archived) return false
    if (view().archived === "archived" && !item.archived) return false
    if (view().status.length && !view().status.some((hit) => state(item).includes(hit))) return false
    if (view().environment.length && !view().environment.some((hit) => env(item).includes(hit))) return false
    if (view().git.length && !view().git.some((hit) => git(item).includes(hit))) return false
    return true
  }

  const matchCount = (sessions: readonly SessionInventoryRow[]) => sessions.filter(match).length

  const dirs = (project: ProjectItem) => {
    const all = new Set(projectWorkspaceDirectories(project))
    if (projectMatches(project) && props.activeDirectory) {
      all.add(projectWorkspaceInfo(project, props.activeDirectory)?.directory ?? props.activeDirectory)
    }
    return [...all]
  }

  const globals = createMemo<GlobalSection[]>(() => {
    const sessions = globalInventorySessions()
    const count = matchCount(sessions)
    if (!props.globalChatEnabled && !count) return []
    return [{
      id: "global",
      label: "Global Chat",
      count,
      ...(sessions[0]?.directory ? { worktree: sessions[0].directory } : {}),
    }]
  })

  const projectGroups = createMemo<ProjectSection[]>(() =>
    props.projects.map((project) => ({
      id: project.id,
      label: projectLabel(project),
      count: matchCount(sessionInventory().byProject[project.id] ?? []),
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
          count: matchCount(group?.sessions ?? []),
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
        workspaceId: workspaceSessionBacking(session, directory)?.workspaceId,
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
  const railSessionActivity = createRailSessionActivity({
    targets: sessionStatusTargets,
    focusedTarget: focusedSessionStatusTarget,
    activityRevision: sessionActivityRevision,
    liveStatusType: (sessionID) =>
      queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(sessionID, "status"))?.type,
    optimisticStartedAt: (sessionID) => promptSessionStatusMeta(sessionID)?.started,
    autoResponds: (request, directory) => permission.autoResponds(request, directory),
  })
  const sidebarSessionStatusInputs = railSessionActivity.rowInputs
  const primeSidebarStatusTarget = (sessionID: string) => {
    invalidateSidebarSessionStatusGroupsForSession(sessionStatusTargetGroups(), sessionID)
    refreshSidebarStatusTargets()
  }
  let sidebarStatusPrimeTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleSidebarStatusPrime = (sessionID: string) => {
    if (sidebarStatusPrimeTimer) clearTimeout(sidebarStatusPrimeTimer)
    sidebarStatusPrimeTimer = setTimeout(() => {
      sidebarStatusPrimeTimer = undefined
      primeSidebarStatusTarget(sessionID)
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
        bumpSessionActivityRevision((value) => value + 1)
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
          // Captured BEFORE the request so a read that was already in flight
          // when a prompt was sent cannot pass itself off as having seen it.
          const readStartedAt = Date.now()
          const request = Promise
            .all([
              readRailBatchLeg("session status", client.session.status(undefined, { signal: controller.signal })),
              readRailBatchLeg("permissions", client.permission.list(undefined, { signal: controller.signal })),
              readRailBatchLeg("questions", client.question.list(undefined, { signal: controller.signal })),
            ])
            .then(([statusRead, permissionRead, questionRead]) => {
              if (controller.signal.aborted) return
              const statuses = statusRead.ok ? statusRead.value : undefined
              const permissions = permissionRead.ok ? permissionRead.value : undefined
              const questions = questionRead.ok ? questionRead.value : undefined
              railSessionActivity.applyBatchRead({
                targets: group.targets,
                readStartedAt,
                ...(statuses ? { statuses } : {}),
                ...(permissions ? { permissions } : {}),
                ...(questions ? { questions } : {}),
              })
              syncUnfocusedRailBatchStatusToCache({
                focusedSessionId: focusedSessionStatusTarget()?.sessionID,
                targets: group.targets,
                statuses,
                readStartedAt,
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
              sidebarSessionStatusBatches.set(batchKey, {
                updatedAt: statusRead.ok && permissionRead.ok && questionRead.ok ? Date.now() : 0,
              })
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
        clear: (handle) => clearTimeout(handle),
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

  const sidebarSessionUnseenDone = railSessionActivity.unseenDone

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
      if (!meta || meta.type !== "terminal") return []
      if (input.directory) return terminalMetaMatchesPlacement(meta, input.directory) ? [meta] : []
      if (directories) {
        return [...directories].some((placement) => terminalMetaMatchesPlacement(meta, placement)) ? [meta] : []
      }
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

  // "Is this row the active one?" comes from the focused workbench surface.
  // `createSelector` gives each row a per-key subscription, so a session switch
  // re-runs the bindings of the TWO affected rows instead of every row in every
  // section.
  const workbenchActiveSessionKey = createMemo(() => {
    const focusedId = claxedoState.wb.selectors.focusedContent()
    const focused = focusedId ? claxedoState.meta.get(focusedId) : undefined
    if (!focused || (focused.type !== "session" && focused.type !== "context")) return undefined
    return `${focused.directory}\0${focused.sessionId}`
  })
  const isWorkbenchActiveSession = createSelector<string | undefined, string>(workbenchActiveSessionKey)
  const sessionActiveInWorkbench = (session: Row, directory: string) =>
    isWorkbenchActiveSession(`${directory}\0${session.id}`)

  const sessionDirectory = (session: Row) => session.directory ?? session.project.worktree
  const sessionWorkbenchRef = (session: Row) => {
    const directory = sessionDirectory(session)

    return sessionRefForWorkspaceSession({
      sessionId: session.id,
      directory,
      workspace: workspaceSessionBacking(session, directory),
    })
  }
  // The identity a row's surface opens under. For a relay-backed row
  // `replaceSessionUrl` writes the same workspace id into `/w/<id>/session/…`,
  // and the route layer that mirrors that URL reuses a surface only when it
  // carries that id (`sameWorkspaceSession`): opened without it, the surface is
  // followed one pass later by a second one for the same session, and the
  // first is stashed before its page is built.
  const sessionOpenOptions = (session: Row) => {
    const workspace = workspaceSessionBacking(session, sessionDirectory(session))
    const sessionRef = sessionWorkbenchRef(session)
    return {
      ...(sessionRef ? { sessionRef } : {}),
      ...(workspace ? { workspaceRouteId: workspace.workspaceId } : {}),
    }
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
      ...(session.owner ? { owner: session.owner } : {}),
    }
  }
  const sessionMetadata = (session: Row, showMetadata?: boolean): SessionNavigationDisplayRow["metadata"] => {
    if (!showMetadata) return undefined
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
    if (isRelayBackedWorkspaceKind(kind)) {
      return {
        icon: runtimeIcon(kind),
        label: label || runtimeLabel(kind),
      }
    }
    if (!showWorkspace || rootWorktree) return undefined
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
    const directory = sessionDirectory(session)
    const links = sessionRowLinks({
      sessionId: session.id,
      sessionRef: sessionNavigationRefForRow(session),
      workspaceDirectory: directory,
      workspaceId: workspaceSessionBacking(session, directory)?.workspaceId,
      localServer: server.isLocal(),
      sessionStore: window.__CLAXEDO__?.sessionStore,
    })
    return {
      source: sessionSourceRow(session),
      get title() {
        return sessionRowTitle(session.title)
      },
      directory: sessionDirectory(session),
      // `active` is read HERE, lazily, for the same reason as `timeLabel`:
      // the focused workbench surface changes on EVERY session switch, and
      // reading it while BUILDING the row invalidated the whole rows array.
      // As an accessor over `createSelector` keys, a switch re-runs only the
      // active-reading bindings of the outgoing and incoming rows.
      // Must stay an accessor: spreading this object would evaluate it
      // eagerly and restore the whole-list invalidation.
      //
      // Authoritative selection is the focused workbench session only. Do not
      // OR route/`session.active` here — those can mark a row selected while
      // the pane still shows a previous session (click show no-op / boot draft).
      get active() {
        return inputActive
          ? inputActive()
          : sessionActiveInWorkbench(session, sessionDirectory(session))
      },
      ...(input?.nested ? { nested: true } : {}),
      ...(session.owner ? { owner: session.owner } : {}),
      get status() { return sessionStatus(session) },
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
        return formatCompactAge(time) ?? language.t("common.justNow")
      },
      ...(metadata ? { metadata } : {}),
      ...(links.link ? { link: links.link } : {}),
      ...(links.deepLink ? { deepLink: links.deepLink } : {}),
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
  const afterVisibleActivation = (task: () => void) => setTimeout(task, fastSessionSwitchAnyQuietDelay({ baseDelay: 80 }) + 100)
  const activateSession = (session: Row) => {
    const measure = measureRendererPhase
    const focusOrigin = typeof document === "undefined" ? undefined : document.activeElement
    const directory = sessionDirectory(session)
    abortSidebarSessionStatusBatches()
    // A click-owned read has no reason to survive a different activation. Do
    // this before navigation so stale JSON cannot parse in the next session's
    // foreground task.
    prefetchSidebarSessionMessages.supersede(directory, session.id)
    // `activateSession` owns navigation; this notification only closes the
    // mobile drawer and must not open the session again.
    // The open starts at the click, not at the mount: everything the user
    // waits for is measured from here.
    sessionPerf.openStart(session.id, "rail")
    measure("sessionActivate.onSessionSelect", () => props.onSessionSelect?.(sessionDirectory(session), session.id))
    const existingId = measure("sessionActivate.findContent", () => existingSessionContentId(session))
    const existingAlive = !!existingId && claxedoState.wb.state.contentIds.includes(existingId)
    const backing = workspaceSessionBacking(session, directory)
    // Decide open vs show synchronously inside openSession/showOrCreate in this
    // click. Never defer the content swap to afterVisibleActivation, route/URL
    // sync, or a later remount — those stay status/tab side-effects only.
    let networkQuiet = existingAlive && hasFreshMessagePrefetch(directory, session.id)
    if (!existingAlive) {
      networkQuiet = measure("sessionActivate.prefetch", () => prefetchSidebarSessionMessages.start(directory, session.id, {
        bypassQuiet: true,
        sessionRef: sessionWorkbenchRef(session),
        ...(backing ? { workspaceKind: backing.kind, workspaceId: backing.workspaceId } : {}),
      }))
    }
    const serial = ++sessionActivationSerial
    measure("sessionActivate.markFastSwitch", () => markFastSessionSwitch(session.id, Date.now(), { networkQuiet }))
    const contentId = measure("sessionActivate.openSession", () => claxedoState.layout.openSession(directory, session.id, sessionRowTitle(session.title), sessionOpenOptions(session)))
    measure("sessionActivate.replaceUrl", () => replaceSessionUrl(session))
    focusComposerWhenReady({ origin: focusOrigin, sessionId: session.id })
    afterVisibleActivation(() => {
      if (serial !== sessionActivationSerial) return
      scheduleSidebarStatusPrime(session.id)
      const meta = claxedoState.meta.get(contentId)
      if (meta) props.onTabSelect?.(meta)
    })
  }
  const prepareSessionDrag = (session: Row) =>
    existingSessionContentId(session) ?? claxedoState.layout.openSession(
      sessionDirectory(session),
      session.id,
      sessionRowTitle(session.title),
      { focus: false, ...sessionOpenOptions(session) },
    )
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
    const existingId = existingSessionContentId(session)
    if (existingId && claxedoState.wb.state.contentIds.includes(existingId)) {
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
    const nextSession = nextSiblingAfterRemoval(rows, session.id)
    const archived = await props.onArchiveSession?.(session, nextSession?.id)
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
                <DropdownMenu.RadioGroup value={view().archived} onChange={(v) => { if (isArchive(v)) setArchive(v) }}>
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
    const selectedRouteId = () =>
      workspaceRouteId([input.project], input.workspaceDir) ??
      (input.workspaceDir === props.activeDirectory ? props.activeWorkspaceRouteId : undefined)
    const createTerminal = (command?: string, title?: string) =>
      props.onNewTerminal?.(input.workspaceDir, command, title, selectedRouteId())
    // Opened directly rather than through `onNewTerminal`: the creator is a
    // surface, not a pty, so it needs none of that action's pty plumbing.
    const openTerminalCreator = () => {
      const focusedId = claxedoState.wb.selectors.focusedContent()
      const focused = focusedId ? claxedoState.meta.get(focusedId) : undefined
      const routeId = selectedRouteId()
      const sessionId = terminalSessionIdForWorkspace(focused, {
        directory: input.workspaceDir,
        workspaceRouteId: routeId,
      })
      claxedoState.layout.openTerminal(input.workspaceDir, NEW_TERMINAL_ID, "New Terminal", {
        workspaceRouteId: routeId,
        ...(sessionId ? { sessionId } : {}),
      })
    }
    const mainWorkspace = () => input.workspaceDir === input.project.worktree
    const canMutateWorkspace = () => !workspace(input.project, input.workspaceDir).workspaceId || can("mutate.workspace", workspacePlacement(workspace(input.project, input.workspaceDir).workspaceId))

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
                props.onNewSession?.(input.workspaceDir, selectedRouteId())
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
                  createTerminal(getTerminalCommands().agents.claude, "Claude")
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
                  createTerminal(getTerminalCommands().agents.codex, "Codex")
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
              <Icon name="three-dots" size="small" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="z-[200]">
                <DropdownMenu.Item
                  onSelect={() => {
                    const item = {
                      ...input.project,
                      expanded: input.project.expanded ?? false,
                    }
                    void dialog.show(() => <DialogEditProject project={item} />)
                  }}
                >
                  <Icon name="pencil-line" size="small" />
                  Edit
                </DropdownMenu.Item>
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
      sort: SESSION_LIST_SORT_DEFAULT,
      limit: SESSION_GROUP_PAGE_SIZE,
    }))
    // Global Chat's sessions belong to no workspace, so the app's own central
    // server owns them — the same server a local or cloud workspace's list
    // comes from.
    const list = createRailSectionSessionList({
      baseUrl: () => globalSDK.url,
      source: () => centralSessionSource({ local: server.isLocal() }),
      query: globalSessionListQuery,
      archiveView: () => view().archived,
    })
    const sessionListLoadingMore = list.loadingMore
    const sessionListPageError = list.pageError
    const globalProject = createMemo<ProjectItem>(() => ({
      id: "global",
      worktree: section.worktree ?? "global",
      name: "Global Chat",
    }))
    const sectionRows = createMemo(() =>
      list.loaded() ? list.rows().map((item) => navigationSessionRow(item, globalProject(), "global")) : [])
    let visibleRows = sectionRows()
    createEffect(() => {
      visibleRows = open() ? sectionRows() : []
      registerVisibleSessionRows("global", visibleRows)
    })
    onCleanup(() => clearVisibleSessionRows("global", visibleRows))
    const more = list.more
    const count = list.count
    const loadingInitial = createMemo(() => !list.loaded() && list.isFetching() && sectionRows().length === 0)
    const errorInitial = createMemo(() => list.isError() && !list.isFetching())
    const emptyLoaded = createMemo(() => list.loaded() && sectionRows().length === 0)
    const doneLoaded = createMemo(() =>
      list.loaded() && sectionRows().length > 0 && !more() && count() <= sectionRows().length && count() > SESSION_GROUP_PAGE_SIZE
    )
    const loadMoreGlobalSessionList = () => list.loadMore(SESSION_GROUP_PAGE_SIZE)
    const reconcileArchivedSessionListRow = (item: SessionNavigationDisplayRow) =>
      list.reconcileArchived(item.source.sessionRef)

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
                onAction={() => list.retry()}
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
                onClick={(e) => {
                  void loadMoreGlobalSessionList()
                  e.currentTarget.blur()
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
    const sharedWorkspacesForMeta = useSharedWorkspaceIds()
    const workspaceMeta = createMemo(() => {
      const workspace = projectWorkspaceInfo(section.project, section.workspaceDir)
      return railWorkspaceMetaLabels({
        kind: runtime(),
        ...(workspaceStatusLabel(workspace) ? { status: workspaceStatusLabel(workspace) } : {}),
        ...(workspace?.role ? { role: workspace.role } : {}),
        ...(workspace?.hostOnline === undefined ? {} : { hostOnline: workspace.hostOnline }),
        // The row itself is the durable record of which workspaces a phone
        // can reach — not a transient toast.
        publishedByThisMachine: sharedWorkspacesForMeta.shared(
          workspaceRowId(section.project, section.workspaceDir),
        ),
        label: (key, role) => key === "role" ? language.t(workspaceRoleLabelKey(role)) : language.t(`sidebar.workspace.${key}`),
      })
    })
    // Every relay-backed workspace names its id here, not just a cloud one: it
    // is what a `session.created` frame off that workspace's stream is matched
    // against, and a user-hosted row carries the HOST's filesystem directory
    // rather than this section's `workspace:<id>` ref.
    const sessionListWorkspaceId = createMemo(() => isRelayBackedWorkspaceKind(runtime())
      ? workspaceRowId(section.project, section.workspaceDir)
      : undefined)
    const sessionListQuery = createMemo<SessionListQuery>(() => ({
      scope: "workspace",
      ...(sessionListWorkspaceId() ? { workspaceId: sessionListWorkspaceId() } : {}),
      directory: workspaceItem().directory,
      groupBy: "none",
      archived: view().archived,
      status: view().status,
      environment: view().environment,
      git: view().git,
      sort: SESSION_LIST_SORT_DEFAULT,
      limit: SESSION_GROUP_PAGE_SIZE,
    }))
    const [_open, setOpen] = createSignal(section.count > 0)
    const [autoOpened, setAutoOpened] = createSignal(section.count > 0)
    const [manuallyToggled, setManuallyToggled] = createSignal(false)
    const open = createMemo(() => _open())
    const list = createRailSectionSessionList({
      baseUrl: () => globalSDK.url,
      // The catalog row's kind, and nothing else, decides which server answers
      // for this workspace's sessions.
      source: () => sessionSourceForWorkspace({
        kind: runtime(),
        workspaceId: workspaceRowId(section.project, section.workspaceDir),
        projectId: section.project.id,
      }),
      query: sessionListQuery,
      archiveView: () => view().archived,
      enabled: open,
    })
    const sessionListLoadingMore = list.loadingMore
    const sessionListPageError = list.pageError
    const sectionRows = createMemo(() =>
      list.loaded() ? list.rows().map((item) => navigationSessionRow(item, section.project, section.workspaceDir)) : [])
    const visibleRowsKey = `workspace:${section.workspaceDir}`
    let visibleRows = sectionRows()
    createEffect(() => {
      visibleRows = open() ? sectionRows() : []
      registerVisibleSessionRows(visibleRowsKey, visibleRows)
    })
    onCleanup(() => clearVisibleSessionRows(visibleRowsKey, visibleRows))

    createEffect(() => {
      if (active()) setOpen(true)
    })

    const more = list.more
    const count = list.count
    const loadingInitial = createMemo(() => !list.loaded() && list.isFetching() && sectionRows().length === 0)
    const errorInitial = createMemo(() => list.isError() && !list.isFetching())
    const emptyLoaded = createMemo(() => list.loaded() && sectionRows().length === 0)
    const doneLoaded = createMemo(() =>
      list.loaded() && sectionRows().length > 0 && !more() && count() <= sectionRows().length && count() > SESSION_GROUP_PAGE_SIZE
    )
    const loadMoreWorkspaceSessionList = () => list.loadMore(SESSION_GROUP_PAGE_SIZE)
    const reconcileArchivedSessionListRow = (item: SessionNavigationDisplayRow) =>
      list.reconcileArchived(item.source.sessionRef)
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
              openWorkspacePanel(section.workspaceDir)
            }}
          >
            <span
              class="size-4 shrink-0 flex items-center justify-center relative" role="button" tabIndex={0}
              aria-label={open() ? "Collapse workspace" : "Expand workspace"} aria-expanded={open()}
              onClick={(e) => {
                e.stopPropagation()
                setManuallyToggled(true)
                setOpen(!_open())
              }}
              onKeyDown={(e: KeyboardEvent) => activateDisclosureFromKeyboard(e, () => {
                setManuallyToggled(true)
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
                onAction={() => list.retry()}
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
                onClick={(e) => {
                  void loadMoreWorkspaceSessionList()
                  e.currentTarget.blur()
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
    const [open, setOpen] = createSignal(section.count > 0 || projectMatches(section.project))
    const active = createMemo(() => projectMatches(section.project))
    const projectSessionListQuery = createMemo<SessionListQuery>(() => ({
      scope: "project",
      projectId: section.project.id,
      groupBy: "none",
      archived: view().archived,
      status: view().status,
      environment: view().environment,
      git: view().git,
      sort: SESSION_LIST_SORT_DEFAULT,
      limit: SESSION_GROUP_PAGE_SIZE,
    }))
    const list = createRailSectionSessionList({
      baseUrl: () => globalSDK.url,
      // A project section lists the sessions of ALL its workspaces, and those
      // do not share one server: the central one answers for the local and
      // cloud workspaces, each user-hosted workspace from its own runtime over
      // the relay.
      source: () => projectSessionSource({
        local: server.isLocal(),
        projectId: section.project.id,
        workspaces: section.project.workspaces,
      }),
      query: projectSessionListQuery,
      archiveView: () => view().archived,
      enabled: open,
    })
    const sessionListLoadingMore = list.loadingMore
    const sessionListPageError = list.pageError
    const sectionRows = createMemo(() =>
      list.loaded() ? list.rows().map((item) => navigationSessionRow(item, section.project, section.project.worktree)) : [])
    const visibleRowsKey = `project:${section.project.id}`
    let visibleRows = sectionRows()
    createEffect(() => {
      visibleRows = open() ? sectionRows() : []
      registerVisibleSessionRows(visibleRowsKey, visibleRows)
    })
    onCleanup(() => clearVisibleSessionRows(visibleRowsKey, visibleRows))
    const terminalItems = createMemo(() => terminalSurfaceRows({ directories: directories() }))
    const projectActionDirectory = createMemo(() => {
      return resolveProjectActionDirectory({
        directories: directories(),
        activeDirectory: props.activeDirectory,
        projectWorktree: section.project.worktree,
        workspaceIdForDirectory: (directory) => projectWorkspaceInfo(section.project, directory)?.workspaceId,
      })
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
    const more = list.more
    const count = list.count
    const loadingInitial = createMemo(() => !list.loaded() && list.isFetching() && sectionRows().length === 0)
    const errorInitial = createMemo(() => list.isError() && !list.isFetching())
    const emptyLoaded = createMemo(() => list.loaded() && sectionRows().length === 0)
    const doneLoaded = createMemo(() =>
      list.loaded() && sectionRows().length > 0 && !more() && count() <= sectionRows().length && count() > SESSION_GROUP_PAGE_SIZE
    )
    const loadMoreProjectSessionList = () => list.loadMore(SESSION_GROUP_PAGE_SIZE)
    const reconcileArchivedSessionListRow = (item: SessionNavigationDisplayRow) =>
      list.reconcileArchived(item.source.sessionRef)

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
              onClick={(e) => {
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
                onAction={() => list.retry()}
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
                onClick={(e) => {
                  void loadMoreProjectSessionList()
                  e.currentTarget.blur()
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
    const [open, setOpen] = createSignal(projectMatches(group.project) || group.items.some((item) => item.count > 0))
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
              onClick={(e) => {
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
          onOpenTasks={props.onOpenTasks}
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
            utilities={() => (
              <>
                {/* The switcher's org/team resources read under the shell-wide
                    Suspense boundary; without a local boundary, OPENING the
                    account menu suspended the entire shell. Loading here means
                    the submenu rows simply pop in. */}
                <Suspense fallback={null}>
                  <RailOrgTeamSwitcher />
                </Suspense>
                <FilterMenu />
              </>
            )}
          />
        </div>
      </div>
    </nav>
  )
}
