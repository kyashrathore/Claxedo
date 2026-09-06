import { WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER } from "./management-auth"
import { WorkspaceRuntimeRoutes } from "./routes/manifest"
import type { WorkspaceCapabilities } from "./capabilities"
import type { RuntimeSnapshot } from "./routes/config"
import type { AgentFileContent } from "@claxedo/agent-runtime-contract"

export type WorkspaceRuntimeClientOptions = {
  baseUrl: string | URL
  fetch?: typeof fetch
  headers?: HeadersInit
}

export type WorkspaceRuntimeConfigApplyOptions = {
  token?: string
  headers?: HeadersInit
}

export type WorkspaceRuntimeRequestOptions = {
  headers?: HeadersInit
  signal?: AbortSignal
}

export type WorkspaceFileNode = {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored: boolean
}

export type WorkspaceFileContent = AgentFileContent

export type WorkspaceFileStatus = {
  path: string
  added: number
  removed: number
  status: "added" | "deleted" | "modified"
}

export type WorkspaceFileSearchQuery = {
  query: string
  dirs?: "true" | "false"
  type?: "file" | "directory"
  limit?: number
}

export type WorkspaceRuntimeHealth = {
  ok: boolean
  status: "ready" | "applying" | "error"
  service: "workspace-runtime"
  routeAuthBoundary: "relay-host-auth" | "loopback-only" | "private-network-host-guard" | "private-network-dev-unsafe"
  serviceExposure: {
    source: "loopback" | "driver-service-url"
    access: "private" | "public" | "driver-authenticated" | "unknown"
    driver?: string
    fallbackAccess?: "private" | "public" | "driver-authenticated" | "unknown"
    note?: string
  }
  exposure?: { kind: "loopback" | "relay" | "private-network-host-guard" | "private-network-dev-unsafe" | "embedded" }
}

export type WorkspaceRuntimeClient = {
  health: () => Promise<WorkspaceRuntimeHealth>
  capabilities: () => Promise<WorkspaceCapabilities>
  applyConfig: (snapshot: RuntimeSnapshot  , options?: WorkspaceRuntimeConfigApplyOptions) => Promise<void>
  runtimeEventsUrl: () => URL
  eventsUrl: () => URL
  files: {
    raw: (path: string, options?: WorkspaceRuntimeRequestOptions) => Promise<Response>
    tree: (path: string, options?: WorkspaceRuntimeRequestOptions) => Promise<WorkspaceFileNode[]>
    content: (path: string, options?: WorkspaceRuntimeRequestOptions) => Promise<WorkspaceFileContent>
    status: (options?: WorkspaceRuntimeRequestOptions) => Promise<WorkspaceFileStatus[]>
    list: (path?: string, options?: WorkspaceRuntimeRequestOptions) => Promise<{ paths: string[] }>
    search: (query: WorkspaceFileSearchQuery, options?: WorkspaceRuntimeRequestOptions) => Promise<string[]>
  }
  diff: {
    targets: (options?: WorkspaceRuntimeRequestOptions) => Promise<unknown>
    vcs: (query?: Record<string, string | undefined>, options?: WorkspaceRuntimeRequestOptions) => Promise<unknown>
    file: (file: string, query?: Record<string, string | undefined>, options?: WorkspaceRuntimeRequestOptions) => Promise<unknown>
    refs: (options?: WorkspaceRuntimeRequestOptions) => Promise<unknown>
  }
  git: {
    snapshot: (path: string, options?: WorkspaceRuntimeRequestOptions) => Promise<unknown>
    commit: (body: { path: string; content: string; message: string; expected?: { baseCommit?: string; baseBlobSha?: string } }, options?: WorkspaceRuntimeRequestOptions) => Promise<unknown>
  }
  pty: {
    list: (options?: WorkspaceRuntimeRequestOptions) => Promise<unknown>
    create: (body: unknown, options?: WorkspaceRuntimeRequestOptions) => Promise<unknown>
    get: (id: string, options?: WorkspaceRuntimeRequestOptions) => Promise<unknown>
    update: (id: string, body: unknown, options?: WorkspaceRuntimeRequestOptions) => Promise<unknown>
    remove: (id: string, options?: WorkspaceRuntimeRequestOptions) => Promise<boolean>
    connectUrl: (id: string, cursor?: number) => URL
  }
  process: {
    list: (options?: WorkspaceRuntimeRequestOptions) => Promise<unknown>
    create: (body: unknown, options?: WorkspaceRuntimeRequestOptions) => Promise<unknown>
    update: (id: string, body: unknown, options?: WorkspaceRuntimeRequestOptions) => Promise<unknown>
    remove: (id: string, options?: WorkspaceRuntimeRequestOptions) => Promise<boolean>
    start: (id: string, body?: unknown, options?: WorkspaceRuntimeRequestOptions) => Promise<unknown>
    stop: (id: string, options?: WorkspaceRuntimeRequestOptions) => Promise<boolean>
    restart: (id: string, options?: WorkspaceRuntimeRequestOptions) => Promise<unknown>
    logs: (query?: Record<string, string | undefined>, options?: WorkspaceRuntimeRequestOptions) => Promise<string>
  }
}

