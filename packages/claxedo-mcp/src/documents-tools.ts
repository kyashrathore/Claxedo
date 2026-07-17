import path from "node:path"
import { z } from "zod"

type ToolResult = Readonly<{ content: readonly Readonly<{ type: "text"; text: string }>[]; isError?: boolean }>
type Register = (
  name: string,
  config: Readonly<{ description: string; inputSchema: Record<string, unknown>; _meta?: Record<string, unknown> }>,
  handler: (input: Record<string, unknown>) => Promise<ToolResult>,
) => void
type Request = <Result>(requestPath: string, init?: RequestInit) => Promise<Result>

type ToolName = "documents_list" | "documents_open"

type DocumentRow = Record<string, unknown>

const metadataKeys = [
  "id",
  "project_id",
  "display_name",
  "origin_kind",
  "placement_kind",
  "placement_id",
  "managed_relative_path",
  "repository_id",
  "workspace_id",
  "repository_relative_path",
  "branch",
  "status",
  "session_id",
  "archived_at",
  "created_at",
  "updated_at",
  "last_opened_at",
  "last_known_file_version",
] as const

export class DocumentToolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "DocumentToolError"
  }
}

export const DOCUMENT_TOOL_SCHEMAS = {
  documents_list: {
    project_id: z.string().trim().min(1).optional().describe("Project whose active document metadata to list."),
    directory: z.string().trim().min(1).optional().describe("Local project directory when no project id is available."),
  },
  documents_open: {
    id_or_name: z
      .string()
      .trim()
      .min(1)
      .describe("Claxedo document reference, exact document id, or case-insensitive display name."),
    project_id: z.string().trim().min(1).optional().describe("Project used to resolve a display name."),
    directory: z.string().trim().min(1).optional().describe("Local project directory used to resolve a display name."),
    session_id: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Current Claxedo session id used for the per-project local file grant. Uses the runtime default when omitted."),
  },
} as const

export function registerDocumentTools(
  register: Register,
  request: Request,
  defaults?: { directory?: string; sessionId?: string },
) {
  register(
    "documents_list",
    {
      description: "List Claxedo document index metadata. Returns no document content bodies.",
      inputSchema: DOCUMENT_TOOL_SCHEMAS.documents_list,
    },
    (input) => callDocuments(request, "documents_list", withDefaults(input, defaults)),
  )
  register(
    "documents_open",
    {
      description: "Open a claxedo://document/... reference, exact id, or name as an honest canonical file path for this session.",
      inputSchema: DOCUMENT_TOOL_SCHEMAS.documents_open,
      _meta: { "io.claxedo/session-argument": "session_id" },
    },
    (input) => callDocuments(request, "documents_open", withDefaults(input, defaults)),
  )
}

export async function callDocuments(
  request: Request,
  tool: ToolName,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (tool === "documents_list") {
    const parsed = z.strictObject(DOCUMENT_TOOL_SCHEMAS.documents_list).parse(input)
    validateScope(parsed)
    const documents = await request<DocumentRow[]>(listPath(parsed, "active"), { method: "GET" })
    return text({ documents: documents.map(metadata) })
  }

  const parsed = z.strictObject(DOCUMENT_TOOL_SCHEMAS.documents_open).parse(input)
  validateScope(parsed)
  const sessionId = parsed.session_id
  if (!sessionId) {
    throw new DocumentToolError(
      400,
      "document_session_required",
      "session_id is required to grant a session-owned document path",
    )
  }
  const idOrName = documentReferenceId(parsed.id_or_name)
  const documents = await request<DocumentRow[]>(listPath(parsed, "all"), { method: "GET" })
  const exact = documents.find((document) => document.id === idOrName)
  const matches = exact
    ? [exact]
    : documents.filter(
        (document) => string(document.display_name)?.toLocaleLowerCase() === idOrName.toLocaleLowerCase(),
      )
  if (!matches.length)
    throw new DocumentToolError(404, "document_not_found", `Document '${idOrName}' was not found`)
  if (matches.length > 1)
    throw new DocumentToolError(
      409,
      "document_name_ambiguous",
      `More than one document is named '${idOrName}'`,
    )
  const document = matches[0]!
  if (document.archived_at)
    throw new DocumentToolError(410, "document_archived", `Document '${idOrName}' is archived`)
  const documentId = string(document.id)
  if (!documentId)
    throw new DocumentToolError(502, "document_metadata_invalid", "Document index returned an entry without an id")
  const opened = await request<{ document_id?: unknown; display_name?: unknown; path?: unknown }>(
    `/documents/${encodeURIComponent(documentId)}/agent-open`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    },
  )
  const canonicalPath = string(opened.path)
  if (!canonicalPath || !path.isAbsolute(canonicalPath)) {
    throw new DocumentToolError(
      502,
      "document_path_invalid",
      "Document service did not return a canonical absolute path",
    )
  }
  return text({
    document_id: string(opened.document_id) ?? documentId,
    display_name: string(opened.display_name) ?? string(document.display_name) ?? documentId,
    path: canonicalPath,
  })
}

function listPath(input: { project_id?: string; directory?: string }, archived: "active" | "all") {
  const query = new URLSearchParams()
  if (input.project_id) query.set("project_id", input.project_id)
  if (input.directory) query.set("directory", input.directory)
  query.set("archived", archived)
  return `/documents?${query}`
}

function validateScope(input: { project_id?: string; directory?: string }) {
  if (!input.project_id && !input.directory) {
    throw new DocumentToolError(400, "document_scope_required", "project_id or directory is required")
  }
  if (input.project_id && input.directory) {
    throw new DocumentToolError(400, "document_scope_ambiguous", "Use project_id or directory, not both")
  }
}

function withDefaults(input: Record<string, unknown>, defaults?: { directory?: string; sessionId?: string }) {
  return {
    ...input,
    ...(!input.project_id && !input.directory && defaults?.directory ? { directory: defaults.directory } : {}),
    ...(!input.session_id && defaults?.sessionId ? { session_id: defaults.sessionId } : {}),
  }
}

export function documentReferenceId(value: string) {
  const match = /^claxedo:\/\/document\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(value.trim())
  if (!match) return value.trim()
  return decodeURIComponent(match[1]!)
}

function metadata(document: DocumentRow) {
  return Object.fromEntries(metadataKeys.flatMap((key) => (key in document ? [[key, document[key]]] : [])))
}

function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}
