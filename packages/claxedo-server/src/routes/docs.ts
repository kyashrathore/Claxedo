import { Hono } from "hono"
import { z } from "zod"
import { DocumentStoreError, type DocumentAuthor, type DocumentScope, type DocumentStore } from "../document-store"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "../control-plane/auth"
import {
  requireAuthority,
  type OrgId,
  type ProjectAction,
  type ProjectId,
  type WorkspaceAuthority,
} from "../control-plane/authority"
import type { ControlPlaneServices } from "../control-plane/services"
import { isLoopbackLocalRequest } from "./local-only-projection"

const LOCAL_ORG = "__local__"
const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/i)
const AuthorSchema = z.strictObject({
  type: z.enum(["user", "agent", "system"]),
  id: z.string().trim().min(1),
})
const RevisionContentSchema = z.strictObject({
  title: z.string().trim().min(1),
  markdown: z.string().refine((value) => value.trim().length > 0),
  contentHash: ContentHashSchema,
  authoredBy: AuthorSchema,
})
const AppendRevisionSchema = RevisionContentSchema.extend({
  expectedParentRevisionId: z.string().trim().min(1),
})

export type DocsRouteOptions = {
  store: (auth?: SignedControlPlaneAuth) => DocumentStore
  services?: ControlPlaneServices
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  authority?: WorkspaceAuthority
}

type AuthorizedDocumentScope = DocumentScope & { auth?: SignedControlPlaneAuth }

export function DocsRoutes(options: DocsRouteOptions) {
  return new Hono()
    .onError((error) => {
      if (error instanceof ControlPlaneAuthError) {
        return Response.json(controlPlaneAuthErrorBody(error), { status: error.status })
      }
      if (error instanceof DocumentStoreError) {
        if (error.code === "document_revision_conflict") {
          return Response.json(
            {
              error: {
                code: error.code,
                message: error.message,
                currentRevisionId: error.currentRevisionId,
              },
            },
            { status: 409 },
          )
        }
        if (error.code === "document_content_hash_mismatch") {
          return documentError("document_content_hash_mismatch", error.message, 422)
        }
        return notFound()
      }
      throw error
    })
    .get("/", async (c) => {
      const projectId = c.req.query("project_id")?.trim()
      if (!projectId) return documentError("document_project_required", "project_id is required", 400)
      const scope = await authorizeProject(c.req.raw, options, projectId, "read")
      if (scope instanceof Response) return scope
      return c.json({ documents: await options.store(scope.auth).list(scope) })
    })
    .post("/", async (c) => {
      const projectId = c.req.query("project_id")?.trim()
      if (!projectId) return documentError("document_project_required", "project_id is required", 400)
      const scope = await authorizeProject(c.req.raw, options, projectId, "write")
      if (scope instanceof Response) return scope
      const parsed = RevisionContentSchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return documentError("document_invalid_request", parsed.error.message, 400)
      const authorError = authorizeAuthor(scope.auth, parsed.data.authoredBy)
      if (authorError) return authorError
      const hashError = await validateHash(parsed.data.markdown, parsed.data.contentHash)
      if (hashError) return hashError
      return c.json(
        await options.store(scope.auth).create({
          scope,
          title: parsed.data.title,
          markdown: parsed.data.markdown,
          contentHash: parsed.data.contentHash.toLowerCase(),
          authoredBy: parsed.data.authoredBy,
          authoredAt: Date.now(),
        }),
        201,
      )
    })
    .post("/:documentId/revisions", async (c) => {
      const scope = await authorizeDocument(
        c.req.raw,
        options,
        c.req.param("documentId"),
        c.req.query("project_id"),
        "write",
      )
      if (scope instanceof Response) return scope
      const parsed = AppendRevisionSchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return documentError("document_invalid_request", parsed.error.message, 400)
      const authorError = authorizeAuthor(scope.auth, parsed.data.authoredBy)
      if (authorError) return authorError
      const hashError = await validateHash(parsed.data.markdown, parsed.data.contentHash)
      if (hashError) return hashError
      return c.json(
        await options.store(scope.auth).appendRevision({
          scope,
          documentId: c.req.param("documentId"),
          expectedParentRevisionId: parsed.data.expectedParentRevisionId,
          title: parsed.data.title,
          markdown: parsed.data.markdown,
          contentHash: parsed.data.contentHash.toLowerCase(),
          authoredBy: parsed.data.authoredBy,
          authoredAt: Date.now(),
        }),
        201,
      )
    })
    .get("/:documentId/revisions/:revisionId", async (c) => {
      const scope = await authorizeDocument(
        c.req.raw,
        options,
        c.req.param("documentId"),
        c.req.query("project_id"),
        "read",
      )
      if (scope instanceof Response) return scope
      const revision = await options
        .store(scope.auth)
        .getRevision(scope, c.req.param("documentId"), c.req.param("revisionId"))
      if (!revision) return notFound()
      return c.json(revision)
    })
    .get("/:documentId", async (c) => {
      const scope = await authorizeDocument(
        c.req.raw,
        options,
        c.req.param("documentId"),
        c.req.query("project_id"),
        "read",
      )
      if (scope instanceof Response) return scope
      const revision = await options.store(scope.auth).getHeadRevision(scope, c.req.param("documentId"))
      if (!revision) return notFound()
      return c.json(revision)
    })
}

