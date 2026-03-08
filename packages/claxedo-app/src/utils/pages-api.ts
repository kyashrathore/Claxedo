/**
 * Frontend API client for Pages
 *
 * Pages are served by backend routes at /api/pages.
 */
import { authFetch, getDefaultBaseUrl } from "./api"

export type Page = {
  id: string
  title: string
  content: string
  status: string
  session_id: string | null
  created_at: string
  updated_at: string
}

export type PageStatus = {
  id: string
  name: string
  color: string
  position: number
  transitions: string[]
}

export type PageMarkdownExport = {
  id: string
  title: string
  markdown: string
  meta: {
    page_id: string
    updated_at: string
    doc_hash: string
    md_export_hash: string
    md_export_base_doc_hash: string
    derived_markdown: boolean
  }
}

export type PageMarkdownSync = {
  page: Page
  imported: boolean
  conflict: boolean
  base_hash?: string
  current_hash?: string
  initialized?: boolean
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

function base() {
  return `${getDefaultBaseUrl()}/api/pages`
}

function looksLikeHtmlResponse(res: Response) {
  const type = typeof res.headers?.get === "function" ? res.headers.get("content-type") || "" : ""
  return type.includes("text/html")
}

function htmlApiError() {
  return "Pages API resolved to app HTML. Set VITE_OPENCODE_BACKEND_URL=http://localhost:4096."
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
  list(): Promise<Page[]> {
    return request<Page[]>(base())
  },

  get(id: string): Promise<Page> {
    return request<Page>(`${base()}/${id}`)
  },

  create(title?: string): Promise<Page> {
    return request<Page>(base(), {
      method: "POST",
      body: JSON.stringify({ title }),
    })
  },

  update(id: string, patch: Partial<Pick<Page, "title" | "content">>): Promise<Page> {
    return request<Page>(`${base()}/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })
  },

  delete(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`${base()}/${id}`, {
      method: "DELETE",
    })
  },

  listStatuses(): Promise<PageStatus[]> {
    return request<PageStatus[]>(`${base()}/statuses`)
  },

  saveStatuses(statuses: PageStatus[]): Promise<PageStatus[]> {
    return request<PageStatus[]>(`${base()}/statuses`, {
      method: "PUT",
      body: JSON.stringify(statuses),
    })
  },

  updateSessionId(pageId: string, sessionId: string | null): Promise<Page> {
    return request<Page>(`${base()}/${pageId}/session`, {
      method: "PATCH",
      body: JSON.stringify({ session_id: sessionId }),
    })
  },

  transitionStatus(pageId: string, status: string): Promise<Page> {
    return request<Page>(`${base()}/${pageId}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    })
  },

  exportMarkdown(id: string): Promise<PageMarkdownExport> {
    return request<PageMarkdownExport>(`${base()}/${id}/export/markdown`)
  },

  async exportMarkdownRaw(id: string): Promise<string> {
    const res = await authFetch(`${base()}/${id}/export/markdown?raw=1`, {
      headers: { Accept: "text/markdown" },
    })
    if (res.ok && looksLikeHtmlResponse(res)) throw new Error(htmlApiError())
    if (!res.ok) {
      const text = await res.text()
      throw new Error(text || `Request failed: ${res.status}`)
    }
    return res.text()
  },

  importMarkdown(id: string, markdown: string, force = false): Promise<PageMarkdownSync> {
    return request<PageMarkdownSync>(`${base()}/${id}/import/markdown`, {
      method: "POST",
      body: JSON.stringify({ markdown, force }),
    })
  },

  syncMarkdown(id: string, force = false): Promise<PageMarkdownSync> {
    return request<PageMarkdownSync>(`${base()}/${id}/sync/markdown`, {
      method: "POST",
      body: JSON.stringify({ force }),
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

  writeback(id: string, filePath: string, directory: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`${base()}/${id}/writeback`, {
      method: "POST",
      body: JSON.stringify({ filePath, directory }),
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
