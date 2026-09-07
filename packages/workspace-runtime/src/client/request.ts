import { errorMessage } from "@claxedo/helpers"
import { asRecord, asRecordOrEmpty } from "@claxedo/helpers/guards"

/** The callable half of `fetch`; a bare `typeof fetch` differs per runtime lib (Bun's carries `preconnect`). */
export type WorkspaceRuntimeTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type WorkspaceScope = { directory?: string; workspace?: string }

export type WorkspaceRuntimeClientOptions = {
  baseUrl: string | URL
  fetch?: WorkspaceRuntimeTransport
  headers?: HeadersInit
  directory?: string
  workspace?: string
}

export type WorkspaceRuntimeRequestOptions = { headers?: HeadersInit; signal?: AbortSignal }

export type WorkspaceRuntimeResponse<T> = { data: T; request: Request; response: Response }

export type WorkspaceRuntimeCall = {
  operation: string
  method?: string
  path: string
  /** Per-call `directory`/`workspace`; a member left undefined falls back to the client's own. */
  scope?: WorkspaceScope
  query?: Record<string, unknown>
  body?: unknown
  headers?: HeadersInit
  options?: WorkspaceRuntimeRequestOptions
}

export type WorkspaceRuntimeCaller = {
  /** The request sent and its 2xx response; anything else is thrown typed. */
  send(input: WorkspaceRuntimeCall): Promise<{ request: Request; response: Response }>
  /** `send` with the response body read as JSON. */
  call<T>(input: WorkspaceRuntimeCall): Promise<WorkspaceRuntimeResponse<T>>
  url(path: string, query?: Record<string, unknown>): URL
}

export class WorkspaceRuntimeClientError extends Error {
  constructor(readonly operation: string, readonly status: number, readonly code: string, readonly body: unknown, message: string) {
    super(message)
    this.name = "WorkspaceRuntimeClientError"
  }
}

export class WorkspaceRuntimeClientPayloadError extends Error {
  constructor(readonly operation: string, message: string) {
    super(message)
    this.name = "WorkspaceRuntimeClientPayloadError"
  }
}

export class WorkspaceRuntimeClientTransportError extends Error {
  constructor(readonly operation: string, override readonly cause: unknown) {
    super(errorMessage(cause))
    this.name = "WorkspaceRuntimeClientTransportError"
  }
}

export function createWorkspaceRuntimeCaller(options: WorkspaceRuntimeClientOptions): WorkspaceRuntimeCaller {
  const transport = options.fetch ?? fetch
  const baseUrl = options.baseUrl.toString().replace(/\/+$/, "")

  const url = (path: string, query: Record<string, unknown> = {}) => {
    const target = new URL(`${baseUrl}${path}`)
    for (const [key, value] of Object.entries(query)) appendQuery(target, key, value)
    return target
  }

  const send = async (input: WorkspaceRuntimeCall) => {
    input.options?.signal?.throwIfAborted()
    const target = url(input.path, {
      directory: input.scope?.directory ?? options.directory,
      workspace: input.scope?.workspace ?? options.workspace,
      ...input.query,
    })
    const hasBody = input.body !== undefined
    const requestInit: RequestInit = {
      method: input.method ?? "GET",
      headers: mergeHeaders(
        options.headers,
        { Accept: "application/json" },
        hasBody ? { "Content-Type": "application/json" } : undefined,
        input.headers,
        input.options?.headers,
      ),
      signal: input.options?.signal,
      ...(hasBody ? { body: JSON.stringify(input.body) } : {}),
    }
    const request = new Request(target, requestInit)
    let response: Response
    try {
      response = await transport(target, requestInit)
    } catch (error) {
      if (asRecord(error)?.name === "AbortError" || input.options?.signal?.aborted) throw error
      throw new WorkspaceRuntimeClientTransportError(input.operation, error)
    }
    input.options?.signal?.throwIfAborted()
    if (!response.ok) throw await workspaceRuntimeClientError(input.operation, response)
    return { request, response }
  }

  /**
   * `T` is a DECLARED view of the body, the same contract `RuntimeStore` uses
   * for its JSON columns: the routes this client calls are defined in this
   * package, so a read here is the other end of a serialization this
   * repository owns — not a parse of foreign input. It is not a validation,
   * and callers that must survive an older runtime should narrow what they
   * read.
   */
  const call = async <T>(input: WorkspaceRuntimeCall): Promise<WorkspaceRuntimeResponse<T>> => {
    const sent = await send(input)
    try {
      return { data: await sent.response.json(), ...sent }
    } catch (error) {
      throw new WorkspaceRuntimeClientPayloadError(input.operation, error instanceof Error ? error.message : "Response was not valid JSON")
    }
  }

  return { send, call, url }
}

/** The typed error for a non-2xx response whose body is a Claxedo `{ error: { code, message } }` envelope, or any other body. */
export async function workspaceRuntimeClientError(operation: string, response: Response) {
  const text = await response.clone().text().catch(() => "")
  const body: unknown = await response.json().catch(() => undefined)
  const row = asRecordOrEmpty(body)
  const nested = asRecordOrEmpty(row.error)
  const code = typeof nested.code === "string" ? nested.code : typeof row.code === "string" ? row.code : `http_${response.status}`
  const message = typeof nested.message === "string"
    ? nested.message
    : typeof row.message === "string"
      ? row.message
      : text || `Workspace runtime request failed with status ${response.status}`
  return new WorkspaceRuntimeClientError(operation, response.status, code, body ?? text, message)
}

function appendQuery(url: URL, key: string, value: unknown) {
  if (value === undefined) return
  // A query value is a scalar. Anything else used to reach the wire as
  // "[object Object]", which no endpoint can read back; JSON at least is.
  if (typeof value === "string") url.searchParams.set(key, value)
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    url.searchParams.set(key, value.toString())
  } else url.searchParams.set(key, JSON.stringify(value) ?? "")
}

function mergeHeaders(...values: Array<HeadersInit | undefined>) {
  const headers = new Headers()
  for (const value of values) {
    if (!value) continue
    new Headers(value).forEach((headerValue, key) => headers.set(key, headerValue))
  }
  return headers
}

/** The members of `input` named by `keys`, for a query string. */
export function namedMembers(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]))
}

/** Everything in `input` except the scope, the named keys, and undefined members, for a request body or query. */
export function without(input: Record<string, unknown>, keys: readonly string[] = []): Record<string, unknown> {
  const omitted = new Set([...keys, "directory", "workspace"])
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => !omitted.has(key) && value !== undefined))
}
