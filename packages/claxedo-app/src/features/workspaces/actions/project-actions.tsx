import {
  DialogDeleteWorkspace,
  DialogSelectDirectory,
  DialogSettings,
  directorySessionCacheQueryOptions,
  ensureDirectorySessionCache,
  findProjectForWorkspace,
  message,
} from "@/features/workspaces/app-ports"
import { showToast } from "@opencode-ai/ui/toast"
import { validWorktree } from "@/platform/sync/worktree"

import { api, apiBearerToken, getDefaultBaseUrl } from "@/platform/api/api"
import type { ProjectItem, WorkspaceItem } from "../../../app/workbench/rail/domain-types"
import type { WorkspaceBarItem } from "../../../app/workbench/rail/workspace-toolbar"
import type { ActionProps, Nav } from "../../../app/workbench/actions/shared"
import { workspaceSessionRoute } from "@/platform/identity/route"
import { workspaceRouteId as routeIdFromProjects } from "@/platform/identity/workspace-route"
import { createLocalWorkspace, type LocalWorkspaceProps } from "./workspace-recovery"
import { DialogCreateCloudProject } from "../ui/dialogs/create-cloud-project"
import { centralTransportForServer } from "@/platform/runtime/transport"
import type { ClaxedoEvent } from "../../../app/integrations/claxedo-events"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import type { DirectorySessionCacheValue } from "../../session/data/sync/queries"
import { ensureLocalProject } from "../data/query/project-ensure"
import {
  controlWorkspaceUrl,
  experimentalSandboxPath,
  workspaceCreateUrl,
  workspaceResolveUrl,
} from "@/platform/runtime/agent/workspace-control-routes"

type ProvisionEvent = Extract<ClaxedoEvent, { type: "provision" }>
type WorkspaceDirectoryRef = string

/**
 * Every directory a project owns: its root worktree, its sandboxes, and the
 * worktrees in `workspaces`.
 *
 * Removing a project has to purge state keyed by directory — open tabs above
 * all — and tab metas carry the workspace directory, not the project id. The
 * three lists overlap but none of them is a superset: a git worktree created
 * from the project shows up in `workspaces` without ever being a sandbox, so
 * walking only `worktree + sandboxes` left that worktree's tabs behind in the
 * switcher, pointing at a project that no longer exists.
 */
