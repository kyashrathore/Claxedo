import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import type { ControlPlaneServices } from "../../authority/services"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
} from "@claxedo/server-core/platform/auth/auth"
import { apiError, signedOrError, type WorkspaceRouteOptions } from "../route-support"

const workspaceShareBodyLimitBytes = 16 * 1024

const shareTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("actor"), actorId: z.string().trim().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("user"), userId: z.string().trim().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("org"), orgId: z.string().trim().min(1).max(512) }).strict(),
])

const shareBody = z.object({
  role: z.union([z.literal("viewer"), z.literal("editor"), z.literal("admin")]),
  target: shareTarget.optional(),
}).strict()

const revokeShareBody = z.object({
  grantId: z.string().trim().min(1).max(512).optional(),
  target: shareTarget.optional(),
}).strict()

export function workspaceShareRoutes(
  services?: ControlPlaneServices,
  options: WorkspaceRouteOptions = {},
) {
  const limitedBody = bodyLimit({
    maxSize: workspaceShareBodyLimitBytes,
    onError: (c) => c.json({
      error: apiError(
        "request_body_too_large",
        `Request body exceeds the ${workspaceShareBodyLimitBytes}-byte limit`,
      ),
    }, 413),
  })
  return new Hono()
    .post("/:id/shares", limitedBody, async (c) => {
      const authResult = await signedOrError(c.req.raw, {
        ...options,
        requireSigned: true,
      }, services)
      if ("error" in authResult) return c.json(authResult.error, authResult.status)
      const auth = authResult.auth
      if (!auth) return c.json(controlPlaneAuthErrorBody(
        new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required"),
      ), 401)
      const parsed = shareBody.safeParse(await c.req.json().catch(() => ({})))
      if (!parsed.success) {
        return c.json(shareTargetError("workspace_share_target_invalid", "Share target is invalid"), 400)
      }
      const body = parsed.data
      if (!body.target) {
        return c.json(shareTargetError("workspace_share_target_required", "Share target is required"), 400)
      }
      try {
        return c.json(await requireAuthority(services).grantWorkspaceShare(auth, {
          workspaceId: c.req.param("id"),
          role: body.role,
          target: body.target,
        }))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .delete("/:id/shares", limitedBody, async (c) => {
      const authResult = await signedOrError(c.req.raw, {
        ...options,
        requireSigned: true,
      }, services)
      if ("error" in authResult) return c.json(authResult.error, authResult.status)
      const auth = authResult.auth
      if (!auth) return c.json(controlPlaneAuthErrorBody(
        new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required"),
      ), 401)
      const parsed = revokeShareBody.safeParse(await c.req.json().catch(() => ({})))
      if (!parsed.success) {
        return c.json(shareTargetError("workspace_share_target_invalid", "Share target is invalid"), 400)
      }
      const body = parsed.data
      if (!!body.grantId === !!body.target) {
        return c.json(shareTargetError(
          body.grantId || body.target ? "workspace_share_target_ambiguous" : "workspace_share_target_required",
          body.grantId || body.target
            ? "Share revoke target must be exactly one grant or canonical target"
            : "Share target is required",
        ), 400)
      }
      try {
        return c.json(await requireAuthority(services).revokeWorkspaceShare(auth, {
          workspaceId: c.req.param("id"),
          ...(body.grantId ? { grantId: body.grantId } : { target: body.target! }),
        }))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
}

function shareTargetError(
  code: "workspace_share_target_required" | "workspace_share_target_ambiguous" | "workspace_share_target_invalid",
  message: string,
) {
  return { error: apiError(code, message) }
}
