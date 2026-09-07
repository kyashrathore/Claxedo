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
  call<T>(input: WorkspaceRuntimeCall): Promise<WorkspaceRuntimeResponse<T>>
  /** For a route whose success is `204 No Content`; a body where none was promised is a payload error. */
  callNoContent(input: WorkspaceRuntimeCall): Promise<WorkspaceRuntimeResponse<void>>
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
   * `data` is `T` because the operation says so, not because anything checked:
   * at an HTTP boundary nothing can without a validator. `T` is not even
   * pinned to routes this package serves — `createWorkspaceRuntimeCaller` is
   * exported, and the app's `createServerRoutesClient` sends it at `/project`,
   * `/path`, provider OAuth and `/experimental/worktree`, which claxedo-server
   * answers.
   *
   * Unlike a brand or an inexpressible constructor type, the claim IS
   * checkable: it needs a per-operation decoder, the way
   * `claxedo-app/src/platform/account/hosted-operations.ts` writes them. That
   * is the recorded follow-up, and until then the unchecked read stays on this
   * one line so no call site carries it. Narrowing at each call site instead
   * satisfies the lint rule, validates nothing, and collapses the concrete
   * types every reader depends on.
   */
  const call = async <T>(input: WorkspaceRuntimeCall): Promise<WorkspaceRuntimeResponse<T>> => {
    const sent = await send(input)
    let body: unknown
    try {
      body = await sent.response.json()
    } catch (error) {
      throw new WorkspaceRuntimeClientPayloadError(input.operation, error instanceof Error ? error.message : "Response was not valid JSON")
    }
    return { data: body as T, ...sent }
  }

  const callNoContent = async (input: WorkspaceRuntimeCall): Promise<WorkspaceRuntimeResponse<void>> => {
    const sent = await send(input)
    if (sent.response.status !== 204) {
      throw new WorkspaceRuntimeClientPayloadError(
        input.operation,
        `Expected 204 No Content, got ${sent.response.status}`,
      )
    }
    return { data: undefined, ...sent }
  }

  return { send, call, callNoContent, url }
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
  // No route reads a structured query value, so a non-scalar is encoded as JSON
  // rather than left to `String(value)`, which yields "[object Object]".
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

export function namedMembers(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]))
}

export function without(input: Record<string, unknown>, keys: readonly string[] = []): Record<string, unknown> {
  const omitted = new Set([...keys, "directory", "workspace"])
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => !omitted.has(key) && value !== undefined))
}