function projectDirectories(project: ProjectItem): string[] {
  return [
    ...new Set([
      project.worktree,
      ...(project.sandboxes ?? []),
      ...Object.keys(project.workspaces ?? {}),
    ]),
  ].filter(Boolean)
}

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
  | "workspaceRouteId"
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
  const ensureLocalWorkspaceRouteId = async (dir: string) => {
    const current = props.workspaceRouteId(dir)
    if (current) return current
    const projects = await ensureLocalProject({
      baseUrl: props.globalSDK.url,
      request: props.platform.fetch,
      directory: dir,
      projectsQuery: props.projectInventoryActions.query(),
    })
    return Array.isArray(projects) ? routeIdFromProjects(projects, dir) : undefined
  }

  const openProjectSessionSurface = (workspaceDir: string, workspaceRouteId: string) => {
    const paneId = props.state.wb.state.focusedPaneId
    if (paneId) {
      props.state.workspace.setPaneWorktreePinned(paneId, null)
      props.state.workspace.setPaneWorktreeDefault(paneId, workspaceDir)
    }
    return props.state.layout.openSession(workspaceDir, "new", "New Session", { workspaceRouteId })
  }
  const handleNewProject = () => {
    async function handleProjectSelected(workspaceDir: string) {
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

      let routeId = props.workspaceRouteId(workspaceDir)
      if (props.platform.platform !== "web") {
        try {
          const projects = await ensureLocalProject({
            baseUrl: props.globalSDK.url,
            request: props.platform.fetch,
            directory: workspaceDir,
            projectsQuery: props.projectInventoryActions.query(),
          })
          routeId = Array.isArray(projects) ? routeIdFromProjects(projects, workspaceDir) : routeId
        } catch {
          showToast({
            title: "Not a git repository",
            description: "Only git repositories can be added as projects",
            variant: "error",
          })
          return
        }
      }
      if (!routeId) return
      props.layout.projects.open(workspaceDir)
      void ensureDirectorySessionCache(props.directorySessionCacheActions, workspaceDir)
      const id = openProjectSessionSurface(workspaceDir, routeId)
      if (id)
        nav(workspaceSessionRoute(routeId), "new-project-selected", {
          workspaceDir,
          surfaceId: id,
        })
      props.dialog.close()
    }

    // On HOSTED web there is no local filesystem behind the directory picker —
    // it routes through the loopback bridge and dead-ends. The hosted-web path
    // is the cloud create flow: pick a connected GitHub repository (or paste a
    // URL, with a connect-GitHub path inside the dialog), provision a sandbox,
    // and open the resulting workspace directory like any other selection.
    // Web against a LOOPBACK server (self-host localhost) keeps the directory
    // picker — the local filesystem is right there, same discriminator the
    // home route uses.
    if (props.platform.platform === "web" && centralTransportForServer(props.globalSDK.url) !== "loopback") {
      void props.dialog.show(() => (
        <DialogCreateCloudProject
          onSelect={(result) => {
            const directory = Array.isArray(result) ? result[0] : result
            if (typeof directory === "string" && directory) {
              void handleProjectSelected(directory)
            }
          }}
        />
      ))
      return
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

  /** Create a local worktree directly — no dialog */
  const handleNewLocalWorkspace = async (
    project: ProjectItem,
    onProgress?: (step: string, message?: string) => void,
    workspaceName?: string,
  ): Promise<WorkspaceBarItem | undefined> => {
    return createLocalWorkspace(props, project, {
      onProgress,
      workspaceName,
      onReady: async (created) => {
        onProgress?.("redirecting")
        const routeId = await ensureLocalWorkspaceRouteId(created)
        if (!routeId) return
        const tabId = openProjectSessionSurface(created, routeId)
        if (tabId) nav(workspaceSessionRoute(routeId), "new-workspace-created", { projectId: project.id, created, tabId })
      },
    })
  }

  /** Create a cloud sandbox directly — no dialog, calls API inline with progress */
  const handleNewCloudWorkspace = async (
    project: ProjectItem,
    onProgress?: (step: string, message?: string) => void,
    workspaceName?: string,
    /**
     * Callers that own what opens in the new workspace (the terminal creator
     * opens a terminal there) pass `openSession: false`, so provisioning does
     * not race them by opening a session surface and navigating to it first.
     */
    opts?: { openSession?: boolean },
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
      if (opts?.openSession !== false) {
        const tabId = openProjectSessionSurface(dir, result.workspaceId)
        if (tabId) nav(workspaceSessionRoute(result.workspaceId), "new-workspace-created", { projectId: project.id, created: dir, tabId })
      }
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

  /**
   * Provision a workspace for the project owning `directory` and resolve to the
   * created directory, WITHOUT opening anything in it.
   *
   * `handleNewLocalWorkspace` / `handleNewCloudWorkspace` both end by opening a
   * session surface and navigating to it, which is the right default for the
   * sidebar's "add workspace" affordances and wrong for any caller that already
   * knows what belongs in the new workspace. The terminal creator is the first
   * such caller: it provisions on launch and then opens a terminal there.
   *
   * Resolves undefined when the flow fails — the underlying handlers raise their
   * own toast, so callers should stop rather than report a second error.
   */
  const createWorkspaceDirectory = async (input: {
    directory: WorkspaceDirectoryRef
    kind: "local" | "cloud"
    workspaceName?: string
    onProgress?: (step: string, message?: string) => void
  }): Promise<{ directory: WorkspaceDirectoryRef; workspaceId: string } | undefined> => {
    const project = findProjectForWorkspace(props.projects, input.directory)
    if (!project) return undefined
    const created = input.kind === "cloud"
      ? await handleNewCloudWorkspace(project, input.onProgress, input.workspaceName, { openSession: false })
      : await createLocalWorkspace(props, project, {
          onProgress: input.onProgress,
          workspaceName: input.workspaceName,
        })
    if (!created?.directory) return undefined
    const workspaceId = created.workspaceId ?? (
      input.kind === "local" ? await ensureLocalWorkspaceRouteId(created.directory) : undefined
    )
    return workspaceId ? { directory: created.directory, workspaceId } : undefined
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
    // `providerDirectory` as well as `directory`: a draft-session tab is scoped
    // `global` and only records the workspace that would receive its first
    // prompt, so matching on `directory` alone left the draft tab of a removed
    // project open with nowhere to send anything.
    props.state.meta
      .findAll((m) => m.directory === dir || m.providerDirectory === dir)
      .forEach((meta) => {
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
    // The bearer comes from whatever the build bound through
    // `configureApiRuntime({ bearerToken })`, not from the identity provider
    // directly — importing `getAuthToken` here put Clerk in the local bundle
    // for one cloud-only action. A local build binds no source and gets `null`,
    // which this already handled: the header is simply omitted, and only a
    // cloud workspace reaches here at all.
    const token = await apiBearerToken()
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
    const current = props.activeProjectId()
    // Navigate away BEFORE purging tabs. While the route still names the
    // removed workspace (`/w/:workspaceId/session`), route-intent recreates the draft
    // surface the purge just closed (`route-intent.ts` receive() opens a
    // `sessionId: "new"` draft for a workspace session route), route-sync then
    // keeps the URL parked on the removed workspace, and
    // `autoOpenActiveProject` (`app-shell-state.ts`, `ignoreClosed: true`)
    // silently re-opens the project the user just removed — the sidebar row
    // came back within a second of the (successful) optimistic removal.
    // Leaving the route first makes the purge below final.
    if (current === project.worktree) {
      props.navigate("/")
    }
    for (const dir of projectDirectories(project)) {
      purgeWorkspaceState(dir)
      props.state.workspace.cleanupDeletedWorktree(dir, project.id)
    }
    removeProjectFromInventory(project)
    props.layout.projects.close(project.worktree)
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
    handleNewLocalWorkspace,
    handleNewCloudWorkspace,
    createWorkspaceDirectory,
    handleSettings,
    handleHelp,
    handleDeleteWorkspace,
    handleRemoveProject,
  }
}
