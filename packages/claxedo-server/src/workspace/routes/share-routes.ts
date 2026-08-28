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
const shareBody = z.object({
  role: z.union([z.literal("viewer"), z.literal("editor"), z.literal("admin")]),
  grantedToTokenIdentifier: z.string().optional(),
  grantedToSubject: z.string().optional(),
  grantedToOrgId: z.string().optional(),
  grantedToClerkSubject: z.string().optional(),
  grantedToClerkOrgId: z.string().optional(),
}).strict()

const revokeShareBody = z.object({
  grantId: z.string().optional(),
  grantedToTokenIdentifier: z.string().optional(),
  grantedToSubject: z.string().optional(),
  grantedToOrgId: z.string().optional(),
  grantedToClerkSubject: z.string().optional(),
  grantedToClerkOrgId: z.string().optional(),
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
      const body = shareBody.parse(await c.req.json().catch(() => ({})))
      const target = shareTarget(body)
      const count = targetCount(target)
      if (count === 0) return c.json(shareTargetError("workspace_share_target_required", "Share target is required"), 400)
      if (count > 1) return c.json(shareTargetError("workspace_share_target_ambiguous", "Share target must be exactly one user or org"), 400)
      try {
        return c.json(await requireAuthority(services).grantWorkspaceShare(auth, {
          workspaceId: c.req.param("id"),
          role: body.role,
          ...target,
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
      const body = revokeShareBody.parse(await c.req.json().catch(() => ({})))
      const target = revokeShareTarget(body)
      const count = targetCount(target)
      if (count === 0) return c.json(shareTargetError("workspace_share_target_required", "Share target is required"), 400)
      if (count > 1) return c.json(shareTargetError("workspace_share_target_ambiguous", "Share revoke target must be exactly one grant, user, or org"), 400)
      try {
        return c.json(await requireAuthority(services).revokeWorkspaceShare(auth, {
          workspaceId: c.req.param("id"),
          ...target,
        }))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
}

function shareTargetError(code: "workspace_share_target_required" | "workspace_share_target_ambiguous", message: string) {
  return { error: apiError(code, message) }
}

function shareTarget(input: z.infer<typeof shareBody>) {
  return {
    grantedToTokenIdentifier: input.grantedToTokenIdentifier,
    grantedToClerkSubject: input.grantedToClerkSubject ?? input.grantedToSubject,
    grantedToClerkOrgId: input.grantedToClerkOrgId ?? input.grantedToOrgId,
  }
}

function revokeShareTarget(input: z.infer<typeof revokeShareBody>) {
  return {
    grantId: input.grantId,
    grantedToTokenIdentifier: input.grantedToTokenIdentifier,
    grantedToClerkSubject: input.grantedToClerkSubject ?? input.grantedToSubject,
    grantedToClerkOrgId: input.grantedToClerkOrgId ?? input.grantedToOrgId,
  }
}

function targetCount(input: Record<string, string | undefined>) {
  return Object.values(input).filter((value) => !!value).length
}
