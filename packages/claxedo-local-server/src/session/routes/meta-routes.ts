import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { nonEmptyString } from "@claxedo/helpers/guards"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import { controlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  listSessionMetas,
  parseSessionMeta,
  putSessionMeta,
  sessionMeta,
  type SessionMeta,
} from "@claxedo/server-core/session/meta/index"
import { parseSessionListQuery } from "@claxedo/server-core/session/navigation-list"
import { writeSessionReader } from "@claxedo/server-core/session/meta/reads"
import { sessionReaderWrite, type SessionReaderAction } from "@claxedo/server-core/session/reader"
import { LOCAL_USER_ID } from "@claxedo/server-core/platform/auth/local-identity"
import { getProjectWorkspace, listWorkspaces, resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { workspaceIdFromWorkspaceRef } from "@claxedo/server-core/workspace/refs"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { asRecord } from "@claxedo/helpers/guards"
import { localSessionListPage, signedSessionListPage } from "../list/session-list-page"
import { readMountedEmbeddedWorkspaceRuntime } from "../../deployments/local/embedded-workspace-runtime"

type Options = {
  services?: ControlPlaneServicesContract
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  refreshSessionProjection?: (workspace: Workspace) => Promise<void>
}

async function workspace(c: {
  req: {
    query: (k: string) => string | undefined
    header: (k: string) => string | undefined
  }
}) {
  const projectId = c.req.query("projectId")
  const directoryHeader = c.req.header("x-claxedo-directory")
  const headerWorkspaceId = workspaceIdFromWorkspaceRef(directoryHeader)
  const workspaceId = c.req.query("workspaceId") ??
    c.req.query("workspace") ??
    c.req.header("x-workspace-id") ??
    headerWorkspaceId
  const hit = await resolveWorkspace({
    workspaceId,
    directory: c.req.query("directory") || (headerWorkspaceId ? undefined : directoryHeader),
  })
  if (workspaceId !== undefined && !hit) {
    throw new HTTPException(404, { message: "Local workspace not found" })
  }
  if (hit) return hit
  return projectId ? await getProjectWorkspace(projectId) : undefined
}

async function routeAuth(request: Request, options: Options) {
  const config = options.authConfig ?? controlPlaneAuthConfig()
  if (!config.enabled && config.mode === "local-only" && !bearerToken(request.headers.get("authorization"))) return undefined
  const context = await controlPlaneAuthContext(request, {
    config,
    verifier: options.verifier,
  })
  return context.mode === "signed" ? context : undefined
}

async function signedOrError(request: Request, options: Options) {
  try {
    return {
      auth: await routeAuth(request, options),
    }
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) {
      return { error: controlPlaneAuthErrorBody(err), status: err.status }
    }
    throw err
  }
}

async function authorizeRead(
  auth: SignedControlPlaneAuth | undefined,
  options: Options,
  input: {
    sessionId: string
    workspaceId?: string
  },
) {
  if (!auth) return
  const authority = requireAuthority(options.services)
  await authority.usersMe(auth)
  if (!input.workspaceId) {
    throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Workspace context is required")
  }
  await authority.authorizeSessionRead(auth, {
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
  })
}

async function authorizeWrite(
  auth: SignedControlPlaneAuth | undefined,
  options: Options,
  workspaceId: string | undefined,
) {
  if (!auth) return
  const authority = requireAuthority(options.services)
  await authority.usersMe(auth)
  if (!workspaceId) {
    throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Workspace context is required")
  }
  await authority.openWorkspace(auth, { workspaceId })
}

async function authorizeWorkspaceRead(
  auth: SignedControlPlaneAuth | undefined,
  options: Options,
  workspaceId: string | undefined,
) {
  if (!auth) return
  const authority = requireAuthority(options.services)
  await authority.usersMe(auth)
  if (!workspaceId) {
    throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Workspace context is required")
  }
  await authority.openWorkspace(auth, { workspaceId })
}

function responseMeta(input: SessionMeta | undefined, auth: SignedControlPlaneAuth | undefined, sessionId: string) {
  const fallback = { sessionID: sessionId, tags: [], attachments: [] }
  if (!input) return fallback
  if (!auth) return input
  const { directory: _directory, ...safe } = input
  return safe
}

function authoritySessionId(input: unknown) {
  const row = asRecord(input)
  return nonEmptyString(row?.session_id)
    ?? nonEmptyString(row?.sessionId)
    ?? nonEmptyString(row?.sessionID)
    ?? nonEmptyString(row?.id)
    ?? ""
}

function authoritySessionMeta(input: unknown, workspaceId: string): SessionMeta | undefined {
  const sessionID = authoritySessionId(input)
  if (!sessionID) return undefined
  const row = asRecord(input)
  const createdAt = typeof row?.created_at === "number"
    ? row.created_at
    : typeof row?.createdAt === "number"
      ? row.createdAt
      : 0
  const updatedAt = typeof row?.updated_at === "number"
    ? row.updated_at
    : typeof row?.updatedAt === "number"
      ? row.updatedAt
      : createdAt
  return {
    sessionID,
    title: nonEmptyString(row?.title) ?? sessionID,
    workspaceID: workspaceId,
    host: "workspace",
    tags: [],
    attachments: [],
    createdAt,
    updatedAt,
  }
}

/**
 * This machine's single user's marks. A signed reader's marks live on the
 * account, which its client writes to directly, so a signed caller is refused
 * rather than given the machine's marks.
 */
