import type { Accessor } from "solid-js"
import type { useLayout, useGlobalSync, useGlobalSDK, usePlatform } from "@opencode-ai/claxedo-app"
import type { useDialog } from "@opencode-ai/ui/context/dialog"
import type { useConfigOptional } from "../../context/config"
import type { useClaxedoLayout } from "../context/claxedo-layout"
import type { useClaxedoEventsOptional } from "../../providers/claxedo-events"
import type { ProjectItem } from "../layouts/rail-sidebar"
import type { WorkspaceBarItem } from "../layouts/top-tab-bar"

export type ClaxedoApi = ReturnType<typeof useClaxedoLayout>
export type LayoutApi = ReturnType<typeof useLayout>
export type GlobalSyncApi = ReturnType<typeof useGlobalSync>
export type GlobalSDKApi = ReturnType<typeof useGlobalSDK>
export type DialogApi = ReturnType<typeof useDialog>
export type PlatformApi = ReturnType<typeof usePlatform>
export type ConfigApi = ReturnType<typeof useConfigOptional>

export type EventsApi = ReturnType<typeof useClaxedoEventsOptional>

export type ActionProps = {
  params: { id?: string; dir?: string; pageId?: string; tabId?: string }
  navigate: (path: string) => void
  claxedo: ClaxedoApi
  dialog: DialogApi
  globalSync: GlobalSyncApi
  globalSDK: GlobalSDKApi
  layout: LayoutApi
  platform: PlatformApi
  config: ConfigApi
  events?: EventsApi
  projects: Accessor<ProjectItem[]>
  activeWorkspaceId: Accessor<string | undefined>
  activeProjectId: Accessor<string | undefined>
  flowLog: (...args: unknown[]) => void
}

export type Nav = (path: string, reason: string, details?: Record<string, unknown>) => void

export function message(err: unknown) {
  if (typeof err === "string") return err
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: unknown }).data
    if (
      data &&
      typeof data === "object" &&
      "message" in data &&
      typeof (data as { message?: unknown }).message === "string"
    ) {
      return (data as { message: string }).message
    }
  }
  if (
    err &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message
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
  if (!project) return
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

export function missingLocalWorkspace(
  projects: Accessor<ProjectItem[]>,
  workspaceDir: string,
) {
  const ws = findWorkspaceForDirectory(projects, workspaceDir)
  if (!ws) return
  if (ws.isCloud) return
  if (ws.available !== false) return
  return ws
}
