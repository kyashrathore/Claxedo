import z from "zod"
import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { hostedControlCall, parseHostedHttpError, signedAccountRun } from "@/platform/account/hosted-control-call"
import type { SaveRequest, SaveResponse } from "@/features/documents/state/persistence-controller"
import { readField, readString } from "@/lib/record"

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

/**
 * Wire schemas for the document shapes above.
 *
 * Every read here answers through `hostedControlCall`, which has two producers:
 * the hosted operation's decoder in `HOSTED_OPERATIONS` — `array` or `object`,
 * which proves the container and nothing about the fields — and a raw HTTP body.
 * Neither is a `DocumentSummary` until something parses one. The
 * `z.ZodType<…>` annotations tie each schema to the type it certifies, so a
 * field added to one and not the other is a compile error.
 *
 * A declared-nullable field accepts a missing key as well as an explicit null:
 * the two say the same thing about a document, and only one of the two
 * transports bothers to send the key.
 */
const nullableString = z.string().nullable().optional().transform(value => value ?? null)

const DocumentSummarySchema: z.ZodType<DocumentSummary> = z.object({
  id: z.string(),
  project_id: z.string(),
  display_name: z.string(),
  origin_kind: z.enum(["managed", "repository"]),
  placement_kind: z.enum(["local", "hosted"]),
  placement_id: z.string(),
  managed_relative_path: nullableString,
  repository_id: nullableString,
  workspace_id: nullableString,
  repository_relative_path: nullableString,
  branch: nullableString,
  status: z.string(),
  session_id: nullableString,
  archived_at: nullableString,
  created_at: z.string(),
  updated_at: z.string(),
  last_opened_at: nullableString,
  last_known_file_version: nullableString,
})

const DocumentContentSchema: z.ZodType<DocumentContent> = z.object({
  markdown: z.string(),
  version: z.string(),
  modifiedAt: z.number(),
})

const DocumentAgentOpenSchema: z.ZodType<DocumentAgentOpen> = z.object({
  document_id: z.string(),
  display_name: z.string(),
  path: z.string(),
})

const DocumentSnapshotSchema: z.ZodType<DocumentSnapshot> = z.object({
  id: z.string(),
  sha256: z.string(),
  size: z.number(),
  reason: z.string(),
  actor: z.object({ type: z.enum(["user", "agent", "system"]), id: z.string() }),
  sessionId: z.string().optional(),
  createdAt: z.number(),
  pins: z.array(z.string()),
})

const RuntimeConflictResolutionSchema = z.object({
  path: z.string(),
  preserved: z.string().optional(),
  version: z.string(),
})

const ExportEnvelopeSchema = z.object({ bytesBase64: z.string() })

/** `transitions` is loose here on purpose; `parseTransitions` settles it below. */
const DocumentStatusRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  position: z.number(),
  transitions: z.union([z.array(z.string()), z.string()]),
})

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

/** The route body, unchecked: the schemas in `documentCall` establish the type. */
async function json(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!response.ok) {
    const body = parseErrorBody(text)
    throw new DocumentApiError(body.code, response.status, body.message)
  }
  return JSON.parse(text)
}

/**
 * The documents error envelope, read once.
 *
 * Both transports send `{ error: … }`: the JSON routes send an object with
 * `code`/`message`, the hosted control plane sends the code as a bare string.
 * These were parsed in two places that disagreed on which half wins.
 */
function documentErrorFields(body: unknown, fallbackMessage: string) {
  const error = readField(body, "error")
  return {
    code: readString(error, "code") || (typeof error === "string" ? error : "") || "document_request_failed",
    message: readString(error, "message") || fallbackMessage,
  }
}

function parseErrorBody(text: string) {
  try {
    return documentErrorFields(JSON.parse(text), text)
  } catch (error) {
    return { code: "document_request_failed", message: text || String(error) }
  }
}

function queryParams(query: DocumentQuery = {}) {
  return {
    ...(query.projectId ? { project_id: query.projectId } : {}),
    ...(query.documentId ? { document_id: query.documentId } : {}),
    ...(query.directory ? { directory: query.directory } : {}),
    ...(query.archived ? { archived: query.archived } : {}),
  }
}

async function request(url: URL, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  return json(await authFetch(String(url), { ...init, headers }))
}

