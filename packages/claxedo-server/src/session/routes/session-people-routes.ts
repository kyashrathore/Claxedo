import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { ControlPlaneServices } from "../../authority/services"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  ControlPlaneAuthError,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
} from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { signedOrError } from "../../workspace/route-support"
import { readJsonRecord } from "@claxedo/server-core/platform/json/index"
import {
  notifySessionShareChanged,
  peopleErrorResponse,
  type SessionShareChangedSink,
  type SessionShareFanoutTarget,
} from "../session-people-contract"
import { requestedSessionShareLevel } from "@claxedo/server-core/platform/auth/session-share-level"

type Options = {
  authentication?: RequestAuthenticationAdapter
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  cliTokenEnv?: Record<string, string | undefined>
  sessionShareChangedSink?: SessionShareChangedSink
}

const bodyLimitBytes = 16 * 1024

async function signedAuth(req: Request, options: Options, services: ControlPlaneServices) {
  const authResult = await signedOrError(req, {
    authentication: options.authentication,
    authConfig: options.authConfig,
    verifier: options.verifier,
    requireSigned: true,
  }, services)
  if ("error" in authResult) {
    const status = authResult.status ?? 401
    throw Object.assign(
      new ControlPlaneAuthError(status, "invalid_bearer_token", "Signed auth required"),
      { response: authResult },
    )
  }
  if (authResult.auth) return authResult.auth
  throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
}

function shareTargetFromBody(body: Record<string, unknown>): SessionShareFanoutTarget {
  return {
    ...(typeof body.grantedToTokenIdentifier === "string" ? { grantedToTokenIdentifier: body.grantedToTokenIdentifier } : {}),
    ...(typeof body.grantedToSubject === "string" ? { grantedToSubject: body.grantedToSubject } : {}),
    ...(typeof body.grantedToUserId === "string" ? { grantedToUserId: body.grantedToUserId } : {}),
    ...(typeof body.grantedToOrgId === "string" ? { grantedToOrgId: body.grantedToOrgId } : {}),
    ...(typeof body.grantedToTeamId === "string" ? { grantedToTeamId: body.grantedToTeamId } : {}),
    ...(typeof body.grantedToTeamPublicId === "string" ? { grantedToTeamPublicId: body.grantedToTeamPublicId } : {}),
  }
}

/**
 * Hosted workerd must not import the Node supervisor or workspace runtime.
 */
export function SessionPeopleControlRoutes(services: ControlPlaneServices, options: Options = {}) {
  const app = new Hono()
  const limited = bodyLimit({
    maxSize: bodyLimitBytes,
    onError: (c) => c.json({
      error: {
        code: "request_body_too_large",
        message: `Request body exceeds the ${bodyLimitBytes}-byte limit`,
      },
    }, 413),
  })
  app.use("/sessions/:sessionId/shares", limited)

  return app
    .get("/sessions/:sessionId/shares", async (c) => {
      const workspaceId = c.req.query("workspaceId")
      if (!workspaceId) {
        return c.json({
          error: {
            code: "session_share_input_required",
            message: "workspaceId is required",
          },
        }, 400)
      }
      try {
        const auth = await signedAuth(c.req.raw, options, services)
        const list = requireAuthority(services).listSessionShares
        if (!list) return c.json({ error: { code: "not_implemented", message: "Session shares unavailable" } }, 501)
        return c.json(await list(auth, {
          sessionId: c.req.param("sessionId"),
          workspaceId,
        }))
      } catch (err) {
        return peopleErrorResponse(c, err)
      }
    })
    .post("/sessions/:sessionId/shares", async (c) => {
      const body = (await readJsonRecord(c.req.raw)) ?? {}
      const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : undefined
      if (!workspaceId) {
        return c.json({
          error: {
            code: "session_share_input_required",
            message: "workspaceId is required",
          },
        }, 400)
      }
      try {
        const auth = await signedAuth(c.req.raw, options, services)
        const authority = requireAuthority(services)
        const grant = authority.grantSessionShare
        if (!grant) return c.json({ error: { code: "not_implemented", message: "Session shares unavailable" } }, 501)
        const target = shareTargetFromBody(body)
        const result = await grant(auth, {
          sessionId: c.req.param("sessionId"),
          workspaceId,
          level: requestedSessionShareLevel(body.level),
          ...target,
        })
        await notifySessionShareChanged({
          auth,
          authority,
          phase: "granted",
          level: result.level,
          sessionId: c.req.param("sessionId"),
          workspaceId,
          target,
          ...(options.sessionShareChangedSink ? { sink: options.sessionShareChangedSink } : {}),
        })
        return c.json(result)
      } catch (err) {
        return peopleErrorResponse(c, err)
      }
    })
    .delete("/sessions/:sessionId/shares", async (c) => {
      const body = (await readJsonRecord(c.req.raw)) ?? {}
      const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : undefined
      if (!workspaceId) {
        return c.json({
          error: {
            code: "session_share_input_required",
            message: "workspaceId is required",
          },
        }, 400)
      }
      try {
        const auth = await signedAuth(c.req.raw, options, services)
        const authority = requireAuthority(services)
        const revoke = authority.revokeSessionShare
        if (!revoke) return c.json({ error: { code: "not_implemented", message: "Session shares unavailable" } }, 501)
        const target = shareTargetFromBody(body)
        const result = await revoke(auth, {
          sessionId: c.req.param("sessionId"),
          workspaceId,
          ...(typeof body.grantId === "string" ? { grantId: body.grantId } : {}),
          ...target,
        })
        for (const revokedTarget of result.revokedTargets) {
          await notifySessionShareChanged({
            auth,
            authority,
            phase: "revoked",
            sessionId: c.req.param("sessionId"),
            workspaceId,
            target: revokedTarget,
            ...(options.sessionShareChangedSink ? { sink: options.sessionShareChangedSink } : {}),
          })
        }
        const { revokedTargets: _revokedTargets, ...response } = result
        return c.json(response)
      } catch (err) {
        return peopleErrorResponse(c, err)
      }
    })
}
