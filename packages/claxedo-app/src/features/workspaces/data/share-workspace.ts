import { workspaceRoute } from "@/platform/identity/route"
import { isFilesystemDirectory } from "@/platform/identity/legacy-resolver"
import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"

type ProjectWorkspace = {
  id?: string
  workspace_id?: string
  directory?: string
  kind?: string
}

export type LocalWorkspaceShareTarget = {
  workspaceId: string
  directory: string
}

type ShareableProject = {
  id?: string
  worktree: string
  workspaces?: Record<string, ProjectWorkspace>
}

export function localWorkspaceShareTarget(input: {
  project: ShareableProject
  directory: string
}): LocalWorkspaceShareTarget | undefined {
  const workspaces = input.project.workspaces ?? {}
  const rows = Object.values(workspaces)
  const row =
    workspaces[input.directory] ??
    rows.find((item) => item.directory === input.directory) ??
    rows.find((item) => item.id === input.directory || item.workspace_id === input.directory)
  const directory = row?.directory ?? (input.directory === input.project.worktree ? input.project.worktree : undefined)
  const workspaceId =
    row?.id ?? row?.workspace_id ?? (input.directory === input.project.worktree ? input.project.id : undefined)
  if (!workspaceId || !directory || !isFilesystemDirectory(directory)) return
  if (row?.kind === "cloud") return
  return { workspaceId, directory }
}

function errorMessage(input: unknown, fallback: string) {
  if (!input || typeof input !== "object") return fallback
  const error = (input as { error?: unknown }).error
  if (!error || typeof error !== "object") return fallback
  const message = (error as { message?: unknown }).message
  return typeof message === "string" && message.trim() ? message : fallback
}

async function responseJson(response: Response) {
  return await response
    .clone()
    .json()
    .catch(() => undefined)
}

export function workspaceShareUrl(input: { origin?: string; workspaceId: string }) {
  const origin = input.origin ?? (typeof window === "undefined" ? undefined : window.location.origin)
  if (!origin) return workspaceRoute(input.workspaceId)
  return new URL(workspaceRoute(input.workspaceId), origin).toString()
}

function workspaceUserHostedRegisterUrl(input: { serverUrl?: string; workspaceId: string }) {
  return new URL(
    `/api/workspace/${encodeURIComponent(input.workspaceId)}/user-hosted/register`,
    normalizeUrl(input.serverUrl) ?? getClaxedoServerUrl(),
  )
}

export async function registerUserHostedWorkspace(input: {
  workspaceId: string
  displayName?: string
  serverUrl?: string
  request?: typeof fetch
}) {
  const response = await (input.request ?? authFetch)(
    workspaceUserHostedRegisterUrl({
      serverUrl: input.serverUrl ?? getClaxedoServerUrl(),
      workspaceId: input.workspaceId,
    }),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...(input.displayName ? { displayName: input.displayName } : {}),
      }),
    },
  )
  if (!response.ok)
    throw new Error(errorMessage(await responseJson(response), `Share workspace failed: ${response.status}`))
  return await responseJson(response)
}
