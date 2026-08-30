import type {
  AgentPermission,
  AgentPresentationSession,
  AgentPromptResponse,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentRuntimeStatus,
  AgentSnapshotFileDiff,
  AgentTodo,
} from "@claxedo/agent-runtime-contract"
import type {
  ClaxedoAgentProfile,
  ClaxedoCommand,
  ClaxedoConfig,
  ClaxedoLspStatus,
  ClaxedoMcpStatus,
  ClaxedoPath,
  ClaxedoProject,
  ClaxedoProviderAuth,
  ClaxedoProviderAuthorization,
  ClaxedoProviderList,
  ClaxedoVcsInfo,
} from "./claxedo-api-types"

export type ServerClientRequestOptions = { headers?: HeadersInit; signal?: AbortSignal }
export type ServerClientResponse<T> = { data: T; error?: unknown; request: Request; response: Response }
export type ServerScope = { directory?: string; workspace?: string }

export type ServerFileNode = {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored: boolean
}
export type ServerFileContent = {
  type: "text" | "binary"
  content: string
  diff?: string
  encoding?: "base64"
  mimeType?: string
}
export type ServerFileStatus = {
  path: string
  added: number
  removed: number
  status: "added" | "deleted" | "modified"
}

export type SessionInput = ServerScope & { sessionID: string }
export type SessionCreateInput = ServerScope & {
  parentID?: string
  title?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  metadata?: Record<string, unknown>
  permission?: unknown
  workspaceID?: string
}
export type SessionUpdateInput = SessionInput & {
  title?: string
  time?: { archived?: number }
  [key: string]: unknown
}
export type SessionMessageInput = SessionInput & Record<string, unknown>

