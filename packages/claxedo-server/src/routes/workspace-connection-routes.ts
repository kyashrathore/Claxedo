import { Hono } from "hono"
import { z } from "zod"
import type { ControlPlaneServices } from "../control-plane/services"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
} from "../control-plane/auth"
import { createFixedWindowConnectionRateLimiter } from "../control-plane/rate-limit"
import { resolveWorkspace } from "../workspace-store"
import { isLoopbackLocalRequest } from "./local-only-projection"
import { cloudConnectionInfo, localLoopbackCloudConnectionInfo } from "./workspace-cloud-connection"
import {
  connectionRateLimitError,
  signedOrError,
  userHostedConnectionInfo,
  type WorkspaceRouteOptions,
} from "./workspace-user-hosted"
import { syncWorkspaceAgentExtensionsForSignedUser } from "./workspace-signed-access"

const refreshConnectionBody = z.object({
  previousJti: z.string().optional(),
}).strict()

export function workspaceConnectionRoutes(
  services?: ControlPlaneServices,
  options: WorkspaceRouteOptions = {},
) {
  const connectionRateLimiter = options.connectionRateLimiter ?? createFixedWindowConnectionRateLimiter()
  return new Hono()
    .get("/:id/connection", async (c) => {
      const workspaceId = c.req.param("id")
      const ws = await resolveWorkspace({ workspaceId })
      const authResult = await signedOrError(c.req.raw, {
        ...options,
        requireSigned: true,
      }, services)
      if ("error" in authResult) {
        const loopback = await localLoopbackConnectionResponse(c, c.req.raw, services, options, ws)
        if (loopback) return loopback
        return c.json(authResult.error, authResult.status)
      }
      const auth = authResult.auth
      if (!auth) {
          const loopback = await localLoopbackConnectionResponse(c, c.req.raw, services, options, ws)
        if (loopback) return loopback
        return c.json(controlPlaneAuthErrorBody(
          new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required"),
        ), 401)
      }
      try {
        const rateLimit = await connectionRateLimitError(services, connectionRateLimiter, auth, workspaceId)
        if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
        const result = ws?.kind === "cloud"
          ? await cloudConnectionInfo(services, options, auth, ws)
          : await userHostedConnectionInfo(services, options, auth, workspaceId)
        if ("error" in result) return c.json({ error: result.error }, result.status)
        await syncWorkspaceAgentExtensionsForSignedUser(services, auth, workspaceId).catch(() => {})
        return c.json(result.connection)
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .post("/:id/connection/refresh", async (c) => {
      const workspaceId = c.req.param("id")
      const ws = await resolveWorkspace({ workspaceId })
      const authResult = await signedOrError(c.req.raw, {
        ...options,
        requireSigned: true,
      }, services)
      if ("error" in authResult) {
        const loopback = await localLoopbackConnectionResponse(c, c.req.raw, services, options, ws)
        if (loopback) return loopback
        return c.json(authResult.error, authResult.status)
      }
      const auth = authResult.auth
      if (!auth) {
          const loopback = await localLoopbackConnectionResponse(c, c.req.raw, services, options, ws)
        if (loopback) return loopback
        return c.json(controlPlaneAuthErrorBody(
          new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required"),
        ), 401)
      }
      const body = refreshConnectionBody.parse(await c.req.json().catch(() => ({})))
      try {
        const rateLimit = await connectionRateLimitError(services, connectionRateLimiter, auth, workspaceId)
        if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
        const result = ws?.kind === "cloud"
          ? await cloudConnectionInfo(services, options, auth, ws, body.previousJti)
          : await userHostedConnectionInfo(services, options, auth, workspaceId, body.previousJti)
        if ("error" in result) return c.json({ error: result.error }, result.status)
        await syncWorkspaceAgentExtensionsForSignedUser(services, auth, workspaceId).catch(() => {})
        return c.json(result.connection)
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
}

async function localLoopbackConnectionResponse(
  c: { json: (body: unknown, status?: number) => Response },
  request: Request,
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  ws: Awaited<ReturnType<typeof resolveWorkspace>>,
) {
  if (ws?.kind !== "cloud" || !isLoopbackLocalRequest(request)) return
  try {
    const result = await localLoopbackCloudConnectionInfo(services, options, request, ws)
    if ("error" in result) return c.json({ error: result.error }, result.status)
    return c.json(result.connection)
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
    throw err
  }
}
