import { getExtensions } from "@opencode-ai/app-shared"
import { DialogSettings } from "@opencode-ai/claxedo-app"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { showToast } from "@opencode-ai/ui/toast"
import { validWorktree } from "@claxedo/utils/worktree"

import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { DialogCreateCloudProject } from "../../components/dialog-create-cloud-project"
import { DialogNewProject } from "../../components/dialog-new-project"
import { DialogDeleteWorkspace } from "../components/dialogs"
import type { ProjectItem, WorkspaceItem } from "../layouts/rail-sidebar"
import type { WorkspaceBarItem } from "../layouts/top-tab-bar"
import { getAuthToken } from "../../utils/auth-client"
import type { ActionProps, Nav } from "./shared"
import { findProjectForWorkspace, message } from "./shared"

export function createProjectActions(props: ActionProps, nav: Nav) {
  const handleProjectSelect = (_project: ProjectItem) => {
    // Projects are always expanded now, so clicking the project header does nothing.
  }

  const handleNewProject = () => {
    const handleProjectSelected = (workspaceDir: string) => {
      props.flowLog("new project selected", {
        workspaceDir,
        routeDir: props.activeWorkspaceId(),
        routeSession: props.params.id,
        routeTab: props.params.tabId,
      })

      if (!validWorktree(workspaceDir)) {
        showToast({
          title: "Invalid project path",
          description: workspaceDir,
          variant: "error",
        })
        return
      }

      props.layout.projects.open(workspaceDir)
      props.globalSync.child(workspaceDir)
      props.claxedo.worktree.setPinned(null)
      props.claxedo.worktree.setDefault(workspaceDir)
      const id = props.claxedo.topTabs.addSession(workspaceDir, "new", "New Session")
      if (id) props.claxedo.topTabs.setActive(id)
      if (id)
        nav(`/${base64Encode(workspaceDir)}/tab/${id}`, "new-project-selected", {
          workspaceDir,
          tabId: id,
        })
      props.dialog.close()
    }

    const showLocalDialog = () => {
      props.dialog.show(() => (
        <DialogSelectDirectory
          onSelect={(dir) => {
            if (typeof dir === "string") {
              handleProjectSelected(dir)
            }
          }}
        />
      ))
    }

    const showCloudDialog = () => {
      props.dialog.show(() => (
        <DialogCreateCloudProject
          onSelect={(workspaceDir) => {
            if (typeof workspaceDir === "string") {
              handleProjectSelected(workspaceDir)
            }
          }}
        />
      ))
    }

    if (props.config?.sandboxEnabled) {
      props.dialog.show(() => (
        <DialogNewProject
          onLocal={() => showLocalDialog()}
          onCloud={() => showCloudDialog()}
          onClose={() => props.dialog.close()}
        />
      ))
      return
    }

    showLocalDialog()
  }

  const handleNewWorkspace = async (project: ProjectItem): Promise<WorkspaceBarItem | undefined> => {
    const ext = getExtensions()
    const worktree = project.worktree

    const onWorktreeCreated = (created: string, name: string) => {
      props.flowLog("workspace created", {
        projectId: project.id,
        created,
        name,
        routeDir: props.activeWorkspaceId(),
        routeSession: props.params.id,
        routeTab: props.params.tabId,
      })

      props.globalSync.child(created)
      props.claxedo.workspaceRecency.recordAccess(project.id, created)
      props.claxedo.worktree.setPinned(null)
      props.claxedo.worktree.setDefault(created)

      const tabId = props.claxedo.topTabs.addSession(created, "new", "New Session")
      if (tabId) props.claxedo.topTabs.setActive(tabId)

      if (tabId)
        nav(`/${base64Encode(created)}/tab/${tabId}`, "new-workspace-created", {
          projectId: project.id,
          created,
          tabId,
        })

      return {
        id: created,
        directory: created,
        name,
        projectWorktree: worktree,
        canDelete: true,
      }
    }

    const handleError = (err: unknown) => {
      if (
        err &&
        typeof err === "object" &&
        "name" in err &&
        (err as { name?: unknown }).name === "WorktreeNotGitError"
      ) {
        showToast({
          title: "Worktrees require a git project",
          description: message(err),
          variant: "error",
        })
        return
      }
      showToast({
        title: "Failed to create worktree",
        description: message(err),
        variant: "error",
      })
    }

    if (ext.app.createWorkspace) {
      try {
        const created = await ext.app.createWorkspace(worktree)
        if (created) return onWorktreeCreated(created, getFilename(created))
      } catch (err) {
        handleError(err)
      }
      return
    }

    try {
      const result = await props.globalSDK.client.worktree.create({ directory: worktree, worktreeCreateInput: {} })
      const created = result.data?.directory
      const name = result.data?.name
      if (created) return onWorktreeCreated(created, name ?? getFilename(created))
    } catch (err) {
      handleError(err)
    }
    return
  }

  const handleSettings = () => {
    props.dialog.show(() => <DialogSettings />)
  }

  const handleHelp = () => {
    props.platform.openLink("https://opencode.ai/docs")
  }

  const purgeWorkspaceState = (dir: string) => {
    const tabs = props.claxedo.topTabs.items().filter((t) => t.directory === dir)
    for (const tab of tabs) {
      props.claxedo.topTabs.close(tab.id)
    }
    const [_, setChild] = props.globalSync.child(dir, { bootstrap: false })
    setChild("session", [])
    setChild("sessionTotal", 0)
    setChild("message", {})
    setChild("part", {})

    const project = findProjectForWorkspace(props.projects, dir)
    if (!project) return
    const all = [project.worktree, ...(project.sandboxes ?? [])]
    props.claxedo.workspaceRecency.cleanup(
      project.id,
      all.filter((workspace) => workspace !== dir),
    )
  }

  const deleteCloudMainWorkspace = async (dir: string) => {
    const token = await getAuthToken()
    const headers: Record<string, string> = {}
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    const res = await fetch(`/api/experimental/sandbox?directory=${encodeURIComponent(dir)}`, {
      method: "DELETE",
      headers,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error((err as { error?: string }).error || "Failed to destroy sandbox")
    }
  }

  const deleteWorkspaceWorktree = async (projectWorktree: string, dir: string) => {
    await props.globalSDK.client.worktree.remove({
      directory: projectWorktree,
      worktreeRemoveInput: { directory: dir },
    })
  }

  const removeSandboxFromProject = (projectWorktree: string, dir: string) => {
    const projectIndex = props.globalSync.data.project.findIndex((p) => p.worktree === projectWorktree)
    if (projectIndex === -1) return
    const project = props.globalSync.data.project[projectIndex]
    if (!project.sandboxes?.includes(dir)) return
    props.globalSync.set(
      "project",
      projectIndex,
      "sandboxes",
      project.sandboxes.filter((sandbox) => sandbox !== dir),
    )
  }

  const cleanupDeletedWorkspaceSelection = (dir: string, projectWorktree: string) => {
    if (props.claxedo.worktree.pinned() === dir) {
      props.claxedo.worktree.setPinned(null)
    }
    if (props.claxedo.worktree.default() === dir) {
      props.claxedo.worktree.setDefault(projectWorktree)
    }
    if (props.activeWorkspaceId() === dir) {
      props.navigate("/")
    }
  }

  const handleCloudMainWorkspaceDeleted = (dir: string) => {
    purgeWorkspaceState(dir)
    props.layout.projects.remove(dir)
    props.navigate("/")
    showToast({
      title: "Sandbox Destroyed",
      description: "The sandbox has been destroyed.",
      variant: "success",
      duration: 3000,
    })
  }

  const handleDeleteWorkspace = (workspace: WorkspaceItem) => {
    props.dialog.show(() => (
      <DialogDeleteWorkspace
        directory={workspace.directory}
        isMain={workspace.isMain}
        isCloud={workspace.isCloud}
        onDelete={async (dir) => {
          if (workspace.isMain && workspace.isCloud) {
            await deleteCloudMainWorkspace(dir)
            handleCloudMainWorkspaceDeleted(dir)
            return
          }

          const projectWorktree = workspace.projectWorktree ?? props.activeProjectId()
          if (!projectWorktree) return

          await deleteWorkspaceWorktree(projectWorktree, dir)
          purgeWorkspaceState(dir)
          removeSandboxFromProject(projectWorktree, dir)
          cleanupDeletedWorkspaceSelection(dir, projectWorktree)
        }}
        onClose={() => props.dialog.close()}
      />
    ))
  }

  const handleRemoveProject = (project: ProjectItem) => {
    const current = props.activeProjectId()
    props.layout.projects.close(project.worktree)
    if (current === project.worktree) {
      props.navigate("/")
    }
  }

  return {
    handleProjectSelect,
    handleNewProject,
    handleNewWorkspace,
    handleSettings,
    handleHelp,
    handleDeleteWorkspace,
    handleRemoveProject,
  }
}
