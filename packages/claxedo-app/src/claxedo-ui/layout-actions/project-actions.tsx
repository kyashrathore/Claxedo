import { DialogSettings } from "@/components/dialogs/settings"
import { getFilename } from "@/utils/path"
import { showToast } from "@opencode-ai/ui/toast"
import { validWorktree } from "@/shared/data/worktree"

import { DialogSelectDirectory } from "@/components/dialogs/select-directory"
import { DialogCreateCloudWorkspace } from "../../components/dialogs/create-cloud-workspace"
import { DialogNewProject } from "../../components/dialogs/new-project"
import { api, getDefaultBaseUrl } from "@/shared/data/api"
import { DialogDeleteWorkspace } from "../components/dialogs"
import type { ProjectItem, WorkspaceItem } from "../rail/domain-types"
import type { WorkspaceBarItem } from "../rail/workspace-toolbar"
import { getAuthToken } from "@/shared/data/auth-client"
import { Worktree as WorktreeState } from "@/shared/data/worktree"
import type { ActionProps, Nav } from "./shared"
import { ensureDirectorySessionCache, findProjectForWorkspace, message } from "./shared"
import { capture as phCapture } from "../../utils/analytics"
import { workspaceSessionRoute } from "../../shell/identity/route"
import { createLocalWorkspace, type LocalWorkspaceProps } from "./workspace-recovery"
import type { ClaxedoEvent } from "../../context/claxedo-events"
import { queryClient } from "../../shared/query/query-client"
import { shellDataKeys } from "../../shell/data/keys"
import { directorySessionCacheQueryOptions, type DirectorySessionCacheValue } from "../../shell/data/queries"
import { ensureLocalProject } from "../../shared/query/project-ensure"
import {
  controlWorkspaceUrl,
  experimentalSandboxPath,
  workspaceCreateUrl,
  workspaceResolveUrl,
} from "@/agent-runtime/workspace-control-routes"

type ProvisionEvent = Extract<ClaxedoEvent, { type: "provision" }>
type WorkspaceDirectoryRef = string

export type ProjectActionProps = Pick<
  ActionProps,
  | "params"
  | "navigate"
  | "dialog"
  | "directorySessionCacheActions"
  | "events"
  | "globalBootstrapActions"
  | "projectInventoryActions"
  | "config"
  | "projects"
  | "routeDirectory"
  | "activeDirectory"
  | "activeProjectId"
  | "flowLog"
> & {
  state: {
    wb: {
      state: Pick<ActionProps["state"]["wb"]["state"], "focusedPaneId" | "panes">
    }
    workspace: Pick<
      ActionProps["state"]["workspace"],
      | "setPaneWorktreePinned"
      | "setPaneWorktreeDefault"
      | "paneWorktree"
      | "recordAccess"
      | "cleanupRecency"
      | "cleanupDeletedWorktree"
    >
    layout: Pick<ActionProps["state"]["layout"], "openSession" | "closeContent">
    meta: Pick<ActionProps["state"]["meta"], "findAll">
  }
  globalSDK: {
    url?: string
    client: {
      worktree: {
        create: (input: { directory: WorkspaceDirectoryRef; worktreeCreateInput: { name?: string } }) => Promise<{
          data?: {
            directory?: WorkspaceDirectoryRef
            name?: string | null
          }
        }>
        remove: (input: { directory: WorkspaceDirectoryRef; worktreeRemoveInput: { directory: WorkspaceDirectoryRef } }) => Promise<unknown>
      }
    }
  }
  layout: {
    projects: Pick<ActionProps["layout"]["projects"], "open" | "close" | "remove">
  }
  platform: Pick<ActionProps["platform"], "platform" | "fetch" | "openLink">
}

