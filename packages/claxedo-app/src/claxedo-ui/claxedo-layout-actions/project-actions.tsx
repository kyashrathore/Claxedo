import { DialogSettings } from "@/components/dialog-settings"
import { getFilename } from "@opencode-ai/util/path"
import { showToast } from "@opencode-ai/ui/toast"
import { validWorktree } from "@claxedo/utils/worktree"

import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { DialogCreateCloudWorkspace } from "../../components/dialog-create-cloud-workspace"
import { DialogNewProject } from "../../components/dialog-new-project"
import { api, getDefaultBaseUrl } from "../../utils/api"
import { DialogDeleteWorkspace } from "../components/dialogs"
import type { ProjectItem, WorkspaceItem } from "../layouts/rail-sidebar"
import type { WorkspaceBarItem } from "../layouts/workspace-toolbar"
import { getAuthToken } from "../../utils/auth-client"
import { Worktree as WorktreeState } from "@/utils/worktree"
import type { ActionProps, Nav } from "./shared"
import { findProjectForWorkspace, message } from "./shared"
import { capture as phCapture } from "../../analytics/posthog"
import { sessionRoute } from "../state/surface-route"
import { createLocalWorkspace } from "./workspace-recovery"

export function createProjectActions(props: ActionProps, nav: Nav) {
  const openProjectSessionSurface = (workspaceDir: string) => {
    const paneId = props.state.wb.state.focusedPaneId
    if (paneId) {
      props.state.workspace.setPaneWorktreePinned(paneId, null)
      props.state.workspace.setPaneWorktreeDefault(paneId, workspaceDir)
    }
    return props.state.layout.openSession(workspaceDir, "new", "New Session")
  }

  const handleNewProject = () => {
    const handleProjectSelected = async (workspaceDir: string) => {
      props.flowLog("new project selected", {
        workspaceDir,
        routeDir: props.activeWorkspaceId(),
        routeSession: props.params.id,
      })

      if (!validWorktree(workspaceDir)) {
        showToast({
          title: "Invalid project path",
          description: workspaceDir,
          variant: "error",
        })
        return
      }

      if (props.platform.platform !== "web") {
        try {
          await props.globalSync.project.ensure(workspaceDir)
        } catch {
          showToast({
            title: "Not a git repository",
            description: "Only git repositories can be added as projects",
            variant: "error",
          })
          return
        }
      }
      props.layout.projects.open(workspaceDir)
      props.globalSync.child(workspaceDir)
      const id = openProjectSessionSurface(workspaceDir)
      if (id)
        nav(sessionRoute(workspaceDir), "new-project-selected", {
          workspaceDir,
          surfaceId: id,
        })
      props.dialog.close()
    }

    props.dialog.show(() => (
      <DialogSelectDirectory
        onSelect={(dir) => {
          if (typeof dir === "string") {
            void handleProjectSelected(dir)
          }
        }}
      />
    ))
  }

  const handleNewWorkspace = async (project: ProjectItem): Promise<WorkspaceBarItem | undefined> => {
    const worktree = project.worktree

    const onWorktreeCreated = async (created: string, name: string, wait = false) => {
      props.flowLog("workspace created", {
        projectId: project.id,
        created,
        name,
        routeDir: props.activeWorkspaceId(),
        routeSession: props.params.id,
      })

      const item = {
        id: created,
        directory: created,
        name,
        projectWorktree: worktree,
        canDelete: true,
      } satisfies WorkspaceBarItem

      if (wait) WorktreeState.pending(created)
      const [child] = props.globalSync.child(created)
      props.state.workspace.recordAccess(project.id, created)

      if (wait) {
        const result = await WorktreeState.wait(created)
        if (result.status === "failed") {
          showToast({
            title: "Failed to create worktree",
            description: result.message,
            variant: "error",
          })
          return
        }

        if (child.status === "loading") {
          await new Promise<void>((resolve) => {
            const id = setInterval(() => {
              if (child.status === "loading") return
              clearInterval(id)
              resolve()
            }, 100)
          })
        }
      }

      const tabId = openProjectSessionSurface(created)

      if (tabId)
        nav(sessionRoute(created), "new-workspace-created", {
          projectId: project.id,
          created,
          tabId,
        })

      return item
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

    const createLocalWorktree = async (): Promise<WorkspaceBarItem | undefined> => {
      try {
        const result = await props.globalSDK.client.worktree.create({ directory: worktree, worktreeCreateInput: {} })
        const created = result.data?.directory
        const name = result.data?.name
        if (created) return onWorktreeCreated(created, name ?? getFilename(created), true)
      } catch (err) {
        handleError(err)
      }
      return undefined
    }

    // When sandbox is enabled, let the user choose between local worktree and cloud sandbox
    if (props.config?.sandboxEnabled) {
      return new Promise<WorkspaceBarItem | undefined>((resolve) => {
        props.dialog.show(() => (
          <DialogNewProject
            onLocal={async () => {
              props.dialog.close()
              resolve(await createLocalWorktree())
            }}
            onCloud={() => {
              props.dialog.show(() => (
                <DialogCreateCloudWorkspace
                  projectId={project.id}
                  onCreated={async (dir) => {
                    await props.globalSync.bootstrap().catch(() => undefined)
                    props.dialog.close()
                    resolve(await onWorktreeCreated(dir, getFilename(dir)))
                  }}
                  onClose={() => {
                    props.dialog.close()
                    resolve(undefined)
                  }}
                />
              ))
            }}
            onClose={() => {
              props.dialog.close()
              resolve(undefined)
            }}
          />
        ))
      })
    }

    return createLocalWorktree()
  }

  /** Create a local worktree directly — no dialog */
  const handleNewLocalWorkspace = async (
    project: ProjectItem,
    onProgress?: (step: string, message?: string) => void,
    workspaceName?: string,
  ): Promise<WorkspaceBarItem | undefined> => {
    return createLocalWorkspace(props, project, {
      onProgress,
      workspaceName,
      onReady: (created) => {
        onProgress?.("redirecting")
        const tabId = openProjectSessionSurface(created)
        if (tabId) nav(sessionRoute(created), "new-workspace-created", { projectId: project.id, created, tabId })
      },
    })
  }

  /** Create a cloud sandbox directly — no dialog, calls API inline with progress */
  const handleNewCloudWorkspace = async (
    project: ProjectItem,
    onProgress?: (step: string, message?: string) => void,
    workspaceName?: string,
  ): Promise<WorkspaceBarItem | undefined> => {
    const worktree = project.worktree
    const baseUrl = getDefaultBaseUrl()
    try {
      onProgress?.("acquiring_sandbox")
      const body: Record<string, string> = { projectId: project.id }
      if (workspaceName) body.workspaceName = workspaceName
      const result = await api.post<{ workspaceId: string; directory?: string }>(
        `${baseUrl}/api/workspace/create`,
        body,
      )
      const dir = result.directory
      if (!dir) throw new Error("Workspace create did not return a directory")

      // Listen for SSE provision events if available
      if (props.events) {
        await new Promise<void>((resolve, reject) => {
          const unsub = props.events!.on("provision", (ev) => {
            if (ev.workspaceId !== result.workspaceId) return
            onProgress?.(ev.step, ev.message)
            if (ev.step === "ready") { unsub(); resolve() }
            if (ev.step === "error") { unsub(); reject(new Error(ev.message || "Provisioning failed")) }
          })
          // Timeout fallback
          setTimeout(() => { unsub(); resolve() }, 120_000)
        })
      }

      await props.globalSync.bootstrap().catch(() => undefined)
      onProgress?.("ready")
      onProgress?.("redirecting")
      await new Promise(resolve => setTimeout(resolve, 1200))
      props.flowLog("workspace created", { projectId: project.id, created: dir })
      const item = { id: dir, directory: dir, name: getFilename(dir), projectWorktree: worktree, canDelete: true } satisfies WorkspaceBarItem
      props.state.workspace.recordAccess(project.id, dir)
      const tabId = openProjectSessionSurface(dir)
      if (tabId) nav(sessionRoute(dir), "new-workspace-created", { projectId: project.id, created: dir, tabId })
      return item
    } catch (err) {
      onProgress?.("error", err instanceof Error ? err.message : "Failed to create cloud workspace")
      showToast({ title: "Failed to create cloud workspace", description: message(err), variant: "error" })
    }
    return undefined
  }

  const handleSettings = () => {
    props.dialog.show(() => <DialogSettings />)
  }

  const handleHelp = () => {
    props.platform.openLink("https://opencode.ai/docs")
  }

  const purgeWorkspaceState = (dir: string) => {
    const matchingMetas = props.state.meta.findAll((m) => m.directory === dir)
    for (const meta of matchingMetas) {
      props.state.layout.closeContent(meta.id)
    }
    const [_, setChild] = props.globalSync.child(dir, { bootstrap: false })
    setChild("session", [])
    setChild("sessionTotal", 0)
    setChild("message", {})
    setChild("part", {})

    const project = findProjectForWorkspace(props.projects, dir)
    if (!project) return
    const all = [project.worktree, ...(project.sandboxes ?? [])]
    const valid = all.filter((workspace) => workspace !== dir)
    props.state.workspace.cleanupRecency(project.id, valid)
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
    const index = props.globalSync.data.project.findIndex((p) => p.worktree === projectWorktree)
    if (index === -1) return
    const project = props.globalSync.data.project[index]
    const sandboxes = project.sandboxes?.filter((item) => item !== dir)
    if (project.sandboxes && sandboxes && sandboxes.length !== project.sandboxes.length) {
      props.globalSync.set("project", index, "sandboxes", sandboxes)
    }
    const workspaces = (project as Record<string, unknown>).workspaces as Record<string, unknown> | undefined
    if (workspaces && dir in workspaces) {
      const { [dir]: _, ...remaining } = workspaces
      props.globalSync.set("project", index, "workspaces" as any, remaining)
    }
    return project
  }

  const cleanupDeletedWorkspaceSelection = (dir: string, projectWorktree: string) => {
    for (const pane of props.state.wb.state.panes) {
      const worktree = props.state.workspace.paneWorktree(pane.id)
      if (worktree.pinned === dir) props.state.workspace.setPaneWorktreePinned(pane.id, null)
      if (worktree.default === dir) props.state.workspace.setPaneWorktreeDefault(pane.id, projectWorktree)
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
    phCapture("workspace_delete_initiated", { is_cloud: workspace.isCloud, is_main: workspace.isMain })
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
          const project = removeSandboxFromProject(projectWorktree, dir)
          props.state.workspace.cleanupDeletedWorktree(dir, project?.id)
          cleanupDeletedWorkspaceSelection(dir, projectWorktree)
        }}
        onClose={() => props.dialog.close()}
      />
    ))
  }

  const handleRemoveProject = (project: ProjectItem) => {
    phCapture("project_removed")
    const current = props.activeProjectId()
    for (const dir of [project.worktree, ...(project.sandboxes ?? [])]) {
      props.state.workspace.cleanupDeletedWorktree(dir, project.id)
    }
    props.layout.projects.close(project.worktree)
    if (current === project.worktree) {
      props.navigate("/")
    }
  }

  return {
    handleNewProject,
    handleNewWorkspace,
    handleNewLocalWorkspace,
    handleNewCloudWorkspace,
    handleSettings,
    handleHelp,
    handleDeleteWorkspace,
    handleRemoveProject,
  }
}
