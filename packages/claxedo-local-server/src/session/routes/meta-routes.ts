import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import { controlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/clerk-adapter"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  listSessionNavigationMetas,
  listSessionMetas,
  parseSessionMeta,
  putSessionMeta,
  sessionMeta,
  type SessionMeta,
} from "@claxedo/server-core/session/meta/index"
import {
  buildSessionListResponse,
  parseSessionListQuery,
  sessionListStoreFilter,
  sessionListStorePageFilter,
} from "@claxedo/server-core/session/navigation-list"
import { getProjectWorkspace, resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"

type Options = {
  services?: ControlPlaneServicesContract
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  refreshSessionProjection?: (workspace: Workspace) => Promise<void>
}

async function workspace(c: {
  req: {
    query: (k: string) => string | undefined
    header: (k: string) => string | undefined
  }
}) {
  const projectId = c.req.query("projectId")
  const directoryHeader = c.req.header("x-opencode-directory")
  const headerWorkspaceId = directoryHeader?.startsWith("workspace:")
    ? directoryHeader.slice("workspace:".length)
    : undefined
  const hit = await resolveWorkspace({
    workspaceId: c.req.query("workspaceId") ||
      c.req.query("workspace") ||
      c.req.header("x-workspace-id") ||
      headerWorkspaceId ||
      (projectId?.startsWith("ws_") ? projectId : undefined),
    directory: c.req.query("directory") || (headerWorkspaceId ? undefined : directoryHeader),
  })
  if (hit) return hit
  if (projectId) return await getProjectWorkspace(projectId)
}

async function routeAuth(request: Request, options: Options) {
  const config = options.authConfig ?? controlPlaneAuthConfig()
  if (!config.enabled && config.mode === "local-only" && !bearerToken(request.headers.get("authorization"))) return
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

function record(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
}

function nonEmptyString(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

async function authorizedProjectWorkspaceIds(
  auth: SignedControlPlaneAuth,
  options: Options,
  projectId: string,
) {
  const workspaces = await requireAuthority(options.services).listWorkspaces(auth)
  if (!Array.isArray(workspaces)) return new Set<string>()
  return new Set(workspaces.flatMap((input) => {
    const row = record(input)
    if (!row) return []
    const rowProjectId = nonEmptyString(row.project_id) ?? nonEmptyString(row.projectID) ?? nonEmptyString(row.projectId)
    if (rowProjectId !== projectId) return []
    const workspaceId = nonEmptyString(row.workspace_id) ?? nonEmptyString(row.workspaceID) ?? nonEmptyString(row.workspaceId)
    return workspaceId ? [workspaceId] : []
  }))
}

function responseMeta(input: SessionMeta | undefined, auth: SignedControlPlaneAuth | undefined, sessionId: string) {
  const fallback = { sessionID: sessionId, tags: [], attachments: [] }
  if (!input) return fallback
  if (!auth) return input
  const { directory: _directory, ...safe } = input
  return safe
}

function authoritySessionId(input: unknown) {
  const row = record(input)
  return nonEmptyString(row?.session_id)
    ?? nonEmptyString(row?.sessionId)
    ?? nonEmptyString(row?.sessionID)
    ?? nonEmptyString(row?.id)
    ?? ""
}

function authoritySessionMeta(input: unknown, workspaceId: string): SessionMeta | undefined {
  const sessionID = authoritySessionId(input)
  if (!sessionID) return
  const row = record(input)
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

export function SessionMetaRoutes(options: Options = {}) {
  return new Hono()
    .onError((err, c) => {
      if (err instanceof ControlPlaneAuthError) {
        return c.json(controlPlaneAuthErrorBody(err), err.status)
      }
      throw err
    })
    // The desktop-local session inventory. `/api/control/sessions` belongs to
    // the hosted control plane and is intentionally absent from this product;
    // local metadata is projected into the local SQLite store and read here.
    .get("/api/claxedo/session", async (c) => {
      const authResult = await signedOrError(c.req.raw, options)
      if (authResult.error) return c.json(authResult.error, authResult.status)
      const resolved = await workspace(c).catch(() => undefined)
      await authorizeWorkspaceRead(authResult.auth, options, resolved?.id)
      // Signed callers get participant-scoped authority rows. Projection metas
      // are workspace-complete and would leak private sessions to editors who
      // are not participants (two-user privacy / Journey 3).
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
      const sessions = await listSessionMetas({
        ...(resolved?.id ? { workspaceID: resolved.id } : {}),
        ...(c.req.query("directory") ? { directory: c.req.query("directory") } : {}),
      })
      return c.json({
        sessions: sessions.map((item) => responseMeta(item, authResult.auth, item.sessionID)),
      })
    })
    .get("/api/claxedo/session-list", async (c) => {
      const authResult = await signedOrError(c.req.raw, options)
      if (authResult.error) return c.json(authResult.error, authResult.status)
      try {
        const query = parseSessionListQuery(new URL(c.req.url))
        if (authResult.auth && query.scope === "project" && query.projectId) {
          // Project membership is not workspace membership. Workspace shares
          // are granted independently, so authorize from the principal's real
          // workspace inventory and list each workspace through authority so
          // private sessions stay participant-scoped.
          const authorized = await authorizedProjectWorkspaceIds(authResult.auth, options, query.projectId)
          const authority = requireAuthority(options.services)
          const projectId = query.projectId
          const sessions = (await Promise.all(
            [...authorized].map(async (workspaceId) => {
              const rows = await authority.listSessions(authResult.auth!, { workspaceId })
              return (Array.isArray(rows) ? rows : []).map((row) => ({
                ...(row && typeof row === "object" ? row : {}),
                workspace_id: workspaceId,
                project_id: projectId,
              }))
            }),
          )).flat()
          return c.json(buildSessionListResponse({ query, sessions }))
        }
        const resolved = await workspace(c).catch(() => undefined)
        await authorizeWorkspaceRead(authResult.auth, options, resolved?.id)
        if (authResult.auth && resolved?.id) {
          const sessions = await requireAuthority(options.services).listSessions(authResult.auth, {
            workspaceId: resolved.id,
          })
          return c.json(buildSessionListResponse({
            query,
            sessions: Array.isArray(sessions) ? sessions : [],
          }))
        }
        if (resolved) await options.refreshSessionProjection?.(resolved)
        const canUseBoundedProjection = query.groupBy === "none" &&
          query.environment.length === 0 &&
          query.git.length === 0
        if (canUseBoundedProjection) {
          return c.json(buildSessionListResponse({
            query,
            sessions: await listSessionNavigationMetas(sessionListStorePageFilter(query)),
            cursorApplied: true,
          }))
        }
        return c.json(buildSessionListResponse({
          query,
          sessions: await listSessionMetas(sessionListStoreFilter(query)),
        }))
      } catch (err) {
        if (err instanceof Error && err.message === "invalid_session_list_cursor") {
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
    .get("/api/claxedo/session/:id/meta", async (c) => {
      const authResult = await signedOrError(c.req.raw, options)
      if (authResult.error) return c.json(authResult.error, authResult.status)
      const hit = await sessionMeta(c.req.param("id"))
      const ws = hit?.workspaceID
        ? undefined
        : await workspace(c).catch(() => undefined)
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
      const ws = await workspace(c).catch(() => undefined)
      const previous = await sessionMeta(c.req.param("id"))
      await authorizeWrite(authResult.auth, options, ws?.id ?? previous?.workspaceID)
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
