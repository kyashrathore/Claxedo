import { createWorkspaceRelayConnection, openWorkspaceConnection } from "./workspace-relay-connection"
import { authFetch } from "@/shared/data/api"
import { hasBacking, type SessionRef } from "../shell/identity/session-ref"
import {
  isFilesystemDirectory,
  workspaceIdFromRef,
} from "../shell/identity/legacy-resolver"
import { queryClient } from "../shared/query/query-client"

export type WorkspaceRuntimeSnapshotLike = {
  kind?: "local" | "cloud" | "user-hosted" | null
  workspaceId?: string | null
} | null

export type WorkspaceRuntimeTarget =
  | { kind: "local" }
  | { kind: "cloud" | "user-hosted"; workspaceId: string }

export type WorkspaceRuntimeRequestOptions = {
  serverUrl: string
  sessionRef?: SessionRef
  directory?: string
  workspaceId?: string
  workspaceKind?: "local" | "cloud" | "user-hosted" | null
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

export function isLoopbackHttpUrl(input: string | undefined) {
  if (!input) return false
  try {
    const url = new URL(input)
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]")
  } catch {
    return false
  }
}

// True only for Local Personal Mode: loopback server plus a real local
// workspace directory. Cloud workspaces pass workspaceId separately.
export function isLocalPersonalScope(input: { serverUrl?: string; directory?: string }) {
  return isLoopbackHttpUrl(input.serverUrl) && isFilesystemDirectory(input.directory)
}

export function centralTransportForServer(serverUrl: string | undefined) {
  return isLocalPersonalScope({ serverUrl, directory: "/" }) ? "loopback" : "signed-web"
}

export function unsignedLocalFetch(input: string | URL | Request, init?: RequestInit) {
  if (input instanceof Request) {
    const headers = new Headers(init?.headers ?? input.headers)
    headers.delete("Authorization")
    return globalThis.fetch(new Request(input, { ...init, headers }))
  }
  const headers = new Headers(init?.headers)
  headers.delete("Authorization")
  return globalThis.fetch(input, { ...init, headers })
}

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

function normalizeRuntimeKind(input: unknown): WorkspaceRuntimeTarget["kind"] | undefined {
  return input === "local" || input === "cloud" || input === "user-hosted" ? input : undefined
}

function workspaceRuntimeTarget(input: WorkspaceRuntimeSnapshotLike | undefined): WorkspaceRuntimeTarget | undefined {
  const kind = normalizeRuntimeKind(input?.kind)
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
    const sessionResourceKind = normalizeRuntimeKind(options.workspaceKind)
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
  if (directoryWorkspaceId) return { kind: "cloud" as const, workspaceId: directoryWorkspaceId }
  return undefined
}

export function createWorkspaceRuntimeRequest(options: WorkspaceRuntimeRequestOptions) {
  const request = options.request ?? authFetch
  const serverUrl = options.serverUrl.replace(/\/+$/, "")

  const runtimeFetch = async (path: string, init?: RequestInit) => {
    const runtime = await resolveRuntimeTarget(options)
    if ((runtime?.kind === "cloud" || runtime?.kind === "user-hosted") && runtime.workspaceId) {
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
