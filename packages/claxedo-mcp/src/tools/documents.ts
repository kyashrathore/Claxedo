/**
 * Claxedo documents, as an agent uses them: find the ones a project has, and
 * turn a `claxedo://document/...` reference into a real path this session may
 * open.
 *
 * The service is mounted on the self-hosted node and nowhere else today, so
 * every tool here has to answer a deployment that does not serve `/documents`
 * with a sentence rather than a stack trace.
 */
import path from "node:path"
import { z } from "zod"
import { claxedoDocumentReferenceId } from "@claxedo/helpers/claxedo-document"
import { record, records, text } from "../json"
import type { ClaxedoFetch } from "../client/contract"
import type { McpToolContext } from "../context"
import { mcpToolRefusal, type McpToolResult } from "../mcp-tool"
import type { ToolRegistry } from "./registry"
import { declaredToolAccess } from "./inventory"
import { toolJson, WORKSPACE_TARGET_SCHEMA } from "./target"

/** The index fields a caller can act on; the rest of a row is service bookkeeping. */
const METADATA_KEYS = [
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

const SCOPE_SCHEMA = {
  project: z.string().trim().min(1).optional().describe("Project whose documents to read."),
  directory: WORKSPACE_TARGET_SCHEMA.directory.describe("Local project directory, when the project id is not to hand. Defaults to this workspace's own."),
} as const

export function registerDocumentTools(registry: ToolRegistry) {
  registry.tool(
    "documents_list",
    {
      description: "List the active Claxedo documents of a project. Returns index metadata only, never document content.",
      inputSchema: { ...SCOPE_SCHEMA },
      access: declaredToolAccess({ audiences: ["runtime", "user"], write: false, scope: "read" }),
    },
    async (args, ctx) => answering(async () => {
      const scope = documentScope(ctx, args)
      if ("refusal" in scope) return scope.refusal
      const documents = await listDocuments(ctx, scope, "active")
      if ("refusal" in documents) return documents.refusal
      return toolJson({ documents: documents.rows.map(metadata) })
    }),
  )

  registry.tool(
    "documents_open",
    {
      description:
        "Resolve a claxedo://document/... reference, document id, or display name to a canonical absolute path this session may read and write.",
      inputSchema: {
        ...SCOPE_SCHEMA,
        document: z.string().trim().min(1).describe("A claxedo://document/... reference, an exact document id, or a display name."),
        session: z.string().trim().min(1).optional().describe("Session the path is granted to. A session's own credential always grants to itself."),
      },
      access: declaredToolAccess({ audiences: ["runtime", "user"], write: true, scope: "act" }),
      sessionIdFromHandler: true,
    },
    async (args, ctx, addressed) => answering(async () => {
      const sessionId = grantedSession(ctx, args.session)
      if (!sessionId) {
        return mcpToolRefusal("Opening a document grants a path to one session; name the session it is for.")
      }
      addressed?.(sessionId)
      const scope = documentScope(ctx, args)
      if ("refusal" in scope) return scope.refusal
      const documents = await listDocuments(ctx, scope, "all")
      if ("refusal" in documents) return documents.refusal

      const reference = claxedoDocumentReferenceId(args.document)
      const match = resolveDocument(documents.rows, reference)
      if ("refusal" in match) return match.refusal

      const opened = record(
        await documentsJson(ctx, `/documents/${encodeURIComponent(match.id)}/agent-open`, {
          method: "POST",
          body: { session_id: sessionId },
        }),
      )
      const canonical = text(opened?.path)
      if (!canonical || !path.isAbsolute(canonical)) {
        return mcpToolRefusal(`The documents service opened ${match.id} without a canonical absolute path.`)
      }
      return toolJson({
        document: text(opened?.document_id) ?? match.id,
        name: text(opened?.display_name) ?? text(match.row.display_name) ?? match.id,
        path: canonical,
        session: sessionId,
      })
    }),
  )
}

type DocumentScope = Readonly<{ project?: string; directory?: string }>

type Refusal = Readonly<{ refusal: McpToolResult }>

/**
 * A session's own credential grants only to itself: the path the service
 * returns is a per-session write grant, and letting the model name another
 * session would hand it one.
 */
function grantedSession(ctx: McpToolContext, requested: string | undefined): string | undefined {
  if (ctx.credential.kind === "runtime") return ctx.credential.sessionId
  return requested
}

function documentScope(ctx: McpToolContext, args: Readonly<{ project?: string; directory?: string }>): DocumentScope | Refusal {
  if (ctx.credential.kind === "runtime") {
    const directory = ctx.client.ownWorkspace?.directory
    if (!directory) return { refusal: mcpToolRefusal("The runtime's document workspace is unavailable.") }
    if (args.project || (args.directory && path.resolve(args.directory) !== path.resolve(directory))) {
      return { refusal: mcpToolRefusal("A runtime credential can access documents only in its own workspace directory.") }
    }
    return { directory }
  }
  if (args.project && args.directory) {
    return { refusal: mcpToolRefusal("Name a project or a directory, not both.") }
  }
  if (args.project) return { project: args.project }
  const directory = args.directory ?? ctx.client.ownWorkspace?.directory
  if (!directory) return { refusal: mcpToolRefusal("Name the project or the directory whose documents to read.") }
  return { directory }
}

async function listDocuments(ctx: McpToolContext, scope: DocumentScope, archived: "active" | "all"): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }> | Refusal> {
  const query = new URLSearchParams({ archived })
  if (scope.project) query.set("project_id", scope.project)
  if (scope.directory) query.set("directory", scope.directory)
  const listed = await documentsJson(ctx, `/documents?${query}`)
  if (!Array.isArray(listed)) {
    return { refusal: mcpToolRefusal("The documents index did not answer with a list of documents.") }
  }
  return { rows: records(listed) }
}

