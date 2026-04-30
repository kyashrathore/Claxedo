import type { Session } from "@opencode-ai/sdk/v2"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { createStore, produce } from "solid-js/store"

import type { SessionItem } from "../layouts/rail-sidebar"
import { DialogDeleteSession } from "../components/dialogs"
import type { ActionProps, Nav } from "./shared"
import { findProjectForWorkspace, findWorkspaceForDirectory, message } from "./shared"
import { capture as phCapture } from "../../analytics/posthog"
import { sessionRoute } from "../state/surface-route"
import { recoverMissingWorkspace } from "./workspace-recovery"
import { CloudStartupView, type CloudLog } from "../../overrides/components/session/cloud-startup-view"
import { appendWorkspaceRuntimeLog, prepareWorkspaceRuntime } from "../../cloud/runtime/workspace-runtime-store"

export function createSessionActions(props: ActionProps, nav: Nav) {
  const setFocusedWorkspace = (workspaceDir: string) => {
    const paneId = props.state.wb.state.focusedPaneId
    if (!paneId) return
    props.state.workspace.setPaneWorktreePinned(paneId, null)
    props.state.workspace.setPaneWorktreeDefault(paneId, workspaceDir)
  }

  const sessionMeta = (directory: string, sessionId: string) =>
    props.state.meta.find(
      (meta) => meta.type === "session" && meta.directory === directory && meta.sessionId === sessionId,
    )

  const prepareCloudWorkspace = async (workspaceDir: string) => {
    let dialogOpen = false

    const [gate, setGate] = createStore({
      status: "pending_sandbox",
      err: undefined as string | undefined,
      logs: [] as CloudLog[],
    })

    const result = await prepareWorkspaceRuntime({
      directory: workspaceDir,
      events: props.events,
      onResolved: (workspace) => {
        if (!workspace || workspace.kind !== "cloud" || workspace.status === "ready") return
        setGate("status", workspace.status ?? "pending_sandbox")
        props.dialog.show(() => (
          <Dialog title="Preparing cloud workspace" fit>
            <div class="px-6 pb-6 pt-2">
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
    await props.globalSync.refreshDirectory(workspaceDir)
    if (dialogOpen) props.dialog.close()
    return true
  }

  const handleSessionSelect = (workspaceDir: string, sessionId: string) => {
    props.flowLog("session select", {
      workspaceDir,
      sessionId,
      routeDir: props.activeWorkspaceId(),
      routeSession: props.params.id,
      focusedPane: props.state.wb.state.focusedPaneId,
    })

    if (!workspaceDir) return
    props.layout.projects.open(workspaceDir)

    const project = findProjectForWorkspace(props.projects, workspaceDir)
    if (project) props.state.workspace.recordAccess(project.id, workspaceDir)
    setFocusedWorkspace(workspaceDir)

    const [store] = props.globalSync.child(workspaceDir)
    const session = store.session?.find((item: Session) => item.id === sessionId && item.directory === workspaceDir)
    props.state.layout.openSession(workspaceDir, sessionId, session?.title || "Session")
    nav(sessionRoute(workspaceDir, sessionId), "session-select", {
      workspaceDir,
      sessionId,
      contentId: sessionMeta(workspaceDir, sessionId)?.id,
    })
  }

  const handleNewSession = async (workspaceDir?: string) => {
    props.flowLog("new session click", {
      workspaceDir: workspaceDir ?? null,
      routeDir: props.activeWorkspaceId(),
      routeSession: props.params.id,
      focusedPane: props.state.wb.state.focusedPaneId,
    })

    if (!workspaceDir) {
      const providerDirectory = props.activeWorkspaceId() ?? props.projects()[0]?.worktree
      if (!providerDirectory) return
      props.state.layout.openDraftSession(
        providerDirectory,
        `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
      )
      return
    }

    props.layout.projects.open(workspaceDir)

    if (recoverMissingWorkspace(props, workspaceDir, (created, project) => {
      props.globalSync.child(created)
      props.state.workspace.recordAccess(project.id, created)
      setFocusedWorkspace(created)
      props.state.layout.openSession(created, "new", "New Session")
      nav(sessionRoute(created), "new-session:recovered-workspace", {
        projectId: project.id,
        workspaceDir,
        created,
      })
    })) return

    const wsInfo = findWorkspaceForDirectory(props.projects, workspaceDir)
    if (wsInfo?.isCloud) {
      props.flowLog("new session cloud guard", { workspaceDir, isCloud: true })
      const ready = await prepareCloudWorkspace(workspaceDir)
      if (!ready) return
    }

    setFocusedWorkspace(workspaceDir)
    props.state.layout.openSession(workspaceDir, "new", "New Session")
    nav(sessionRoute(workspaceDir), wsInfo?.isCloud ? "new-session:cloud" : "new-session", {
      workspaceDir,
    })
  }

  const handleNewReview = async (workspaceDir: string) => {
    props.flowLog("new review click", {
      workspaceDir,
      routeDir: props.activeWorkspaceId(),
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

    props.state.workspacePanel.open("review", {
      workspaceDir,
      targetPaneId: props.state.wb.state.focusedPaneId ?? undefined,
      navigator: null,
      focus: null,
    })
    nav(sessionRoute(workspaceDir, sessionID), "new-review", {
      workspaceDir,
      contentId: props.state.wb.selectors.focusedContent(),
    })
  }

  const handleDeleteSession = (sessionItem: SessionItem) => {
    const directory = sessionItem.directory
    if (!directory) return

    const [store, setStore] = props.globalSync.child(directory)
    const session = store.session?.find((item: Session) => item.id === sessionItem.id)

    props.dialog.show(() => (
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
            phCapture("session_deleted")
            await props.globalSDK.client.session.delete({ directory: item.directory, sessionID: item.id })
            setStore(
              produce((draft: { session?: Session[] }) => {
                if (draft.session) {
                  draft.session = draft.session.filter((draftSession: Session) => draftSession.id !== item.id)
                }
              }),
            )
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

  const handleArchiveSession = async (sessionItem: SessionItem) => {
    const directory = sessionItem.directory
    if (!directory) return

    const [, setStore] = props.globalSync.child(directory)

    try {
      phCapture("session_archived")
      await props.globalSDK.client.session.update({
        directory,
        sessionID: sessionItem.id,
        time: { archived: Date.now() },
      })
      setStore(
        produce((draft: { session?: Session[] }) => {
          if (draft.session) {
            draft.session = draft.session.filter((item: Session) => item.id !== sessionItem.id)
          }
        }),
      )
      props.globalSync.globalSessions.drop?.({
        id: sessionItem.id,
        directory,
        projectID: sessionItem.projectID,
        tags: sessionItem.tags,
      })

      const meta = sessionMeta(directory, sessionItem.id)
      if (meta) props.state.layout.closeContent(meta.id)

      showToast({
        title: "Session archived",
        description: `Session "${sessionItem.title}" has been archived.`,
        variant: "success",
        duration: 3000,
      })
    } catch (error) {
      showToast({
        title: "Error archiving session",
        description: message(error),
        variant: "error",
      })
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