export type ClaxedoServerClient = {
  file: {
    list(input: ServerScope & { path: string }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<ServerFileNode[]>>
    read(input: ServerScope & { path: string }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<ServerFileContent>>
    status(input?: ServerScope, options?: ServerClientRequestOptions): Promise<ServerClientResponse<ServerFileStatus[]>>
  }
  find: {
    files(input: ServerScope & { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<string[]>>
  }
  session: {
    list(input?: ServerScope & { scope?: "project"; path?: string; roots?: boolean | "true" | "false"; start?: number; search?: string; limit?: number }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<AgentPresentationSession[]>>
    create(input?: SessionCreateInput, options?: ServerClientRequestOptions): Promise<ServerClientResponse<AgentPresentationSession>>
    get(input: SessionInput, options?: ServerClientRequestOptions): Promise<ServerClientResponse<AgentPresentationSession>>
    delete(input: SessionInput, options?: ServerClientRequestOptions): Promise<ServerClientResponse<boolean>>
    update(input: SessionUpdateInput, options?: ServerClientRequestOptions): Promise<ServerClientResponse<AgentPresentationSession>>
    status(input?: ServerScope, options?: ServerClientRequestOptions): Promise<ServerClientResponse<Record<string, AgentRuntimeStatus>>>
    todo(input: SessionInput, options?: ServerClientRequestOptions): Promise<ServerClientResponse<AgentTodo[]>>
    diff(input: SessionInput & { messageID?: string }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<AgentSnapshotFileDiff[]>>
    fork(input: SessionInput & { messageID?: string }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<AgentPresentationSession>>
    abort(input: SessionInput, options?: ServerClientRequestOptions): Promise<ServerClientResponse<boolean>>
    summarize(input: SessionInput & { providerID: string; modelID: string; auto?: boolean }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<boolean>>
    prompt(input: SessionMessageInput, options?: ServerClientRequestOptions): Promise<ServerClientResponse<AgentPromptResponse>>
    promptAsync(input: SessionMessageInput, options?: ServerClientRequestOptions): Promise<ServerClientResponse<boolean>>
    command(input: SessionMessageInput, options?: ServerClientRequestOptions): Promise<ServerClientResponse<AgentPromptResponse>>
    shell(input: SessionMessageInput, options?: ServerClientRequestOptions): Promise<ServerClientResponse<AgentPromptResponse>>
    revert(input: SessionInput & { messageID: string; partID?: string }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<AgentPresentationSession>>
    unrevert(input: SessionInput, options?: ServerClientRequestOptions): Promise<ServerClientResponse<AgentPresentationSession>>
  }
  permission: {
    list(input?: ServerScope, options?: ServerClientRequestOptions): Promise<ServerClientResponse<AgentPermission[]>>
    respond(input: ServerScope & { sessionID: string; permissionID: string; response?: "once" | "always" | "reject" }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<boolean>>
  }
  question: {
    list(input?: ServerScope, options?: ServerClientRequestOptions): Promise<ServerClientResponse<AgentQuestion[]>>
    reply(input: ServerScope & { requestID: string; answers?: AgentQuestionAnswer[] }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<boolean>>
    reject(input: ServerScope & { requestID: string }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<boolean>>
  }
  project: {
    list(input?: ServerScope, options?: ServerClientRequestOptions): Promise<ServerClientResponse<ClaxedoProject[]>>
    current(input?: ServerScope, options?: ServerClientRequestOptions): Promise<ServerClientResponse<ClaxedoProject>>
    update(input: ServerScope & { projectID: string; name?: string; icon?: ClaxedoProject["icon"]; commands?: ClaxedoProject["commands"] }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<ClaxedoProject>>
  }
  global: {
    health(options?: ServerClientRequestOptions): Promise<ServerClientResponse<{ healthy: boolean; version?: string }>>
    config: {
      get(options?: ServerClientRequestOptions): Promise<ServerClientResponse<ClaxedoConfig>>
      update(input?: { config?: ClaxedoConfig }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<ClaxedoConfig>>
    }
    dispose(options?: ServerClientRequestOptions): Promise<ServerClientResponse<boolean>>
  }
  worktree: {
    create(input?: ServerScope & { worktreeCreateInput?: { name?: string; baseRef?: string } }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<{ directory: string; name?: string }>>
    remove(input?: ServerScope & { worktreeRemoveInput?: { directory?: string } }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<boolean>>
  }
  provider: {
    list(input?: ServerScope, options?: ServerClientRequestOptions): Promise<ServerClientResponse<ClaxedoProviderList>>
    auth(input?: ServerScope, options?: ServerClientRequestOptions): Promise<ServerClientResponse<ClaxedoProviderAuth>>
    oauth: {
      authorize(input: ServerScope & { providerID: string; method?: number; inputs?: Record<string, string> }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<ClaxedoProviderAuthorization>>
      callback(input: ServerScope & { providerID: string; method?: number; code?: string }, options?: ServerClientRequestOptions): Promise<ServerClientResponse<boolean>>
    }
  }
  path: { get(input?: ServerScope, options?: ServerClientRequestOptions): Promise<ServerClientResponse<ClaxedoPath>> }
  app: { agents(input?: ServerScope, options?: ServerClientRequestOptions): Promise<ServerClientResponse<ClaxedoAgentProfile[]>> }
  config: { get(input?: ServerScope, options?: ServerClientRequestOptions): Promise<ServerClientResponse<ClaxedoConfig>> }
  command: { list(input?: ServerScope, options?: ServerClientRequestOptions): Promise<ServerClientResponse<ClaxedoCommand[]>> }
  vcs: { get(input?: ServerScope, options?: ServerClientRequestOptions): Promise<ServerClientResponse<ClaxedoVcsInfo>> }
  mcp: { status(input?: ServerScope, options?: ServerClientRequestOptions): Promise<ServerClientResponse<Record<string, ClaxedoMcpStatus>>> }
  lsp: { status(input?: ServerScope, options?: ServerClientRequestOptions): Promise<ServerClientResponse<ClaxedoLspStatus[]>> }
}

export type CreateClaxedoServerClientOptions = {
  baseUrl: string
  request?: typeof fetch
  headers?: HeadersInit
  directory?: string
  workspace?: string
}

export class ServerClientResponseError extends Error {
  constructor(readonly operation: string, readonly status: number, readonly code: string, readonly body: unknown, message: string) {
    super(message)
    this.name = "ServerClientResponseError"
  }
}
export class ServerClientPayloadError extends Error {
  constructor(readonly operation: string, message: string, readonly body: unknown) {
    super(message)
    this.name = "ServerClientPayloadError"
  }
}
export class ServerClientTransportError extends Error {
  constructor(readonly operation: string, readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = "ServerClientTransportError"
  }
}

export function createClaxedoServerClient(options: CreateClaxedoServerClientOptions): ClaxedoServerClient {
  const transport = options.request ?? fetch
  const baseUrl = options.baseUrl.replace(/\/+$/, "")

  async function call<T>(input: {
    operation: string
    method: string
    path: string
    parameters?: Record<string, unknown>
    query?: string[]
    body?: unknown
    options?: ServerClientRequestOptions
  }): Promise<ServerClientResponse<T>> {
    input.options?.signal?.throwIfAborted()
    const url = new URL(`${baseUrl}${input.path}`)
    const parameters = input.parameters ?? {}
    appendQuery(url, "directory", typeof parameters.directory === "string" ? parameters.directory : options.directory)
    appendQuery(url, "workspace", typeof parameters.workspace === "string" ? parameters.workspace : options.workspace)
    for (const key of input.query ?? []) appendQuery(url, key, parameters[key])
    const hasBody = input.body !== undefined
    const headers = mergeHeaders(options.headers, { Accept: "application/json" }, hasBody ? { "Content-Type": "application/json" } : undefined, input.options?.headers)
    const requestInit: RequestInit = {
      method: input.method,
      headers,
      signal: input.options?.signal,
      ...(hasBody ? { body: JSON.stringify(input.body) } : {}),
    }
    const request = new Request(url, requestInit)
    let response: Response
    try {
      response = await transport(url, requestInit)
    } catch (error) {
      if (isAbortError(error) || input.options?.signal?.aborted) throw error
      throw new ServerClientTransportError(input.operation, error)
    }
    input.options?.signal?.throwIfAborted()
    if (!response.ok) throw await responseError(input.operation, response)
    return { data: await responseJson(input.operation, response) as T, request, response }
  }

  const parameters = (value: unknown) => record(value)
  const body = (value: unknown, omitted: string[]) => omit(record(value), [...omitted, "directory", "workspace"])
  const sessionPath = (input: SessionInput) => `/session/${encodeURIComponent(input.sessionID)}`
  const request = <T>(operation: string, method: string, path: string, value?: unknown, config?: {
    query?: string[]
    body?: unknown
    options?: ServerClientRequestOptions
  }) => call<T>({ operation, method, path, parameters: parameters(value), ...config })

  return {
    file: {
      list: (input, opts) => request("file.list", "GET", "/file", input, { query: ["path"], options: opts }),
      read: (input, opts) => request("file.read", "GET", "/file/content", input, { query: ["path"], options: opts }),
      status: (input, opts) => request("file.status", "GET", "/file/status", input, { options: opts }),
    },
    find: { files: (input, opts) => request("find.files", "GET", "/find/file", input, { query: ["query", "dirs", "type", "limit"], options: opts }) },
    session: {
      list: (input, opts) => request("session.list", "GET", "/session", input, { query: ["scope", "path", "roots", "start", "search", "limit"], options: opts }),
      create: (input, opts) => request("session.create", "POST", "/session", input, { body: body(input, []), options: opts }),
      get: (input, opts) => request("session.get", "GET", sessionPath(input), input, { options: opts }),
      delete: (input, opts) => request("session.delete", "DELETE", sessionPath(input), input, { options: opts }),
      update: (input, opts) => request("session.update", "PATCH", sessionPath(input), input, { body: body(input, ["sessionID"]), options: opts }),
      status: (input, opts) => request("session.status", "GET", "/session/status", input, { options: opts }),
      todo: (input, opts) => request("session.todo", "GET", `${sessionPath(input)}/todo`, input, { options: opts }),
      diff: (input, opts) => request("session.diff", "GET", `${sessionPath(input)}/diff`, input, { query: ["messageID"], options: opts }),
      fork: (input, opts) => request("session.fork", "POST", `${sessionPath(input)}/fork`, input, { body: body(input, ["sessionID"]), options: opts }),
      abort: (input, opts) => request("session.abort", "POST", `${sessionPath(input)}/abort`, input, { options: opts }),
      summarize: (input, opts) => request("session.summarize", "POST", `${sessionPath(input)}/summarize`, input, { body: body(input, ["sessionID"]), options: opts }),
      prompt: (input, opts) => request("session.prompt", "POST", `${sessionPath(input)}/message`, input, { body: body(input, ["sessionID"]), options: opts }),
      promptAsync: (input, opts) => request("session.promptAsync", "POST", `${sessionPath(input)}/prompt_async`, input, { body: body(input, ["sessionID"]), options: opts }),
      command: (input, opts) => request("session.command", "POST", `${sessionPath(input)}/command`, input, { body: body(input, ["sessionID"]), options: opts }),
      shell: (input, opts) => request("session.shell", "POST", `${sessionPath(input)}/shell`, input, { body: body(input, ["sessionID"]), options: opts }),
      revert: (input, opts) => request("session.revert", "POST", `${sessionPath(input)}/revert`, input, { body: body(input, ["sessionID"]), options: opts }),
      unrevert: (input, opts) => request("session.unrevert", "POST", `${sessionPath(input)}/unrevert`, input, { options: opts }),
    },
    permission: {
      list: (input, opts) => request("permission.list", "GET", "/permission", input, { options: opts }),
      respond: (input, opts) => request("permission.respond", "POST", `/session/${encodeURIComponent(input.sessionID)}/permissions/${encodeURIComponent(input.permissionID)}`, input, { body: { response: input.response }, options: opts }),
    },
    question: {
      list: (input, opts) => request("question.list", "GET", "/question", input, { options: opts }),
      reply: (input, opts) => request("question.reply", "POST", `/question/${encodeURIComponent(input.requestID)}/reply`, input, { body: { answers: input.answers }, options: opts }),
      reject: (input, opts) => request("question.reject", "POST", `/question/${encodeURIComponent(input.requestID)}/reject`, input, { options: opts }),
    },
    project: {
      list: (input, opts) => request("project.list", "GET", "/project", input, { options: opts }),
      current: (input, opts) => request("project.current", "GET", "/project/current", input, { options: opts }),
      update: (input, opts) => request("project.update", "PATCH", `/project/${encodeURIComponent(input.projectID)}`, input, { body: body(input, ["projectID"]), options: opts }),
    },
    global: {
      health: (opts) => request("global.health", "GET", "/global/health", undefined, { options: opts }),
      config: {
        get: (opts) => request("global.config.get", "GET", "/global/config", undefined, { options: opts }),
        update: (input, opts) => request("global.config.update", "PATCH", "/global/config", undefined, { body: input?.config ?? {}, options: opts }),
      },
      dispose: (opts) => request("global.dispose", "POST", "/global/dispose", undefined, { options: opts }),
    },
    worktree: {
      create: (input, opts) => request("worktree.create", "POST", "/experimental/worktree", input, { body: input?.worktreeCreateInput ?? {}, options: opts }),
      remove: (input, opts) => request("worktree.remove", "DELETE", "/experimental/worktree", input, { body: input?.worktreeRemoveInput ?? {}, options: opts }),
    },
    provider: {
      list: (input, opts) => request("provider.list", "GET", "/provider", input, { options: opts }),
      auth: (input, opts) => request("provider.auth", "GET", "/provider/auth", input, { options: opts }),
      oauth: {
        authorize: (input, opts) => request("provider.oauth.authorize", "POST", `/provider/${encodeURIComponent(input.providerID)}/oauth/authorize`, input, { body: body(input, ["providerID"]), options: opts }),
        callback: (input, opts) => request("provider.oauth.callback", "POST", `/provider/${encodeURIComponent(input.providerID)}/oauth/callback`, input, { body: body(input, ["providerID"]), options: opts }),
      },
    },
    path: { get: (input, opts) => request("path.get", "GET", "/path", input, { options: opts }) },
    app: { agents: (input, opts) => request("app.agents", "GET", "/app/agents", input, { options: opts }) },
    config: { get: (input, opts) => request("config.get", "GET", "/config", input, { options: opts }) },
    command: { list: (input, opts) => request("command.list", "GET", "/command", input, { options: opts }) },
    vcs: { get: (input, opts) => request("vcs.get", "GET", "/vcs", input, { options: opts }) },
    mcp: { status: (input, opts) => request("mcp.status", "GET", "/mcp", input, { options: opts }) },
    lsp: { status: (input, opts) => request("lsp.status", "GET", "/lsp", input, { options: opts }) },
  }
}

function appendQuery(url: URL, key: string, value: unknown) {
  if (value !== undefined) url.searchParams.set(key, String(value))
}
function mergeHeaders(...values: Array<HeadersInit | undefined>) {
  const headers = new Headers()
  for (const value of values) {
    if (!value) continue
    new Headers(value).forEach((headerValue, key) => headers.set(key, headerValue))
  }
  return headers
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function omit(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key, field]) => !keys.includes(key) && field !== undefined))
}
async function responseJson(operation: string, response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    throw new ServerClientPayloadError(operation, error instanceof Error ? error.message : "Server response was not valid JSON", undefined)
  }
}
async function responseError(operation: string, response: Response) {
  const body = await response.clone().json().catch(() => undefined)
  const row = record(body)
  const nested = record(row.error)
  const code = typeof nested.code === "string" ? nested.code : typeof row.code === "string" ? row.code : `http_${response.status}`
  const message = typeof nested.message === "string" ? nested.message : typeof row.message === "string" ? row.message : `Server request failed with status ${response.status}`
  return new ServerClientResponseError(operation, response.status, code, body, message)
}
function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}
