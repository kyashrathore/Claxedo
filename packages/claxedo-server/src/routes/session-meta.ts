import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthConfig,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "../control-plane/auth"
import type { ControlPlaneServices } from "../control-plane/services"
import { requireAuthority } from "../control-plane/authority"
import { parseSessionMeta, putSessionMeta, sessionMeta, type SessionMeta } from "../session-meta"
import { resolveWorkspace } from "../workspace-store"

type Options = {
  services?: ControlPlaneServices
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
}

async function workspace(c: {
  req: {
    query: (k: string) => string | undefined
    header: (k: string) => string | undefined
  }
}) {
  const hit = await resolveWorkspace({
    workspaceId: c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id"),
    directory: c.req.query("directory") || c.req.header("x-opencode-directory"),
  })
  if (hit) return hit
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

function responseMeta(input: SessionMeta | undefined, auth: SignedControlPlaneAuth | undefined, sessionId: string) {
  const fallback = { sessionID: sessionId, tags: [], attachments: [] }
  if (!input) return fallback
  if (!auth) return input
  const { directory: _directory, ...safe } = input
  return safe
}

export function SessionMetaRoutes(options: Options = {}) {
  return new Hono()
    .onError((err, c) => {
      if (err instanceof ControlPlaneAuthError) {
        return c.json(controlPlaneAuthErrorBody(err), err.status)
      }
      throw err
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
