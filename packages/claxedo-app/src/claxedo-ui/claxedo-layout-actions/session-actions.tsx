import type { Session } from "@opencode-ai/sdk/v2"
import { showToast } from "@opencode-ai/ui/toast"
import { produce } from "solid-js/store"
import { base64Encode } from "@opencode-ai/util/encode"

import type { SessionItem } from "../layouts/rail-sidebar"
import { DialogDeleteSession } from "../components/dialogs"
import { REVIEW_MODE_LABEL } from "../context/claxedo-layout/review-intent"
import type { ReviewMode } from "../context/claxedo-layout/types"
import type { ActionProps, Nav } from "./shared"
import { findProjectForWorkspace, findWorkspaceForDirectory, message } from "./shared"
import { capture as phCapture } from "../../analytics/posthog"
import { archiveSession, runUpdate } from "./session-actions.logic"
import { sessionRoute } from "../context/claxedo-layout/tab-route"
import { recoverMissingWorkspace } from "./workspace-recovery"

export function createSessionActions(props: ActionProps, nav: Nav) {
  const handleSessionSelect = (workspaceDir: string, sessionId: string) => {
    props.flowLog("session select", {
      workspaceDir,
      sessionId,
      routeDir: props.activeWorkspaceId(),
      routeSession: props.params.id,
      routeTab: props.params.tabId,
      focusedGroup: props.claxedo.split.focusedId(),
    })

    if (!workspaceDir) return

    const project = findProjectForWorkspace(props.projects, workspaceDir)
    if (project) {
      props.claxedo.workspaceRecency.recordAccess(project.id, workspaceDir)
    }

    // Match handleNewSession's group targeting for robustness
    const groups = props.claxedo.split.groups()
    const focusedId = props.claxedo.split.focusedId()
    const matches = groups.filter((g) => props.claxedo.groupWorktree(g.id).default() === workspaceDir)
    const targetGroupId = matches.find((g) => g.id === focusedId)?.id ?? matches[0]?.id ?? focusedId
    const tabs = targetGroupId ? props.claxedo.groupTabs(targetGroupId) : props.claxedo.topTabs
    if (targetGroupId) props.claxedo.dispatch({ type: "SplitFocusRequested", groupId: targetGroupId })

    const [store] = props.globalSync.child(workspaceDir)
    const session = store.session?.find((s: Session) => s.id === sessionId && s.directory === workspaceDir)
    const title = session?.title || "Session"
    const summary = session?.summary

    const id = tabs.addSession(
      workspaceDir,
      sessionId,
      title,
      summary ? { additions: summary.additions ?? 0, deletions: summary.deletions ?? 0 } : undefined,
    )
    if (!id) return
    tabs.setActive(id)
    const url = sessionRoute(workspaceDir, sessionId)
    nav(url, "session-select", {
      workspaceDir,
      sessionId,
      tabId: id,
    })
  }

  const handleNewSession = (workspaceDir: string, groupId?: string) => {
    props.flowLog("new session click", {
      workspaceDir,
      requestedGroupId: groupId,
      routeDir: props.activeWorkspaceId(),
      routeSession: props.params.id,
      routeTab: props.params.tabId,
      focusedGroup: props.claxedo.split.focusedId(),
    })

    if (recoverMissingWorkspace(props, workspaceDir, (created, project) => {
      const nextGroupId = groupId ?? props.claxedo.split.focusedId()
      const nextTabs = nextGroupId ? props.claxedo.groupTabs(nextGroupId) : props.claxedo.topTabs
      if (nextGroupId) props.claxedo.dispatch({ type: "SplitFocusRequested", groupId: nextGroupId })
      props.globalSync.child(created)
      const tabId = nextTabs.addSession(created, "new", "New Session")
      if (tabId) {
        nextTabs.setActive(tabId)
        nav(sessionRoute(created), "new-session:recovered-workspace", {
          projectId: project.id,
          workspaceDir,
          created,
          requestedGroupId: groupId,
          tabId,
        })
      }
    })) return

    const groups = props.claxedo.split.groups()
    const focusedId = props.claxedo.split.focusedId()
    const matches = groups.filter((g) => props.claxedo.groupWorktree(g.id).default() === workspaceDir)
    const targetGroupId = groupId ?? matches.find((g) => g.id === focusedId)?.id ?? matches[0]?.id ?? focusedId
    const tabs = targetGroupId ? props.claxedo.groupTabs(targetGroupId) : props.claxedo.topTabs
    if (targetGroupId) props.claxedo.dispatch({ type: "SplitFocusRequested", groupId: targetGroupId })

    // Cloud workspaces: signal cloud-pending intent so the session page
    // engages the startup gate immediately instead of showing a blank shell.
    const wsInfo = findWorkspaceForDirectory(props.projects, workspaceDir)
    if (wsInfo?.isCloud) {
      props.flowLog("new session cloud guard", { workspaceDir, isCloud: true })
      const id = tabs.addSession(workspaceDir, "new", "Preparing workspace...")
      if (id) {
        tabs.setActive(id)
        nav(sessionRoute(workspaceDir), "new-session:cloud", {
          workspaceDir,
          requestedGroupId: groupId,
          tabId: id,
        })
      }
      return
    }

    const id = tabs.addSession(workspaceDir, "new", "New Session")
    if (id) {
      tabs.setActive(id)
      nav(sessionRoute(workspaceDir), "new-session", {
        workspaceDir,
        requestedGroupId: groupId,
        tabId: id,
      })
    }
  }

  const handleNewReview = async (workspaceDir: string, groupId?: string) => {
    props.flowLog("new review click", {
      workspaceDir,
      requestedGroupId: groupId,
      routeDir: props.activeWorkspaceId(),
      focusedGroup: props.claxedo.split.focusedId(),
    })

    const groups = props.claxedo.split.groups()
    const focusedId = props.claxedo.split.focusedId()
    const matches = groups.filter((g) => props.claxedo.groupWorktree(g.id).default() === workspaceDir)
    const targetGroupId = groupId ?? matches.find((g) => g.id === focusedId)?.id ?? matches[0]?.id ?? focusedId
    const tabs = targetGroupId ? props.claxedo.groupTabs(targetGroupId) : props.claxedo.topTabs
    if (targetGroupId) props.claxedo.dispatch({ type: "SplitFocusRequested", groupId: targetGroupId })

    // Create a fresh session for the review — SDK requires a real session ID
    const mode: ReviewMode = "uncommitted"
    const title = `Review: ${REVIEW_MODE_LABEL[mode]}`
    let sessionID: string | undefined
    try {
      const created = await props.globalSDK.client.session.create({
        directory: workspaceDir,
        title,
      })
      sessionID = created.data?.id
    } catch {
      // fall through
    }
    if (!sessionID) return

    const id = tabs.addReviewWorkspace(workspaceDir, sessionID, title, undefined, mode)
    if (id) {
      tabs.setActive(id)
      nav(`/${base64Encode(workspaceDir)}/tab/${id}`, "new-review", {
        workspaceDir,
        requestedGroupId: groupId,
        tabId: id,
      })
    }
  }

  const handleDeleteSession = (sessionItem: SessionItem) => {
    const directory = sessionItem.directory
    if (!directory) return

    const [store, setStore] = props.globalSync.child(directory)
    const session = store.session?.find((s: Session) => s.id === sessionItem.id)

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
        onDelete={async (s) => {
          try {
            phCapture("session_deleted")
            await props.globalSDK.client.session.delete({ directory: s.directory, sessionID: s.id })
            setStore(
              produce((draft: { session?: Session[] }) => {
                if (draft.session) {
                  draft.session = draft.session.filter((item: Session) => item.id !== s.id)
                }
              }),
            )

            const tab = props.claxedo.topTabs.findSession(s.directory, s.id)
            if (tab) props.claxedo.topTabs.close(tab.id)
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
      await archiveSession({
        item: sessionItem,
        update: (input) => runUpdate(props.globalSDK.client.session, input),
        setStore,
        drop: props.globalSync.globalSessions.drop,
        findTab: props.claxedo.topTabs.findSession,
        closeTab: props.claxedo.topTabs.close,
        toast: showToast,
        track: () => phCapture("session_archived"),
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
