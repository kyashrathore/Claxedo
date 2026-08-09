import type { Placement } from "@/platform/runtime/placement"
import { workspaceIdFromRef } from "@/platform/identity/legacy-resolver"
import {
  createWorkspaceRuntimeRequest,
  unsignedLocalFetch,
  type WorkspaceRuntimeRequestOptions,
  type WorkspaceRuntimeSnapshotLike,
} from "@/platform/runtime/agent/workspace-runtime-request"
import {
  centralTransportForServer,
  isLocalPersonalScope,
} from "@/platform/runtime/server-transport"
import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"

export {
  centralTransportForServer,
  isLocalPersonalScope,
  unsignedLocalFetch,
  type WorkspaceRuntimeRequestOptions,
  type WorkspaceRuntimeSnapshotLike,
}

export type RuntimeTransport = {
  fetch(path: string, init?: RequestInit): Promise<Response>
  sdkFetch: typeof fetch
  json<T>(path: string, init?: RequestInit): Promise<T>
}

export function submitTransportForPlacement(input: {
  serverUrl?: string
  directory?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "local" | "cloud" | "user-hosted" | null
}) {
  const loopbackWorkspaceBridge = isLocalPersonalScope(input)
  const directoryWorkspaceId = workspaceIdFromRef(input.directory)
  const controlPlaneSession = !!input.signedControlPlane ||
    !!directoryWorkspaceId ||
    (!!input.workspaceId && !loopbackWorkspaceBridge)
  return {
    loopbackWorkspaceBridge,
    controlPlaneSession,
    workspaceRuntimeSession: controlPlaneSession || !!input.workspaceId || !!directoryWorkspaceId,
  }
}

export function createTransport(input: {
  placement: Placement
  serverUrl?: string
  directory?: string
  request?: typeof fetch
  relayRequest?: typeof fetch
  resolveWorkspaceRuntime?: WorkspaceRuntimeRequestOptions["resolveWorkspaceRuntime"]
  workspace?: WorkspaceRuntimeRequestOptions["workspace"]
}): RuntimeTransport {
  const serverUrl = normalizeUrl(input.serverUrl) ?? getClaxedoServerUrl()
  const runtime = () => createWorkspaceRuntimeRequest({
    serverUrl,
    directory: input.directory,
    workspaceId: workspaceRuntimeId(input.placement),
    workspace: input.workspace ?? workspaceRuntimeSnapshot(input.placement),
    request: input.request,
    relayRequest: input.relayRequest,
    resolveWorkspaceRuntime: input.resolveWorkspaceRuntime,
    preferRelayOnLoopback: input.placement.transport === "workspace-relay" ||
      input.placement.transport === "direct-runtime",
  })
  const runtimeFetch = input.placement.transport === "signed-web"
    ? (path: string, init?: RequestInit) => (input.request ?? authFetch)(`${serverUrl}${path}`, init)
    : (path: string, init?: RequestInit) => runtime().fetch(path, init)

  return {
    fetch: runtimeFetch,
    sdkFetch: async (requestInput, init) => {
      const url = new URL(requestInput instanceof Request ? requestInput.url : String(requestInput), serverUrl)
      const request = requestInput instanceof Request ? new Request(requestInput, init) : new Request(url, init)
      const body = request.method === "GET" || request.method === "HEAD"
        ? undefined
        : (init?.body ?? (requestInput instanceof Request ? await request.clone().arrayBuffer() : undefined))
      return await runtimeFetch(`${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        ...(body === undefined ? {} : { body }),
        cache: request.cache,
        signal: request.signal,
      })
    },
    async json<T>(path: string, init?: RequestInit) {
      const response = await runtimeFetch(path, init)
      if (response.ok) return await response.json() as T
      throw new Error((await response.text()) || `Request failed: ${response.status}`)
    },
  }
}

function workspaceRuntimeId(placement: Placement) {
  if (placement.hosting !== "workspace" || placement.transport === "signed-web") return undefined
  if (placement.transport === "loopback" && !placement.workspaceId) return undefined
  if (!placement.workspaceId) throw new Error("Workspace transport requires workspaceId")
  return placement.workspaceId
}

function workspaceRuntimeSnapshot(placement: Placement) {
  if (placement.hosting !== "workspace" || placement.transport === "signed-web" || !placement.workspaceId) return undefined
  return { kind: "cloud" as const, workspaceId: placement.workspaceId }
}
