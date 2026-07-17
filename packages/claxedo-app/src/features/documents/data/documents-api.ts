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

export type DocumentAgentOpen = {
  document_id: string
  display_name: string
  path: string
}

export type DocumentSnapshot = {
  id: string
  sha256: string
  size: number
  reason: string
  actor: { type: "user" | "agent" | "system"; id: string }
  sessionId?: string
  createdAt: number
  pins: string[]
}

export type DocumentStatus = {
  id: string
  name: string
  color: string
  position: number
  transitions: string[]
}

export type DocumentQuery = {
  projectId?: string
  documentId?: string
  directory?: string
  archived?: "active" | "archived" | "all"
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

function documentsUrl(input?: { id?: string; path?: string | string[]; query?: DocumentQuery }) {
  const segments = ["documents"]
  if (input?.id) segments.push(encodeURIComponent(input.id))
  if (input?.path) {
    const pathSegments = Array.isArray(input.path) ? input.path : input.path.split("/").filter(Boolean)
    segments.push(...pathSegments.map(encodeURIComponent))
  }
  const url = new URL(`/${segments.join("/")}`, normalizeUrl(getClaxedoServerUrl()) ?? getClaxedoServerUrl())
  if (input?.query?.projectId) url.searchParams.set("project_id", input.query.projectId)
  if (input?.query?.documentId) url.searchParams.set("document_id", input.query.documentId)
  if (input?.query?.directory) url.searchParams.set("directory", input.query.directory)
  if (input?.query?.archived) url.searchParams.set("archived", input.query.archived)
  return url
}

export function documentWorkSourceUrl(baseUrl: string, documentId: string) {
  return new URL(
    `/documents/${encodeURIComponent(documentId)}/work-source`,
    normalizeUrl(baseUrl) ?? baseUrl,
  ).toString()
}

export function documentWorkSourcePinUrl(baseUrl: string, documentId: string, snapshotId: string) {
  return new URL(
    `/documents/${encodeURIComponent(documentId)}/snapshots/${encodeURIComponent(snapshotId)}/work-source-pin`,
    normalizeUrl(baseUrl) ?? baseUrl,
  ).toString()
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
    // Fetch summary and content concurrently. They are independent reads, and
    // awaiting them in series made opening a document two separate trips
    // through the global fetch throttle (`lib/fetch-throttle.ts`, cap 4) — so
    // under a busy multi-workspace bootstrap the second request re-queued
    // behind everything the first one let through, roughly doubling the open
    // latency. The archived guard still runs before content is handed back; on
    // an archived document the concurrent content read is simply discarded.
    const [summary, content] = await Promise.all([documentsApi.get(id), documentsApi.content(id)])
    if (summary.archived_at) throw new DocumentApiError("document_archived", 410, "This document is archived.")
    return {
      id,
      displayName: summary.display_name,
      summary,
      ...content,
    }
  },
  agentOpen(id: string, sessionId: string) {
    return request<DocumentAgentOpen>(documentsUrl({ id, path: "agent-open" }), {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId }),
    })
  },
  resolveRuntimeConflict(id: string, input: { sessionId: string; choice: "durable" | "draft" }) {
    return request<{ path: string; preserved?: string; version: string }>(
      documentsUrl({ id, path: ["runtime-conflict", "resolve"] }),
      {
        method: "POST",
        body: JSON.stringify({ session_id: input.sessionId, choice: input.choice }),
      },
    )
  },
  snapshots(id: string) {
    return request<DocumentSnapshot[]>(documentsUrl({ id, path: "snapshots" }))
  },
  restoreSnapshot(id: string, snapshotId: string, expectedVersion: string) {
    return request<DocumentContent>(documentsUrl({ id, path: ["snapshots", snapshotId, "restore"] }), {
      method: "POST",
      headers: { "If-Match": expectedVersion },
      body: JSON.stringify({}),
    })
  },
  moveToRepository(id: string, destination: { workspaceId: string; path: string }) {
    return request<DocumentSummary>(documentsUrl({ id, path: "move-to-repository" }), {
      method: "POST",
      body: JSON.stringify({ workspace_id: destination.workspaceId, path: destination.path }),
    })
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
  createFromRepository(input: {
    projectId?: string
    directory?: string
    workspaceId: string
    path: string
    displayName?: string
  }) {
    return request<DocumentSummary>(documentsUrl({ path: "from-repo" }), {
      method: "POST",
      body: JSON.stringify({
        project_id: input.projectId,
        directory: input.directory,
        workspace_id: input.workspaceId,
        path: input.path,
        display_name: input.displayName,
      }),
    })
  },
  async exportBytes(id: string) {
    const response = await authFetch(String(documentsUrl({ id, path: "export" })))
    if (response.ok) return new Uint8Array(await response.arrayBuffer())
    return await json<never>(response)
  },
  async listStatuses(query: DocumentQuery = {}) {
    const rows = await request<Array<Omit<DocumentStatus, "transitions"> & { transitions: string[] | string }>>(
      documentsUrl({ path: "statuses", query }),
    )
    return rows.map((row) => ({
      ...row,
      transitions: typeof row.transitions === "string" ? (JSON.parse(row.transitions) as string[]) : row.transitions,
    }))
  },
  transitionStatus(id: string, status: string) {
    return request<DocumentSummary>(documentsUrl({ id, path: "status" }), {
      method: "POST",
      body: JSON.stringify({ status }),
    })
  },
}

export type DocumentsApi = typeof documentsApi
