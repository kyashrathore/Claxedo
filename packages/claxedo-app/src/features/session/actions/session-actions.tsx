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
import { parseShellRoute, sessionRoute as canonicalSessionRoute, workspaceRoute, workspaceSessionRoute } from "@/platform/identity/route"
import { CloudStartupView, type CloudLog } from "@/features/session/ui/components/cloud-startup-view"
import { appendWorkspaceRuntimeLog } from "@/platform/runtime/workspace-log"
import { workspaceStartup } from "@/platform/runtime/workspace-startup"
import { shouldBlockRemoteSessionHistoryAction } from "./session-actions.logic"
import { directorySessionCacheQueryOptions, type DirectorySessionCacheValue } from "../data/sync/queries"
import { removeSessionInventoryQueryData } from "../data/sync/session-inventory"
import { queryClient } from "@/platform/query/query-client"
import { reconcileArchivedSessionListQueryData } from "../data/query/session-list"
import { removeDirectorySession } from "../data/sync/directory-session-cache"
import { cleanupSessionCaches } from "../data/sync/session-cache-cleanup"
import { cloneLocalSelectionState, getLocalSelectionHandoff, localDraftSelectionHandoffID, setLocalSelectionHandoff, type LocalSelectionState } from "../store/local-selection-handoff"
import { sessionConfigSelectionQueryKey } from "../store/session-config-selection"
import { writeBrowserRoute } from "@/lib/browser-history"
import { sameWorkspaceDirectory } from "@/platform/identity/legacy-resolver"
import { cancelArchiveProjectionReads } from "../data/sync/archive-projection-boundary"
import { flushQueryPersistence } from "@/platform/query/persister"
import { focusComposerWhenReady } from "../composer/ui/composer-focus"

const directorySessionCacheEnsureTimers = new Map<string, ReturnType<typeof setTimeout>>()
const DIRECTORY_SESSION_CACHE_ENSURE_DELAY_MS = 8_000

function pathnameTargetsSession(pathname: string, sessionId: string) {
  const route = parseShellRoute(pathname)
  return (
    (route.kind === "session" || route.kind === "workspace-session" || route.kind === "legacy-directory") &&
    route.sessionId === sessionId
  )
}

function sessionListRefForArchive(sessionItem: SessionItem, directory: string) {
  if (sessionItem.sessionRef) return sessionItem.sessionRef
  if (sessionItem.workspaceId) return `workspace:${sessionItem.workspaceId}:session:${sessionItem.id}`
  return `local:${directory}:session:${sessionItem.id}`
}

export function createSessionActions(props: ActionProps, nav: Nav) {
  const replaceSessionUrl = (sessionId: string) => {
    if (typeof window === "undefined") return
    const next = canonicalSessionRoute(sessionId)
    if (window.location.pathname === next) return
    writeBrowserRoute(next, { replace: true, notify: true })
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
    if (focused?.type !== "session" || !focused.sessionId) return undefined
    if (focused.directory && focused.directory !== workspaceDir) return undefined
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
        if (!workspace || workspace.kind !== "provisioner" || workspace.status === "ready") return
        setGate("status", workspace.status ?? "acquiring_sandbox")
        void props.dialog.show(() => (
          <Dialog title="Preparing cloud environment" fit>
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
        title: "Failed to prepare cloud environment",
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
    const focusOrigin = typeof document === "undefined" ? undefined : document.activeElement
    const handOffComposerFocus = () => focusComposerWhenReady({ origin: focusOrigin, sessionId: "new" })
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
      props.state.layout.openSession(providerDirectory, "new", "New Session", {
        workspaceRouteId: routeId,
        sessionRef: sessionRefForActionWorkspace({
          projects: props.projects,
          workspaceDir: providerDirectory,
          sessionId: "new",
          workspaceRouteId: routeId,
          hostKind: props.hostKindForRoute(routeId),
        }),
      })
      nav(workspaceSessionRoute(routeId), "new-session", {
        workspaceDir: providerDirectory,
      })
      handOffComposerFocus()
      return
    }

    if (recoverMissingWorkspace(props, workspaceDir, (created, project, item) => {
      const routeId = item.workspaceId
      if (!routeId) throw new Error("The new workspace is unavailable")
      ensureDirectorySessionCache(created)
      props.state.workspace.recordAccess(project.id, created)
      setFocusedWorkspace(created)
      seedDraftSelection(created)
      props.state.layout.openSession(created, "new", "New Session", {
        workspaceRouteId: routeId,
        sessionRef: sessionRefForActionWorkspace({
          projects: props.projects,
          workspaceDir: created,
          sessionId: "new",
          workspaceRouteId: routeId,
          hostKind: props.hostKindForRoute(routeId),
        }),
      })
      nav(workspaceSessionRoute(routeId), "new-session:recovered-workspace", {
        projectId: project.id,
        workspaceDir,
        created,
      })
      handOffComposerFocus()
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
    props.state.layout.openSession(workspaceDir, "new", "New Session", {
      workspaceRouteId: routeId,
      sessionRef: sessionRefForActionWorkspace({
        projects: props.projects,
        workspaceDir,
        sessionId: "new",
        workspaceRouteId: routeId,
        hostKind: props.hostKindForRoute(routeId),
      }),
    })
    nav(workspaceSessionRoute(routeId), wsInfo?.isCloud ? "new-session:cloud" : "new-session", {
      workspaceDir,
    })
    handOffComposerFocus()
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

    const created = await props.globalSDK.createClient({ directory: workspaceDir }).session.create({
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
            await props.globalSDK.createClient({ directory: item.directory }).session.delete({
              directory: item.directory,
              sessionID: item.id,
            })
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
      await props.globalSDK.createClient({ directory }).session.update({
        directory,
        sessionID: sessionItem.id,
        time: { archived: archivedAt },
      })
      const meta = sessionMeta(directory, sessionItem.id)
      const wasActive =
        props.params.id === sessionItem.id ||
        props.state.wb.selectors.focusedContent() === meta?.id ||
        (typeof window !== "undefined" && pathnameTargetsSession(window.location.pathname, sessionItem.id))
      // Unmount the consumer before cancelling its reads. A mounted query
      // observer immediately restarts a cancelled config request and can
      // recreate the archived session cache after cleanup.
      if (meta) props.state.layout.closeContent(meta.id)
      await cancelArchiveProjectionReads({
        baseUrl: props.globalSDK.url,
        directory,
        sessionId: sessionItem.id,
      })
      removeDirectorySessionCacheRow(directory, sessionItem.id)
      removeSessionInventoryQueryData({
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
        sessionId: sessionItem.id,
        directory,
        workspaceId: sessionItem.workspaceId,
        archivedAt,
      })
      cleanupSessionCaches(sessionItem.id)
      await flushQueryPersistence()

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
