import { createWorkspaceRelayConnection, openWorkspaceConnection } from "@/platform/runtime/agent/workspace-relay-connection"
import { authFetch, unsignedLocalFetch } from "@/platform/api/api"
import { hasBacking, type SessionRef } from "@/platform/identity/session-ref"
import { workspaceIdFromRef } from "@/platform/identity/legacy-resolver"
import { queryClient } from "@/platform/query/query-client"
import { workspaceKind, type SignedWorkspaceKind, type WorkspaceKind } from "@/platform/runtime/agent/workspace-kind"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import {
  isLocalPersonalScope,
  isLoopbackHttpUrl,
} from "@/platform/runtime/server-transport"

export {
  centralTransportForServer,
  isLocalPersonalScope,
  isLoopbackHttpUrl,
} from "@/platform/runtime/server-transport"
export { unsignedLocalFetch } from "@/platform/api/api"

export type WorkspaceRuntimeSnapshotLike = {
  kind?: WorkspaceKind | null
  workspaceId?: string | null
} | null

export type WorkspaceRuntimeTarget =
  | { kind: "local" }
  | { kind: SignedWorkspaceKind; workspaceId: string }

export type WorkspaceRuntimeRequestOptions = {
  serverUrl: string
  sessionRef?: SessionRef
  directory?: string
  workspaceId?: string
  workspaceKind?: WorkspaceKind | null
  workspace?: WorkspaceRuntimeSnapshotLike
  request?: typeof fetch
  relayRequest?: typeof fetch
  resolveWorkspaceRuntime?: (input: { directory: string; workspaceId?: string }) => Promise<WorkspaceRuntimeSnapshotLike>
  preferRelayOnLoopback?: boolean
  sessionResource?: boolean
}

type RelayConnection = {
  transport: ReturnType<typeof createWorkspaceRelayConnection>
}

const relayRequestIds = new WeakMap<typeof fetch, number>()
let nextRelayRequestId = 1

function unsignedFetchWith(request: typeof fetch, input: string | URL | Request, init?: RequestInit) {
  if (input instanceof Request) {
    const headers = new Headers(init?.headers ?? input.headers)
    headers.delete("Authorization")
    return request(new Request(input, { ...init, headers }))
  }
  const headers = new Headers(init?.headers)
  headers.delete("Authorization")
  return request(input, { ...init, headers })
}

function relayRequestId(request: typeof fetch) {
  const cached = relayRequestIds.get(request)
  if (cached) return cached
  const next = nextRelayRequestId
  nextRelayRequestId += 1
  relayRequestIds.set(request, next)
  return next
}

async function workspaceRelayConnection(input: {
  request: typeof fetch
  relayRequest?: typeof fetch
  serverUrl: string
  workspaceId: string
  headers?: HeadersInit
}) {
  const auth = new Headers(input.headers).get("authorization") ?? ""
  const key = [
    "shell",
    "workspace-runtime-relay",
    input.serverUrl,
    input.workspaceId,
    auth,
    relayRequestId(input.request),
    relayRequestId(input.relayRequest ?? input.request),
  ] as const
  const cached = queryClient.getQueryData<Promise<RelayConnection>>(key)
  if (cached) return cached
  const pending = openWorkspaceConnection(input.workspaceId, {
    serverUrl: input.serverUrl,
    request: input.request,
    headers: input.headers,
  }).then((connection) => ({
    transport: createWorkspaceRelayConnection(connection, {
      serverUrl: input.serverUrl,
      request: input.request,
      relayRequest: input.relayRequest ?? input.request,
      headers: input.headers,
    }),
  }))
  queryClient.setQueryData(key, pending)
  pending.catch(() => {
    if (queryClient.getQueryData<Promise<RelayConnection>>(key) === pending) {
      queryClient.removeQueries({ queryKey: key })
    }
  })
  return pending
}

function relayRuntimePath(path: string) {
  const url = new URL(path, "http://workspace-runtime.local")
  url.searchParams.delete("directory")
  url.searchParams.delete("workspaceId")
  return `${url.pathname}${url.search}`
}

function relayRuntimeInit(init: RequestInit | undefined, workspaceId: string): RequestInit | undefined {
  const headers = new Headers(init?.headers)
  headers.set("x-opencode-directory", `workspace:${workspaceId}`)
  return {
    ...init,
    headers,
  }
}

function connectionFailureResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const status = Number(/^Workspace connection failed: (\d+)$/.exec(message)?.[1])
  return new Response(message, {
    status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502,
  })
}

function controlPlaneHeaders(init?: RequestInit): HeadersInit | undefined {
  const authorization = new Headers(init?.headers).get("authorization")
  if (!authorization) return undefined
  return { Authorization: authorization }
}

function workspaceRuntimeTarget(input: WorkspaceRuntimeSnapshotLike | undefined): WorkspaceRuntimeTarget | undefined {
  const kind = workspaceKind(input?.kind)
  if (!kind) return
  if (kind === "local") return { kind }
  if (!input?.workspaceId) return
  return { kind, workspaceId: input.workspaceId }
}