async function readerWrite(request: Request, options: Options, sessionId: string, action: SessionReaderAction) {
  const authResult = await signedOrError(request, options)
  if (authResult.error) return Response.json(authResult.error, { status: authResult.status })
  if (authResult.auth) throw new HTTPException(403, { message: "A signed reader's marks live on the account" })
  const write = sessionReaderWrite(action, await request.json().catch(() => undefined))
  if (!write) throw new HTTPException(400, { message: `invalid ${action} body` })
  const state = await writeSessionReader(LOCAL_USER_ID, sessionId, write)
  if (!state) throw new HTTPException(404, { message: "session metadata not found" })
  return Response.json(state)
}

export function SessionMetaRoutes(options: Options = {}) {
  return new Hono()
    .onError((err, c) => {
      if (err instanceof ControlPlaneAuthError) {
        return c.json(controlPlaneAuthErrorBody(err), err.status)
      }
      if (err instanceof HTTPException) return err.getResponse()
      throw err
    })
    // The desktop-local session inventory. `/api/control/sessions` belongs to
    // the hosted control plane and is intentionally absent from this product;
    // local metadata is projected into the local SQLite store and read here.
    .get("/api/claxedo/session", async (c) => {
      const authResult = await signedOrError(c.req.raw, options)
      if (authResult.error) return c.json(authResult.error, authResult.status)
      const resolved = await workspace(c)
      await authorizeWorkspaceRead(authResult.auth, options, resolved?.id)
      // Projection metas cover the whole workspace and cannot filter by the
      // signed caller's session shares.
      if (authResult.auth && resolved?.id) {
        const rows = await requireAuthority(options.services).listSessions(authResult.auth, {
          workspaceId: resolved.id,
        })
        return c.json({
          sessions: (Array.isArray(rows) ? rows : []).flatMap((item) => {
            const meta = authoritySessionMeta(item, resolved.id)
            if (!meta) return []
            return [responseMeta(meta, authResult.auth, meta.sessionID)]
          }),
        })
      }
      if (resolved) await options.refreshSessionProjection?.(resolved)
      const roots = c.req.query("roots") === "true" || c.req.query("roots") === "1"
      const sessions = await listSessionMetas({
        ...(resolved?.id ? { workspaceID: resolved.id } : {}),
        ...(c.req.query("directory") ? { directory: c.req.query("directory") } : {}),
      })
      return c.json({
        sessions: sessions
          .filter((item) => !roots || !item.parentID)
          .map((item) => responseMeta(item, authResult.auth, item.sessionID)),
      })
    })
    .get("/api/claxedo/session-list", async (c) => {
      const authResult = await signedOrError(c.req.raw, options)
      if (authResult.error) return c.json(authResult.error, authResult.status)
      try {
        const query = parseSessionListQuery(new URL(c.req.url))
        const broad = query.scope === "all" || (query.scope === "project" && query.projectId)
        const named = broad && !c.req.query("workspaceId") && !c.req.query("directory")
          ? undefined
          : await workspace(c)
        if (authResult.auth) {
          return c.json(await signedSessionListPage(requireAuthority(options.services), authResult.auth, { query, workspace: named }))
        }
        return c.json(await localSessionListPage({
          query,
          workspace: named,
          coveredWorkspaces: async () => (await listWorkspaces()).filter((item) =>
            (query.scope === "all" || item.project_id === query.projectId) && item.kind !== "cloud"),
          ...(options.refreshSessionProjection ? { refreshSessionProjection: options.refreshSessionProjection } : {}),
          readRuntimeStatus: readMountedEmbeddedWorkspaceRuntime,
        }))
      } catch (err) {
        if (err instanceof ClaxedoError && err.code === "invalid_session_list_cursor") {
          return c.json({
            error: {
              code: "invalid_session_list_cursor",
              message: "Session list cursor does not match this query",
            },
          }, 400)
        }
        throw err
      }
    })
    .post("/api/claxedo/session/:id/seen", (c) => readerWrite(c.req.raw, options, c.req.param("id"), "seen"))
    .post("/api/claxedo/session/:id/settle", (c) => readerWrite(c.req.raw, options, c.req.param("id"), "settle"))
    .get("/api/claxedo/session/:id/meta", async (c) => {
      const authResult = await signedOrError(c.req.raw, options)
      if (authResult.error) return c.json(authResult.error, authResult.status)
      const hit = await sessionMeta(c.req.param("id"))
      const ws = hit?.workspaceID
        ? undefined
        : await workspace(c)
      await authorizeRead(authResult.auth, options, {
        sessionId: c.req.param("id"),
        workspaceId: hit?.workspaceID ?? ws?.id,
      })
      return c.json(responseMeta(hit, authResult.auth, c.req.param("id")))
    })
    .put("/api/claxedo/session/:id/meta", async (c) => {
      const authResult = await signedOrError(c.req.raw, options)
      if (authResult.error) return c.json(authResult.error, authResult.status)
      const body = await c.req.json().catch(() => ({}))
      const next = parseSessionMeta(body)
      const ws = await workspace(c)
      const previous = await sessionMeta(c.req.param("id"))
      // The session's recorded workspace decides authorization; a
      // caller-selected workspace must not stand in for it, and rebinding to
      // another workspace is authorized on that workspace separately.
      await authorizeWrite(authResult.auth, options, previous?.workspaceID ?? ws?.id)
      if (ws && previous?.workspaceID && ws.id !== previous.workspaceID) {
        await authorizeWrite(authResult.auth, options, ws.id)
      }
      if (!previous) throw new HTTPException(404, { message: "session metadata not found" })
      if (!Object.keys(next).length && !ws) {
        throw new HTTPException(400, { message: "session metadata update is empty" })
      }
      await putSessionMeta(c.req.param("id"), {
        ws,
        ...next,
      })
      return c.json(responseMeta(await sessionMeta(c.req.param("id")), authResult.auth, c.req.param("id")))
    })
}
