/**
 * ClaxedoLayout - Custom layout component for Rail + Tab UI
 *
 * This replaces the default Layout when registered via the extension system.
 * It provides the Rail sidebar and Tab bar UI with Project > Workspace > Session hierarchy.
 *
 * Note: ClaxedoLayout is at app level (outside DirectoryLayout/SDKProvider),
 * so it cannot directly access terminal context. Terminal tab creation is
 * coordinated via claxedo layout state and rendered through multi-pane leaves.
 */

import "./claxedo-layout.css"
import { createSignal, createMemo, createEffect, on, Show, For, type ParentProps } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import type { Session, UserMessage } from "@opencode-ai/sdk/v2"
import {
  useLayout,
  type LocalProject,
  useGlobalSync,
  useGlobalSDK,
  usePlatform,
  useLanguage,
} from "@opencode-ai/claxedo-app"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Toast, showToast } from "@opencode-ai/ui/toast"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { Popover } from "@opencode-ai/ui/popover"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { base64Decode, base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { validWorktree } from "@claxedo/utils/worktree"

// Import directly from source files to avoid circular dependency
// (index.tsx exports ClaxedoLayout, so we can't import from index here)
import { RailLayoutInner } from "./layouts/rail-layout"
import type { ProjectItem } from "./layouts/rail-sidebar"
import { useClaxedoLayout, ClaxedoLayoutProvider } from "./context/claxedo-layout"
import { useCommand } from "@/context/command"
import { useConfigOptional } from "../context/config"
import { createDebugLogger } from "../overrides/utils/debug"
import { createClaxedoLayoutActions } from "./claxedo-layout-actions"
import type { ReviewMode } from "./context/claxedo-layout/types"
import { createRouteIntentAdapter } from "./context/claxedo-layout/route-intent"
import { buildTabContextSnapshot, createTabContextSyncAdapter } from "./context/claxedo-layout/tab-context-sync"
import {
  createReviewIntentAdapter,
  REVIEW_POPOVER_MODES,
  pickPreviewSessionId,
  sumChanges,
  type ReviewPopoverMode,
  type ReviewModeStats,
} from "./context/claxedo-layout/review-intent"

import { useAgentHooks } from "../agent-hooks/listener"

function decodeDir(encoded: string | undefined) {
  if (!encoded) return
  try {
    const decoded = base64Decode(encoded)
    if (!validWorktree(decoded)) return
    return decoded
  } catch {
    return
  }
}

/**
 * Convert upstream LocalProject to Claxedo ProjectItem
 */
function projectToProjectItem(project: LocalProject): ProjectItem {
  return {
    id: project.id ?? project.worktree,
    worktree: project.worktree,
    name: project.name,
    icon: project.icon,
    expanded: project.expanded,
    sandboxes: project.sandboxes,
    commands: project.commands,
  }
}

const REVIEW_MODE_LABEL: Record<ReviewMode, string> = {
  "session-turn": "Session turn",
  session: "Session",
  staged: "Staged",
  committed: "Committed",
  uncommitted: "Uncommitted",
  "vs-base": "vs base (legacy)",
  "to-from": "to / from",
}

const extractErrorMessage = (input: unknown): string | undefined => {
  if (!input) return undefined
  if (typeof input === "string" && input.trim()) return input
  if (input instanceof Error && input.message.trim()) return input.message
  if (typeof input !== "object") return undefined

  if ("message" in input && typeof input.message === "string" && input.message.trim()) return input.message
  if ("detail" in input && typeof input.detail === "string" && input.detail.trim()) return input.detail
  if ("error" in input) {
    const nested = extractErrorMessage(input.error)
    if (nested) return nested
  }
  if ("data" in input) {
    const nested = extractErrorMessage(input.data)
    if (nested) return nested
  }
  if ("issues" in input && Array.isArray(input.issues) && input.issues.length > 0) {
    const first = input.issues[0]
    const nested = extractErrorMessage(first)
    if (nested) return nested
  }
  if ("errors" in input && Array.isArray(input.errors) && input.errors.length > 0) {
    const first = input.errors[0]
    const nested = extractErrorMessage(first)
    if (nested) return nested
  }
  return undefined
}

const extractStatusCode = (input: unknown): number | undefined => {
  if (!input || typeof input !== "object") return undefined
  const obj = input as Record<string, unknown>
  if (typeof obj.status === "number") return obj.status
  if (typeof obj.statusCode === "number") return obj.statusCode
  if ("data" in obj && obj.data && typeof obj.data === "object") {
    const data = obj.data as Record<string, unknown>
    if (typeof data.statusCode === "number") return data.statusCode
    if (typeof data.status === "number") return data.status
  }
  return undefined
}

const safeStringify = (input: unknown) => {
  try {
    const raw = JSON.stringify(input)
    if (!raw) return String(input)
    if (raw.length <= 500) return raw
    return `${raw.slice(0, 500)}...`
  } catch {
    return String(input)
  }
}

const formatErrorMessage = (input: unknown, fallback = "Request failed") => {
  const message = extractErrorMessage(input)
  const status = extractStatusCode(input)
  if (message && status) return `${message} (${status})`
  if (message) return message
  if (status) return `${fallback} (${status})`
  if (typeof input === "object" && input) {
    const obj = input as Record<string, unknown>
    if (typeof obj.name === "string" && obj.name.trim()) return `${fallback} (${obj.name})`
  }
  return fallback
}

const debugErrorShape = (input: unknown) => {
  if (!input || typeof input !== "object") {
    return {
      type: typeof input,
      value: String(input),
    }
  }
  const obj = input as Record<string, unknown>
  const data = typeof obj.data === "object" && obj.data ? (obj.data as Record<string, unknown>) : undefined
  const nested = typeof obj.error === "object" && obj.error ? (obj.error as Record<string, unknown>) : undefined
  return {
    keys: Object.keys(obj),
    name: typeof obj.name === "string" ? obj.name : undefined,
    message: extractErrorMessage(input),
    statusCode: extractStatusCode(input),
    status: typeof obj.status === "number" ? obj.status : undefined,
    statusText: typeof obj.statusText === "string" ? obj.statusText : undefined,
    hasError: "error" in obj,
    hasData: "data" in obj,
    dataKeys: data ? Object.keys(data) : undefined,
    errorKeys: nested ? Object.keys(nested) : undefined,
    errorType: typeof obj.error,
    dataType: typeof obj.data,
    causeType: typeof obj.cause,
    raw: safeStringify(input),
  }
}

/**
 * Bridge component that syncs upstream state with Claxedo state
 */
function ClaxedoStateBridge(props: ParentProps) {
  const claxedo = useClaxedoLayout()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const params = useParams()
  const navigate = useNavigate()
  const debug = createDebugLogger("layout.state-bridge", "layout:bridge", {
    legacyKey: "opencode.debug.terminal",
  })

  // Set up agent lifecycle listeners for tab status indicators
  useAgentHooks()

  const workspaceId = createMemo(() => decodeDir(params.dir))
  const tabId = createMemo(() => params.tabId)
  const sessionId = createMemo(() => params.id)
  const pageId = createMemo(() => params.pageId)

  const route = createRouteIntentAdapter({
    claxedo,
    globalSync,
    globalSDK,
    navigate,
    log: (event, payload) => {
      debug.log(event, payload)
    },
  })

  const sessionTitle = createMemo(() => {
    const wsId = workspaceId()
    const id = sessionId()
    if (!wsId || !id) return ""
    const [store] = globalSync.child(wsId)
    const session = store.session.find((s: Session) => s.id === id && s.directory === wsId)
    return session?.title ?? ""
  })

  const sessionBadge = createMemo(() => {
    const wsId = workspaceId()
    const id = sessionId()
    if (!wsId || !id) return undefined
    const [store] = globalSync.child(wsId)
    const session = store.session.find((s: Session) => s.id === id && s.directory === wsId)
    const summary = session?.summary
    if (!summary) return undefined
    return {
      additions: summary.additions ?? 0,
      deletions: summary.deletions ?? 0,
    }
  })
  const sessionBadgeAdditions = createMemo(() => sessionBadge()?.additions ?? 0)
  const sessionBadgeDeletions = createMemo(() => sessionBadge()?.deletions ?? 0)
  const sessionHasBadge = createMemo(() => !!sessionBadge())

  // Combined effect to handle workspace and session sync together
  createEffect(
    on(
      () =>
        [
          claxedo.ready(),
          workspaceId(),
          tabId(),
          sessionId(),
          pageId(),
          sessionTitle(),
          sessionHasBadge(),
          sessionBadgeAdditions(),
          sessionBadgeDeletions(),
        ] as const,
      ([ready, wsId, tid, id, pid, title, hasBadge, additions, deletions]) => {
        route.receive({
          ready,
          workspaceId: wsId,
          tabId: tid,
          sessionId: id,
          pageId: pid,
          sessionTitle: title,
          sessionBadge: hasBadge ? { additions, deletions } : undefined,
        })
      },
    ),
  )

  return <>{props.children}</>
}

/**
 * ClaxedoLayoutContent - The actual layout content
 */
function ClaxedoLayoutContent(props: ParentProps) {
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const params = useParams()
  const navigate = useNavigate()
  const claxedo = useClaxedoLayout()
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const command = useCommand()
  const language = useLanguage()
  const config = useConfigOptional()
  const flowDebug = createDebugLogger("terminal.flow", "terminal:flow", {
    legacyKey: "opencode.debug.terminal",
  })
  const flowLog = (...args: unknown[]) => flowDebug.log(...args)
  const debug = createDebugLogger("layout.tabs", "layout:tabs", {
    legacyKey: "opencode.debug.terminal",
  })

  // Register process pane command
  command.register(() => [
    {
      id: "processPane.toggle",
      title: "Toggle Process Pane",
      category: "View",
      keybind: "mod+shift+;",
      onSelect: () => claxedo.processPane.requestToggle(),
    },
  ])

  // Convert projects to ProjectItems
  const projects = createMemo(() => {
    const projectList = layout.projects.list()
    return projectList.map(projectToProjectItem)
  })

  const activeTab = createMemo(() => claxedo.topTabs.active())

  // Current workspace from URL.
  const routeWorkspaceId = createMemo(() => {
    if (!params.dir) return undefined
    return decodeDir(params.dir)
  })

  // Active workspace for Claxedo UI actions prefers the active tab's directory.
  // This keeps terminal/file tabs decoupled from transient route state.
  const activeWorkspaceId = createMemo(() => {
    const tabDir = activeTab()?.directory
    if (tabDir && tabDir !== "__pages__") return tabDir
    return routeWorkspaceId()
  })

  // Get active project (the project that contains the current workspace)
  const activeProjectId = createMemo(() => {
    const dir = activeWorkspaceId()
    if (!dir) return undefined

    const project = layout.projects.list().find((p) => p.worktree === dir || p.sandboxes?.includes(dir))
    return project?.worktree
  })

  // Per-group layout for focused group (file tree + review panel are per-group)
  const focusedGroupLayout = createMemo(() => claxedo.groupLayout(claxedo.split.focusedId()!))

  // Initialize sync for the active workspace eagerly (no wait for globalSync)
  createEffect(() => {
    const dir = activeWorkspaceId()
    if (!dir) return
    globalSync.child(dir)
  })

  // Auto-open project when navigating to a workspace that isn't in the sidebar yet.
  // Must wait for globalSync.ready so rootFor() can resolve sandboxes to their parent project
  // — otherwise a sandbox directory gets added as a top-level project.
  createEffect(() => {
    if (!globalSync.ready) return
    const dir = activeWorkspaceId()
    if (!dir) return
    const existing = layout.projects.list().find((p) => p.worktree === dir || p.sandboxes?.includes(dir))
    if (existing) return
    layout.projects.open(dir)
  })

  // Auto-select main workspace when no workspace is selected.
  // Uses on() so the callback body is untracked — store reads inside
  // setPinned/setDefault/child don't become dependencies of this effect.
  createEffect(
    on(
      () => ({ dir: params.dir, projects: layout.projects.list() }),
      ({ dir, projects }) => {
        if (dir) return
        if (!projects.length) return
        const mainWorktree = projects[0].worktree
        if (!mainWorktree) return

        claxedo.worktree.setPinned(null)
        claxedo.worktree.setDefault(mainWorktree)
        globalSync.child(mainWorktree)
        const existing = claxedo.topTabs.orderedItems().find((tab) => tab.directory === mainWorktree)
        const tabId = existing?.id ?? claxedo.topTabs.addSession(mainWorktree, "new", "New Session")
        if (tabId) {
          claxedo.topTabs.setActive(tabId)
          queueMicrotask(() => navigate(`/${base64Encode(mainWorktree)}/tab/${tabId}`, { replace: true }))
        }
      },
    ),
  )

  // Sidebar selection should be driven by the active tab, not the URL.
  // When non-session tabs (terminal/file) are active, we intentionally clear the session highlight.
  const activeSessionId = createMemo(() => {
    const tab = activeTab()
    if (!tab) return params.id
    if (tab.type === "session" || tab.type === "review" || tab.type === "context") {
      if (!tab.sessionId) return undefined
      if (tab.sessionId === "new") return undefined
      return tab.sessionId
    }
    return undefined
  })

  // Ensure we always have an active tab when a directory route is open.
  // One-shot on initial mount/restore only. Do not recreate tabs after
  // users intentionally close the last tab.
  const [initialTabEnsured, setInitialTabEnsured] = createSignal(false)
  createEffect(() => {
    const dir = activeWorkspaceId()
    if (!dir) return
    if (initialTabEnsured()) return
    if (claxedo.topTabs.activeId()) {
      setInitialTabEnsured(true)
      return
    }
    if (params.tabId) {
      setInitialTabEnsured(true)
      return
    }
    if (params.id) {
      setInitialTabEnsured(true)
      return
    }
    if (params.pageId) {
      setInitialTabEnsured(true)
      return
    }
    const id = claxedo.topTabs.addSession(dir, "new", "New Session")
    if (id) claxedo.topTabs.setActive(id)
    setInitialTabEnsured(true)
  })

  const {
    handleProjectSelect,
    handleWorkspaceSelect,
    handleSessionSelect,
    handleNewProject,
    handleNewWorkspace,
    handleSettings,
    handleHelp,
    handleNewSession,
    handleDeleteSession,
    handleArchiveSession,
    handleDeleteWorkspace,
    handleRemoveProject,
    handleNewTerminal,
    handleNewPage,
    handleTabSelect,
  } = createClaxedoLayoutActions({
    params,
    navigate: (path) => navigate(path),
    claxedo,
    dialog,
    globalSync,
    globalSDK,
    layout,
    platform,
    config,
    projects,
    activeWorkspaceId,
    activeProjectId,
    flowLog,
  })

  const reviewTitle = (mode: ReviewMode) => `Review: ${REVIEW_MODE_LABEL[mode]}`

  const activeGroupContext = () => {
    const groupId = claxedo.split.focusedId()
    if (!groupId) return
    const tabs = claxedo.groupTabs(groupId)
    const wt = claxedo.groupWorktree(groupId)
    const active = tabs.active()
    const tabDir = active?.directory
    const directory = tabDir && tabDir !== "__pages__" ? tabDir : (wt.default() ?? activeWorkspaceId())
    if (!directory) return
    const sessionID =
      active?.type === "session" && active.sessionId && active.sessionId !== "new" ? active.sessionId : undefined
    return { groupId, tabs, directory, sessionID, activeType: active?.type }
  }

  const tabContextSync = createTabContextSyncAdapter({
    sdkUrl: () => globalSDK.url,
    request: platform.fetch ?? fetch,
  })

  const tabContext = createMemo(() => {
    const ctx = activeGroupContext()
    if (!ctx) return
    const tab = ctx.tabs.active()
    if (!tab) return

    return buildTabContextSnapshot({
      groupId: ctx.groupId,
      tab,
      layout: claxedo.multiPane.activeLayout(tab.id),
    })
  })

  createEffect(
    on(
      tabContext,
      (snapshot) => {
        tabContextSync.push(snapshot)
      },
      { defer: true },
    ),
  )

  const sourceSessionMeta = createMemo(() => {
    const ctx = activeGroupContext()
    if (!ctx?.sessionID) return
    const [store] = globalSync.child(ctx.directory)
    const session = store.session.find((s: Session) => s.id === ctx.sessionID)
    const title = session?.title ?? "Session"
    const sessionDiffs = store.session_diff[ctx.sessionID] ?? []
    const sessionCount = session?.summary?.files ?? sessionDiffs.length
    const sessionChanges = {
      additions: session?.summary?.additions ?? sumChanges(sessionDiffs).additions,
      deletions: session?.summary?.deletions ?? sumChanges(sessionDiffs).deletions,
    }
    const users = (store.message[ctx.sessionID] ?? []).filter((msg): msg is UserMessage => msg.role === "user")
    const turnDiffs = users.at(-1)?.summary?.diffs ?? []
    const turnCount = turnDiffs.length
    const turnChanges = sumChanges(turnDiffs)
    return { title, sessionCount, turnCount, sessionChanges, turnChanges }
  })

  const reviewWorkspaces = createMemo(() => {
    const current = activeGroupContext()?.directory
    const seen = new Set<string>()
    const list = projects()
      .flatMap((project) => {
        const dirs = [project.worktree, ...(project.sandboxes ?? []).filter((dir) => dir !== project.worktree)]
        return dirs.map((directory) => {
          const isMain = directory === project.worktree
          return {
            directory,
            label: `${project.name || getFilename(project.worktree)} / ${isMain ? "main" : getFilename(directory)}`,
          }
        })
      })
      .filter((item) => {
        if (seen.has(item.directory)) return false
        seen.add(item.directory)
        return true
      })
    if (!current) return list
    return [...list].sort((a, b) => {
      if (a.directory === current) return -1
      if (b.directory === current) return 1
      return a.label.localeCompare(b.label)
    })
  })
  const worktreeLabel = (directory: string | undefined) => {
    if (!directory) return "Select worktree"
    return reviewWorkspaces().find((item) => item.directory === directory)?.label ?? getFilename(directory)
  }

  const [reviewMode, setReviewMode] = createSignal<ReviewPopoverMode>("session-turn")
  const [reviewWorktree, setReviewWorktree] = createSignal("")
  const [reviewPopoverOpen, setReviewPopoverOpen] = createSignal(false)
  const [reviewBasePreset, setReviewBasePreset] = createSignal("")
  const [reviewBranch, setReviewBranch] = createSignal("")
  const [reviewFromRef, setReviewFromRef] = createSignal("HEAD~1")
  const [reviewToRef, setReviewToRef] = createSignal("HEAD")
  const [reviewSubmitting, setReviewSubmitting] = createSignal(false)
  const [reviewBaseDefault, setReviewBaseDefault] = createSignal("")
  const [reviewBaseCandidates, setReviewBaseCandidates] = createSignal<string[]>([])
  const [reviewBaseLoading, setReviewBaseLoading] = createSignal(false)
  const [reviewBaseError, setReviewBaseError] = createSignal("")
  const [reviewStats, setReviewStats] = createSignal<Partial<Record<ReviewPopoverMode, ReviewModeStats>>>({})

  const activeReviewContext = createMemo(() => activeGroupContext())
  const activeSessionAvailable = createMemo(
    () => activeReviewContext()?.activeType === "session" && !!activeReviewContext()?.sessionID,
  )
  const visibleReviewModes = createMemo<ReviewPopoverMode[]>(() => {
    if (activeSessionAvailable()) return [...REVIEW_POPOVER_MODES]
    return REVIEW_POPOVER_MODES.filter((mode) => mode !== "session-turn" && mode !== "session")
  })

  const committedFromRef = createMemo(() => {
    const custom = reviewBranch().trim()
    if (custom) return custom
    const preset = reviewBasePreset().trim()
    if (preset) return preset
    const auto = reviewBaseDefault().trim()
    if (auto) return auto
    return undefined
  })

  const reviewIntent = createReviewIntentAdapter({
    session: globalSDK.client.session,
    formatError: (error) => formatErrorMessage(error),
    debugErrorShape,
    log: (event, payload) => {
      debug.log(event, payload)
    },
  })

  const patchReviewStats = (mode: ReviewPopoverMode, patch: Partial<ReviewModeStats>) => {
    setReviewStats((prev) => {
      const current = prev[mode] ?? { additions: 0, deletions: 0, files: 0, loading: false, ready: false }
      return {
        ...prev,
        [mode]: {
          ...current,
          ...patch,
        },
      }
    })
  }

  const loadReviewBaseTargets = async (directory: string) => {
    const ctx = activeReviewContext()
    setReviewBaseLoading(true)
    setReviewBaseError("")
    const result = await reviewIntent.loadBaseTargets({
      directory,
      mode: reviewMode(),
      reviewWorktree: reviewWorktree(),
      context: ctx,
      activeWorkspaceId: activeWorkspaceId(),
      activeSessionId: activeSessionId(),
      routeDir: decodeDir(params.dir),
      routeTabId: params.tabId,
      routeSessionId: params.id,
    })
    if (result.kind === "stale") return
    if (result.kind !== "ok") {
      setReviewBaseDefault("")
      setReviewBaseCandidates([])
      if (result.kind === "error") setReviewBaseError(result.message ?? "")
      setReviewBaseLoading(false)
      return
    }
    setReviewBaseDefault(result.defaultRef)
    setReviewBaseCandidates(result.candidates)
    setReviewBaseLoading(false)
  }

  const handleReviewPopoverOpenChange = (open: boolean) => {
    setReviewPopoverOpen(open)
    debug.log("review popover open change", {
      open,
      focusedGroupId: claxedo.split.focusedId(),
      activeTabId: claxedo.topTabs.activeId(),
      activeTabType: claxedo.topTabs.active()?.type,
    })
    if (!open) return
    const ctx = activeReviewContext()
    if (ctx?.directory) setReviewWorktree(ctx.directory)
    setReviewMode(activeSessionAvailable() ? "session-turn" : "uncommitted")
    setReviewBasePreset("")
    setReviewBranch("")
    setReviewFromRef("HEAD~1")
    setReviewToRef("HEAD")
    debug.log("review popover opened", {
      contextDirectory: ctx?.directory,
      contextSessionID: ctx?.sessionID,
      contextGroupID: ctx?.groupId,
      contextActiveType: ctx?.activeType,
      defaultMode: activeSessionAvailable() ? "session-turn" : "uncommitted",
      visibleModes: visibleReviewModes(),
      activeWorkspaceId: activeWorkspaceId(),
      activeSessionId: activeSessionId(),
      routeDir: decodeDir(params.dir),
      routeTabId: params.tabId,
      routeSessionId: params.id,
    })
  }

  createEffect(() => {
    if (!reviewPopoverOpen()) return
    if (!visibleReviewModes().includes("committed")) return
    const directory = reviewWorktree().trim() || activeReviewContext()?.directory
    if (!directory) return
    void loadReviewBaseTargets(directory)
  })

  createEffect(() => {
    const visible = visibleReviewModes()
    if (visible.includes(reviewMode())) return
    if (visible.includes("uncommitted")) {
      setReviewMode("uncommitted")
      return
    }
    if (visible[0]) setReviewMode(visible[0])
  })

  const previewSessionID = createMemo(() => {
    const ctx = activeReviewContext()
    const directory = reviewWorktree().trim() || ctx?.directory
    if (!directory) return undefined
    if (ctx?.sessionID) return ctx.sessionID
    const [store] = globalSync.child(directory)
    return pickPreviewSessionId({
      directory,
      sessions: store.session,
      preferred: ctx?.sessionID,
    })
  })

  createEffect(() => {
    if (!reviewPopoverOpen()) return
    reviewIntent.clearHiddenModeStats({
      allModes: REVIEW_POPOVER_MODES,
      visibleModes: visibleReviewModes(),
      patch: patchReviewStats,
    })
  })

  createEffect(() => {
    if (!reviewPopoverOpen()) return
    reviewIntent.syncSessionModeStats({
      visibleModes: visibleReviewModes(),
      source: sourceSessionMeta(),
      patch: patchReviewStats,
    })
  })

  createEffect(() => {
    if (!reviewPopoverOpen()) return
    reviewIntent.refreshDiffModeStats({
      modes: visibleReviewModes().filter((mode) => mode !== "session" && mode !== "session-turn"),
      directory: reviewWorktree().trim() || activeReviewContext()?.directory,
      sessionID: previewSessionID(),
      committed: committedFromRef(),
      from: reviewFromRef().trim(),
      to: reviewToRef().trim(),
      context: activeReviewContext(),
      patch: patchReviewStats,
    })
  })

  const autoBaseLabel = createMemo(() => {
    if (reviewBaseDefault()) return `Auto (${reviewBaseDefault()})`
    if (reviewBaseLoading()) return "Auto (detecting...)"
    if (reviewBaseError()) return "Auto (unavailable)"
    return "Auto"
  })

  const modeStats = (mode: ReviewPopoverMode) => reviewStats()[mode]
  const modeStatsTitle = (mode: ReviewPopoverMode) => {
    const stats = modeStats(mode)
    if (!stats?.error) return undefined
    return stats.error
  }

  const renderModeStats = (mode: ReviewPopoverMode) => {
    const stats = modeStats(mode)
    if (stats?.loading) {
      return <span class="text-12-regular text-text-weak">...</span>
    }
    if (stats?.ready) {
      return (
        <span class="flex items-center gap-1 text-12-medium">
          <span class="text-green-400" style={{ color: "#4ade80" }}>
            +{stats.additions}
          </span>
          <span class="text-red-400" style={{ color: "#f87171" }}>
            -{stats.deletions}
          </span>
        </span>
      )
    }
    if (stats?.error) {
      return <span class="text-12-medium text-text-danger">!</span>
    }
    return <span class="text-12-regular text-text-weak">--</span>
  }

  const canOpenReview = createMemo(() => {
    const ctx = activeReviewContext()
    if (!ctx) return false
    const mode = reviewMode()
    if (mode === "session" || mode === "session-turn") return !!ctx.sessionID
    if (!reviewWorktree().trim()) return false
    if (mode === "to-from") return !!reviewFromRef().trim() && !!reviewToRef().trim()
    if (mode === "committed") return !!committedFromRef()
    return true
  })

  createEffect(() => {
    const ctx = activeReviewContext()
    if (!ctx?.directory) return
    if (reviewWorktree().trim()) return
    setReviewWorktree(ctx.directory)
  })

  const openReview = async (mode: ReviewMode, fromRef?: string, toRef?: string, targetDirectory?: string) => {
    const ctx = activeReviewContext()
    if (!ctx) return
    const directory = targetDirectory ?? ctx.directory
    const pickSessionID = (preferred?: string) => {
      const [store] = globalSync.child(directory)
      return pickPreviewSessionId({
        directory,
        sessions: store.session,
        preferred,
      })
    }
    debug.log("open review requested", {
      mode,
      fromRef,
      toRef,
      groupId: ctx.groupId,
      directory,
      sourceSessionId: ctx.sessionID,
    })

    let sessionID = ctx.sessionID
    if (mode === "session" || mode === "session-turn") {
      if (!sessionID) return
    } else {
      sessionID = pickSessionID(ctx.sessionID)
      if (sessionID) {
        debug.log("review session reused", { mode, directory, sessionID })
      } else {
        const created = await globalSDK.client.session.create({
          directory,
          title: reviewTitle(mode),
        })
        sessionID = created.data?.id
        debug.log("review session created", { mode, directory, sessionID })
      }
      if (!sessionID) return
    }

    const [store] = globalSync.child(directory)
    const session = store.session.find((s: Session) => s.id === sessionID)
    const title = session?.title ?? reviewTitle(mode)
    const badge = session?.summary
      ? {
          additions: session.summary.additions ?? 0,
          deletions: session.summary.deletions ?? 0,
        }
      : undefined

    const tabId = ctx.tabs.addReview(directory, sessionID, title, badge, mode, fromRef, toRef)
    debug.log("review tab opened", {
      mode,
      fromRef,
      toRef,
      directory,
      sessionID,
      tabId,
    })
    if (tabId) {
      ctx.tabs.setActive(tabId)
      queueMicrotask(() => navigate(`/${base64Encode(directory)}/tab/${tabId}`))
    }
  }

  const openReviewFromPanel = async () => {
    if (reviewSubmitting()) return
    const mode = reviewMode()
    const dir = reviewWorktree().trim() || activeReviewContext()?.directory
    if ((mode === "session" || mode === "session-turn") && !activeReviewContext()?.sessionID) return
    if (mode !== "session" && mode !== "session-turn" && !dir) return

    setReviewSubmitting(true)
    setReviewPopoverOpen(false)
    try {
      if (mode === "session" || mode === "session-turn") {
        await openReview(mode)
        return
      }
      if (mode === "staged") {
        await openReview(mode, undefined, undefined, dir)
        return
      }
      if (mode === "uncommitted") {
        await openReview(mode, undefined, undefined, dir)
        return
      }
      if (mode === "committed") {
        const from = committedFromRef()
        if (!from) return
        await openReview(mode, from, "HEAD", dir)
        return
      }
      const from = reviewFromRef().trim()
      const to = reviewToRef().trim()
      if (!from || !to) return
      await openReview("to-from", from, to, dir)
    } catch (error) {
      showToast({
        title: language.t("common.requestFailed"),
        description: formatErrorMessage(error, language.t("common.requestFailed")),
      })
    } finally {
      setReviewSubmitting(false)
    }
  }

  return (
    <>
      <RailLayoutInner
        projects={projects()}
        activeProjectId={activeProjectId()}
        activeWorkspaceId={activeWorkspaceId()}
        activeSessionId={activeSessionId()}
        homedir={globalSync.data.path.home}
        onProjectSelect={handleProjectSelect}
        onWorkspaceSelect={handleWorkspaceSelect}
        onSessionSelect={handleSessionSelect}
        onNewProject={handleNewProject}
        onNewWorkspace={handleNewWorkspace}
        onSettings={handleSettings}
        onHelp={handleHelp}
        onNewSession={handleNewSession}
        onNewTerminal={handleNewTerminal}
        onNewPage={handleNewPage}
        onTabSelect={handleTabSelect}
        onDeleteSession={handleDeleteSession}
        onArchiveSession={handleArchiveSession}
        onDeleteWorkspace={handleDeleteWorkspace}
        onRemoveProject={handleRemoveProject}
        // titlebar={<Titlebar />}
        topBarRight={() => (
          <div class="flex items-center gap-3">
            <Show when={params.dir && activeReviewContext()?.activeType !== "page"}>
              <Popover
                placement="bottom-end"
                open={reviewPopoverOpen()}
                onOpenChange={handleReviewPopoverOpenChange}
                trigger={<Icon size="small" name="layout-right" />}
                triggerAs="button"
                triggerProps={{
                  class:
                    "group/review-toggle size-6 p-0 flex items-center justify-center rounded hover:bg-surface-base-hover",
                  "aria-label": language.t("command.review.toggle"),
                  onPointerDown: (event) => event.stopPropagation(),
                }}
                class="w-[360px] [&_[data-slot=popover-body]]:p-3"
              >
                <div class="flex flex-col gap-3">
                  <div class="text-12-medium text-text-weak">Review changes</div>

                  <div class="flex flex-col gap-1">
                    <div class="text-12-medium text-text-weak">Mode</div>
                    <div class="flex flex-col gap-1">
                      <For each={visibleReviewModes()}>
                        {(mode) => (
                          <button
                            type="button"
                            class="h-8 rounded-md border px-2 text-12-medium"
                            classList={{
                              "border-border-weak-base bg-background-base text-text-base": reviewMode() !== mode,
                              "border-border-strong-base bg-surface-base-hover text-text-strong": reviewMode() === mode,
                            }}
                            onClick={() => setReviewMode(mode)}
                            title={modeStatsTitle(mode)}
                          >
                            <span class="flex items-center justify-between gap-3">
                              <span>{REVIEW_MODE_LABEL[mode]}</span>
                              {renderModeStats(mode)}
                            </span>
                          </button>
                        )}
                      </For>
                    </div>
                  </div>

                  <Show when={reviewMode() === "session-turn" || reviewMode() === "session"}>
                    <div class="rounded-md border border-border-weak-base px-3 py-2 flex items-center justify-between gap-3">
                      <div class="min-w-0 text-12-medium text-text-weak truncate">
                        {sourceSessionMeta()?.title ?? "Session"}
                      </div>
                    </div>
                  </Show>

                  <Show when={reviewMode() !== "session" && reviewMode() !== "session-turn"}>
                    <div class="flex flex-col gap-3">
                      <div class="flex flex-col gap-1">
                        <div class="text-12-medium text-text-weak">Worktree</div>
                        <select
                          class="h-8 rounded-md border border-border-weak-base bg-background-base px-2 text-13-regular"
                          value={reviewWorktree()}
                          onInput={(event) => setReviewWorktree(event.currentTarget.value)}
                        >
                          <option value="">{worktreeLabel(undefined)}</option>
                          <For each={reviewWorkspaces()}>
                            {(ws) => <option value={ws.directory}>{ws.label}</option>}
                          </For>
                        </select>
                      </div>

                      <Show when={reviewMode() === "committed"}>
                        <div class="flex flex-col gap-2">
                          <div class="flex flex-col gap-1">
                            <div class="text-12-medium text-text-weak">Base target</div>
                            <select
                              class="h-8 rounded-md border border-border-weak-base bg-background-base px-2 text-13-regular"
                              value={reviewBasePreset()}
                              onInput={(event) => setReviewBasePreset(event.currentTarget.value)}
                            >
                              <option value="">{autoBaseLabel()}</option>
                              <For each={reviewBaseCandidates()}>{(ref) => <option value={ref}>{ref}</option>}</For>
                            </select>
                            <Show when={reviewBaseLoading()}>
                              <div class="text-11-regular text-text-weak">Detecting base targets...</div>
                            </Show>
                            <Show when={!reviewBaseLoading() && reviewBaseError()}>
                              <div class="text-11-regular text-text-danger">
                                Failed to detect base targets: {reviewBaseError()}
                              </div>
                            </Show>
                          </div>
                          <div class="flex flex-col gap-1">
                            <div class="text-12-medium text-text-weak">Custom base ref (optional)</div>
                            <input
                              class="h-8 rounded-md border border-border-weak-base bg-background-base px-2 text-13-regular"
                              value={reviewBranch()}
                              onInput={(event) => setReviewBranch(event.currentTarget.value)}
                              placeholder={reviewBaseDefault() ? `Auto: ${reviewBaseDefault()}` : "dev"}
                            />
                          </div>
                        </div>
                      </Show>

                      <Show when={reviewMode() === "to-from"}>
                        <div class="grid grid-cols-2 gap-2">
                          <div class="flex flex-col gap-1">
                            <div class="text-12-medium text-text-weak">From</div>
                            <input
                              class="h-8 rounded-md border border-border-weak-base bg-background-base px-2 text-13-regular"
                              value={reviewFromRef()}
                              onInput={(event) => setReviewFromRef(event.currentTarget.value)}
                              placeholder="HEAD~1"
                            />
                          </div>
                          <div class="flex flex-col gap-1">
                            <div class="text-12-medium text-text-weak">To</div>
                            <input
                              class="h-8 rounded-md border border-border-weak-base bg-background-base px-2 text-13-regular"
                              value={reviewToRef()}
                              onInput={(event) => setReviewToRef(event.currentTarget.value)}
                              placeholder="HEAD"
                            />
                          </div>
                        </div>
                      </Show>
                    </div>
                  </Show>

                  <div class="flex justify-end">
                    <Button
                      variant="primary"
                      size="small"
                      disabled={!canOpenReview() || reviewSubmitting()}
                      onClick={() => void openReviewFromPanel()}
                    >
                      {reviewSubmitting() ? "Opening..." : "Open Review"}
                    </Button>
                  </div>
                </div>
              </Popover>
            </Show>
            <Show when={params.dir}>
              <TooltipKeybind
                title={language.t("command.fileTree.toggle")}
                keybind={command.keybind("fileTree.toggle")}
              >
                <Button
                  variant="ghost"
                  class="group/file-tree-toggle size-6 p-0"
                  onClick={() => {
                    const gl = focusedGroupLayout()
                    gl.fileTree.setOpened(!gl.fileTree.opened())
                  }}
                  aria-label={language.t("command.fileTree.toggle")}
                  aria-expanded={focusedGroupLayout().fileTree.opened()}
                  aria-controls="file-tree-panel"
                >
                  <div class="relative flex items-center justify-center size-4">
                    <Icon
                      size="small"
                      name="bullet-list"
                      classList={{
                        "text-icon-strong": focusedGroupLayout().fileTree.opened(),
                        "text-icon-weak": !focusedGroupLayout().fileTree.opened(),
                      }}
                    />
                  </div>
                </Button>
              </TooltipKeybind>
            </Show>
          </div>
        )}
      >
        {props.children}
      </RailLayoutInner>
    </>
  )
}

/**
 * ClaxedoLayout - Main layout component for extension system
 *
 * Register this as `layoutComponent` in the app extensions.
 *
 * Note: TerminalProvider is NOT added here because ClaxedoLayout is at app level
 * (outside SDKProvider). Terminal context is provided via directoryProviders extension
 * point, which injects TerminalProvider at directory level.
 */
export function ClaxedoLayout(props: ParentProps) {
  return (
    <ClaxedoLayoutProvider>
      <Toast.Region />
      <ClaxedoStateBridge>
        <ClaxedoLayoutContent>{props.children}</ClaxedoLayoutContent>
      </ClaxedoStateBridge>
    </ClaxedoLayoutProvider>
  )
}
