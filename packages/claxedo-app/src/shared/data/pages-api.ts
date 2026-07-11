/**
 * Frontend API client for Pages
 *
 * Pages are served by claxedo-server routes at /pages.
 */
import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/shared/data/api"

export type Page = {
  id: string
  title: string
  content: string
  status: string
  visibility: "private" | "project" | "org" | "public"
  version: number
  session_id: string | null
  directory: string | null
  source_kind: string | null
  source_repo_root: string | null
  source_repo_key: string | null
  source_branch: string | null
  source_path: string | null
  base_commit: string | null
  base_blob_sha: string | null
  base_tree_sha: string | null
  last_materialized_commit: string | null
  last_materialized_blob_sha: string | null
  last_commit_at: string | null
  last_commit_author_id: string | null
  commit_status: string | null
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
  directory?: string
  project_id?: string
  visibility?: Page["visibility"]
  source_kind?: string | null
  source_repo_root?: string | null
  source_repo_key?: string | null
  source_branch?: string | null
  source_path?: string | null
  base_commit?: string | null
  base_blob_sha?: string | null
  base_tree_sha?: string | null
}

export type PageCreateFromRepoInput = {
  title?: string
  status?: string
  directory?: string
  project_id?: string
  workspace_id?: string
  path: string
}

export type PageGitCommitInput = {
  message?: string
}

export type PageUpdateConflict = {
  conflict: true
  currentVersion: number
}

export type PageUpdateResult = Page | PageUpdateConflict

export function isPageUpdateConflict(input: PageUpdateResult): input is PageUpdateConflict {
  return "conflict" in input && input.conflict
}

function looksLikeHtmlResponse(res: Response) {
  const type = typeof res.headers?.get === "function" ? res.headers.get("content-type") || "" : ""
  return type.includes("text/html")
}

function htmlApiError() {
  return "Pages API resolved to app HTML. Set VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3001."
}

function jsonHeaders(input?: HeadersInit) {
  const headers = new Headers(input)
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  return headers
}

export function pagesUrl(input?: { serverUrl?: string; pageId?: string; path?: string; query?: PageQuery }) {
  const segments = ["pages"]
  if (input?.pageId) segments.push(encodeURIComponent(input.pageId))
  if (input?.path) {
    segments.push(
      ...input.path
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean)
        .map(encodeURIComponent),
    )
  }
  const url = new URL(`/${segments.join("/")}`, normalizeUrl(input?.serverUrl) ?? getClaxedoServerUrl())
  if (input?.query?.scope) url.searchParams.set("scope", input.query.scope)
  if (input?.query?.project_id) url.searchParams.set("project_id", input.query.project_id)
  if (input?.query?.directory?.trim()) url.searchParams.set("directory", input.query.directory.trim())
  if (url.search.includes("+")) url.search = url.search.replace(/\+/g, "%20")
  return url
}

export async function request<T>(url: string | URL, init?: RequestInit): Promise<T> {
  const res = await authFetch(String(url), {
    ...init,
    headers: jsonHeaders(init?.headers),
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

async function requestText(url: string | URL, init?: RequestInit) {
  const res = await authFetch(String(url), {
    ...init,
    headers: jsonHeaders(init?.headers),
  })
  if (res.ok && looksLikeHtmlResponse(res)) throw new Error(htmlApiError())
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `Request failed: ${res.status}`)
  }
  return res.text()
}

export const pagesApi = {
  list(input?: PageQuery): Promise<Page[]> {
    return request<Page[]>(pagesUrl({ query: input }))
  },

  get(id: string, input?: PageQuery): Promise<Page> {
    return request<Page>(pagesUrl({ pageId: id, query: input }))
  },

  eventsUrl(input?: PageQuery) {
    return String(pagesUrl({ path: "events", query: input }))
  },

  async watchListEvents(input: PageQuery | undefined, onChange: () => void, signal?: AbortSignal) {
    const res = await authFetch(String(pagesUrl({ path: "events", query: input })), {
      headers: { Accept: "text/event-stream" },
      signal,
    })
    if (!res.ok || !res.body) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (!signal?.aborted) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const events = buffer.split("\n\n")
      buffer = events.pop() ?? ""
      for (const event of events) {
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (!data) continue
        const payload = JSON.parse(data) as { type?: string }
        if (payload.type === "pages.changed") onChange()
      }
    }
  },

  create(input: PageCreateInput = {}): Promise<Page> {
    return request<Page>(pagesUrl(), {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  createFromRepo(input: PageCreateFromRepoInput): Promise<Page> {
    return request<Page>(pagesUrl({ path: "from-repo" }), {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  async update(
    id: string,
    patch: Partial<Pick<Page, "title" | "content">>,
    input?: PageQuery & { version?: number },
  ): Promise<PageUpdateResult> {
    const headers = input?.version === undefined ? undefined : { "If-Match": String(input.version) }
    const query = input ? { scope: input.scope, directory: input.directory, project_id: input.project_id } : undefined
    const res = await authFetch(String(pagesUrl({ pageId: id, query })), {
      method: "PATCH",
      headers: jsonHeaders(headers),
      body: JSON.stringify(patch),
    })
    if (res.ok && looksLikeHtmlResponse(res)) throw new Error(htmlApiError())
    if (res.status === 409) {
      const body = await res.json().catch(() => undefined) as { currentVersion?: unknown } | undefined
      return {
        conflict: true,
        currentVersion: typeof body?.currentVersion === "number" ? body.currentVersion : 0,
      }
    }
    if (!res.ok) {
      const text = await res.text()
      throw new Error(text || `Request failed: ${res.status}`)
    }
    return res.json()
  },

  exportMarkdown(id: string, input?: PageQuery): Promise<string> {
    return requestText(pagesUrl({ pageId: id, path: "export", query: input }))
  },

  commitToGit(id: string, input: PageGitCommitInput = {}, query?: PageQuery): Promise<Page> {
    return request<Page>(pagesUrl({ pageId: id, path: "git/commit", query }), {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  delete(id: string, input?: PageQuery): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(pagesUrl({ pageId: id, query: input }), {
      method: "DELETE",
    })
  },

  listStatuses(input?: PageQuery): Promise<PageStatus[]> {
    return request<PageStatus[]>(pagesUrl({ path: "statuses", query: input }))
  },

  saveStatuses(statuses: PageStatus[], input?: PageQuery): Promise<PageStatus[]> {
    return request<PageStatus[]>(pagesUrl({ path: "statuses", query: input }), {
      method: "PUT",
      body: JSON.stringify(statuses),
    })
  },

  updateSessionId(pageId: string, sessionId: string | null, input?: PageQuery): Promise<Page> {
    return request<Page>(pagesUrl({ pageId, path: "session", query: input }), {
      method: "PATCH",
      body: JSON.stringify({ session_id: sessionId }),
    })
  },

  transitionStatus(pageId: string, status: string, input?: PageQuery): Promise<Page> {
    return request<Page>(pagesUrl({ pageId, path: "status", query: input }), {
      method: "POST",
      body: JSON.stringify({ status }),
    })
  },
}