/**
 * One documents operation, over whichever transport is available, checked once.
 *
 * `parse` runs on the result rather than inside the fallback because the hosted
 * branch needs it just as much: `HOSTED_OPERATIONS` proves `documents.get`
 * answers *an object*, and every reader below wants a `DocumentSummary`.
 */
async function documentCall<T>(
  operation: Parameters<typeof hostedControlCall>[0],
  input: Record<string, unknown>,
  fallback: () => Promise<unknown>,
  parse: (raw: unknown) => T,
): Promise<T> {
  try {
    return parse(await hostedControlCall(operation, input, fallback))
  } catch (error) {
    const hosted = parseHostedHttpError(error)
    if (hosted) {
      const { code, message } = documentErrorFields(hosted.body, hosted.detail)
      throw new DocumentApiError(code, hosted.status, message)
    }
    throw error
  }
}

export const documentsApi = {
  list(query: DocumentQuery = {}) {
    const archived = query.archived ?? "active"
    return documentCall(
      "documents.list",
      queryParams({ ...query, archived }),
      () => request(documentsUrl({ query: { ...query, archived } })),
      raw => z.array(DocumentSummarySchema).parse(raw),
    )
  },
  get(id: string) {
    return documentCall(
      "documents.get",
      { id },
      () => request(documentsUrl({ id })),
      raw => DocumentSummarySchema.parse(raw),
    )
  },
  content(id: string) {
    return documentCall(
      "documents.content.get",
      { id },
      () => request(documentsUrl({ id, path: "content" })),
      raw => DocumentContentSchema.parse(raw),
    )
  },
  async open(id: string): Promise<OpenDocument> {
    // Fetch summary and content concurrently. They are independent reads, and
    // awaiting them in series made opening a document two separate trips
    // through the global fetch throttle (`lib/fetch-throttle.ts`, cap 4) — so
    // under a busy multi-workspace bootstrap the second request re-queued
    // behind everything the first one let through, roughly doubling the open
    // latency. The archived guard still runs before content is handed back; on
    // an archived document the concurrent content read is simply discarded.
    //
    // `allSettled`, not `all`, is what makes that last sentence true: an
    // archived document's content read is the one most likely to fail, and
    // `Promise.all` would hand its rejection to the caller instead of the typed
    // `document_archived`. Discarding the read means discarding its failure too.
    const [summary, content] = await Promise.allSettled([documentsApi.get(id), documentsApi.content(id)])
    if (summary.status === "rejected") throw summary.reason
    if (summary.value.archived_at) throw new DocumentApiError("document_archived", 410, "This document is archived.")
    if (content.status === "rejected") throw content.reason
    return {
      id,
      displayName: summary.value.display_name,
      summary: summary.value,
      ...content.value,
    }
  },
  agentOpen(id: string, sessionId: string) {
    return documentCall(
      "documents.agentOpen",
      { id, session_id: sessionId },
      () => request(documentsUrl({ id, path: "agent-open" }), {
        method: "POST",
        body: JSON.stringify({ session_id: sessionId }),
      }),
      raw => DocumentAgentOpenSchema.parse(raw),
    )
  },
  resolveRuntimeConflict(id: string, input: { sessionId: string; choice: "durable" | "draft" }) {
    return documentCall(
      "documents.runtimeConflictResolve",
      { id, session_id: input.sessionId, choice: input.choice },
      () => request(
        documentsUrl({ id, path: ["runtime-conflict", "resolve"] }),
        {
          method: "POST",
          body: JSON.stringify({ session_id: input.sessionId, choice: input.choice }),
        },
      ),
      raw => RuntimeConflictResolutionSchema.parse(raw),
    )
  },
  snapshots(id: string) {
    return documentCall(
      "documents.snapshots",
      { id },
      () => request(documentsUrl({ id, path: "snapshots" })),
      raw => z.array(DocumentSnapshotSchema).parse(raw),
    )
  },
  restoreSnapshot(id: string, snapshotId: string, expectedVersion: string) {
    return documentCall(
      "documents.snapshots.restore",
      { id, snapshotId, ifMatch: expectedVersion },
      () => request(documentsUrl({ id, path: ["snapshots", snapshotId, "restore"] }), {
        method: "POST",
        headers: { "If-Match": expectedVersion },
        body: JSON.stringify({}),
      }),
      raw => DocumentContentSchema.parse(raw),
    )
  },
  moveToRepository(id: string, destination: { workspaceId: string; path: string }) {
    return documentCall(
      "documents.moveToRepository",
      { id, workspace_id: destination.workspaceId, path: destination.path },
      () => request(documentsUrl({ id, path: "move-to-repository" }), {
        method: "POST",
        body: JSON.stringify({ workspace_id: destination.workspaceId, path: destination.path }),
      }),
      raw => DocumentSummarySchema.parse(raw),
    )
  },
  async save(id: string, input: SaveRequest): Promise<SaveResponse> {
    const run = await signedAccountRun()
    if (run) {
      try {
        const saved = await documentCall(
          "documents.content.put",
          {
            id,
            display_name: input.displayName,
            markdown: input.markdown,
            ifMatch: input.expectedVersion,
          },
          async () => {
            throw new Error("unreachable")
          },
          raw => DocumentContentSchema.parse(raw),
        )
        return { ok: true, version: saved.version }
      } catch (error) {
        if (error instanceof DocumentApiError && error.status === 409) {
          const current = await documentsApi.open(id)
          return {
            ok: false,
            kind: "conflict",
            currentVersion: current.version,
            current: { displayName: current.displayName, markdown: current.markdown },
          }
        }
        throw error
      }
    }
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
    const saved = DocumentContentSchema.parse(await json(response))
    return { ok: true, version: saved.version }
  },
  create(input: { projectId?: string; directory?: string; displayName: string; markdown?: string }) {
    return documentCall(
      "documents.create",
      {
        display_name: input.displayName,
        markdown: input.markdown ?? "",
        ...(input.projectId ? { project_id: input.projectId } : {}),
        ...(input.directory ? { directory: input.directory } : {}),
      },
      () => request(documentsUrl(), {
        method: "POST",
        body: JSON.stringify({
          project_id: input.projectId,
          directory: input.directory,
          display_name: input.displayName,
          markdown: input.markdown ?? "",
        }),
      }),
      raw => DocumentSummarySchema.parse(raw),
    )
  },
  createFromRepository(input: {
    projectId?: string
    directory?: string
    workspaceId: string
    path: string
    displayName?: string
  }) {
    return documentCall(
      "documents.fromRepo",
      {
        workspace_id: input.workspaceId,
        path: input.path,
        ...(input.projectId ? { project_id: input.projectId } : {}),
        ...(input.directory ? { directory: input.directory } : {}),
        ...(input.displayName ? { display_name: input.displayName } : {}),
      },
      () => request(documentsUrl({ path: "from-repo" }), {
        method: "POST",
        body: JSON.stringify({
          project_id: input.projectId,
          directory: input.directory,
          workspace_id: input.workspaceId,
          path: input.path,
          display_name: input.displayName,
        }),
      }),
      raw => DocumentSummarySchema.parse(raw),
    )
  },
  async exportBytes(id: string) {
    const envelope = await documentCall(
      "documents.export",
      { id },
      async () => {
        const response = await authFetch(String(documentsUrl({ id, path: "export" })))
        if (!response.ok) return await json(response)
        const bytes = new Uint8Array(await response.arrayBuffer())
        // Match the AccountPort envelope so the common path below is one decode.
        let binary = ""
        for (const byte of bytes) binary += String.fromCharCode(byte)
        return { bytesBase64: btoa(binary) }
      },
      raw => ExportEnvelopeSchema.parse(raw),
    )
    const binary = atob(envelope.bytesBase64)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  },
  async listStatuses(query: DocumentQuery = {}) {
    const rows = await documentCall(
      "documents.statuses",
      queryParams(query),
      () => request(documentsUrl({ path: "statuses", query })),
      raw => z.array(DocumentStatusRowSchema).parse(raw),
    )
    return rows.map((row) => ({
      ...row,
      transitions: parseTransitions(row.transitions),
    }))
  },
}

export type DocumentsApi = typeof documentsApi

/**
 * `transitions` arrives either as a JSON array or as the JSON TEXT of one,
 * depending on whether the row came back through the control plane's
 * pass-through or straight from SQLite.
 */
function parseTransitions(value: string[] | string): string[] {
  if (typeof value !== "string") return value
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
}
