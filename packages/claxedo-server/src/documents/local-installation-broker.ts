import { Hono, type Context } from "hono"
import { timingSafeEqualStrings } from "../authority/web-crypto"
import { withDocumentOperation, type DocumentsBackend } from "./backend"
import type { DocumentIndexEntry } from "./index-store"
import type { DocumentVersion } from "./port"
import { DocumentVersionConflictError } from "./errors"
import { verifyDocumentRelayJobToken } from "../authority/runtime-access-token"

const MAX_BROKER_BODY_BYTES = 2 * 1024 * 1024 + 64 * 1024

export function LocalInstallationDocumentBroker(options: {
  backend: DocumentsBackend
  installationToken?: string
  env?: NodeJS.ProcessEnv
  jobState?: ReturnType<typeof createLocalDocumentJobState>
}) {
  const jobs = options.jobState ?? createLocalDocumentJobState()
  const app = new Hono()
  app.use("*", async (context, next) => {
    const token = context.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
    if (
      !options.installationToken ||
      !token ||
      !timingSafeEqualStrings(token, options.installationToken) ||
      context.req.header("x-claxedo-document-broker") !== "1"
    )
      return context.json({ error: "unauthorized" }, 401)
    await next()
  })
  app.post("/jobs/activate", async (context) => {
    jobs.prune()
    const verified = await verifyJob(context, options.env)
    if (!verified) return context.json({ error: "document_capability_denied" }, 403)
    if (!jobs.activate(verified.jti, verified.jobExpiresAt))
      return context.json({ error: "document_capability_revoked" }, 403)
    return context.json({ active: true })
  })
  app.post("/jobs/revoke", async (context) => {
    jobs.prune()
    const verified = await verifyJob(context, options.env)
    if (!verified) return context.json({ error: "document_capability_denied" }, 403)
    jobs.revoke(verified.jti, verified.jobExpiresAt)
    return context.json({ revoked: true })
  })
  app.get("/index", async (context) => {
    if (!(await requireActiveJob(context, jobs, options.env)))
      return context.json({ error: "document_capability_denied" }, 403)
    const orgId = required(context.req.query("org_id"))
    const projectId = required(context.req.query("project_id"))
    return context.json(
      (await options.backend.index.list({ orgId: "__local__", projectId })).map((entry) => ({
        ...entry,
        org_id: orgId,
      })),
    )
  })
  app.get("/:id", async (context) => {
    if (!(await requireActiveJob(context, jobs, options.env)))
      return context.json({ error: "document_capability_denied" }, 403)
    const entry = await entryFor(options.backend, context)
    if (!entry) return context.json({ error: "not_found" }, 404)
    const read = await options.backend.workspace.read(await options.backend.workspace.resolve(portEntry(entry)))
    return context.json({ entry: { ...entry, org_id: required(context.req.query("org_id")) }, read })
  })
  app.put("/:id", async (context) => {
    if (!(await requireActiveJob(context, jobs, options.env)))
      return context.json({ error: "document_capability_denied" }, 403)
    const body = await readBrokerBody(context.req.raw).catch((error) =>
      error instanceof BrokerBodyTooLargeError
        ? context.json({ error: "document_body_too_large" }, 413)
        : context.json({ error: "invalid" }, 400),
    )
    if (body instanceof Response) return body
    if (typeof body.markdown !== "string" || typeof body.sessionId !== "string")
      return context.json({ error: "invalid" }, 400)
    const markdown = body.markdown
    const sessionId = body.sessionId
    const expected = context.req.header("if-match")
    if (!expected) return context.json({ error: "version_required" }, 428)
    return await withDocumentOperation(options.backend, context.req.param("id"), async () => {
      const entry = await entryFor(options.backend, context)
      if (!entry) return context.json({ error: "not_found" }, 404)
      if (entry.archived_at) return context.json({ error: "archived" }, 409)
      const written = await options.backend.workspace
        .write(await options.backend.workspace.resolve(portEntry(entry)), {
          markdown,
          expectedVersion: expected as DocumentVersion,
          actor: { type: "agent", id: sessionId },
          sessionId,
        })
        .catch((error) => {
          if (error instanceof DocumentVersionConflictError) {
            return context.json({ error: "document_version_conflict", currentVersion: error.currentVersion }, 409)
          }
          throw error
        })
      if (written instanceof Response) return written
      await options.backend.index.update({ orgId: entry.org_id, projectId: entry.project_id }, entry.id, {
        last_known_file_version: written.version,
      })
      return context.json(written)
    })
  })
  return app
}

