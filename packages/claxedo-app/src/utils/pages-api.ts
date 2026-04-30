/**
 * Frontend API client for Pages
 *
 * Pages are served by claxedo-server routes at /pages.
 */
import { authFetch, getClaxedoServerUrl } from "./api"

export type Page = {
  id: string
  title: string
  content: string
  status: string
  session_id: string | null
  file_path: string | null
  directory: string | null
  created_at: string
  updated_at: string
  project_id?: string | null
  project_name?: string | null
  project_worktree?: string | null
}

export type PageStatus = {
  id: string
  name: string
  color: string
  position: number
  transitions: string[]
}

export type ArenaControlSignal = "continue" | "done" | "question"
export type ArenaStatus = "idle" | "running" | "paused" | "stopping" | "completed" | "failed"

export type ArenaAgentConfig = {
  name: string
  role: string
  duty: string
  model: string
  style?: string
  temperature?: number
}

export type ArenaConfig = {
  max_agents?: number
  max_rounds?: number
  max_wave_runtime_ms?: number
  max_turn_runtime_ms?: number
  max_relay_chars?: number
  recent_messages?: number
  agents?: ArenaAgentConfig[]
}

export type ArenaMessage = {
  id: string
  wave_id: string
  round: number
  kind: "user" | "agent" | "relay" | "system"
  source: string
  text: string
  signal: ArenaControlSignal
  meta: Record<string, unknown>
  created_at: number
}

export type ArenaAgentState = {
  key: string
  name: string
  role: string
  duty: string
  model: string
  status: string
  settled: boolean
  signal: string
}

export type ArenaWaveState = {
  id: string
  status: string
  round: number
  targets: string[]
  termination: string
  started_at: number
  finished_at: number
}

export type ArenaState = {
  arena: {
    id: string
    page_id: string
    status: ArenaStatus
    parent_session_id: string
    current_round: number
    stop_reason: string
    last_error: string
    synopsis: string
    config: ArenaConfig
    created_at: number
    updated_at: number
  } | null
  agents: ArenaAgentState[]
  waves: ArenaWaveState[]
  messages: ArenaMessage[]
}

export type ArenaStartRequest = {
  directory?: string
  parent_session_id?: string
  parentSessionId?: string
  config?: ArenaConfig
}

export type ArenaMessageRequest = {
  text: string
  targets?: string[]
  mentions?: string[]
  page_context?: string
}

export type ArenaControlRequest = {
  action: "pause" | "resume" | "stop" | "retry"
}

export type PageScope = "all" | "project" | "global"

export type PageQuery = {
  scope?: PageScope
  directory?: string
  project_id?: string
}

export type PageCreateInput = {
  title?: string
  content?: string
  status?: string
  file_path?: string
  directory?: string
  project_id?: string
}

function base() {
  return `${getClaxedoServerUrl()}/pages`
}

function url(path = "", input?: PageQuery) {
  const txt = query(input)
  return `${base()}${path}${txt ? `?${txt}` : ""}`
}

function looksLikeHtmlResponse(res: Response) {
  const type = typeof res.headers?.get === "function" ? res.headers.get("content-type") || "" : ""
  return type.includes("text/html")
}

function htmlApiError() {
  return "Pages API resolved to app HTML. Set VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3001."
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  })
  if (res.ok && looksLikeHtmlResponse(res)) {
    throw new Error(htmlApiError())
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `Request failed: ${res.status}`)
  }
  return res.json()
}

export const pagesApi = {
  list(input?: PageQuery): Promise<Page[]> {
    return request<Page[]>(url("", input))
  },

  get(id: string, input?: PageQuery): Promise<Page> {
    return request<Page>(url(`/${id}`, input))
  },

  findByFile(file_path: string, directory: string): Promise<Page | null> {
    const params = new URLSearchParams({ file_path, directory })
    return request<Page | null>(`${base()}/by-file?${params}`)
  },

  create(title?: string | PageCreateInput, file_path?: string, directory?: string): Promise<Page> {
    const body = typeof title === "object" && title !== null
      ? title
      : { title, file_path, directory }
    return request<Page>(base(), {
      method: "POST",
      body: JSON.stringify(body),
    })
  },

  update(id: string, patch: Partial<Pick<Page, "title" | "content">>, input?: PageQuery): Promise<Page> {
    return request<Page>(url(`/${id}`, input), {
      method: "PATCH",
      body: JSON.stringify(patch),
    })
  },

  delete(id: string, input?: PageQuery): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(url(`/${id}`, input), {
      method: "DELETE",
    })
  },

  listStatuses(input?: PageQuery): Promise<PageStatus[]> {
    return request<PageStatus[]>(url("/statuses", input))
  },

  saveStatuses(statuses: PageStatus[], input?: PageQuery): Promise<PageStatus[]> {
    return request<PageStatus[]>(url("/statuses", input), {
      method: "PUT",
      body: JSON.stringify(statuses),
    })
  },

  updateSessionId(pageId: string, sessionId: string | null, input?: PageQuery): Promise<Page> {
    return request<Page>(url(`/${pageId}/session`, input), {
      method: "PATCH",
      body: JSON.stringify({ session_id: sessionId }),
    })
  },

  transitionStatus(pageId: string, status: string, input?: PageQuery): Promise<Page> {
    return request<Page>(url(`/${pageId}/status`, input), {
      method: "POST",
      body: JSON.stringify({ status }),
    })
  },

  arenaStart(id: string, input: ArenaStartRequest): Promise<ArenaState> {
    return request<ArenaState>(`${base()}/${id}/arena/start`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  arenaState(id: string): Promise<ArenaState> {
    return request<ArenaState>(`${base()}/${id}/arena/state`)
  },

  arenaMessage(
    id: string,
    input: ArenaMessageRequest,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; wave_id: string; state: ArenaState }> {
    return request<{ ok: boolean; wave_id: string; state: ArenaState }>(`${base()}/${id}/arena/message`, {
      method: "POST",
      body: JSON.stringify(input),
      signal,
    })
  },

  arenaControl(id: string, input: ArenaControlRequest): Promise<{ ok: boolean; state: ArenaState }> {
    return request<{ ok: boolean; state: ArenaState }>(`${base()}/${id}/arena/control`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  arenaEventsUrl(id: string, directory?: string) {
    const dir = cleanDir(directory)
    if (!dir) return `${base()}/${id}/arena/events`
    return `${base()}/${id}/arena/events?directory=${encodeURIComponent(dir)}`
  },
}

function cleanDir(value: unknown) {
  if (typeof value !== "string") return ""
  return value.trim()
}

function query(input?: PageQuery) {
  if (!input) return ""
  const params = new URLSearchParams()
  if (input.scope) params.set("scope", input.scope)
  if (input.project_id) params.set("project_id", input.project_id)
  const dir = cleanDir(input.directory)
  if (dir) params.set("directory", dir)
  return params.toString()
}
