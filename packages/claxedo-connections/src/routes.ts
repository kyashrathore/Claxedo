import { Hono } from "hono"
import type { Context } from "hono"
import type { ConnectionsService } from "./service.js"
import type { ConnectionScope, IntegrationCapability } from "./types.js"

export type RouteGate = (c: Context) => Promise<Response | null> | Response | null
export type RouteOwnerResolver = (c: Context) => string | undefined

export type IntegrationsRouteOptions = {
  gate?: RouteGate
  tokenGate?: RouteGate
  // Hosts resolve an authenticated subject to this opaque owner key. No
  // resolver means unsigned-local and therefore the team partition only.
  owner?: RouteOwnerResolver
  // Token callers prove their turn separately from management callers. An
  // omitted resolver safely grants team rows only.
  tokenOwner?: RouteOwnerResolver
}

const CAPABILITIES: IntegrationCapability[] = ["docs", "work-source", "channel", "code-host"]

const CALLBACK_PAGE = (ok: boolean) =>
  `<!doctype html><html><body style="font-family:sans-serif;padding:2rem"><h2>${
    ok ? "Connection complete" : "Connection failed"
  }</h2><p>You can close this window and return to the app.</p></body></html>`

function scopeFrom(body: { scope?: string }): ConnectionScope | undefined {
  if (body.scope === undefined) return "team"
  if (body.scope === "team" || body.scope === "personal") return body.scope
}

export function createIntegrationsRoutes(service: ConnectionsService, options: IntegrationsRouteOptions = {}) {
  const app = new Hono()
  const gate: RouteGate = options.gate ?? (() => null)
  const tokenGate: RouteGate = options.tokenGate ?? (() => null)

  const gated = async (c: Context, extra?: RouteGate) => {
    const denied = await gate(c)
    if (denied) return denied
    if (!extra) return null
    return extra(c)
  }

  const visibleConnection = async (id: string, owner: string | undefined) => {
    const row = await service.getById(id)
    if (!row || (row.owner !== undefined && row.owner !== owner)) return undefined
    return row
  }

  const connectOwner = (c: Context, scope: ConnectionScope) => {
    if (scope === "team") return { ok: true as const }
    const owner = options.owner?.(c)
    if (owner === undefined) return { ok: false as const }
    return { ok: true as const, owner }
  }

  app.get("/", async (c) => {
    const denied = await gated(c)
    if (denied) return denied
    const owner = options.owner?.(c)
    return c.json({
      integrations: service.listIntegrations(),
      connections: await service.list({ owner }),
      personalScopeEnabled: owner !== undefined,
    })
  })

  app.post("/:id/connect", async (c) => {
    const denied = await gated(c)
    if (denied) return denied
    const integrationId = c.req.param("id")
    const body = (await c.req.json().catch(() => ({}))) as {
      method?: string
      fields?: Record<string, string>
      secret?: string
      confirmReplace?: boolean
      scope?: string
    }
    const scope = scopeFrom(body)
    if (!scope) return c.json({ ok: false, code: "invalid_connection_scope" }, 422)
    const owner = connectOwner(c, scope)
    if (!owner.ok) return c.json({ ok: false, code: "personal_scope_requires_signed_subject" }, 422)
    if (body.method === "oauth") {
      const result = await service.connectOAuth({
        integrationId,
        ...(owner.owner !== undefined ? { owner: owner.owner } : {}),
        ...(body.confirmReplace !== undefined ? { confirmReplace: body.confirmReplace } : {}),
      })
      if (!result.ok) return c.json(result, result.code === "connection_exists" ? 409 : 404)
      return c.json(result)
    }
    if (typeof body.secret !== "string" || !body.secret.trim()) {
      return c.json({ ok: false, code: "connection_verify_failed", reason: "unauthorized" }, 422)
    }
    const result = await service.connect({
      integrationId,
      ...(owner.owner !== undefined ? { owner: owner.owner } : {}),
      fields: body.fields ?? {},
      secret: body.secret,
      ...(body.confirmReplace !== undefined ? { confirmReplace: body.confirmReplace } : {}),
    })
    if (!result.ok) {
      const status = result.code === "connection_exists" ? 409 : result.code === "unknown_integration" ? 404 : 422
      return c.json(result, status)
    }
    return c.json(result)
  })

  app.get("/callback", async (c) => {
    const state = c.req.query("state") ?? ""
    const code = c.req.query("code")
    const outcome = state ? await service.handleCallback(state, code) : { ok: false }
    return c.html(CALLBACK_PAGE(outcome.ok), outcome.ok ? 200 : 400)
  })

  app.get("/attempts/:state", async (c) => {
    const denied = await gated(c)
    if (denied) return denied
    const status = service.attemptStatus(c.req.param("state"))
    if (!status) return c.json({ code: "attempt_not_found" }, 404)
    return c.json(status)
  })

  app.delete("/connections/:id", async (c) => {
    const denied = await gated(c)
    if (denied) return denied
    const row = await visibleConnection(c.req.param("id"), options.owner?.(c))
    if (!row) return c.json({ code: "connection_not_found" }, 404)
    await service.remove(row.id)
    return c.json({ ok: true })
  })

  app.post("/connections/:id/reverify", async (c) => {
    const denied = await gated(c)
    if (denied) return denied
    const row = await visibleConnection(c.req.param("id"), options.owner?.(c))
    if (!row) return c.json({ code: "connection_not_found" }, 404)
    const result = await service.reverify(row.id)
    return c.json(result, result.ok ? 200 : 422)
  })

  app.post("/connections/:id/auth-failure", async (c) => {
    const denied = await gated(c, tokenGate)
    if (denied) return denied
    const row = await visibleConnection(c.req.param("id"), options.tokenOwner?.(c))
    if (!row) return c.json({ code: "connection_not_found" }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string }
    await service.reportAuthFailure(row.id, typeof body.reason === "string" ? body.reason : "unspecified")
    return c.body(null, 204)
  })

  app.get("/connections/:id/token", async (c) => {
    const denied = await gated(c, tokenGate)
    if (denied) return denied
    const row = await visibleConnection(c.req.param("id"), options.tokenOwner?.(c))
    if (!row) return c.json({ code: "connection_not_found" }, 404)
    const capabilityRaw = c.req.query("capability")
    const capability = CAPABILITIES.includes(capabilityRaw as IntegrationCapability)
      ? (capabilityRaw as IntegrationCapability)
      : undefined
    const result = await service.getToken(row.id, capability)
    if (!result.ok) {
      return c.json(
        {
          code: result.code,
          ...(result.credentialStatus !== undefined ? { status: result.credentialStatus } : {}),
        },
        result.status,
      )
    }
    return c.json(result.response)
  })

  return app
}
