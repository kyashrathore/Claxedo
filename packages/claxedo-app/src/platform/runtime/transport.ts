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
import type { WorkspaceSessionAuthority } from "@/platform/runtime/agent/workspace-relay-connection"
import type { WorkspaceHostKind } from "@/platform/runtime/placement-wire"

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
  /**
   * The JSON body of a successful runtime response, as `unknown`.
   *
   * The transport knows a path and a status; it does not know what any runtime
   * route answers, so it does not claim to. Callers narrow with the decoder
   * their own resource owns — see `http-backend.ts`, which owns the vcs and
   * mcp shapes it reads through here.
   */
  json(path: string, init?: RequestInit): Promise<unknown>
}

export function submitTransportForPlacement(input: {
  serverUrl?: string
  directory?: string
  signedControlPlane?: boolean
  /**
   * How the server that will serve this directory composed its runtime's
   * session access, IN ITS OWN WORDS — the `session_authority` the project
   * catalog carries for the workspace. `undefined` means nothing declared one.
   */
  sessionAuthority?: WorkspaceSessionAuthority
  workspaceId?: string
  hostKind?: WorkspaceHostKind | null
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
    // Which wire reaches the runtime and who owns the session's lifecycle are
    // separate questions. A `managed-private` runtime records every session it
    // serves and answers `POST /session` with `session_reservation_required`
    // until the caller has reserved one — and that is true of a workspace this
    // same machine serves over loopback, because a signed self-hosted server
    // composes its embedded runtimes that way on localhost.
    //
    // So the answer comes from the server, never from this build: the
    // catalog's `session_authority` is the serving process's own declaration
    // of the policy it mounted. The wire cannot stand in for it — loopback
    // reaches a signed self-hosted server's reserving runtime as readily as a
    // daemon's unbound one.
    managedSessionRegistration: controlPlaneSession || input.sessionAuthority === "managed-private",
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
    preferRelayOnLoopback: input.placement.transport === "workspace-relay",
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
    async json(path: string, init?: RequestInit): Promise<unknown> {
      const response = await runtimeFetch(path, init)
      if (response.ok) return await response.json()
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
  return { kind: "provisioner" as const, workspaceId: placement.workspaceId }
}
