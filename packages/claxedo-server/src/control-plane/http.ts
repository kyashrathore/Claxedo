import { Hono } from "hono"
import type { ControlPlaneServices } from "./services"
import { authContext, errorResponse, json, pullTriggerInput, runtimeSnapshotInput } from "./http-protocol"
import type { ControlPlaneHttpOptions } from "./http-protocol"
import { cachedIdempotency, lockKey, serialized } from "./http-idempotency"
import {
  pullControlSession,
  pullControlSessionMessages,
  resolveSessionGateway,
} from "./http-session-pull"
import {
  heartbeatControlRuntime,
  registerControlRuntime,
} from "./http-runtime-status"

export type { ControlPlaneHttpOptions }
export { resolveSessionGateway, pullControlSession, pullControlSessionMessages }
export { registerControlRuntime, heartbeatControlRuntime }

export function ControlPlaneHttpRoutes(
  services: ControlPlaneServices,
  options: ControlPlaneHttpOptions = {},
) {
  const app = new Hono()
  const ok = () => ({ ok: true })

  app.post("/workspaces/:workspaceId/sessions/:sessionId/register", async (c) => {
    try {
      const auth = await authContext(c.req.raw, options)
      const body = pullTriggerInput.parse(await json(c.req.raw))
      const workspaceId = c.req.param("workspaceId")
      const sessionId = c.req.param("sessionId")
      const key = body.idempotencyKey ? `register:${workspaceId}:${sessionId}:${body.idempotencyKey}` : undefined
      const result = await cachedIdempotency(key, () =>
        serialized(lockKey(workspaceId, sessionId), () =>
          pullControlSession(services, options, auth, {
            workspaceId,
            sessionId,
          })))
      return c.json(result)
    } catch (error) {
      return errorResponse(error)
    }
  })

  app.post("/workspaces/:workspaceId/sessions/:sessionId/checkpoint", async (c) => {
    try {
      const auth = await authContext(c.req.raw, options)
      const body = pullTriggerInput.parse(await json(c.req.raw))
      const workspaceId = c.req.param("workspaceId")
      const sessionId = c.req.param("sessionId")
      const key = body.idempotencyKey ? `checkpoint:${workspaceId}:${sessionId}:${body.idempotencyKey}` : undefined
      const result = await cachedIdempotency(key, () =>
        serialized(lockKey(workspaceId, sessionId), () =>
          pullControlSessionMessages(services, options, auth, {
            workspaceId,
            sessionId,
            ...(body.expectedEventOrdinal === undefined ? {} : { expectedEventOrdinal: body.expectedEventOrdinal }),
          })))
      return c.json(result)
    } catch (error) {
      return errorResponse(error)
    }
  })

  app.post("/workspaces/:workspaceId/sessions/:sessionId/repair", async (c) => {
    try {
      const auth = await authContext(c.req.raw, options)
      const body = pullTriggerInput.parse(await json(c.req.raw))
      const workspaceId = c.req.param("workspaceId")
      const sessionId = c.req.param("sessionId")
      const key = body.idempotencyKey ? `repair:${workspaceId}:${sessionId}:${body.idempotencyKey}` : undefined
      const result = await cachedIdempotency(key, () =>
        serialized(lockKey(workspaceId, sessionId), async () => {
          const session = await pullControlSession(services, options, auth, {
            workspaceId,
            sessionId,
          })
          const messages = await pullControlSessionMessages(services, options, auth, {
            workspaceId,
            sessionId,
            ...(body.expectedEventOrdinal === undefined ? {} : { expectedEventOrdinal: body.expectedEventOrdinal }),
          })
          return { ok: true, session, messages }
        }))
      return c.json(result)
    } catch (error) {
      return errorResponse(error)
    }
  })

  app.post("/runtime/register", async (c) => {
    try {
      await authContext(c.req.raw, options)
      await registerControlRuntime(services, runtimeSnapshotInput.parse(await json(c.req.raw)))
      return c.json(ok())
    } catch (error) {
      return errorResponse(error)
    }
  })

  app.post("/runtime/heartbeat", async (c) => {
    try {
      await authContext(c.req.raw, options)
      await heartbeatControlRuntime(services, runtimeSnapshotInput.parse(await json(c.req.raw)))
      return c.json(ok())
    } catch (error) {
      return errorResponse(error)
    }
  })

  return app
}