function resolveDocument(rows: readonly Record<string, unknown>[], reference: string): Readonly<{ id: string; row: Record<string, unknown> }> | Refusal {
  const exact = rows.find((row) => row.id === reference)
  const matches = exact
    ? [exact]
    : rows.filter((row) => text(row.display_name)?.toLocaleLowerCase() === reference.toLocaleLowerCase())
  if (matches.length === 0) return { refusal: mcpToolRefusal(`No document '${reference}' is in this project.`) }
  if (matches.length > 1) return { refusal: mcpToolRefusal(`More than one document is named '${reference}'; open it by id.`) }
  const row = matches[0]
  if (row.archived_at) return { refusal: mcpToolRefusal(`Document '${reference}' is archived.`) }
  const id = text(row.id)
  if (!id) return { refusal: mcpToolRefusal("The documents index answered with an entry that has no id.") }
  return { id, row }
}

function metadata(document: Record<string, unknown>) {
  return Object.fromEntries(METADATA_KEYS.flatMap((key) => (key in document ? [[key, document[key]]] : [])))
}

/** The deployment does not serve documents, or the service refused; either way the answer is a sentence. */
class DocumentsUnavailable extends Error {}

/** Turns that refusal into the tool's own answer instead of an exception the host renders as a crash. */
async function answering(handle: () => Promise<McpToolResult>): Promise<McpToolResult> {
  try {
    return await handle()
  } catch (error) {
    if (error instanceof DocumentsUnavailable) return mcpToolRefusal(error.message)
    throw error
  }
}

async function documentsJson(ctx: McpToolContext, requestPath: string, input: Readonly<{ method?: string; body?: unknown }> = {}) {
  const response = await documentsService(ctx)(requestPath, {
    method: input.method ?? "GET",
    ...(input.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.body) }),
  })
  if (response.status === 404 && !requestPath.startsWith("/documents/")) {
    throw new DocumentsUnavailable("This Claxedo deployment does not serve the documents service.")
  }
  if (!response.ok) {
    const body = record(await response.json().catch(() => undefined))
    throw new DocumentsUnavailable(text(record(body?.error)?.message) ?? text(body?.message) ?? `The documents service answered ${response.status}.`)
  }
  return await response.json()
}

function documentsService(ctx: McpToolContext): ClaxedoFetch {
  const { documents } = ctx.client
  if (!documents) throw new DocumentsUnavailable("This Claxedo deployment does not serve the documents service.")
  return documents
}
