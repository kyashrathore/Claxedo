import { Hono } from "hono"
import { z } from "zod"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "../authority/auth"
import {
  requireAuthority,
  type ProjectAction,
  type ProjectId,
  type WorkspaceAuthority,
} from "../authority/authority"
import type { ControlPlaneServices } from "../authority/services"
import { DocumentAgentOpenError, type DocumentChangedSink, type DocumentsBackend } from "../documents/backend"
import type { DocumentIndexEntry } from "../documents/index-store"
import { DocumentVersionConflictError, DocumentWorkspaceError } from "../documents/errors"
import type { DocumentHandle, DocumentVersion, SnapshotID } from "../documents/port"
import { createDocumentsService, DocumentsServiceError, type DocumentsServiceScope } from "../documents/service"
import { isLoopbackLocalRequest } from "./local-only-projection"

export { DocumentAgentOpenError } from "../documents/backend"
export type { DocumentsBackend as DocumentsRouteBackend } from "../documents/backend"

const LOCAL_ORG = "__local__"
const MAX_BODY_BYTES = 2 * 1024 * 1024

const CreateDocumentBody = z
  .object({
    project_id: z.string().min(1).optional(),
    directory: z.string().min(1).optional(),
    display_name: z.string().trim().min(1),
    markdown: z.string().optional().default(""),
    status: z.string().min(1).optional().default("draft"),
    session_id: z.string().min(1).nullable().optional().default(null),
  })
  .strict()

const FromRepositoryBody = z
  .object({
    project_id: z.string().min(1).optional(),
    directory: z.string().min(1).optional(),
    workspace_id: z.string().min(1),
    path: z.string().min(1),
    display_name: z.string().trim().min(1).optional(),
    status: z.string().min(1).optional().default("draft"),
    session_id: z.string().min(1).nullable().optional().default(null),
  })
  .strict()

