import { workspaceRoute } from "@/platform/identity/route"
import { machineRemoteAccess } from "@/platform/remote-access/machine-remote-access"
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
  const row = workspaces[input.directory] ??
    rows.find((item) => item.directory === input.directory) ??
    rows.find((item) => item.id === input.directory || item.workspace_id === input.directory)
  const directory = row?.directory ?? (input.directory === input.project.worktree ? input.project.worktree : undefined)
  const workspaceId = row?.id ?? row?.workspace_id ?? (input.directory === input.project.worktree ? input.project.id : undefined)
  if (!workspaceId || !directory || !isFilesystemDirectory(directory)) return
  // Anything the engine marks non-local (cloud OR user-hosted) is a remote
  // representation — including the control plane's echo of this machine's own
  // registration — never a directory this machine can publish.
  if (row?.kind && row.kind !== "local") return
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
  return await response.clone().json().catch(() => undefined)
}

export function workspaceShareUrl(input: { origin?: string; workspaceId: string }) {
  const origin = input.origin ?? (typeof window === "undefined" ? undefined : window.location.origin)
  if (!origin) return workspaceRoute(input.workspaceId)
  return new URL(workspaceRoute(input.workspaceId), origin).toString()
}

function workspaceHostAssignmentUrl(input: { serverUrl?: string; workspaceId: string }) {
  return new URL(
    `/api/workspace/${encodeURIComponent(input.workspaceId)}/host-assignment`,
    normalizeUrl(input.serverUrl) ?? getClaxedoServerUrl(),
  )
}

/**
 * Registration is CLIENT-SIGNED: the control plane demands a challenge signed
 * with this machine's host key, and only the local daemon holds that key
 * (`registerLocalHostLink` resolves the workspace, signs the challenge, and
 * registers with the control plane). Calling the control plane directly from
 * here can never work — the renderer has nothing to sign with, and the server
 * answered every such attempt with `invalid_request_body`.
 */
export async function registerUserHostedWorkspace(input: {
  workspaceId: string
  displayName?: string
  serverUrl?: string
  request?: typeof fetch
}) {
  // The desktop: the Host Connector owns the machine key, so the port is the
  // only path that can produce the signed challenge. The self-hosted server:
  // no port is bound, and its own local route below performs the same flow
  // server-side.
  const port = input.request ? undefined : machineRemoteAccess()
  if (port?.shareWorkspace) {
    await port.shareWorkspace({
      workspaceId: input.workspaceId,
      ...(input.displayName ? { displayName: input.displayName } : {}),
    })
    return
  }
  const response = await (input.request ?? authFetch)(workspaceHostAssignmentUrl({
    serverUrl: input.serverUrl ?? getClaxedoServerUrl(),
    workspaceId: input.workspaceId,
  }), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...(input.displayName ? { displayName: input.displayName } : {}),
    }),
  })
  if (!response.ok) throw new Error(errorMessage(await responseJson(response), `Share workspace failed: ${response.status}`))
  return await responseJson(response)
}

/** Withdraw one workspace this machine publishes. Mirrors the register above. */
export async function unregisterUserHostedWorkspace(input: {
  workspaceId: string
  serverUrl?: string
  request?: typeof fetch
}) {
  const port = input.request ? undefined : machineRemoteAccess()
  if (port?.unshareWorkspace) {
    await port.unshareWorkspace(input.workspaceId)
    return
  }
  const response = await (input.request ?? authFetch)(workspaceHostAssignmentUrl({
    serverUrl: input.serverUrl ?? getClaxedoServerUrl(),
    workspaceId: input.workspaceId,
  }), {
    method: "DELETE",
    headers: { Accept: "application/json" },
  })
  if (!response.ok) throw new Error(errorMessage(await responseJson(response), `Unshare workspace failed: ${response.status}`))
  return await responseJson(response)
}
