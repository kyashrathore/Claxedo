import { Hono } from "hono"
import type { ControlPlaneServices } from "../services"
import type { ControlPlaneAuthContext } from "../../platform/auth/auth"
import {
  assertRuntimeMutationAuth,
  authContext,
  errorResponse,
  json,
  pullTriggerInput,
  runtimeSnapshotInput,
} from "./protocol"
import type { ControlPlaneHttpOptions } from "./protocol"
import {
  cachedIdempotency,
  idempotencyCacheKey,
  idempotencyFingerprint,
  lockKey,
  serialized,
} from "./idempotency"
import {
  pullControlSession,
  pullControlSessionMessages,
  resolveSessionGateway,
} from "./session-pull"
import {
  heartbeatControlRuntime,
  registerControlRuntime,
} from "./runtime-status"

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
      const key = idempotencyCacheKey({
        operation: "register",
        principal: idempotencyPrincipal(auth),
        workspaceId,
        sessionId,
        key: body.idempotencyKey,
      })
      const result = await cachedIdempotency(key, () =>
        serialized(lockKey(workspaceId, sessionId), () =>
          pullControlSession(services, options, auth, {
            workspaceId,
            sessionId,
          })), idempotencyFingerprint(body))
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
      const key = idempotencyCacheKey({
        operation: "checkpoint",
        principal: idempotencyPrincipal(auth),
        workspaceId,
        sessionId,
        key: body.idempotencyKey,
      })
      const result = await cachedIdempotency(key, () =>
        serialized(lockKey(workspaceId, sessionId), () =>
          pullControlSessionMessages(services, options, auth, {
            workspaceId,
            sessionId,
            ...(body.expectedEventOrdinal === undefined ? {} : { expectedEventOrdinal: body.expectedEventOrdinal }),
          })), idempotencyFingerprint(body))
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
      const key = idempotencyCacheKey({
        operation: "repair",
        principal: idempotencyPrincipal(auth),
        workspaceId,
        sessionId,
        key: body.idempotencyKey,
      })
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
        }), idempotencyFingerprint(body))
      return c.json(result)
    } catch (error) {
      return errorResponse(error)
    }
  })

  app.post("/runtime/register", async (c) => {
    try {
      const body = runtimeSnapshotInput.parse(await json(c.req.raw))
      assertRuntimeMutationAuth(c.req.raw, await authContext(c.req.raw, options), body.workspaceId)
      await registerControlRuntime(services, body)
      return c.json(ok())
    } catch (error) {
      return errorResponse(error)
    }
  })

  app.post("/runtime/heartbeat", async (c) => {
    try {
      const body = runtimeSnapshotInput.parse(await json(c.req.raw))
      assertRuntimeMutationAuth(c.req.raw, await authContext(c.req.raw, options), body.workspaceId)
      await heartbeatControlRuntime(services, body)
      return c.json(ok())
    } catch (error) {
      return errorResponse(error)
    }
  })

  return app
}

function idempotencyPrincipal(auth: ControlPlaneAuthContext) {
  if (auth.mode === "signed") return `signed:${auth.user.tokenIdentifier}`
  return `unsigned-local:${auth.reason}`
}