const MetadataBody = z
  .object({
    display_name: z.string().trim().min(1).optional(),
    session_id: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine((input) => input.display_name !== undefined || input.session_id !== undefined)

const SessionBody = z.object({ session_id: z.string().min(1).nullable() }).strict()
const StatusBody = z.object({ status: z.string().min(1) }).strict()
const ContentBody = z
  .object({
    markdown: z.string(),
    display_name: z.string().trim().min(1).optional(),
  })
  .strict()
const EmptyBody = z.object({}).strict()
const AgentOpenBody = z.object({ session_id: z.string().trim().min(1) }).strict()
const RuntimeConflictResolveBody = z
  .object({
    session_id: z.string().trim().min(1),
    choice: z.enum(["durable", "draft"]),
  })
  .strict()
const RelocateBody = z.object({ path: z.string().min(1) }).strict()
const MoveToRepositoryBody = z
  .object({
    workspace_id: z.string().min(1),
    path: z.string().min(1),
  })
  .strict()
const GitCommitBody = z
  .object({
    message: z.string().trim().min(1),
    expected: z
      .object({
        baseCommit: z.string().min(1),
        baseBlobSha: z.string().min(1),
      })
      .strict(),
  })
  .strict()
const WorkSourceBody = z
  .object({
    target_stream_id: z.string().trim().min(1).optional(),
    directory: z.string().trim().min(1).optional(),
    repository_url: z.string().url().optional(),
  })
  .strict()
const WorkSourcePinBody = z
  .object({
    work_source_id: z.string().min(1),
    revision_id: z.string().min(1),
  })
  .strict()

export type DocumentsRouteOptions<H extends DocumentHandle = DocumentHandle> = Readonly<{
  backend?: DocumentsBackend<H>
  services?: ControlPlaneServices
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  authority?: WorkspaceAuthority
  documentChangedSink?: DocumentChangedSink
}>

type AuthenticatedScope = Readonly<{
  orgId: string
  projectId: string
  auth?: SignedControlPlaneAuth
}>

type DirectScope = AuthenticatedScope & Readonly<{ entry: DocumentIndexEntry }>

export function DocumentsRoutes<H extends DocumentHandle>(options: DocumentsRouteOptions<H> = {}) {
  const documents = () => createDocumentsService(requireBackend(options), {
    ...(options.documentChangedSink ? { documentChangedSink: options.documentChangedSink } : {}),
  })
  return new Hono()
    .onError((error) => errorResponse(error))
    .get("/statuses", async (context) => {
      const scope = await routeScope(context.req.raw, options, "read", {
        projectId: context.req.query("project_id"),
        directory: context.req.query("directory") ?? context.req.header("x-opencode-directory"),
      })
      return context.json(await documents().listStatuses(scope.projectId))
    })
    .get("/remote", async (context) => {
      const scope = await routeScope(context.req.raw, options, "read", { project_id: context.req.query("project_id") })
      if (!scope.auth) throw notFound()
      return context.json(
        await documents().remoteList({
          auth: scope.auth,
          orgId: scope.orgId,
          projectId: scope.projectId,
          localWorkspaceId: requiredQuery(context.req.query("local_workspace_id")),
          cloudWorkspaceId: requiredQuery(context.req.query("cloud_workspace_id")),
          sessionId: requiredQuery(context.req.query("session_id")),
        }),
      )
    })
    // NOTE: the document-scoped `/events` SSE (external-change watch lease + change
    // stream) was REMOVED. External-change detection is
    // retired; CAS-at-write (`if-match`) is the correctness floor, and the central
    // `document.changed` doorbell on the claxedoBus carries save notifications.
    .get("/", async (context) => {
      const scope = await routeScope(context.req.raw, options, "read", {
        projectId: context.req.query("project_id"),
        directory: context.req.query("directory") ?? context.req.header("x-opencode-directory"),
      })
      const archived = context.req.query("archived")
        ? queryAs(z.enum(["active", "archived", "all"]), context.req.query("archived"))
        : "active"
      const listed = await documents().listPage(scope, archived)
      // The body stays a plain array — that shape is the client contract. Truncation rides a header
      // so a project past the storage listing bound is never silently presented as complete.
      if (listed.truncated) context.header("x-claxedo-documents-truncated", "true")
      return context.json(listed.entries)
    })
    .post("/", async (context) => {
      const body = await bodyAs(context.req.raw, CreateDocumentBody)
      const scope = await routeScope(context.req.raw, options, "write", body)
      return context.json(
        await documents().create(serviceScope(scope), {
          displayName: body.display_name,
          markdown: body.markdown,
          status: body.status,
          sessionId: body.session_id,
        }),
        201,
      )
    })
    .post("/from-repo", async (context) => {
      const body = await bodyAs(context.req.raw, FromRepositoryBody)
      const scope = await routeScope(context.req.raw, options, "write", body)
      const result = await documents().createFromRepository(serviceScope(scope), {
        workspaceId: body.workspace_id,
        path: body.path,
        ...(body.display_name ? { displayName: body.display_name } : {}),
        status: body.status,
        sessionId: body.session_id,
      })
      return result.created ? context.json(result.entry, 201) : context.json(result.entry)
    })
    .get("/:id", async (context) => {
      const scope = await directScope(context.req.raw, options, "read", context.req.param("id"), true)
      requireBackend(options)
      return context.json(scope.entry)
    })
    .patch("/:id", async (context) => {
      const body = await bodyAs(context.req.raw, MetadataBody)
      const expectedVersion = body.display_name ? requiredVersion(context.req.header("if-match")) : undefined
      const scope = await directScope(context.req.raw, options, "write", context.req.param("id"))
      return context.json(await documents().updateMetadata(serviceScope(scope), scope.entry.id, body, expectedVersion))
    })
    .patch("/:id/session", async (context) => {
      const body = await bodyAs(context.req.raw, SessionBody)
      const scope = await directScope(context.req.raw, options, "write", context.req.param("id"))
      return context.json(await documents().updateSession(serviceScope(scope), scope.entry.id, body.session_id))
    })
    .post("/:id/status", async (context) => {
      const body = await bodyAs(context.req.raw, StatusBody)
      const scope = await directScope(context.req.raw, options, "write", context.req.param("id"))
      return context.json(await documents().transitionStatus(serviceScope(scope), scope.entry.id, body.status))
    })
    .post("/:id/archive", async (context) => {
      await optionalEmptyBody(context.req.raw)
      const scope = await directScope(context.req.raw, options, "admin", context.req.param("id"), true)
      return context.json(await documents().archive(serviceScope(scope), scope.entry.id))
    })
    .post("/:id/restore", async (context) => {
      await optionalEmptyBody(context.req.raw)
      const scope = await directScope(context.req.raw, options, "admin", context.req.param("id"), true)
      return context.json(await documents().restoreIndex(serviceScope(scope), scope.entry.id))
    })
    .get("/:id/availability", async (context) => {
      const scope = await directScope(context.req.raw, options, "read", context.req.param("id"), true)
      return context.json(await documents().availability(serviceScope(scope), scope.entry.id))
    })
    .post("/:id/relocate", async (context) => {
      const body = await bodyAs(context.req.raw, RelocateBody)
      const expectedVersion = requiredVersion(context.req.header("if-match"))
      const scope = await directScope(context.req.raw, options, "write", context.req.param("id"), true)
      return context.json(await documents().relocate(serviceScope(scope), scope.entry.id, body.path, expectedVersion))
    })
    .post("/:id/move-to-repository", async (context) => {
      const body = await bodyAs(context.req.raw, MoveToRepositoryBody)
      const scope = await directScope(context.req.raw, options, "write", context.req.param("id"), true)
      return context.json(
        await documents().moveToRepository(serviceScope(scope), scope.entry.id, {
          workspaceId: body.workspace_id,
          relativePath: body.path,
        }),
      )
    })
    .get("/:id/git/snapshot", async (context) => {
      const scope = await directScope(context.req.raw, options, "read", context.req.param("id"))
      return context.json(await documents().gitSnapshot(serviceScope(scope), scope.entry.id))
    })
    .post("/:id/git/commit", async (context) => {
      const body = await bodyAs(context.req.raw, GitCommitBody)
      const scope = await directScope(context.req.raw, options, "write", context.req.param("id"))
      return context.json(await documents().gitCommit(serviceScope(scope), scope.entry.id, body))
    })
    .post("/:id/agent-open", async (context) => {
      const body = await bodyAs(context.req.raw, AgentOpenBody)
      const authenticated = await authenticate(context.req.raw, options)
      const entry = await documents().findAgentEntry(authenticated.orgId, context.req.param("id"), authenticated.auth)
      if (authenticated.auth)
        await authorize(options, authenticated.auth, authenticated.orgId, entry.project_id, "write")
      const opened = await documents().agentOpen(entry, body.session_id, {
        ...(authenticated.auth ? { auth: authenticated.auth } : {}),
        origin: new URL(context.req.url).origin,
      })
      return context.json({
        document_id: entry.id,
        display_name: entry.display_name,
        path: opened.path,
      })
    })
    .put("/:id/runtime-writeback", async (context) => {
      const orgId = requiredQuery(context.req.query("org_id"))
      const projectId = requiredQuery(context.req.query("project_id"))
      const workspaceId = requiredQuery(context.req.query("workspace_id"))
      const sessionId = requiredQuery(context.req.query("session_id"))
      const token = context.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
      if (!token) throw new DocumentHttpError(401, "missing_bearer_token", "Document Session Token is required")
      const body = await bodyAs(context.req.raw, ContentBody)
      const expectedVersion = requiredVersion(context.req.header("if-match"))
      return context.json(
        await documents().runtimeWriteback(context.req.param("id"), {
          token,
          orgId,
          projectId,
          workspaceId,
          sessionId,
          markdown: body.markdown,
          expectedVersion,
        }),
      )
    })
    .post("/:id/runtime-capability/renew", async (context) => {
      const orgId = requiredQuery(context.req.query("org_id"))
      const projectId = requiredQuery(context.req.query("project_id"))
      const workspaceId = requiredQuery(context.req.query("workspace_id"))
      const sessionId = requiredQuery(context.req.query("session_id"))
      const token = context.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
      if (!token) throw new DocumentHttpError(401, "missing_bearer_token", "Document Session Token is required")
      return context.json(
        await documents().runtimeRenew(context.req.param("id"), {
          token,
          orgId,
          projectId,
          workspaceId,
          sessionId,
        }),
      )
    })
    .post("/:id/runtime-conflict/resolve", async (context) => {
      const body = await bodyAs(context.req.raw, RuntimeConflictResolveBody)
      const authenticated = await authenticate(context.req.raw, options)
      if (!authenticated.auth)
        throw new DocumentHttpError(401, "missing_bearer_token", "Signed authentication is required")
      const entry = await documents().findRuntimeConflictEntry(
        authenticated.orgId,
        context.req.param("id"),
        authenticated.auth,
      )
      await authorize(options, authenticated.auth, authenticated.orgId, entry.project_id, "write")
      return context.json(
        await documents().runtimeResolve(entry, {
          auth: authenticated.auth,
          sessionId: body.session_id,
          choice: body.choice,
        }),
      )
    })
    .delete("/:id/runtime-job", async (context) => {
      const orgId = requiredQuery(context.req.query("org_id"))
      const projectId = requiredQuery(context.req.query("project_id"))
      const workspaceId = requiredQuery(context.req.query("workspace_id"))
      const sessionId = requiredQuery(context.req.query("session_id"))
      const token = context.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
      if (!token) throw new DocumentHttpError(401, "missing_bearer_token", "Document Session Token is required")
      await documents().runtimeDispose(context.req.param("id"), {
        token,
        orgId,
        projectId,
        workspaceId,
        sessionId,
      })
      return context.body(null, 204)
    })
    .get("/:id/content", async (context) => {
      const scope = await directScope(context.req.raw, options, "read", context.req.param("id"))
      return context.json(await documents().readContent(serviceScope(scope), scope.entry.id))
    })
    .post("/:id/work-source", async (context) => {
      const body = await bodyAs(context.req.raw, WorkSourceBody)
      const scope = await directScope(context.req.raw, options, "read", context.req.param("id"))
      return context.json(
        await documents().workSource(serviceScope(scope), scope.entry.id, {
          ...(body.target_stream_id ? { targetStreamId: body.target_stream_id } : {}),
          ...(body.directory ? { directory: body.directory } : {}),
          ...(body.repository_url ? { repositoryUrl: body.repository_url } : {}),
        }),
      )
    })
    .post("/:id/snapshots/:snapshotId/work-source-pin", async (context) => {
      const body = await bodyAs(context.req.raw, WorkSourcePinBody)
      const scope = await directScope(context.req.raw, options, "write", context.req.param("id"))
      return context.json(
        await documents().pinWorkSource(
          serviceScope(scope),
          scope.entry.id,
          context.req.param("snapshotId") as SnapshotID,
          { workSourceId: body.work_source_id, revisionId: body.revision_id },
        ),
      )
    })
    .put("/:id/content", async (context) => {
      const expectedVersion = requiredVersion(context.req.header("if-match"))
      const body = await bodyAs(context.req.raw, ContentBody)
      const scope = await directScope(context.req.raw, options, "write", context.req.param("id"))
      return context.json(
        await documents().writeContent(serviceScope(scope), scope.entry.id, {
          markdown: body.markdown,
          expectedVersion,
          ...(body.display_name ? { displayName: body.display_name } : {}),
        }),
      )
    })
    .get("/:id/snapshots", async (context) => {
      const scope = await directScope(context.req.raw, options, "read", context.req.param("id"))
      return context.json(await documents().listSnapshots(serviceScope(scope), scope.entry.id))
    })
    .post("/:id/snapshots/:snapshotId/restore", async (context) => {
      const expectedVersion = requiredVersion(context.req.header("if-match"))
      await optionalEmptyBody(context.req.raw)
      const scope = await directScope(context.req.raw, options, "write", context.req.param("id"))
      return context.json(
        await documents().restoreSnapshot(
          serviceScope(scope),
          scope.entry.id,
          context.req.param("snapshotId") as SnapshotID,
          expectedVersion,
        ),
      )
    })
    .get("/:id/export", async (context) => {
      const scope = await directScope(context.req.raw, options, "read", context.req.param("id"))
      const read = await documents().exportContent(serviceScope(scope), scope.entry.id)
      return new Response(read.markdown, {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="${scope.entry.id}.md"`,
        },
      })
    })
}

async function routeScope<H extends DocumentHandle>(
  request: Request,
  options: DocumentsRouteOptions<H>,
  action: ProjectAction,
  input: { projectId?: string; project_id?: string; directory?: string },
): Promise<AuthenticatedScope> {
  const auth = await authenticate(request, options)
  const explicitProject = input.projectId ?? input.project_id
  const projectId = auth.auth
    ? explicitProject
    : input.directory
      ? await requireBackend(options).index.resolveLocalProjectId(input.directory)
      : explicitProject
  if (!projectId) throw new DocumentHttpError(400, "document_project_required", "project_id or directory is required")
  if (!auth.auth) return { ...auth, projectId }
  await authorize(options, auth.auth, auth.orgId, projectId, action)
  return { ...auth, projectId }
}

async function directScope<H extends DocumentHandle>(
  request: Request,
  options: DocumentsRouteOptions<H>,
  action: ProjectAction,
  documentId: string,
  includeArchived = false,
): Promise<DirectScope> {
  const auth = await authenticate(request, options)
  const entry = await requireBackend(options).index.find(auth.orgId, documentId)
  if (!entry || (!includeArchived && entry.archived_at)) throw notFound()
  if (auth.auth) await authorize(options, auth.auth, auth.orgId, entry.project_id, action)
  return { ...auth, projectId: entry.project_id, entry }
}

async function authenticate<H extends DocumentHandle>(request: Request, options: DocumentsRouteOptions<H>) {
  if (isLoopbackLocalRequest(request)) return { orgId: LOCAL_ORG }
  const auth = await controlPlaneAuthContext(request, {
    ...(options.authConfig ? { config: options.authConfig } : {}),
    ...(options.verifier ? { verifier: options.verifier } : {}),
  })
  if (auth.mode !== "signed") {
    throw new ControlPlaneAuthError(401, "missing_bearer_token", "Signed Control Plane auth is required")
  }
  const authority = routeAuthority(options)
  await authority.usersMe(auth)
  return { orgId: await authority.resolveOrgId(auth), auth }
}

async function authorize<H extends DocumentHandle>(
  options: DocumentsRouteOptions<H>,
  auth: SignedControlPlaneAuth,
  orgId: string,
  projectId: string,
  action: ProjectAction,
) {
  const result = await routeAuthority(options).authorizeProject(auth, {
    orgId: orgId as never,
    projectId: projectId as ProjectId,
    action,
  })
  if (!result.ok) throw notFound()
}

function routeAuthority<H extends DocumentHandle>(options: DocumentsRouteOptions<H>) {
  return options.authority ?? requireAuthority(options.services)
}

function requireBackend<H extends DocumentHandle>(options: DocumentsRouteOptions<H>) {
  if (!options.backend) {
    throw new DocumentHttpError(
      503,
      "document_backend_unavailable",
      "Document storage is not configured for this placement",
    )
  }
  return options.backend
}

async function bodyAs<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  const raw = await cappedBody(request)
  try {
    return schema.parse(JSON.parse(new TextDecoder().decode(raw)))
  } catch (error) {
    if (error instanceof DocumentHttpError) throw error
    throw new DocumentHttpError(400, "document_invalid_body", "Request body does not match the document API schema")
  }
}

async function optionalEmptyBody(request: Request) {
  if (!request.body) return
  const raw = await cappedBody(request)
  if (!raw.byteLength) return
  try {
    EmptyBody.parse(JSON.parse(new TextDecoder().decode(raw)))
  } catch {
    throw new DocumentHttpError(400, "document_invalid_body", "Expected an empty JSON object")
  }
}

async function cappedBody(request: Request) {
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw bodyTooLarge()
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      throw bodyTooLarge()
    }
    chunks.push(chunk.value)
  }
  const raw = new Uint8Array(size)
  let offset = 0
  chunks.forEach((chunk) => {
    raw.set(chunk, offset)
    offset += chunk.byteLength
  })
  return raw
}

function requiredVersion(value: string | undefined) {
  if (!value) throw new DocumentHttpError(428, "document_version_required", "If-Match is required")
  return value as DocumentVersion
}

function requiredQuery(value?: string) {
  if (!value?.trim()) throw new DocumentHttpError(400, "document_invalid_body", "Required document scope is missing")
  return value.trim()
}

function queryAs<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value)
  if (!result.success) throw new DocumentHttpError(400, "document_invalid_query", "Invalid document query parameter")
  return result.data
}

function bodyTooLarge() {
  return new DocumentHttpError(413, "document_body_too_large", `Request bodies are limited to ${MAX_BODY_BYTES} bytes`)
}

function serviceScope(scope: AuthenticatedScope): DocumentsServiceScope {
  return {
    orgId: scope.orgId,
    projectId: scope.projectId,
    actor: { type: "user", id: scope.auth?.user.subject ?? "local_user" },
  }
}

class DocumentHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "DocumentHttpError"
  }
}

function notFound() {
  return new DocumentHttpError(404, "document_not_found", "Document not found")
}

function errorResponse(error: unknown) {
  if (error instanceof ControlPlaneAuthError) {
    return Response.json(controlPlaneAuthErrorBody(error), { status: error.status })
  }
  if (error instanceof DocumentVersionConflictError) {
    return Response.json(
      {
        error: { code: error.code, message: error.message },
        currentVersion: error.currentVersion,
      },
      { status: 409 },
    )
  }
  if (error instanceof DocumentHttpError) {
    return Response.json(
      { error: { code: error.code, message: error.message }, ...error.details },
      { status: error.status },
    )
  }
  if (error instanceof DocumentsServiceError) {
    const status =
      error.code === "document_not_found"
        ? 404
        : error.code === "document_capability_denied" || error.code === "document_conflict_resolution_denied"
          ? 403
          : error.code === "document_snapshot_corrupt"
            ? 500
            : 409
    return Response.json({ error: { code: error.code, message: error.message }, ...error.details }, { status })
  }
  if (error instanceof DocumentAgentOpenError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
  }
  if (error instanceof DocumentWorkspaceError) {
    const status =
      error.code === "document_not_found"
        ? 404
        : error.code === "document_snapshot_not_found"
          ? 404
          : error.code === "document_already_exists"
            ? 409
            : error.code === "document_not_text"
              ? 415
              : error.code === "document_too_large"
                ? 413
                : error.code === "document_invalid_entry" || error.code === "document_path_outside_root"
                  ? 422
                  : error.code === "document_permission_denied"
                    ? 403
                    : 500
    return Response.json({ error: { code: error.code, message: error.message } }, { status })
  }
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    const status =
      error.code === "document_index_not_found"
        ? 404
        : error.code === "git_source_conflict" || error.code === "document_workspace_unavailable"
          ? 409
          : error.code === "document_status_not_found" || error.code === "document_status_transition_not_allowed"
            ? 422
            : 500
    return Response.json(
      {
        error: { code: error.code, message: error instanceof Error ? error.message : "Document request failed" },
        ...("evidence" in error ? { evidence: error.evidence } : {}),
        ...("state" in error ? { state: error.state } : {}),
      },
      { status },
    )
  }
  throw error
}
