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

function peopleAuthorityError(err: unknown): ControlPlaneAuthError | undefined {
  if (err instanceof ControlPlaneAuthError) return err
  const message = err instanceof Error ? err.message : String(err)
  if (message === "Session not found" || message.includes("Session not found")) {
    return new ControlPlaneAuthError(
      404,
      "session_not_found",
      "This session is not on the control plane, so it cannot be shared from People yet.",
    )
  }
  if (message === "session_share_admin_required" || message.includes("session_share_admin_required")) {
    return new ControlPlaneAuthError(
      403,
      "session_share_admin_required",
      "Only the session creator or an org/team admin can manage People on this session.",
    )
  }
  if (message === "session_share_target_required" || message.includes("session_share_target_required")) {
    return new ControlPlaneAuthError(400, "session_share_target_required", "Exactly one share target is required")
  }
  if (message === "session_share_target_not_found" || message.includes("session_share_target_not_found")) {
    return new ControlPlaneAuthError(404, "session_share_target_not_found", "Share target was not found")
  }
  if (message === "session_participant_workspace_access_required" || message.includes("session_participant_workspace_access_required")) {
    return new ControlPlaneAuthError(
      403,
      "session_participant_workspace_access_required",
      "That person needs workspace access before they can be added to the session.",
    )
  }
  return undefined
}

function peopleErrorResponse(c: { json: (body: unknown, status: number) => Response }, err: unknown) {
  const mapped = peopleAuthorityError(err)
  if (mapped) return c.json(controlPlaneAuthErrorBody(mapped), mapped.status)
  throw err
}

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
        return peopleErrorResponse(c, err)
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
        return peopleErrorResponse(c, err)
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
        return peopleErrorResponse(c, err)
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
        return peopleErrorResponse(c, err)
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
          ...(typeof body.grantId === "string" ? { grantId: body.grantId } : {}),
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
        return peopleErrorResponse(c, err)
      }
    })
}
