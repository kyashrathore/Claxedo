import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { ControlPlaneServices } from "../../authority/services"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "@claxedo/server-core/platform/auth/auth"
import {
  notifySessionShareChanged,
  type SessionShareChangedSink,
  type SessionShareFanoutTarget,
} from "./session-share-fanout"

type Options = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  cliTokenEnv?: Record<string, string | undefined>
  sessionShareChangedSink?: SessionShareChangedSink
}

const bodyLimitBytes = 16 * 1024

async function signedAuth(req: Request, options: Options) {
  const auth = await controlPlaneAuthContext(req, {
    config: options.authConfig,
    verifier: options.verifier,
  })
  if (auth?.mode === "signed") return auth
  throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
}

async function participantBody(req: Request) {
  const body = await req.json().catch(() => undefined)
  if (!body || typeof body !== "object" || Array.isArray(body)) return
  const input = body as Record<string, unknown>
  const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : ""
  const participantTokenIdentifier = typeof input.participantTokenIdentifier === "string"
    ? input.participantTokenIdentifier.trim()
    : ""
  if (!workspaceId || !participantTokenIdentifier) return
  return { workspaceId, participantTokenIdentifier }
}

function shareTargetFromBody(body: Record<string, unknown>): SessionShareFanoutTarget {
  return {
    ...(typeof body.grantedToTokenIdentifier === "string" ? { grantedToTokenIdentifier: body.grantedToTokenIdentifier } : {}),
    ...(typeof body.grantedToClerkSubject === "string" ? { grantedToClerkSubject: body.grantedToClerkSubject } : {}),
    ...(typeof body.grantedToUserId === "string" ? { grantedToUserId: body.grantedToUserId } : {}),
    ...(typeof body.grantedToClerkOrgId === "string" ? { grantedToClerkOrgId: body.grantedToClerkOrgId } : {}),
    ...(typeof body.grantedToOrgId === "string" ? { grantedToOrgId: body.grantedToOrgId } : {}),
    ...(typeof body.grantedToTeamId === "string" ? { grantedToTeamId: body.grantedToTeamId } : {}),
    ...(typeof body.grantedToTeamPublicId === "string" ? { grantedToTeamPublicId: body.grantedToTeamPublicId } : {}),
  }
}

/**
 * Worker-safe private-session people routes (participants + share grants).
 * Kept separate from `ControlPlaneSessionRoutes` so hosted workerd does not
 * pull Node supervisor / workspace-runtime via session-list/hybrid create.
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
  app.use("/sessions/:sessionId/participants", limited)
  app.use("/sessions/:sessionId/shares", limited)

  return app
    .post("/sessions/:sessionId/participants", async (c) => {
      const body = await participantBody(c.req.raw)
      if (!body) {
        return c.json({
          error: {
            code: "session_participant_input_required",
            message: "workspaceId and participantTokenIdentifier are required",
          },
        }, 400)
      }
      try {
        const auth = await signedAuth(c.req.raw, options)
        return c.json(await requireAuthority(services).addSessionParticipant(auth, {
          sessionId: c.req.param("sessionId"),
          workspaceId: body.workspaceId,
          participantTokenIdentifier: body.participantTokenIdentifier,
        }))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .delete("/sessions/:sessionId/participants", async (c) => {
      const body = await participantBody(c.req.raw)
      if (!body) {
        return c.json({
          error: {
            code: "session_participant_input_required",
            message: "workspaceId and participantTokenIdentifier are required",
          },
        }, 400)
      }
      try {
        const auth = await signedAuth(c.req.raw, options)
        return c.json(await requireAuthority(services).removeSessionParticipant(auth, {
          sessionId: c.req.param("sessionId"),
          workspaceId: body.workspaceId,
          participantTokenIdentifier: body.participantTokenIdentifier,
        }))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
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
        const auth = await signedAuth(c.req.raw, options)
        const list = requireAuthority(services).listSessionShares
        if (!list) return c.json({ error: { code: "not_implemented", message: "Session shares unavailable" } }, 501)
        return c.json(await list(auth, {
          sessionId: c.req.param("sessionId"),
          workspaceId,
        }))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .post("/sessions/:sessionId/shares", async (c) => {
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
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
        const auth = await signedAuth(c.req.raw, options)
        const authority = requireAuthority(services)
        const grant = authority.grantSessionShare
        if (!grant) return c.json({ error: { code: "not_implemented", message: "Session shares unavailable" } }, 501)
        const target = shareTargetFromBody(body)
        const result = await grant(auth, {
          sessionId: c.req.param("sessionId"),
          workspaceId,
          ...target,
        })
        await notifySessionShareChanged({
          auth,
          authority,
          phase: "granted",
          sessionId: c.req.param("sessionId"),
          workspaceId,
          target,
          ...(options.sessionShareChangedSink ? { sink: options.sessionShareChangedSink } : {}),
        })
        return c.json(result)
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .delete("/sessions/:sessionId/shares", async (c) => {
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
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
        const auth = await signedAuth(c.req.raw, options)
        const authority = requireAuthority(services)
        const revoke = authority.revokeSessionShare
        if (!revoke) return c.json({ error: { code: "not_implemented", message: "Session shares unavailable" } }, 501)
        const target = shareTargetFromBody(body)
        const result = await revoke(auth, {
          sessionId: c.req.param("sessionId"),
          workspaceId,
          ...target,
        })
        await notifySessionShareChanged({
          auth,
          authority,
          phase: "revoked",
          sessionId: c.req.param("sessionId"),
          workspaceId,
          target,
          ...(options.sessionShareChangedSink ? { sink: options.sessionShareChangedSink } : {}),
        })
        return c.json(result)
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
}
