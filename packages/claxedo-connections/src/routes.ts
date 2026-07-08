// HTTP surface as a Hono router factory. The kit implements NO auth policy:
// hosts inject gates. `gate` runs on every route; `tokenGate` additionally
// on the token and auth-failure routes (the host puts its strongest checks
// there — e.g. loopback + custom header).
import { Hono } from "hono"
import type { Context } from "hono"
import type { ConnectionsService } from "./service.js"
import type { IntegrationCapability } from "./types.js"

export type RouteGate = (c: Context) => Promise<Response | null> | Response | null

export type IntegrationsRouteOptions = {
  gate?: RouteGate
  tokenGate?: RouteGate
}

const CAPABILITIES: IntegrationCapability[] = ["docs", "work-source", "channel", "code-host"]

// Fixed static pages: never a redirect, never echoes request parameters —
// the UI learns the outcome by polling attempt status.
const CALLBACK_PAGE = (ok: boolean) =>
  `<!doctype html><html><body style="font-family:sans-serif;padding:2rem"><h2>${
    ok ? "Connection complete" : "Connection failed"
  }</h2><p>You can close this window and return to the app.</p></body></html>`

export function createIntegrationsRoutes(service: ConnectionsService, options: IntegrationsRouteOptions = {}) {
  const app = new Hono()
  const gate: RouteGate = options.gate ?? (() => null)
  const tokenGate: RouteGate = options.tokenGate ?? (() => null)

  const gated = async (c: Context, extra?: RouteGate) => {
    const denied = await gate(c)
    if (denied) return denied
    if (extra) {
      const deniedExtra = await extra(c)
      if (deniedExtra) return deniedExtra
    }
    return null
  }

  app.get("/", async (c) => {
    const denied = await gated(c)
    if (denied) return denied
    return c.json({ integrations: service.listIntegrations(), connections: await service.list() })
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
    }
    if (body.method === "oauth") {
      const result = await service.connectOAuth({
        integrationId,
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
    // The callback arrives from the user's browser via the provider redirect;
    // attempt-state single-use + TTL are the guards here (plan), not the gate.
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
    const removed = await service.remove(c.req.param("id"))
    return removed ? c.json({ ok: true }) : c.json({ code: "connection_not_found" }, 404)
  })

  app.post("/connections/:id/reverify", async (c) => {
    const denied = await gated(c)
    if (denied) return denied
    const result = await service.reverify(c.req.param("id"))
    return c.json(result, result.ok ? 200 : 422)
  })

  app.post("/connections/:id/auth-failure", async (c) => {
    const denied = await gated(c, tokenGate)
    if (denied) return denied
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string }
    await service.reportAuthFailure(c.req.param("id"), typeof body.reason === "string" ? body.reason : "unspecified")
    return c.body(null, 204)
  })

  app.get("/connections/:id/token", async (c) => {
    const denied = await gated(c, tokenGate)
    if (denied) return denied
    const capabilityRaw = c.req.query("capability")
    const capability = CAPABILITIES.includes(capabilityRaw as IntegrationCapability)
      ? (capabilityRaw as IntegrationCapability)
      : undefined
    const result = await service.getToken(c.req.param("id"), capability)
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
