import type { Session } from "@opencode-ai/sdk/v2"
import { base64Encode } from "@opencode-ai/util/encode"
import { showToast } from "@opencode-ai/ui/toast"
import { produce } from "solid-js/store"

import type { SessionItem } from "../layouts/rail-sidebar"
import { DialogDeleteSession } from "../components/dialogs"
import { REVIEW_MODE_LABEL } from "../context/claxedo-layout/review-intent"
import type { ReviewMode } from "../context/claxedo-layout/types"
import type { ActionProps, Nav } from "./shared"
import { findProjectForWorkspace, message } from "./shared"
import { capture as phCapture } from "../../opencode-patches/observability/posthog"

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

    const project = findProjectForWorkspace(props.projects, workspaceDir)
    if (project) {
      props.claxedo.workspaceRecency.recordAccess(project.id, workspaceDir)
    }

    const [store] = props.globalSync.child(workspaceDir)
    const session = store.session?.find((s: Session) => s.id === sessionId && s.directory === workspaceDir)
    const title = session?.title || "Session"
    const summary = session?.summary

    const id = props.claxedo.topTabs.addSession(
      workspaceDir,
      sessionId,
      title,
      summary ? { additions: summary.additions ?? 0, deletions: summary.deletions ?? 0 } : undefined,
    )
    if (id) {
      props.claxedo.topTabs.setActive(id)
      nav(`/${base64Encode(workspaceDir)}/tab/${id}`, "session-select", {
        workspaceDir,
        sessionId,
        tabId: id,
      })
    }
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

    const groups = props.claxedo.split.groups()
    const focusedId = props.claxedo.split.focusedId()
    const matches = groups.filter((g) => props.claxedo.groupWorktree(g.id).default() === workspaceDir)
    const targetGroupId = groupId ?? matches.find((g) => g.id === focusedId)?.id ?? matches[0]?.id ?? focusedId
    const tabs = targetGroupId ? props.claxedo.groupTabs(targetGroupId) : props.claxedo.topTabs
    if (targetGroupId) props.claxedo.dispatch({ type: "SplitFocusRequested", groupId: targetGroupId })
    const id = tabs.addSession(workspaceDir, "new", "New Session")
    if (id) {
      tabs.setActive(id)
      nav(`/${base64Encode(workspaceDir)}/tab/${id}`, "new-session", {
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
    if (!session) return

    props.dialog.show(() => (
      <DialogDeleteSession
        session={session}
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

    const [store, setStore] = props.globalSync.child(directory)
    const session = store.session?.find((s: Session) => s.id === sessionItem.id)
    if (!session) return

    try {
      phCapture("session_archived")
      await props.globalSDK.client.session.update({
        directory: session.directory,
        sessionID: session.id,
        time: { archived: Date.now() },
      })

      setStore(
        produce((draft: { session?: Session[] }) => {
          if (draft.session) {
            draft.session = draft.session.filter((item: Session) => item.id !== session.id)
          }
        }),
      )

      const tab = props.claxedo.topTabs.findSession(session.directory, session.id)
      if (tab) props.claxedo.topTabs.close(tab.id)

      showToast({
        title: "Session archived",
        description: `Session "${session.title}" has been archived.`,
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
