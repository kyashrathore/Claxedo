import { createWorkspaceRuntimeClient, workspaceRuntimeClientError, type WorkspaceRuntimeClient } from "@claxedo/workspace-runtime/client"
import { asRecord } from "@claxedo/helpers/guards"
import type { ClaxedoFetch, ClaxedoMcpClient, ResolvedTarget, TasksGrant, WorkspaceSummary, WorkspaceTarget } from "./contract"
import { ClaxedoMcpClientError } from "./errors"
import {
  createWorkspaceConnectionCache,
  relayRuntimeBaseUrl,
  type WorkspaceConnection,
  type WorkspaceConnectionOptions,
} from "./relay-connection"

export type { ClaxedoFetch, ClaxedoMcpClient, ResolvedTarget, TasksGrant, TasksOperation, WorkspaceSummary, WorkspaceTarget } from "./contract"
export { ClaxedoMcpClientError, type ClaxedoMcpClientErrorCode } from "./errors"
export type { WorkspaceConnection } from "./relay-connection"

export type ClaxedoMcpClientOptions = Readonly<{
  deployment: ClaxedoMcpClient["deployment"]
  /** The runtime running in this process and the one workspace it serves; absent on the hosted Worker, which serves nothing itself. */
  local?: Readonly<{ fetch: ClaxedoFetch; workspace: WorkspaceTarget }>
  /** Control-plane routes, already authenticated as the calling user. */
  controlPlane?: Readonly<{ fetch: ClaxedoFetch }>
  documents?: Readonly<{ fetch: ClaxedoFetch }>
  tasks?: TasksGrant
  /** Dials the relay; defaults to the global fetch. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
}> &
  Pick<WorkspaceConnectionOptions, "now" | "sleep" | "refreshWindowMs" | "provisioningMaxAttempts">

/**
 * `createWorkspaceRuntimeClient` builds absolute URLs, but the in-process runtime
 * fetch receives only a path. This origin is the scaffold those URLs are built
 * on; the adapter strips it before calling the runtime, so it is never dialled.
 */
const IN_PROCESS_ORIGIN = "http://runtime.local"

export function createClaxedoMcpClient(options: ClaxedoMcpClientOptions): ClaxedoMcpClient {
  const { deployment, local, controlPlane, now, sleep, refreshWindowMs, provisioningMaxAttempts } = options
  if (deployment === "hosted" && local) {
    throw new ClaxedoMcpClientError("unresolvable-target", "A hosted endpoint serves no runtime in-process")
  }
  if (deployment !== "hosted" && !local) {
    throw new ClaxedoMcpClientError("local-runtime-required", `A ${deployment} endpoint needs its in-process runtime`)
  }
  if (deployment === "hosted" && !controlPlane) {
    throw new ClaxedoMcpClientError("control-plane-required", "A hosted endpoint needs the calling user's control-plane credential")
  }
  const relayFetch = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const connections = controlPlane
    ? createWorkspaceConnectionCache({ controlPlane: controlPlane.fetch, now, sleep, refreshWindowMs, provisioningMaxAttempts })
    : undefined

  const requireControlPlane = (purpose: string) => {
    if (!controlPlane || !connections) {
      throw new ClaxedoMcpClientError("control-plane-required", `${purpose} needs an account credential and none is reachable`)
    }
    return { fetch: controlPlane.fetch, connections }
  }

  const servedLocally = (target: WorkspaceTarget) => {
    if (!local) return false
    if (target.workspaceId) return target.workspaceId === local.workspace.workspaceId
    return true
  }

  const localTarget = (target: WorkspaceTarget): ResolvedTarget => {
    const workspaceId = target.workspaceId ?? local?.workspace.workspaceId
    const directory = target.directory ?? local?.workspace.directory
    return {
      kind: deployment === "node" ? "node" : "loopback",
      ...(workspaceId ? { workspaceId } : {}),
      ...(directory ? { directory } : {}),
      baseUrl: "",
      headers: {},
    }
  }

  const relayWorkspaceId = (target: WorkspaceTarget) => {
    if (!target.workspaceId) {
      throw new ClaxedoMcpClientError(
        "unresolvable-target",
        `A ${deployment} endpoint reaches other workspaces by id; a directory alone names nothing here`,
      )
    }
    return target.workspaceId
  }

  const relayTarget = (connection: WorkspaceConnection): ResolvedTarget => ({
    kind: "relay",
    workspaceId: connection.workspaceId,
    baseUrl: relayRuntimeBaseUrl(connection),
    headers: { Authorization: `Bearer ${connection.runtimeAccessToken}` },
    expiresAt: connection.tokenExpiresAt,
  })

  const send = (connection: WorkspaceConnection, path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${connection.runtimeAccessToken}`)
    // A redirect off the relay must not carry the runtime token to wherever it points.
    return relayFetch(`${relayRuntimeBaseUrl(connection)}${path}`, { ...init, headers, redirect: init?.redirect ?? "manual" })
  }

  const relayRuntime = (workspaceId: string): ClaxedoFetch => {
    const { connections } = requireControlPlane(`Reaching workspace ${workspaceId}`)
    return async (path, init) => {
      const response = await send(await connections.get(workspaceId), path, init)
      if (response.status !== 401) return response
      return send(await connections.refresh(workspaceId), path, init)
    }
  }

  const resolveTarget = async (target: WorkspaceTarget): Promise<ResolvedTarget> => {
    if (servedLocally(target)) return localTarget(target)
    const workspaceId = relayWorkspaceId(target)
    const { connections } = requireControlPlane(`Reaching workspace ${workspaceId}`)
    return relayTarget(await connections.get(workspaceId))
  }

  const runtime = async (target: WorkspaceTarget): Promise<ClaxedoFetch> => {
    if (servedLocally(target) && local) return local.fetch
    return relayRuntime(relayWorkspaceId(target))
  }

  const server = async (target: WorkspaceTarget): Promise<WorkspaceRuntimeClient> => {
    const resolved = await resolveTarget(target)
    const runtimeFetch = await runtime(target)
    const baseUrl = resolved.kind === "relay" ? resolved.baseUrl : IN_PROCESS_ORIGIN
    const prefix = new URL(baseUrl).pathname.replace(/\/+$/, "")
    return createWorkspaceRuntimeClient({
      baseUrl,
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input)
        return runtimeFetch(`${url.pathname.slice(prefix.length)}${url.search}`, init)
      },
      ...(resolved.directory ? { directory: resolved.directory } : {}),
      ...(resolved.workspaceId ? { workspace: resolved.workspaceId } : {}),
    })
  }

  const workspaces = async (): Promise<readonly WorkspaceSummary[]> => {
    const { fetch: controlPlaneFetch } = requireControlPlane("Listing workspaces")
    const rows = new Map<string, WorkspaceSummary>()
    for (const access of ["cloud", "user-hosted"] as const) {
      const response = await controlPlaneFetch(`/api/workspace?access=${access}`, { method: "GET" })
      if (!response.ok) throw await workspaceRuntimeClientError(`workspace.list.${access}`, response)
      const body: unknown = await response.json()
      const list = asRecord(body)?.workspaces
      if (!Array.isArray(list)) throw new ClaxedoMcpClientError("connection-invalid", `workspace.list.${access} returned no workspaces array`)
      for (const summary of list.map((row) => workspaceSummary(row, access))) {
        if (summary && !rows.has(summary.id)) rows.set(summary.id, summary)
      }
    }
    return [...rows.values()]
  }

  return {
    deployment,
    ...(options.documents ? { documents: options.documents.fetch } : {}),
    ...(options.tasks ? { tasks: options.tasks } : {}),
    ...(local ? { ownWorkspace: local.workspace } : {}),
    ...(controlPlane ? { controlPlane: controlPlane.fetch } : {}),
    runtime,
    resolveTarget,
    server,
    workspaces,
  }
}

/**
 * One control-plane list row. `?access=cloud` answers every visible row, not
 * only cloud ones, so the row's own placement decides its kind and a row whose
 * placement is not the one asked for is dropped and picked up by its own query.
 */
function workspaceSummary(row: unknown, access: "cloud" | "user-hosted"): WorkspaceSummary | undefined {
  const record = asRecord(row)
  const id = record?.workspace_id
  const backing = access === "cloud" ? "cloud-vm" : "local-worktree"
  if (typeof id !== "string" || id.length === 0 || record?.backing !== backing) return undefined
  return {
    id,
    kind: access,
    ...(typeof record.display_name === "string" ? { name: record.display_name } : {}),
    ...(typeof record.remote_directory === "string" ? { directory: record.remote_directory } : {}),
    ...(typeof record.host_online === "boolean" ? { machineOnline: record.host_online } : {}),
  }
}
