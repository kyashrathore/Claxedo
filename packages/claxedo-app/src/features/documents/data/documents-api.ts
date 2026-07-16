import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import type { SaveRequest, SaveResponse } from "@/features/documents/state/persistence-controller"

export type DocumentSummary = {
  id: string
  project_id: string
  display_name: string
  origin_kind: "managed" | "repository"
  placement_kind: "local" | "hosted"
  placement_id: string
  managed_relative_path: string | null
  repository_id: string | null
  workspace_id: string | null
  repository_relative_path: string | null
  branch: string | null
  status: string
  session_id: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
  last_opened_at: string | null
  last_known_file_version: string | null
}

export type DocumentContent = {
  markdown: string
  version: string
  modifiedAt: number
}

export type OpenDocument = DocumentContent & {
  id: string
  displayName: string
  summary: DocumentSummary
}

export type DocumentQuery = {
  projectId?: string
  directory?: string
  archived?: "active" | "archived" | "all"
}

export type DocumentEvent = {
  type: "document.connected" | "document.changed" | "document.heartbeat"
  document_id?: string
  project_id?: string
  reason?: string
  version?: string
  invalidate?: string[]
}

export class DocumentApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function documentsUrl(input?: { id?: string; path?: string; query?: DocumentQuery }) {
  const segments = ["documents"]
  if (input?.id) segments.push(encodeURIComponent(input.id))
  if (input?.path) segments.push(...input.path.split("/").filter(Boolean).map(encodeURIComponent))
  const url = new URL(`/${segments.join("/")}`, normalizeUrl(getClaxedoServerUrl()) ?? getClaxedoServerUrl())
  if (input?.query?.projectId) url.searchParams.set("project_id", input.query.projectId)
  if (input?.query?.directory) url.searchParams.set("directory", input.query.directory)
  if (input?.query?.archived) url.searchParams.set("archived", input.query.archived)
  return url
}

async function json<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (response.ok) return JSON.parse(text) as T
  const body = parseErrorBody(text)
  throw new DocumentApiError(body.code, response.status, body.message)
}

function parseErrorBody(text: string) {
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } | string }
    if (typeof body.error === "object" && body.error) {
      return {
        code: typeof body.error.code === "string" ? body.error.code : "document_request_failed",
        message: typeof body.error.message === "string" ? body.error.message : text,
      }
    }
    return { code: typeof body.error === "string" ? body.error : "document_request_failed", message: text }
  } catch (error) {
    return { code: "document_request_failed", message: text || String(error) }
  }
}

async function request<T>(url: URL, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  return json<T>(await authFetch(String(url), { ...init, headers }))
}

export const documentsApi = {
  list(query: DocumentQuery = {}) {
    return request<DocumentSummary[]>(documentsUrl({ query: { ...query, archived: query.archived ?? "active" } }))
  },
  get(id: string) {
    return request<DocumentSummary>(documentsUrl({ id }))
  },
  content(id: string) {
    return request<DocumentContent>(documentsUrl({ id, path: "content" }))
  },
  async open(id: string): Promise<OpenDocument> {
    const summary = await documentsApi.get(id)
    if (summary.archived_at) throw new DocumentApiError("document_archived", 410, "This document is archived.")
    return {
      id,
      displayName: summary.display_name,
      summary,
      ...(await documentsApi.content(id)),
    }
  },
  async save(id: string, input: SaveRequest): Promise<SaveResponse> {
    const response = await authFetch(String(documentsUrl({ id, path: "content" })), {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": input.expectedVersion },
      body: JSON.stringify({ display_name: input.displayName, markdown: input.markdown }),
    })
    if (response.status === 409) {
      await response.text()
      const current = await documentsApi.open(id)
      return {
        ok: false,
        kind: "conflict",
        currentVersion: current.version,
        current: { displayName: current.displayName, markdown: current.markdown },
      }
    }
    const saved = await json<DocumentContent>(response)
    return { ok: true, version: saved.version }
  },
  create(input: { projectId?: string; directory?: string; displayName: string; markdown?: string }) {
    return request<DocumentSummary>(documentsUrl(), {
      method: "POST",
      body: JSON.stringify({
        project_id: input.projectId,
        directory: input.directory,
        display_name: input.displayName,
        markdown: input.markdown ?? "",
      }),
    })
  },
  async watch(query: DocumentQuery, onEvent: (event: DocumentEvent) => void, signal?: AbortSignal) {
    const response = await authFetch(String(documentsUrl({ path: "events", query })), {
      headers: { Accept: "text/event-stream" },
      signal,
    })
    if (!response.ok || !response.body)
      throw new DocumentApiError("document_events_unavailable", response.status, "Document updates are unavailable.")
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (!signal?.aborted) {
      const chunk = await reader.read()
      if (chunk.done) return
      buffer += decoder.decode(chunk.value, { stream: true })
      const blocks = buffer.split("\n\n")
      buffer = blocks.pop() ?? ""
      blocks.forEach((block) => {
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
        if (data) onEvent(JSON.parse(data) as DocumentEvent)
      })
    }
  },
}

export type DocumentsApi = typeof documentsApi
