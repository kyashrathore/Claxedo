import type { Accessor } from "solid-js"
import type { useLayout, useGlobalSDK, usePlatform } from "@opencode-ai/claxedo-app"
import type { useDialog } from "@opencode-ai/ui/context/dialog"
import type { useConfigOptional } from "../../context/config"
import type { useClaxedoEventsOptional } from "../../providers/claxedo-events"
import type { ProjectItem } from "../layouts/rail-sidebar"
import type { WorkspaceBarItem } from "../layouts/workspace-toolbar"
import type { ClaxedoStateApi } from "../state"
import type { useDirectorySessionCacheActions } from "../../shell/data/directory-session-cache"
import type { useGlobalBootstrapActions } from "../../shell/data/global-bootstrap"
import type { useProjectInventoryActions } from "../../shell/data/project-inventory"
import { sessionRefForWorkspaceSession } from "../../shell/identity/session-ref"

export type LayoutApi = ReturnType<typeof useLayout>
export type GlobalSDKApi = ReturnType<typeof useGlobalSDK>
export type DialogApi = ReturnType<typeof useDialog>
export type PlatformApi = ReturnType<typeof usePlatform>
export type ConfigApi = ReturnType<typeof useConfigOptional>
export type DirectorySessionCacheActions = ReturnType<typeof useDirectorySessionCacheActions>
export type GlobalBootstrapActions = ReturnType<typeof useGlobalBootstrapActions>
export type ProjectInventoryActions = ReturnType<typeof useProjectInventoryActions>

export type EventsApi = ReturnType<typeof useClaxedoEventsOptional>

export type ActionProps = {
  params: { id?: string; dir?: string; pageId?: string }
  navigate: (path: string) => void
  state: ClaxedoStateApi
  dialog: DialogApi
  directorySessionCacheActions: DirectorySessionCacheActions
  globalBootstrapActions: GlobalBootstrapActions
  projectInventoryActions: ProjectInventoryActions
  globalSDK: GlobalSDKApi
  layout: LayoutApi
  platform: PlatformApi
  config: ConfigApi
  events?: EventsApi
  projects: Accessor<ProjectItem[]>
  routeWorkspaceId: Accessor<string | undefined>
  activeWorkspaceId: Accessor<string | undefined>
  activeProjectId: Accessor<string | undefined>
  canUsePages?: Accessor<boolean>
  flowLog: (...args: unknown[]) => void
}

export type Nav = (path: string, reason: string, details?: Record<string, unknown>) => void

export async function ensureDirectorySessionCache(actions: DirectorySessionCacheActions, directory: string) {
  await actions.ensure({
    directory,
  })
}

export function message(err: unknown) {
  if (typeof err === "string") return err
  if (err && typeof err === "object" && "data" in err) {
    const data = err.data
    if (
      data &&
      typeof data === "object" &&
      "message" in data &&
      typeof data.message === "string"
    ) {
      return data.message
    }
  }
  if (
    err &&
    typeof err === "object" &&
    "message" in err &&
    typeof err.message === "string"
  ) {
    return err.message
  }
  if (err instanceof Error) return err.message
  return "Request failed"
}

export function findProjectForWorkspace(
  projects: Accessor<ProjectItem[]>,
  workspaceDir: string,
): ProjectItem | undefined {
  return projects().find((p) => p.worktree === workspaceDir || p.sandboxes?.includes(workspaceDir) || workspaceDir in (p.workspaces ?? {}))
}

export function findWorkspaceForDirectory(
  projects: Accessor<ProjectItem[]>,
  workspaceDir: string,
): WorkspaceBarItem | undefined {
  const project = findProjectForWorkspace(projects, workspaceDir)
  if (!project) return undefined
  const ws = project.workspaces?.[workspaceDir]
  const main = project.worktree === workspaceDir
  const cloud = ws?.kind === "cloud"
  return {
    id: workspaceDir,
    directory: workspaceDir,
    name: ws?.workspace_name ?? (main ? "main" : workspaceDir.split("/").at(-1) ?? workspaceDir),
    isMain: main,
    isCloud: cloud,
    canDelete: main ? cloud : true,
    projectWorktree: project.worktree,
    available: ws?.available ?? true,
  }
}

export function sessionRefForActionWorkspace(input: {
  projects: Accessor<ProjectItem[]>
  workspaceDir: string
  sessionId: string
}) {
  const project = findProjectForWorkspace(input.projects, input.workspaceDir)
  const workspace = project?.workspaces?.[input.workspaceDir]
  return sessionRefForWorkspaceSession({
    sessionId: input.sessionId,
    directory: input.workspaceDir,
    workspace: workspace?.kind === "cloud"
      ? {
          workspaceId: workspace.workspaceId ?? workspace.id,
          kind: "cloud",
        }
      : undefined,
  })
}

export function missingLocalWorkspace(
  projects: Accessor<ProjectItem[]>,
  workspaceDir: string,
) {
  const ws = findWorkspaceForDirectory(projects, workspaceDir)
  if (!ws) return undefined
  if (ws.isCloud) return undefined
  if (ws.available !== false) return undefined
  return ws
}