async function readBrokerBody(request: Request) {
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_BROKER_BODY_BYTES) throw new BrokerBodyTooLargeError()
  if (!request.body) throw new Error("Document broker body is required")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    total += chunk.value.byteLength
    if (total > MAX_BROKER_BODY_BYTES) {
      await reader.cancel()
      throw new BrokerBodyTooLargeError()
    }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  })
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
    markdown?: unknown
    sessionId?: unknown
  }
}

class BrokerBodyTooLargeError extends Error {}

async function requireActiveJob(
  context: Context,
  jobs: ReturnType<typeof createLocalDocumentJobState>,
  env?: NodeJS.ProcessEnv,
) {
  const verified = await verifyJob(context, env)
  return Boolean(verified && jobs.active(verified.jti, verified.jobExpiresAt))
}

export function createLocalDocumentJobState(options: { now?: () => number; maxRevoked?: number } = {}) {
  const active = new Map<string, number>()
  const revoked = new Map<string, number>()
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const prune = () => {
    for (const [jti, expiresAt] of active) if (expiresAt <= now()) active.delete(jti)
    for (const [jti, expiresAt] of revoked) if (expiresAt <= now()) revoked.delete(jti)
  }
  return {
    prune,
    activate(jti: string, expiresAt: number) {
      prune()
      if (revoked.has(jti) || expiresAt <= now()) return false
      if (!active.has(jti) && active.size + revoked.size >= (options.maxRevoked ?? 10_000)) return false
      active.set(jti, expiresAt)
      return true
    },
    revoke(jti: string, expiresAt: number) {
      prune()
      if (!active.has(jti) && !revoked.has(jti) && active.size + revoked.size >= (options.maxRevoked ?? 10_000))
        return false
      active.delete(jti)
      if (expiresAt > now()) revoked.set(jti, expiresAt)
      prune()
      return true
    },
    active(jti: string, expiresAt: number) {
      prune()
      return !revoked.has(jti) && active.get(jti) === expiresAt && expiresAt > now()
    },
    size() {
      prune()
      return { active: active.size, revoked: revoked.size }
    },
  }
}

async function verifyJob(context: Context, env?: NodeJS.ProcessEnv) {
  const token = context.req.header("x-claxedo-document-capability")
  const userId = context.req.header("x-claxedo-document-user")
  const localWorkspaceId = context.req.header("x-claxedo-local-workspace")
  const cloudWorkspaceId = context.req.header("x-claxedo-cloud-workspace")
  const sessionId = context.req.header("x-claxedo-document-session")
  const operation = context.req.header("x-claxedo-document-operation")
  const orgId = context.req.query("org_id")
  const projectId = context.req.query("project_id")
  const routeDocumentId = context.req.param("id")
  const claimedDocumentId = context.req.header("x-claxedo-document-id")
  if (routeDocumentId && claimedDocumentId && claimedDocumentId !== routeDocumentId) return undefined
  const documentId = routeDocumentId || claimedDocumentId || "*"
  if (
    !token ||
    !userId ||
    !localWorkspaceId ||
    !cloudWorkspaceId ||
    !sessionId ||
    !orgId ||
    !projectId ||
    (operation !== "read" && operation !== "write" && operation !== "resolve")
  )
    return undefined
  return await verifyDocumentRelayJobToken(
    token,
    {
      userId,
      orgId,
      projectId,
      localWorkspaceId,
      cloudWorkspaceId,
      sessionId,
      documentId,
      operation,
    },
    env,
  ).catch(() => undefined)
}

async function entryFor(backend: DocumentsBackend, context: Context) {
  const orgId = required(context.req.query("org_id"))
  const projectId = required(context.req.query("project_id"))
  const entry = await backend.index.find("__local__", context.req.param("id"))
  return entry?.project_id === projectId ? entry : undefined
}

function required(value?: string) {
  if (!value?.trim()) throw new Error("Document broker scope is required")
  return value.trim()
}

function portEntry(entry: DocumentIndexEntry) {
  if (entry.origin_kind === "managed")
    return {
      origin: "managed" as const,
      placement: "local" as const,
      orgId: entry.org_id,
      projectId: entry.project_id,
      documentId: entry.id,
      relativePath: entry.managed_relative_path,
    }
  return {
    origin: "repository" as const,
    placement: "local" as const,
    orgId: entry.org_id,
    projectId: entry.project_id,
    documentId: entry.id,
    workspaceId: entry.workspace_id,
    relativePath: entry.repository_relative_path,
  }
}
