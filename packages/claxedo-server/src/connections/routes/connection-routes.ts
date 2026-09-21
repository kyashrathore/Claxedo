import { Hono, type Context } from "hono"
import { routeParam } from "@claxedo/helpers/route-param"
import { z } from "zod"
import type { ControlPlaneServices } from "../../authority/services"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
} from "@claxedo/server-core/platform/auth/auth"
import { createFixedWindowConnectionRateLimiter } from "../../platform/auth/rate-limit"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import {
  cloudConnectionInfo,
  cloudConnectionStatus,
  localLoopbackCloudConnectionInfo,
  localLoopbackCloudConnectionStatus,
} from "../cloud-connection"
import { hostTunnelConnectionInfo } from "../host-tunnel-connection"
import { signedOrError, type WorkspaceRouteOptions } from "../../workspace/route-support"
import { connectionRateLimitError } from "../../workspace/runtime-token-guards"

const refreshConnectionBody = z.object({
  previousJti: z.string().optional(),
}).strict()

export function workspaceConnectionRoutes(
  services?: ControlPlaneServices,
  options: WorkspaceRouteOptions = {},
) {
  const connectionRateLimiter = options.connectionRateLimiter ?? createFixedWindowConnectionRateLimiter()

  // The explicit connect, spelled POST on both connection paths: minting can
  // start billable compute (`cloudConnectionInfo` ensures the sandbox), so it
  // is never a GET. `/connection` mints; `/connection/refresh` additionally
  // revokes the previous token by its declared `previousJti`.
  const connectionPost = async (c: Context) => {
    const workspaceId = routeParam(c, "id")
    const ws = await resolveWorkspace({ workspaceId })
    const authResult = await signedOrError(c.req.raw, {
      ...options,
      requireSigned: true,
    }, services)
    if ("error" in authResult) {
      const loopback = await localLoopbackConnectionResponse(c, c.req.raw, services, options, ws, false)
      if (loopback) return loopback
      return c.json(authResult.error, authResult.status)
    }
    const auth = authResult.auth
    if (!auth) {
        const loopback = await localLoopbackConnectionResponse(c, c.req.raw, services, options, ws, false)
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
        : await hostTunnelConnectionInfo(services, options, auth, workspaceId, body.previousJti)
      if ("error" in result) return c.json({ error: result.error }, result.status)
      return c.json(result.connection)
    } catch (err) {
      if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
      throw err
    }
  }

  return new Hono()
    // GET is the read: it reports the lease's current state and may mint only
    // off an already-running sandbox. The explicit connect is POST above —
    // the only path that runs `sandboxManager.ensure` and so the only one that
    // can start compute (P-118).
    .get("/:id/connection", async (c) => {
      const workspaceId = c.req.param("id")
      const ws = await resolveWorkspace({ workspaceId })
      const authResult = await signedOrError(c.req.raw, {
        ...options,
        requireSigned: true,
      }, services)
      if ("error" in authResult) {
        const loopback = await localLoopbackConnectionResponse(c, c.req.raw, services, options, ws, true)
        if (loopback) return loopback
        return c.json(authResult.error, authResult.status)
      }
      const auth = authResult.auth
      if (!auth) {
          const loopback = await localLoopbackConnectionResponse(c, c.req.raw, services, options, ws, true)
        if (loopback) return loopback
        return c.json(controlPlaneAuthErrorBody(
          new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required"),
        ), 401)
      }
      try {
        const rateLimit = await connectionRateLimitError(services, connectionRateLimiter, auth, workspaceId)
        if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
        const result = ws?.kind === "cloud"
          ? await cloudConnectionStatus(services, options, auth, ws)
          : await hostTunnelConnectionInfo(services, options, auth, workspaceId)
        if ("error" in result) return c.json({ error: result.error }, result.status)
        return c.json(result.connection)
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .post("/:id/connection", connectionPost)
    .post("/:id/connection/refresh", connectionPost)
}

async function localLoopbackConnectionResponse(
  c: { json: (body: unknown, status?: number) => Response },
  request: Request,
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  ws: Awaited<ReturnType<typeof resolveWorkspace>>,
  readOnly: boolean,
) {
  if (ws?.kind !== "cloud" || !isLoopbackLocalRequest(request)) return undefined
  try {
    const result = readOnly
      ? await localLoopbackCloudConnectionStatus(services, options, request, ws)
      : await localLoopbackCloudConnectionInfo(services, options, request, ws)
    if ("error" in result) return c.json({ error: result.error }, result.status)
    return c.json(result.connection)
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
    throw err
  }
}
