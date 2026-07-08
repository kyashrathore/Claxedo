import { Hono } from "hono"
import type { ClerkVerifier, ControlPlaneAuthConfig, SignedControlPlaneAuth } from "../control-plane/auth"
import {
  pullHostedControlSession as pullControlSession,
  pullHostedControlSessionMessages as pullControlSessionMessages,
} from "../control-plane/hosted-session-pull"
import type { ControlPlaneServices } from "../control-plane/services"
import { requireAuthority } from "../control-plane/authority"
import { rec, signedOrError, txt } from "./workspace-user-hosted"

type Options = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  cliTokenEnv?: Record<string, string | undefined>
}

class HostedControlError extends Error {
  constructor(message: string, readonly status: number, readonly code = "BAD_REQUEST") {
    super(message)
  }
}

const pullLocks = new Map<string, Promise<unknown>>()
const pullResults = new Map<string, { expiresAt: number; value: unknown }>()

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

function idempotencyKey(input: unknown) {
  return txt(rec(input)?.idempotencyKey)
}

function expectedEventOrdinal(input: unknown) {
  const value = rec(input)?.expectedEventOrdinal
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function pullKey(workspaceId: string, sessionId: string) {
  return `${workspaceId}\0${sessionId}`
}

async function serialized<T>(key: string, run: () => Promise<T>) {
  const previous = pullLocks.get(key)
  const next = (previous ?? Promise.resolve()).catch(() => undefined).then(run)
  pullLocks.set(key, next)
  try {
    return await next
  } finally {
    if (pullLocks.get(key) === next) pullLocks.delete(key)
  }
}

function cached<T>(key: string | undefined, run: () => Promise<T>) {
  if (!key) return run()
  const hit = pullResults.get(key)
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value as T)
  return run().then((value) => {
    pullResults.set(key, { expiresAt: Date.now() + 5 * 60_000, value })
    return value
  })
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
      const result = await cached(
        idempotencyKey(body) ? `register:${workspaceId}:${sessionId}:${idempotencyKey(body)}` : undefined,
        () => serialized(pullKey(workspaceId, sessionId), () =>
          pullControlSession(requireServices(services), options, auth, { workspaceId, sessionId })),
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
      const result = await cached(
        idempotencyKey(body) ? `checkpoint:${workspaceId}:${sessionId}:${idempotencyKey(body)}` : undefined,
        () => serialized(pullKey(workspaceId, sessionId), () =>
          pullControlSessionMessages(requireServices(services), options, auth, {
            workspaceId,
            sessionId,
            ...(eventOrdinal === undefined ? {} : { expectedEventOrdinal: eventOrdinal }),
          })),
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
      const result = await cached(
        idempotencyKey(body) ? `repair:${workspaceId}:${sessionId}:${idempotencyKey(body)}` : undefined,
        () => serialized(pullKey(workspaceId, sessionId), async () => {
          const session = await pullControlSession(control, options, auth, { workspaceId, sessionId })
          const messages = await pullControlSessionMessages(control, options, auth, {
            workspaceId,
            sessionId,
            ...(eventOrdinal === undefined ? {} : { expectedEventOrdinal: eventOrdinal }),
          })
          return { ok: true, session, messages }
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