export function createWorkspaceRuntimeClient(options: WorkspaceRuntimeClientOptions): WorkspaceRuntimeClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const doFetch = options.fetch ?? fetch
  return {
    health: () => jsonRequest<WorkspaceRuntimeHealth>(doFetch, baseUrl, WorkspaceRuntimeRoutes.health, { headers: options.headers }),
    capabilities: () => jsonRequest<WorkspaceCapabilities>(doFetch, baseUrl, WorkspaceRuntimeRoutes.capabilities, { headers: options.headers }),
    applyConfig: async (snapshot, input = {}) => {
      await request(doFetch, baseUrl, WorkspaceRuntimeRoutes.config, {
        method: "POST",
        headers: {
          ...headersRecord(options.headers),
          ...headersRecord(input.headers),
          "content-type": "application/json",
          ...(input.token ? { [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: input.token } : {}),
        },
        body: JSON.stringify(snapshot),
      })
    },
    runtimeEventsUrl: () => new URL(WorkspaceRuntimeRoutes.runtimeEvents, baseUrl),
    eventsUrl: () => new URL(WorkspaceRuntimeRoutes.events, baseUrl),
    files: {
      raw: (filePath, input = {}) => request(doFetch, baseUrl, withQuery(WorkspaceRuntimeRoutes.file + "/raw", { path: filePath }), requestOptions(options.headers, input)),
      tree: (filePath, input = {}) => jsonRequest<WorkspaceFileNode[]>(doFetch, baseUrl, withQuery(WorkspaceRuntimeRoutes.file, { path: filePath }), requestOptions(options.headers, input)),
      content: (filePath, input = {}) => jsonRequest<WorkspaceFileContent>(doFetch, baseUrl, withQuery(WorkspaceRuntimeRoutes.file + "/content", { path: filePath }), requestOptions(options.headers, input)),
      status: (input = {}) => jsonRequest<WorkspaceFileStatus[]>(doFetch, baseUrl, WorkspaceRuntimeRoutes.file + "/status", requestOptions(options.headers, input)),
      list: (filePath, input = {}) => jsonRequest<{ paths: string[] }>(doFetch, baseUrl, withQuery(WorkspaceRuntimeRoutes.file + "/all", filePath ? { path: filePath } : {}), requestOptions(options.headers, input)),
      search: (query, input = {}) => jsonRequest<string[]>(doFetch, baseUrl, withQuery(WorkspaceRuntimeRoutes.fileSearch, {
        query: query.query,
        dirs: query.dirs,
        type: query.type,
        limit: query.limit === undefined ? undefined : String(query.limit),
      }), requestOptions(options.headers, input)),
    },
    diff: {
      targets: (input = {}) => jsonRequest(doFetch, baseUrl, WorkspaceRuntimeRoutes.diff + "/targets", requestOptions(options.headers, input)),
      vcs: (query = {}, input = {}) => jsonRequest(doFetch, baseUrl, withQuery(WorkspaceRuntimeRoutes.diff + "/vcs", query), requestOptions(options.headers, input)),
      file: (file, query = {}, input = {}) => jsonRequest(doFetch, baseUrl, withQuery(WorkspaceRuntimeRoutes.diff + "/vcs/file", { ...query, file }), requestOptions(options.headers, input)),
      refs: (input = {}) => jsonRequest(doFetch, baseUrl, WorkspaceRuntimeRoutes.diff + "/refs", requestOptions(options.headers, input)),
    },
    git: {
      snapshot: (sourcePath, input = {}) => jsonRequest(doFetch, baseUrl, withQuery(WorkspaceRuntimeRoutes.git + "/snapshot", { path: sourcePath }), requestOptions(options.headers, input)),
      commit: (body, input = {}) => jsonRequest(doFetch, baseUrl, WorkspaceRuntimeRoutes.git + "/commit", jsonOptions(options.headers, input, body)),
    },
    pty: {
      list: (input = {}) => jsonRequest(doFetch, baseUrl, WorkspaceRuntimeRoutes.pty, requestOptions(options.headers, input)),
      create: (body, input = {}) => jsonRequest(doFetch, baseUrl, WorkspaceRuntimeRoutes.pty, jsonOptions(options.headers, input, body)),
      get: (id, input = {}) => jsonRequest(doFetch, baseUrl, pathJoin(WorkspaceRuntimeRoutes.pty, id), requestOptions(options.headers, input)),
      update: (id, body, input = {}) => jsonRequest(doFetch, baseUrl, pathJoin(WorkspaceRuntimeRoutes.pty, id), { ...jsonOptions(options.headers, input, body), method: "PUT" }),
      remove: (id, input = {}) => jsonRequest(doFetch, baseUrl, pathJoin(WorkspaceRuntimeRoutes.pty, id), { ...requestOptions(options.headers, input), method: "DELETE" }),
      connectUrl: (id, cursor) => new URL(withQuery(pathJoin(WorkspaceRuntimeRoutes.pty, id, "connect"), cursor === undefined ? {} : { cursor: String(cursor) }), baseUrl),
    },
    process: {
      list: (input = {}) => jsonRequest(doFetch, baseUrl, WorkspaceRuntimeRoutes.process, requestOptions(options.headers, input)),
      create: (body, input = {}) => jsonRequest(doFetch, baseUrl, WorkspaceRuntimeRoutes.process, jsonOptions(options.headers, input, body)),
      update: (id, body, input = {}) => jsonRequest(doFetch, baseUrl, pathJoin(WorkspaceRuntimeRoutes.process, id), { ...jsonOptions(options.headers, input, body), method: "PUT" }),
      remove: (id, input = {}) => jsonRequest(doFetch, baseUrl, pathJoin(WorkspaceRuntimeRoutes.process, id), { ...requestOptions(options.headers, input), method: "DELETE" }),
      start: (id, body, input = {}) => jsonRequest(doFetch, baseUrl, pathJoin(WorkspaceRuntimeRoutes.process, id, "start"), jsonOptions(options.headers, input, body ?? {})),
      stop: (id, input = {}) => jsonRequest(doFetch, baseUrl, pathJoin(WorkspaceRuntimeRoutes.process, id, "stop"), { ...requestOptions(options.headers, input), method: "POST" }),
      restart: (id, input = {}) => jsonRequest(doFetch, baseUrl, pathJoin(WorkspaceRuntimeRoutes.process, id, "restart"), { ...requestOptions(options.headers, input), method: "POST" }),
      logs: async (query = {}, input = {}) => await request(doFetch, baseUrl, withQuery(WorkspaceRuntimeRoutes.process + "/logs", query), requestOptions(options.headers, input)).then((response) => response.text()),
    },
  }
}

