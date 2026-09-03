import { Hono } from "hono"
import type { ControlPlaneTokenVerifier, ControlPlaneAuthConfig, SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import {
  pullHostedControlSession as pullControlSession,
  pullHostedControlSessionMessages as pullControlSessionMessages,
} from "../../authority/hosted-session-pull"
import type { ControlPlaneServices } from "../../authority/services"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  cachedIdempotency,
  idempotencyCacheKey,
  idempotencyFingerprint,
  lockKey,
  parseIdempotencyKey,
  serialized,
} from "../../authority/http/idempotency"
import { rec, signedOrError, txt } from "../../workspace/route-support"
type Options = {
  authentication?: RequestAuthenticationAdapter
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  cliTokenEnv?: Record<string, string | undefined>
}

class HostedControlError extends Error {
  constructor(message: string, readonly status: number, readonly code = "BAD_REQUEST") {
    super(message)
  }
}

function num(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function errorResponse(error: unknown) {
  if (error instanceof HostedControlError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
  }
  const row = rec(error)
  if (typeof row?.status === "number" && typeof row?.code === "string" && error instanceof Error) {
    return Response.json({ error: { code: row.code, message: error.message } }, { status: row.status })
  }
  const message = error instanceof Error ? error.message : String(error)
  return Response.json({
    error: {
      code: message.includes("required") ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR",
      message,
    },
  }, { status: message.includes("required") ? 400 : 500 })
}

function requireServices(services: ControlPlaneServices | undefined) {
  if (services) return services
  throw new HostedControlError("Control Plane services are not configured", 503, "CONTROL_PLANE_UNAVAILABLE")
}

function expectedEventOrdinal(input: unknown) {
  const value = rec(input)?.expectedEventOrdinal
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

async function json(req: Request) {
  const body = await req.json().catch(() => ({}))
  return rec(body) ?? {}
}

function workspaceId(input: unknown) {
  const id = txt(rec(input)?.workspaceId)
  if (id) return id
  throw new Error("workspaceId is required")
}

async function signedAuth(
  request: Request,
  services: ControlPlaneServices | undefined,
  options: Options,
) {
  const authResult = await signedOrError(request, {
    authentication: options.authentication,
    authConfig: options.authConfig,
    ...(options.verifier ? { verifier: options.verifier } : {}),
    ...(options.cliTokenEnv ? { cliTokenEnv: options.cliTokenEnv } : {}),
    requireSigned: true,
  }, services)
  if ("error" in authResult) {
    const body = rec(authResult.error)
    throw new HostedControlError(
      txt(rec(body?.error)?.message) ?? "Signed auth is required",
      authResult.status ?? 401,
      txt(rec(body?.error)?.code)?.toUpperCase() ?? "UNAUTHORIZED",
    )
  }
  if (!authResult.auth) throw new HostedControlError("Signed auth is required", 401, "UNAUTHORIZED")
  return authResult.auth
}

async function syncRuntime(
  services: ControlPlaneServices | undefined,
  auth: SignedControlPlaneAuth,
  input: unknown,
) {
  const id = workspaceId(input)
  await requireAuthority(services).usersMe(auth)
  await requireAuthority(services).openWorkspace(auth, { workspaceId: id })
}

export function HostedControlRoutes(
  services: ControlPlaneServices | undefined,
  options: Options = {},
) {
  const app = new Hono()
  const ok = () => ({ ok: true })

  app.post("/workspaces/:workspaceId/sessions/:sessionId/register", async (c) => {
    try {
      const auth = await signedAuth(c.req.raw, services, options)
      const body = await json(c.req.raw)
      const sessionId = c.req.param("sessionId")
      const workspaceId = c.req.param("workspaceId")
      const result = await cachedIdempotency(
        idempotencyCacheKey({
          operation: "register",
          principal: `signed:${auth.user.tokenIdentifier}`,
          workspaceId,
          sessionId,
          key: parseIdempotencyKey(body.idempotencyKey),
        }),
        () => serialized(lockKey(workspaceId, sessionId), () =>
          pullControlSession(requireServices(services), options, auth, { workspaceId, sessionId })),
        idempotencyFingerprint({
          reason: txt(body.reason),
          expectedEventOrdinal: expectedEventOrdinal(body),
        }),
      )
      return c.json(result)
    } catch (error) {
      return errorResponse(error)
    }
  })

  app.post("/workspaces/:workspaceId/sessions/:sessionId/checkpoint", async (c) => {
    try {
      const auth = await signedAuth(c.req.raw, services, options)
      const body = await json(c.req.raw)
      const workspaceId = c.req.param("workspaceId")
      const sessionId = c.req.param("sessionId")
      const eventOrdinal = expectedEventOrdinal(body)
      const result = await cachedIdempotency(
        idempotencyCacheKey({
          operation: "checkpoint",
          principal: `signed:${auth.user.tokenIdentifier}`,
          workspaceId,
          sessionId,
          key: parseIdempotencyKey(body.idempotencyKey),
        }),
        () => serialized(lockKey(workspaceId, sessionId), () =>
          pullControlSessionMessages(requireServices(services), options, auth, {
            workspaceId,
            sessionId,
            ...(eventOrdinal === undefined ? {} : { expectedEventOrdinal: eventOrdinal }),
          })),
        idempotencyFingerprint({
          reason: txt(body.reason),
          expectedEventOrdinal: eventOrdinal,
        }),
      )
      return c.json(result)
    } catch (error) {
      return errorResponse(error)
    }
  })

  app.post("/workspaces/:workspaceId/sessions/:sessionId/repair", async (c) => {
    try {
      const auth = await signedAuth(c.req.raw, services, options)
      const body = await json(c.req.raw)
      const control = requireServices(services)
      const workspaceId = c.req.param("workspaceId")
      const sessionId = c.req.param("sessionId")
      const eventOrdinal = expectedEventOrdinal(body)
      const result = await cachedIdempotency(
        idempotencyCacheKey({
          operation: "repair",
          principal: `signed:${auth.user.tokenIdentifier}`,
          workspaceId,
          sessionId,
          key: parseIdempotencyKey(body.idempotencyKey),
        }),
        () => serialized(lockKey(workspaceId, sessionId), async () => {
          const session = await pullControlSession(control, options, auth, { workspaceId, sessionId })
          const messages = await pullControlSessionMessages(control, options, auth, {
            workspaceId,
            sessionId,
            ...(eventOrdinal === undefined ? {} : { expectedEventOrdinal: eventOrdinal }),
          })
          return { ok: true, session, messages }
        }),
        idempotencyFingerprint({
          reason: txt(body.reason),
          expectedEventOrdinal: eventOrdinal,
        }),
      )
      return c.json(result)
    } catch (error) {
      return errorResponse(error)
    }
  })

  app.post("/runtime/register", async (c) => {
    try {
      await syncRuntime(services, await signedAuth(c.req.raw, services, options), await json(c.req.raw))
      return c.json(ok())
    } catch (error) {
      return errorResponse(error)
    }
  })

  app.post("/runtime/heartbeat", async (c) => {
    try {
      await syncRuntime(services, await signedAuth(c.req.raw, services, options), await json(c.req.raw))
      return c.json(ok())
    } catch (error) {
      return errorResponse(error)
    }
  })

  return app
}