export async function resolveRuntimeTarget(options: WorkspaceRuntimeRequestOptions): Promise<WorkspaceRuntimeTarget | undefined> {
  if (options.sessionRef) {
    if (options.sessionRef.host === "central") return undefined
    if (options.sessionRef.toolSandbox?.kind === "workspace") {
      return {
        kind: options.sessionRef.toolSandbox.hosting,
        workspaceId: options.sessionRef.toolSandbox.workspaceId,
      }
    }
  }
  if (options.sessionRef) {
    if (!hasBacking(options.sessionRef)) return undefined
    return { kind: "local" as const }
  }
  const explicitWorkspace = workspaceRuntimeTarget(options.workspace)
  if (explicitWorkspace) return explicitWorkspace
  const directoryWorkspaceId = workspaceIdFromRef(options.directory)
  if (options.sessionResource && options.workspaceId) {
    // Session content for relay-backed workspaces is runtime-native, even when
    // the caller is otherwise in a signed control-plane flow. A confirmed cloud
    // workspace remains central; unresolved `ws_`/`workspace:ws_` refs use the
    // relay because the control plane may not have the user-hosted session rows.
    const sessionResourceKind = workspaceKind(options.workspaceKind)
    if (sessionResourceKind === "cloud") return { kind: "cloud", workspaceId: options.workspaceId }
    if ((sessionResourceKind && sessionResourceKind !== "local") || directoryWorkspaceId) {
      return { kind: "user-hosted", workspaceId: options.workspaceId }
    }
  }
  if (options.workspaceKind === "local" || isLocalPersonalScope(options)) return { kind: "local" as const }
  if (options.workspaceId) return { kind: "cloud" as const, workspaceId: options.workspaceId }
  const resolved = options.directory
    ? await options.resolveWorkspaceRuntime?.({
      directory: options.directory,
      workspaceId: options.workspaceId ?? directoryWorkspaceId,
    })
    : undefined
  const resolvedTarget = workspaceRuntimeTarget(resolved)
  if (resolvedTarget) return resolvedTarget
  if (directoryWorkspaceId) {
    // `resolveWorkspaceRuntime` answered `null` (no record) rather than a real
    // snapshot — the resolve endpoint 404s for a user-hosted workspace but
    // answers a confirmed record for cloud, so a `ws_`/`workspace:` ref that is
    // STILL unresolved here is never guessed as cloud. `sessionWorkspaceRuntimeRef`
    // is the one owner of that "unresolved relay-backed ref" default (see
    // session-workspace.ts): it resolves the same directory against the signed
    // inventory and otherwise defaults to `user-hosted`.
    const ref = sessionWorkspaceRuntimeRef({ directory: options.directory! })
    if (ref) return { kind: ref.kind, workspaceId: ref.workspaceId }
    return undefined
  }
  return undefined
}

export function createWorkspaceRuntimeRequest(options: WorkspaceRuntimeRequestOptions) {
  const request = options.request ?? authFetch
  const serverUrl = options.serverUrl.replace(/\/+$/, "")

  const runtimeFetch = async (path: string, init?: RequestInit) => {
    const runtime = await resolveRuntimeTarget(options)
    // `runtime.kind` narrows this discriminated union itself only via a direct
    // literal comparison (not `isRelayBackedWorkspaceKind`, which narrows just
    // the `kind` field) — TS ties discriminant narrowing to the union's own
    // literal checks, so this stays inline rather than routed through the
    // shared predicate.
    if (runtime && (runtime.kind === "cloud" || runtime.kind === "user-hosted") && runtime.workspaceId) {
      if (isLoopbackHttpUrl(serverUrl) && !options.preferRelayOnLoopback) {
        return await unsignedFetchWith(
          request,
          `${serverUrl}/workspaces/${encodeURIComponent(runtime.workspaceId)}${relayRuntimePath(path)}`,
          relayRuntimeInit(init, runtime.workspaceId),
        )
      }
      return await workspaceRelayConnection({
        request,
        relayRequest: options.relayRequest,
        serverUrl,
        workspaceId: runtime.workspaceId,
        headers: controlPlaneHeaders(init),
      })
        .then((relay) => relay.transport.fetch(relayRuntimePath(path), relayRuntimeInit(init, runtime.workspaceId!)))
        .catch(connectionFailureResponse)
    }
    if (isLoopbackHttpUrl(serverUrl)) {
      return unsignedFetchWith(request, `${serverUrl}${path}`, init)
    }
    return request(`${serverUrl}${path}`, init)
  }

  return {
    fetch: runtimeFetch,
    async json<T>(path: string, init?: RequestInit): Promise<T> {
      const res = await runtimeFetch(path, init)
      if (res.ok) return await res.json()
      throw new Error((await res.text()) || `Request failed: ${res.status}`)
    },
  }
}
