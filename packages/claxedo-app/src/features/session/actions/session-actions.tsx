import type { Session } from "@opencode-ai/sdk/v2"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { createStore } from "solid-js/store"

import { DialogDeleteSession } from "@/features/session/ui/components/dialogs/delete-session-dialog"
import {
  ensureActionDirectorySessionCache,
  findProjectForWorkspace,
  findWorkspaceForDirectory,
  message,
  recoverMissingWorkspace,
  sessionRefForActionWorkspace,
  type ActionProps,
  type Nav,
  type SessionItem,
} from "@/features/session/app-ports"
import { sessionRoute as canonicalSessionRoute, workspaceRoute, workspaceSessionRoute } from "@/platform/identity/route"
import { CloudStartupView, type CloudLog } from "@/features/session/ui/components/cloud-startup-view"
import { appendWorkspaceRuntimeLog } from "@/platform/runtime/workspace-log"
import { workspaceStartup } from "@/platform/runtime/workspace-startup"
import { pathnameTargetsSession, shouldBlockRemoteSessionHistoryAction } from "./session-actions.logic"
import { directorySessionCacheQueryOptions, type DirectorySessionCacheValue } from "../data/sync/queries"
import { removeSessionInventoryQueryData } from "../data/sync/session-inventory"
import { queryClient } from "@/platform/query/query-client"
import { reconcileArchivedSessionListQueryData } from "../data/query/session-list"
import { removeDirectorySession } from "../data/sync/directory-session-cache"
import { cleanupSessionCaches } from "../data/sync/session-cache-cleanup"
import { cloneLocalSelectionState, getLocalSelectionHandoff, localDraftSelectionHandoffID, setLocalSelectionHandoff, type LocalSelectionState } from "../store/local-selection-handoff"
import { sessionConfigSelectionQueryKey } from "../store/session-config-selection"
import { urlRoutingEnabled } from "@/lib/runtime-mode"
import { sameWorkspaceDirectory } from "@/platform/runtime/agent/signed-workspace"
import { workspaceRouteId as resolveWorkspaceRouteId } from "@/platform/identity/workspace-route"

const directorySessionCacheEnsureTimers = new Map<string, ReturnType<typeof setTimeout>>()
const DIRECTORY_SESSION_CACHE_ENSURE_DELAY_MS = 8_000

function sessionListRefForArchive(sessionItem: SessionItem, directory: string) {
  if (sessionItem.sessionRef) return sessionItem.sessionRef
  if (sessionItem.workspaceId) return `workspace:${sessionItem.workspaceId}:session:${sessionItem.id}`
  return `local:${directory}:session:${sessionItem.id}`
}

