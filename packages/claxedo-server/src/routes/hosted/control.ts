import { Hono } from "hono"
import type { ControlPlaneTokenVerifier, ControlPlaneAuthConfig, SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import {
  pullHostedControlSession as pullControlSession,
  pullHostedControlSessionMessages as pullControlSessionMessages,
} from "../../authority/hosted-session-sync"
import type { ControlPlaneServices } from "../../authority/services"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  type IdempotencyCoordinator,
  idempotencyCacheKey,
  idempotencyFingerprint,
  lockKey,
  parseIdempotencyKey,
  serialized,
} from "../../authority/http/idempotency"
import { signedOrError, txt } from "../../workspace/route-support"
import { asRecord } from "@claxedo/server-core/platform/json/index"
type Options = {
  authentication?: RequestAuthenticationAdapter
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  cliTokenEnv?: Record<string, string | undefined>
  idempotency: IdempotencyCoordinator
}

class HostedControlError extends Error {
  constructor(message: string, readonly status: number, readonly code = "BAD_REQUEST") {
    super(message)
  }
}

function errorResponse(error: unknown) {
  if (error instanceof HostedControlError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
  }
  const row = asRecord(error)
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
  const value = asRecord(input)?.expectedEventOrdinal
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

async function json(req: Request) {
  const body = await req.json().catch(() => ({}))
  return asRecord(body) ?? {}
}

function workspaceId(input: unknown) {
  const id = txt(asRecord(input)?.workspaceId)
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
    const body = asRecord(authResult.error)
    throw new HostedControlError(
      txt(asRecord(body?.error)?.message) ?? "Signed auth is required",
      authResult.status ?? 401,
      txt(asRecord(body?.error)?.code)?.toUpperCase() ?? "UNAUTHORIZED",
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
  options: Options,
) {
  const app = new Hono()
  const ok = () => ({ ok: true })

  for (const operation of ["register", "checkpoint", "repair"] as const) {
    app.post(`/workspaces/:workspaceId/sessions/:sessionId/${operation}`, async (c) => {
      try {
        const auth = await signedAuth(c.req.raw, services, options)
        const body = await json(c.req.raw)
        const workspaceId = c.req.param("workspaceId")
        const sessionId = c.req.param("sessionId")
        const eventOrdinal = expectedEventOrdinal(body)
        const input = { workspaceId, sessionId, ...(eventOrdinal === undefined ? {} : { expectedEventOrdinal: eventOrdinal }) }
        const result = await options.idempotency.run(
          idempotencyCacheKey({
            operation,
            principal: `signed:${auth.user.tokenIdentifier}`,
            workspaceId,
            sessionId,
            key: parseIdempotencyKey(body.idempotencyKey),
          }),
          () => serialized(lockKey(workspaceId, sessionId), async () => {
            const control = requireServices(services)
            if (operation === "register") return pullControlSession(control, options, auth, { workspaceId, sessionId })
            if (operation === "checkpoint") return pullControlSessionMessages(control, options, auth, input)
            const session = await pullControlSession(control, options, auth, { workspaceId, sessionId })
            const messages = await pullControlSessionMessages(control, options, auth, input)
            return { ok: true, session, messages }
          }),
          idempotencyFingerprint({ reason: txt(body.reason), expectedEventOrdinal: eventOrdinal }),
        )
        return c.json(result)
      } catch (error) {
        return errorResponse(error)
      }
    })
  }

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