async function authorizeProject(
  request: Request,
  options: DocsRouteOptions,
  projectId: string,
  action: ProjectAction,
): Promise<AuthorizedDocumentScope | Response> {
  if (isLoopbackLocalRequest(request)) return { orgId: LOCAL_ORG, projectId }
  const auth = await signedAuth(request, options)
  const authority = options.authority ?? requireAuthority(options.services)
  await authority.usersMe(auth)
  const orgId = await authority.resolveOrgId(auth)
  const authorization = await authority.authorizeProject(auth, {
    orgId,
    projectId: projectId as ProjectId,
    action,
  })
  if (!authorization.ok) return notFound()
  return { orgId: authorization.orgId, projectId, auth }
}

async function authorizeDocument(
  request: Request,
  options: DocsRouteOptions,
  documentId: string,
  requestedProjectId: string | undefined,
  action: ProjectAction,
): Promise<AuthorizedDocumentScope | Response> {
  if (isLoopbackLocalRequest(request)) {
    const document = await options.store().find({ orgId: LOCAL_ORG }, documentId)
    if (!document || (requestedProjectId && requestedProjectId !== document.projectId)) return notFound()
    return { orgId: LOCAL_ORG, projectId: document.projectId }
  }
  const auth = await signedAuth(request, options)
  const authority = options.authority ?? requireAuthority(options.services)
  await authority.usersMe(auth)
  const orgId = await authority.resolveOrgId(auth)
  const document = await options.store(auth).find({ orgId }, documentId)
  if (!document || (requestedProjectId && requestedProjectId !== document.projectId)) return notFound()
  const authorization = await authority.authorizeProject(auth, {
    orgId: orgId as OrgId,
    projectId: document.projectId as ProjectId,
    action,
  })
  if (!authorization.ok) return notFound()
  return { orgId: authorization.orgId, projectId: document.projectId, auth }
}

async function signedAuth(request: Request, options: DocsRouteOptions) {
  const auth = await controlPlaneAuthContext(request, {
    ...(options.authConfig ? { config: options.authConfig } : {}),
    ...(options.verifier ? { verifier: options.verifier } : {}),
  })
  if (auth.mode !== "signed") {
    throw new ControlPlaneAuthError(401, "missing_bearer_token", "Signed Control Plane auth is required")
  }
  return auth
}

function authorizeAuthor(auth: SignedControlPlaneAuth | undefined, author: DocumentAuthor) {
  if (!auth) return
  if (author.type === "user" && author.id === auth.user.subject) return
  return documentError(
    "document_author_forbidden",
    "Signed document writes must use the authenticated user as author",
    403,
  )
}

async function validateHash(markdown: string, declaredHash: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(markdown))
  const actualHash = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  if (actualHash === declaredHash.toLowerCase()) return
  return documentError("document_content_hash_mismatch", "Document content does not match its declared hash", 422)
}

function notFound() {
  return documentError("document_not_found", "Document revision not found", 404)
}

function documentError(code: string, message: string, status: 400 | 403 | 404 | 422) {
  return Response.json({ error: { code, message } }, { status })
}