export function createProjectActions(props: ProjectActionProps, nav: Nav) {
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
        routeDir: props.activeDirectory(),
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
          await ensureLocalProject({
            baseUrl: props.globalSDK.url,
            request: props.platform.fetch,
            directory: workspaceDir,
            projectsQuery: props.projectInventoryActions.query(),
          })
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
      void ensureDirectorySessionCache(props.directorySessionCacheActions, workspaceDir)
      const id = openProjectSessionSurface(workspaceDir)
      if (id)
        nav(workspaceSessionRoute(workspaceDir), "new-project-selected", {
          workspaceDir,
          surfaceId: id,
        })
      props.dialog.close()
    }

    void props.dialog.show(() => (
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

    const onWorktreeCreated = async (
      created: string,
      name: string,
      wait = false,
    ): Promise<WorkspaceBarItem | undefined> => {
      props.flowLog("workspace created", {
        projectId: project.id,
        created,
        name,
        routeDir: props.activeDirectory(),
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
      const cacheReady = ensureDirectorySessionCache(props.directorySessionCacheActions, created)
      if (!wait) void cacheReady
      props.state.workspace.recordAccess(project.id, created)

      if (wait) {
        const result = await WorktreeState.wait(created)
        if (result.status === "failed") {
          showToast({
            title: "Failed to create worktree",
            description: result.message,
            variant: "error",
          })
          return undefined
        }

        await cacheReady
      }

      const tabId = openProjectSessionSurface(created)

      if (tabId)
        nav(workspaceSessionRoute(created), "new-workspace-created", {
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
        if (created) {
          // The create call resolved, so the worktree exists on disk. Nothing
          // else in production flips WorktreeState pending→ready, so mark it
          // ready here; otherwise onWorktreeCreated's WorktreeState.wait() below
          // blocks forever (core-workspace-lifecycle:544).
          WorktreeState.ready(created)
          return onWorktreeCreated(created, name ?? getFilename(created), true)
        }
      } catch (err) {
        handleError(err)
      }
      return undefined
    }

    // When sandbox is enabled, let the user choose between local worktree and cloud sandbox
    if (props.config?.sandboxEnabled) {
      return new Promise<WorkspaceBarItem | undefined>((resolve) => {
        void props.dialog.show(() => (
          <DialogNewProject
            onLocal={async () => {
              props.dialog.close()
              resolve(await createLocalWorktree())
            }}
            onCloud={() => {
              void props.dialog.show(() => (
                <DialogCreateCloudWorkspace
                  projectId={project.id}
                  onCreated={async (dir) => {
                    await props.globalBootstrapActions.bootstrap().catch(() => undefined)
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
        if (tabId) nav(workspaceSessionRoute(created), "new-workspace-created", { projectId: project.id, created, tabId })
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
    let unsubProvision: (() => void) | undefined
    let provisionTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const buffered: ProvisionEvent[] = []
      const published = new Set<string>()
      let workspaceId: string | undefined
      let provisionReady: Promise<void> | undefined
      let finishProvision: ((event?: ProvisionEvent) => void) | undefined
      let failProvision: ((error: Error) => void) | undefined

      const pushProgress = (step: string, message?: string) => {
        if (step !== "error" && published.has(step)) return
        published.add(step)
        onProgress?.(step, message)
      }

      const publishProvision = (ev: ProvisionEvent) => {
        if (ev.workspaceId !== workspaceId) return
        pushProgress(ev.step, ev.message)
        if (ev.step === "ready") finishProvision?.(ev)
        if (ev.step === "error") failProvision?.(new Error(ev.message || "Provisioning failed"))
      }

      if (props.events) {
        provisionReady = new Promise<void>((resolve, reject) => {
          finishProvision = () => resolve()
          failProvision = reject
          unsubProvision = props.events?.on("provision", (ev) => {
            if (!workspaceId) {
              buffered.push(ev)
              return
            }
            publishProvision(ev)
          })
          provisionTimer = setTimeout(() => {
            unsubProvision?.()
            resolve()
          }, 120_000)
        })
      }

      const body: Record<string, string> = { projectId: project.id }
      if (workspaceName) body.workspaceName = workspaceName
      const result = await api.post<{ workspaceId: string; directory?: string; workspaceName?: string | null; status?: string | null }>(
        workspaceCreateUrl({ baseUrl }),
        body,
      )
      const dir = result.directory
      if (!dir) throw new Error("Workspace create did not return a directory")
      workspaceId = result.workspaceId

      for (const ev of buffered) publishProvision(ev)
      const current = await api
        .get<{ status?: string | null }>(workspaceResolveUrl({ baseUrl, workspaceId }))
        .catch(() => undefined)
      const status = current?.status ?? result.status
      if (status && status !== "pending") pushProgress(status)
      if (status === "ready") finishProvision?.()
      await provisionReady
      if (provisionTimer) clearTimeout(provisionTimer)
      unsubProvision?.()

      await props.globalBootstrapActions.bootstrap().catch(() => undefined)
      pushProgress("ready")
      pushProgress("redirecting")
      await new Promise(resolve => setTimeout(resolve, 1200))
      props.flowLog("workspace created", { projectId: project.id, created: dir })
      const item = {
        id: result.workspaceId,
        workspaceId: result.workspaceId,
        directory: dir,
        name: result.workspaceName ?? workspaceName ?? result.workspaceId,
        projectWorktree: worktree,
        canDelete: true,
      } satisfies WorkspaceBarItem
      props.state.workspace.recordAccess(project.id, result.workspaceId)
      const tabId = openProjectSessionSurface(dir)
      if (tabId) nav(workspaceSessionRoute(dir), "new-workspace-created", { projectId: project.id, created: dir, tabId })
      return item
    } catch (err) {
      onProgress?.("error", err instanceof Error ? err.message : "Failed to create cloud workspace")
      showToast({ title: "Failed to create cloud workspace", description: message(err), variant: "error" })
    } finally {
      if (provisionTimer) clearTimeout(provisionTimer)
      unsubProvision?.()
    }
    return undefined
  }

  const handleSettings = () => {
    void props.dialog.show(() => <DialogSettings />)
  }

  const handleHelp = () => {
    // Claxedo does not yet have a dedicated docs site (tracked separately);
    // point at the project repo, which is also what claxedo-web's own
    // `docs` link resolves to today (packages/claxedo-web/src/config.ts).
    props.platform.openLink("https://github.com/kyashrathore/Claxedo")
  }

  const purgeWorkspaceState = (dir: string) => {
    props.state.meta.findAll((m) => m.directory === dir).forEach((meta) => {
      props.state.layout.closeContent(meta.id)
    })
    queryClient
      .getQueryData<DirectorySessionCacheValue>(directorySessionCacheQueryOptions({ directory: dir }).queryKey)
      ?.session.forEach((session) => {
        queryClient.removeQueries({ queryKey: shellDataKeys.sessionId(session.id) })
      })
    queryClient.removeQueries({ queryKey: directorySessionCacheQueryOptions({ directory: dir }).queryKey, exact: true })

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

    const res = await fetch(experimentalSandboxPath(dir), {
      method: "DELETE",
      headers,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => undefined)
      const error = err && typeof err === "object" && "error" in err && typeof err.error === "string"
        ? err.error
        : undefined
      throw new Error(error || "Failed to destroy sandbox")
    }
  }

  const deleteWorkspaceWorktree = async (projectWorktree: string, dir: string) => {
    await props.globalSDK.client.worktree.remove({
      directory: projectWorktree,
      worktreeRemoveInput: { directory: dir },
    })
  }

  const removeSandboxFromProject = (projectWorktree: string, dir: string) => {
    let updatedProject: ProjectItem | undefined
    queryClient.setQueryData<ProjectItem[] | undefined>(
      props.projectInventoryActions.queryKey(),
      (cached) => {
        const projects = cached ?? props.projects()
        if (!projects.length) return cached
        let changed = false
        const next = projects.map((project) => {
          if (project.worktree !== projectWorktree) return project
          const sandboxes = project.sandboxes?.filter((item) => item !== dir)
          const removeSandbox = !!project.sandboxes && !!sandboxes && sandboxes.length !== project.sandboxes.length
          const removeWorkspace = !!project.workspaces && dir in project.workspaces
          if (!removeSandbox && !removeWorkspace) {
            updatedProject = project
            return project
          }
          changed = true
          const remaining = removeWorkspace
            ? Object.fromEntries(Object.entries(project.workspaces ?? {}).filter(([workspaceDir]) => workspaceDir !== dir))
            : project.workspaces
          updatedProject = {
            ...project,
            ...(removeSandbox ? { sandboxes } : {}),
            ...(removeWorkspace ? { workspaces: remaining } : {}),
          }
          return updatedProject
        })
        return changed ? next : cached
      },
    )
    return updatedProject
  }

  const cleanupDeletedWorkspaceSelection = (dir: string, projectWorktree: string) => {
    for (const pane of props.state.wb.state.panes) {
      const worktree = props.state.workspace.paneWorktree(pane.id)
      if (worktree.pinned === dir) props.state.workspace.setPaneWorktreePinned(pane.id, null)
      if (worktree.default === dir) props.state.workspace.setPaneWorktreeDefault(pane.id, projectWorktree)
    }
    if (props.activeDirectory() === dir) {
      props.navigate("/")
    }
  }

  const deleteProjectWorkspace = async (project: ProjectItem) => {
    const workspaceId = project.workspaces?.[project.worktree]?.workspaceId ?? project.workspaces?.[project.worktree]?.id ?? project.id
    const res = await (props.platform.fetch ?? fetch)(
      controlWorkspaceUrl({ workspaceId }),
      { method: "DELETE" },
    )
    if (res.ok || res.status === 404) return
    const body = await res.json().catch(() => undefined)
    const description = body && typeof body === "object" && "error" in body
      ? message(body.error)
      : "Failed to remove project from workspace store"
    throw new Error(description)
  }

  const removeProjectFromInventory = (project: ProjectItem) => {
    queryClient.setQueryData<ProjectItem[] | undefined>(
      props.projectInventoryActions.queryKey(),
      (cached) => cached?.filter((item) => item.id !== project.id && item.worktree !== project.worktree),
    )
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
    void props.dialog.show(() => (
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
          cleanupDeletedWorkspaceSelection(dir, projectWorktree)
          props.state.workspace.cleanupDeletedWorktree(dir, project?.id)
        }}
        onClose={() => props.dialog.close()}
      />
    ))
  }

  const handleRemoveProject = (project: ProjectItem) => {
    phCapture("project_removed")
    const current = props.activeProjectId()
    for (const dir of [project.worktree, ...(project.sandboxes ?? [])]) {
      purgeWorkspaceState(dir)
      props.state.workspace.cleanupDeletedWorktree(dir, project.id)
    }
    removeProjectFromInventory(project)
    props.layout.projects.close(project.worktree)
    if (current === project.worktree) {
      props.navigate("/")
    }
    void deleteProjectWorkspace(project).catch((err) => {
      showToast({
        title: "Failed to remove project",
        description: message(err),
        variant: "error",
      })
    })
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