/**
 * A JSON response body, typed as the caller's `T`.
 *
 * `T` is a DECLARED view of the body, the same contract `RuntimeStore` uses for
 * its JSON columns: the routes this client calls are defined in this package,
 * so a read here is the other end of a serialization this repository owns —
 * not a parse of foreign input. It is not a validation, and callers that must
 * survive an older runtime should narrow what they read.
 */
async function jsonRequest<T>(doFetch: typeof fetch, baseUrl: URL, path: string, init?: RequestInit): Promise<T> {
  const response = await request(doFetch, baseUrl, path, init)
  return await response.json()
}

async function request(doFetch: typeof fetch, baseUrl: URL, path: string, init?: RequestInit) {
  const response = await doFetch(new URL(path, baseUrl), init)
  if (response.ok) return response
  throw new WorkspaceRuntimeClientError(response.status, await response.text())
}

function normalizeBaseUrl(input: string | URL) {
  const url = new URL(input.toString())
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return url
}

function headersRecord(input: HeadersInit | undefined): Record<string, string> {
  if (!input) return {}
  if (input instanceof Headers) {
    const out: Record<string, string> = {}
    input.forEach((value, key) => {
      out[key] = value
    })
    return out
  }
  if (Array.isArray(input)) return Object.fromEntries(input)
  return input
}

function requestOptions(baseHeaders: HeadersInit | undefined, input: WorkspaceRuntimeRequestOptions): RequestInit {
  return {
    headers: {
      ...headersRecord(baseHeaders),
      ...headersRecord(input.headers),
    },
    signal: input.signal,
  }
}

function jsonOptions(baseHeaders: HeadersInit | undefined, input: WorkspaceRuntimeRequestOptions, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      ...headersRecord(baseHeaders),
      ...headersRecord(input.headers),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: input.signal,
  }
}

function withQuery(path: string, query: Record<string, string | undefined>) {
  const params = new URLSearchParams()
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined) params.set(key, value)
  })
  const suffix = params.toString()
  return suffix ? `${path}?${suffix}` : path
}

function pathJoin(...parts: string[]) {
  return parts.map((part, index) => index === 0 ? part.replace(/\/+$/, "") : encodeURIComponent(part).replace(/^\/+|\/+$/g, "")).join("/")
}

export class WorkspaceRuntimeClientError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`Workspace runtime request failed with status ${status}`)
    this.name = "WorkspaceRuntimeClientError"
  }
}