export function createSessionActions(props: ActionProps, nav: Nav) {
  const replaceSessionUrl = (sessionId: string) => {
    if (typeof window === "undefined") return
    // Desktop routes with MemoryRouter over a file:// document: writing the
    // route here left the window at `file:///s/<session>`, which reloads into a
    // blank error page. See `urlRoutingEnabled`.
    if (!urlRoutingEnabled()) return
    const next = canonicalSessionRoute(sessionId)
    if (window.location.pathname === next) return
    window.history.replaceState(window.history.state, "", next)
  }

  const remoteHistoryReadOnly = (action: string) => {
    if (!shouldBlockRemoteSessionHistoryAction({ serverUrl: props.globalSDK.url })) return false
    showToast({
      title: "Session action unavailable",
      description: `${action} is not available from remote read-only session history.`,
      variant: "error",
    })
    return true
  }

  const setFocusedWorkspace = (workspaceDir: string) => {
    const paneId = props.state.wb.state.focusedPaneId
    if (!paneId) return
    props.state.workspace.setPaneWorktreePinned(paneId, null)
    props.state.workspace.setPaneWorktreeDefault(paneId, workspaceDir)
  }

  const sessionMeta = (directory: string, sessionId: string) =>
    props.state.meta.find(
      (meta) => meta.type === "session" && !!meta.directory && sameWorkspaceDirectory(meta.directory, directory) && meta.sessionId === sessionId,
    )
  const focusedSelection = (workspaceDir: string): LocalSelectionState | undefined => {
    const focusedId = props.state.wb.selectors.focusedContent()
    const focused = focusedId ? props.state.meta.get(focusedId) : undefined
    if (focused?.type !== "session" || !focused.sessionId) return
    if (focused.directory && focused.directory !== workspaceDir) return
    return cloneLocalSelectionState(
      queryClient.getQueryData<LocalSelectionState>(sessionConfigSelectionQueryKey({
        sessionID: focused.sessionId,
        directory: focused.directory ?? workspaceDir,
        sessionRef: focused.content?.sessionRef,
        serverUrl: props.globalSDK.url,
      })) ??
      getLocalSelectionHandoff(focused.sessionId),
    )
  }
  const seedDraftSelection = (workspaceDir: string) => {
    const selection = focusedSelection(workspaceDir)
    if (!selection) return
    setLocalSelectionHandoff(localDraftSelectionHandoffID(workspaceDir), selection)
  }
  const directorySessions = (directory: string) =>
    queryClient.getQueryData<DirectorySessionCacheValue>(
      directorySessionCacheQueryOptions({ directory }).queryKey,
    )?.session ?? []
  const ensureDirectorySessionCache = (directory: string) => {
    void ensureActionDirectorySessionCache(props.directorySessionCacheActions, directory)
  }
  const scheduleDirectorySessionCacheEnsure = (directory: string) => {
    if (directorySessionCacheEnsureTimers.has(directory)) return
    directorySessionCacheEnsureTimers.set(
      directory,
      setTimeout(() => {
        directorySessionCacheEnsureTimers.delete(directory)
        ensureDirectorySessionCache(directory)
      }, DIRECTORY_SESSION_CACHE_ENSURE_DELAY_MS),
    )
  }
  const removeDirectorySessionCacheRow = (directory: string, sessionID: string) => {
    removeDirectorySession(directory, sessionID)
  }

  const prepareCloudWorkspace = async (workspaceDir: string) => {
    let dialogOpen = false

    const [gate, setGate] = createStore({
      status: "acquiring_sandbox",
      err: undefined as string | undefined,
      logs: [] as CloudLog[],
    })

    const result = await workspaceStartup().prepareWorkspaceRuntime({
      directory: workspaceDir,
      events: props.events,
      onResolved: (workspace) => {
        if (!workspace || workspace.kind !== "cloud" || workspace.status === "ready") return
        setGate("status", workspace.status ?? "acquiring_sandbox")
        void props.dialog.show(() => (
          <Dialog title="Preparing cloud workspace" fit>
            <div class="pt-2">
              <CloudStartupView
                status={gate.status}
                err={gate.err}
                logs={gate.logs}
              />
            </div>
          </Dialog>
        ))
        dialogOpen = true
      },
      onStatus: (status) => {
        if (status === "acquiring_sandbox" && gate.err) setGate("err", undefined)
        setGate("status", status)
      },
      onLog: (log) => {
        setGate("logs", (list) => appendWorkspaceRuntimeLog(list, log.step, log.message, log.totalMs, log.ts))
      },
    })

    if (!result.ok) {
      if (result.message) setGate("err", result.message)
      if (dialogOpen) props.dialog.close()
      showToast({
        title: "Failed to prepare cloud workspace",
        description: result.message ?? "Request failed",
        variant: "error",
      })
    }

    if (!result.ok) return false
    void props.directorySessionCacheActions.refresh({
      directory: workspaceDir,
    })
    if (dialogOpen) props.dialog.close()
    return true
  }

  const handleSessionSelect = (workspaceDir: string, sessionId: string) => {
    props.flowLog("session select", {
      workspaceDir,
      sessionId,
      routeDir: props.activeDirectory(),
      routeSession: props.params.id,
      focusedPane: props.state.wb.state.focusedPaneId,
    })

    if (!workspaceDir) return
    const focusedId = props.state.wb.selectors.focusedContent()
    const focused = focusedId ? props.state.meta.get(focusedId) : undefined
    const sameWorkspace = props.activeDirectory() === workspaceDir ||
      (focused?.type === "session" && focused.directory === workspaceDir)
    if (!sameWorkspace) props.layout.projects.open(workspaceDir)

    const project = findProjectForWorkspace(props.projects, workspaceDir)
    if (project && !sameWorkspace) props.state.workspace.recordAccess(project.id, workspaceDir)
    if (!sameWorkspace) setFocusedWorkspace(workspaceDir)

    const sessions = directorySessions(workspaceDir)
    if (sessions.length === 0) scheduleDirectorySessionCacheEnsure(workspaceDir)
    const session = sessions.find((item) => item.id === sessionId && item.directory === workspaceDir)
    const sessionRef = sessionRefForActionWorkspace({
      projects: props.projects,
      workspaceDir,
      sessionId,
    })
    props.state.layout.openSession(workspaceDir, sessionId, session?.title || "Session", {
      sessionRef,
    })
    setTimeout(() => replaceSessionUrl(sessionId), 120)
  }

  const handleNewSession = async (workspaceDir?: string, _paneId?: string, selectedRouteId?: string) => {
    props.flowLog("new session click", {
      workspaceDir: workspaceDir ?? null,
      routeDir: props.activeDirectory(),
      routeSession: props.params.id,
      focusedPane: props.state.wb.state.focusedPaneId,
    })

    if (!workspaceDir) {
      const providerDirectory = props.activeDirectory() ?? props.projects()[0]?.worktree
      if (!providerDirectory) return
      const routeId = props.workspaceRouteId(providerDirectory)
      if (!routeId) return
      props.layout.projects.open(providerDirectory)
      const project = findProjectForWorkspace(props.projects, providerDirectory)
      if (project) props.state.workspace.recordAccess(project.id, providerDirectory)
      setFocusedWorkspace(providerDirectory)
      seedDraftSelection(providerDirectory)
      props.state.layout.openSession(providerDirectory, "new", "New Session", { workspaceRouteId: routeId })
      nav(workspaceSessionRoute(routeId), "new-session", {
        workspaceDir: providerDirectory,
      })
      return
    }

    if (recoverMissingWorkspace(props, workspaceDir, (created, project) => {
      const routeId = resolveWorkspaceRouteId([project], created)
      if (!routeId) return
      ensureDirectorySessionCache(created)
      props.state.workspace.recordAccess(project.id, created)
      setFocusedWorkspace(created)
      seedDraftSelection(created)
      props.state.layout.openSession(created, "new", "New Session", { workspaceRouteId: routeId })
      nav(workspaceSessionRoute(routeId), "new-session:recovered-workspace", {
        projectId: project.id,
        workspaceDir,
        created,
      })
    })) return

    const routeId = selectedRouteId ?? props.workspaceRouteId(workspaceDir)
    if (!routeId) return
    props.layout.projects.open(workspaceDir)

    const wsInfo = findWorkspaceForDirectory(props.projects, workspaceDir)
    if (wsInfo?.isCloud) {
      props.flowLog("new session cloud guard", { workspaceDir, isCloud: true })
      const ready = await prepareCloudWorkspace(workspaceDir)
      if (!ready) return
    }

    setFocusedWorkspace(workspaceDir)
    seedDraftSelection(workspaceDir)
    props.state.layout.openSession(workspaceDir, "new", "New Session", { workspaceRouteId: routeId })
    nav(workspaceSessionRoute(routeId), wsInfo?.isCloud ? "new-session:cloud" : "new-session", {
      workspaceDir,
    })
  }

  const handleNewReview = async (workspaceDir: string) => {
    if (remoteHistoryReadOnly("Review creation")) return
    props.flowLog("new review click", {
      workspaceDir,
      routeDir: props.activeDirectory(),
      focusedPane: props.state.wb.state.focusedPaneId,
    })

    props.layout.projects.open(workspaceDir)
    setFocusedWorkspace(workspaceDir)

    const created = await props.globalSDK.client.session.create({
      directory: workspaceDir,
      title: "Review",
    }).catch(() => undefined)
    const sessionID = created?.data?.id
    if (!sessionID) return

    props.state.workspacePanel.open({
      workspaceDir,
      targetPaneId: props.state.wb.state.focusedPaneId ?? undefined,
      navigator: null,
      focus: null,
    })
    nav(canonicalSessionRoute(sessionID), "new-review", {
      workspaceDir,
      contentId: props.state.wb.selectors.focusedContent(),
    })
  }

  const handleDeleteSession = (sessionItem: SessionItem) => {
    if (remoteHistoryReadOnly("Session deletion")) return
    const directory = sessionItem.directory
    if (!directory) return

    const session = directorySessions(directory).find((item) => item.id === sessionItem.id)

    void props.dialog.show(() => (
      <DialogDeleteSession
        session={session ?? {
          id: sessionItem.id,
          slug: sessionItem.id,
          version: "local",
          directory,
          title: sessionItem.title ?? "Session",
          projectID: sessionItem.projectID ?? directory,
          time: { created: sessionItem.time ?? Date.now(), updated: sessionItem.time ?? Date.now() },
        }}
        onDelete={async (item) => {
          try {
            await props.globalSDK.client.session.delete({ directory: item.directory, sessionID: item.id })
            removeDirectorySessionCacheRow(item.directory, item.id)
            const meta = sessionMeta(item.directory, item.id)
            if (meta) props.state.layout.closeContent(meta.id)
          } catch (error) {
            showToast({
              title: "Error deleting session",
              description: message(error),
              variant: "error",
            })
          }
        }}
        onClose={() => props.dialog.close()}
      />
    ))
  }

  const handleArchiveSession = async (sessionItem: SessionItem, nextSessionId?: string) => {
    if (remoteHistoryReadOnly("Session archive")) return false
    const directory = sessionItem.directory
    if (!directory) return false

    try {
      const archivedAt = Date.now()
      await props.globalSDK.client.session.update({
        directory,
        sessionID: sessionItem.id,
        time: { archived: archivedAt },
      })
      removeDirectorySessionCacheRow(directory, sessionItem.id)
      removeSessionInventoryQueryData<SessionItem>({
        baseUrl: props.globalSDK.url,
        session: {
          id: sessionItem.id,
          directory,
          projectID: sessionItem.projectID,
        },
      })
      reconcileArchivedSessionListQueryData({
        baseUrl: props.globalSDK.url,
        sessionRef: sessionListRefForArchive(sessionItem, directory),
        archivedAt,
      })
      cleanupSessionCaches(sessionItem.id)

      const meta = sessionMeta(directory, sessionItem.id)
      const wasActive =
        props.params.id === sessionItem.id ||
        props.state.wb.selectors.focusedContent() === meta?.id ||
        (typeof window !== "undefined" && pathnameTargetsSession(window.location.pathname, sessionItem.id))
      if (meta) props.state.layout.closeContent(meta.id)

      if (wasActive) {
        if (nextSessionId) {
          nav(canonicalSessionRoute(nextSessionId), "archive-session:next", {
            archivedSessionId: sessionItem.id,
            nextSessionId,
          })
        } else {
          const workspaceId = props.workspaceRouteId(directory)
          nav(workspaceId ? workspaceRoute(workspaceId) : "/", "archive-session:workspace", {
            archivedSessionId: sessionItem.id,
            ...(workspaceId ? { workspaceId } : {}),
          })
        }
      }

      showToast({
        title: "Session archived",
        description: `Session "${sessionItem.title}" has been archived.`,
        variant: "success",
        duration: 3000,
      })
      return true
    } catch (error) {
      showToast({
        title: "Error archiving session",
        description: message(error),
        variant: "error",
      })
      return false
    }
  }

  return {
    handleSessionSelect,
    handleNewSession,
    handleNewReview,
    handleDeleteSession,
    handleArchiveSession,
  }
}
