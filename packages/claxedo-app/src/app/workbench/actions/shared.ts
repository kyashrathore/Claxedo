import type { Accessor } from "solid-js"
import type { useLayout } from "@/app/providers/layout"
import type { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import type { usePlatform } from "@/platform/runtime/platform-provider"
import type { useDialog } from "@opencode-ai/ui/context/dialog"
import type { useConfigOptional } from "../../providers/config"
import type { useClaxedoEventsOptional } from "../../integrations/claxedo-events"
import type { ProjectItem } from "../rail/domain-types"
import type { WorkspaceBarItem } from "../rail/workspace-toolbar"
import type { ClaxedoStateApi } from "../state/index"
import type { useDirectorySessionCacheActions } from "../../../features/session/data/sync/directory-session-cache"
import type { useGlobalBootstrapActions } from "../../integrations/sync/global-bootstrap"
import type { useProjectInventoryActions } from "../../integrations/sync/project-inventory"
import { sessionRefForWorkspaceSession } from "@/platform/identity/session-ref"
import { workspaceSessionRoute } from "@/platform/identity/route"

function projectWorkspaceEntry(project: ProjectItem, workspaceDir: string) {
  return Object.entries(project.workspaces ?? {}).find(
    ([key, workspace]) =>
      key === workspaceDir ||
      workspace.directory === workspaceDir ||
      workspace.id === workspaceDir ||
      workspace.workspaceId === workspaceDir,
  )
}

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
  params: { id?: string; sessionId?: string; dir?: string; pageId?: string; terminalId?: string }
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
  routeDirectory: Accessor<string | undefined>
  routeId: Accessor<string | undefined>
  activeDirectory: Accessor<string | undefined>
  activeProjectId: Accessor<string | undefined>
  canUseDocuments?: Accessor<boolean>
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
    if (data && typeof data === "object" && "message" in data && typeof data.message === "string") {
      return data.message
    }
  }
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message
  }
  if (err instanceof Error) return err.message
  return "Request failed"
}

export function findProjectForWorkspace(
  projects: Accessor<ProjectItem[]>,
  workspaceDir: string,
): ProjectItem | undefined {
  return projects().find(
    (p) =>
      p.worktree === workspaceDir || p.sandboxes?.includes(workspaceDir) || !!projectWorkspaceEntry(p, workspaceDir),
  )
}

export function findWorkspaceForDirectory(
  projects: Accessor<ProjectItem[]>,
  workspaceDir: string,
): WorkspaceBarItem | undefined {
  const project = findProjectForWorkspace(projects, workspaceDir)
  if (!project) return undefined
  const entry = projectWorkspaceEntry(project, workspaceDir)
  const [key, ws] = entry ?? []
  const main = project.worktree === workspaceDir
  const cloud = ws?.kind === "cloud"
  const directory = ws?.directory ?? workspaceDir
  const workspaceId = ws?.workspaceId ?? ws?.id ?? (key && key !== directory ? key : undefined)
  return {
    id: workspaceDir,
    directory,
    workspaceId,
    name: ws?.workspace_name ?? (main ? "main" : (workspaceDir.split("/").at(-1) ?? workspaceDir)),
    isMain: main,
    isCloud: cloud,
    canDelete: main ? cloud : true,
    projectWorktree: project.worktree,
    available: ws?.available ?? true,
  }
}

/**
 * The draft ("new session") route for a workspace directory, in DIRECTORY form.
 *
 * One URL form per workspace: every other writer (rail activation, tab-select
 * mirroring) addresses a local workspace by directory, so minting the draft
 * route from `workspaceId` flipped the `:workspaceId` param on the very next
 * navigation and re-ran workspace resolution. Keying by directory also means a
 * workspace that has no id yet still gets a route, where the id form silently
 * skipped the navigation entirely.
 */
export function workspaceDraftRouteForDirectory(_projects: Accessor<ProjectItem[]>, workspaceDir: string) {
  return workspaceSessionRoute(workspaceDir)
}

export function sessionRefForActionWorkspace(input: {
  projects: Accessor<ProjectItem[]>
  workspaceDir: string
  sessionId: string
}) {
  const project = findProjectForWorkspace(input.projects, input.workspaceDir)
  const workspace = project ? projectWorkspaceEntry(project, input.workspaceDir)?.[1] : undefined
  return sessionRefForWorkspaceSession({
    sessionId: input.sessionId,
    directory: input.workspaceDir,
    workspaceId: workspace?.workspaceId ?? workspace?.id,
    workspace:
      workspace?.kind === "cloud"
        ? {
            workspaceId: workspace.workspaceId ?? workspace.id,
            kind: "cloud",
          }
        : undefined,
  })
}

export function missingLocalWorkspace(projects: Accessor<ProjectItem[]>, workspaceDir: string) {
  const ws = findWorkspaceForDirectory(projects, workspaceDir)
  if (!ws) return undefined
  if (ws.isCloud) return undefined
  if (ws.available !== false) return undefined
  return ws
}
