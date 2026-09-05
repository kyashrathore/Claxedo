import { Hono } from "hono"
import type { Context } from "hono"
import type { ConnectionsService } from "./service.js"
import type { ConnectionScope, IntegrationCapability } from "./types.js"
import { ConnectionsUnavailableError, connectionScopeOf } from "./types.js"

export type RouteGate = (c: Context) => Promise<Response | null> | Response | null
export type RouteOwnerResolver = (c: Context) => string | undefined

export type IntegrationsRouteOptions = {
  gate?: RouteGate
  tokenGate?: RouteGate
  /** Host authorization for organization/team mutations; personal writes do not use it. */
  teamWriteGate?: RouteGate
  /** Host-owned, non-secret callback routing frozen into OAuth attempts. */
  attemptRouting?: (context: Context) => Record<string, string>
  // Hosts resolve an authenticated subject to this opaque owner key. No
  // resolver means unsigned-local and therefore the team partition only.
  owner?: RouteOwnerResolver
  // Token callers prove their turn separately from management callers. An
  // omitted resolver safely grants team rows only.
  tokenOwner?: RouteOwnerResolver
  // Hosts that partition the team scope by an opaque key (e.g. a hosted
  // deployment's `org:{orgId}`) resolve it here per request. Absent resolver
  // (or an undefined result) keeps owner-absent as the team partition — the
  // self-host semantics, byte-identical.
  teamOwner?: RouteOwnerResolver
  // Team partition key for token/auth-failure callers (resolved from the
  // turn credential's tenant, never from the management principal).
  tokenTeamOwner?: RouteOwnerResolver
  // "team" (default): owner-absent rows are the deployment-wide team
  // partition, visible to every gated caller. "refuse": owner-absent rows
  // are never readable or writable through these routes — the hosted
  // invariant: a hosted host must derive its team partition from the
  // caller's org and refuse the null partition outright.
  ownerlessRows?: "team" | "refuse"
}

const CAPABILITIES: IntegrationCapability[] = ["docs", "work-source", "channel", "code-host", "mcp"]

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
  const refuseOwnerless = options.ownerlessRows === "refuse"

  const gated = async (c: Context, extra?: RouteGate) => {
    const denied = await gate(c)
    if (denied) return denied
    if (!extra) return null
    return extra(c)
  }

  type PartitionKeys = { personal?: string; team?: string }
  const managementKeys = (c: Context): PartitionKeys => ({
    personal: options.owner?.(c),
    team: options.teamOwner?.(c),
  })
  const tokenKeys = (c: Context): PartitionKeys => ({
    personal: options.tokenOwner?.(c),
    team: options.tokenTeamOwner?.(c),
  })

  // A row is visible when it belongs to the caller's team partition or the
  // caller's personal partition. Owner-absent rows are the team partition
  // ONLY while no team key is defined and the host has not refused the null
  // partition — a partitioned host must never surface them.
  const visibleConnection = async (id: string, keys: PartitionKeys) => {
    const row = await service.getById(id)
    if (!row) return undefined
    if (row.owner === undefined) {
      if (refuseOwnerless || keys.team !== undefined) return undefined
      return row
    }
    return row.owner === keys.team || row.owner === keys.personal ? row : undefined
  }

  const visibleTeamConnection = async (id: string, keys: PartitionKeys) => {
    const row = await visibleConnection(id, keys)
    if (!row) return { state: "missing" as const }
    const team = keys.team === undefined
      ? row.owner === undefined && !refuseOwnerless
      : row.owner === keys.team
    return team ? { state: "visible" as const, row } : { state: "personal" as const }
  }

  const connectOwner = (c: Context, scope: ConnectionScope) => {
    if (scope === "team") {
      const team = options.teamOwner?.(c)
      if (team !== undefined) return { ok: true as const, owner: team }
      // A host that refuses ownerless rows cannot accept a team write
      // without a resolved team partition key.
      if (refuseOwnerless) return { ok: false as const, code: "team_scope_requires_team_partition" as const }
      return { ok: true as const }
    }
    const owner = options.owner?.(c)
    if (owner === undefined) return { ok: false as const, code: "personal_scope_requires_signed_subject" as const }
    return { ok: true as const, owner }
  }

  app.get("/", async (c) => {
    const denied = await gated(c)
    if (denied) return denied
    const keys = managementKeys(c)
    // Refusing hosts without a resolved team key list personal rows only —
    // never the owner-absent partition.
    try {
      const connections =
        refuseOwnerless && keys.team === undefined
          ? keys.personal !== undefined
            ? await service.list({ owner: keys.personal, scope: "personal" })
            : []
          : await service.list({
              ...(keys.personal !== undefined ? { owner: keys.personal } : {}),
              ...(keys.team !== undefined ? { teamOwner: keys.team } : {}),
            })
      return c.json({
        integrations: service.listIntegrations(),
        connections,
        personalScopeEnabled: keys.personal !== undefined,
      })
    } catch (error) {
      if (error instanceof ConnectionsUnavailableError) return c.json({ code: "connections_unavailable" }, 503)
      throw error
    }
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
    if (scope === "team") {
      const denied = await options.teamWriteGate?.(c)
      if (denied) return denied
    }
    const owner = connectOwner(c, scope)
    if (!owner.ok) return c.json({ ok: false, code: owner.code }, 422)
    const teamKey = options.teamOwner?.(c)
    if (body.method === "oauth") {
      const result = await service.connectOAuth({
        integrationId,
        ...(owner.owner !== undefined ? { owner: owner.owner } : {}),
        ...(teamKey !== undefined ? { teamOwner: teamKey } : {}),
        ...(options.attemptRouting ? { attemptRouting: options.attemptRouting(c) } : {}),
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
    const issuer = c.req.query("iss")
    const outcome = state ? await service.handleCallback(state, code, issuer === undefined ? undefined : { issuer }) : { ok: false }
    return c.html(CALLBACK_PAGE(outcome.ok), outcome.ok ? 200 : 400)
  })

  // Polling this route is what ADVANCES a device grant — there is no callback
  // to settle it. For a redirect attempt the poll is a plain read, so the two
  // oauth shapes share one route and one client-side polling loop.
  app.get("/attempts/:state", async (c) => {
    const denied = await gated(c)
    if (denied) return denied
    const status = await service.pollAttempt(c.req.param("state"))
    if (!status) return c.json({ code: "attempt_not_found" }, 404)
    return c.json(status)
  })

  app.delete("/connections/:id", async (c) => {
    const denied = await gated(c)
    if (denied) return denied
    const row = await visibleConnection(c.req.param("id"), managementKeys(c))
    if (!row) return c.json({ code: "connection_not_found" }, 404)
    if (connectionScopeOf(row.owner, managementKeys(c).team) === "team") {
      const denied = await options.teamWriteGate?.(c)
      if (denied) return denied
    }
    await service.remove(row.id)
    return c.json({ ok: true })
  })

  app.post("/connections/:id/reverify", async (c) => {
    const denied = await gated(c)
    if (denied) return denied
    const row = await visibleConnection(c.req.param("id"), managementKeys(c))
    if (!row) return c.json({ code: "connection_not_found" }, 404)
    if (connectionScopeOf(row.owner, managementKeys(c).team) === "team") {
      const denied = await options.teamWriteGate?.(c)
      if (denied) return denied
    }
    const result = await service.reverify(row.id)
    return c.json(result, result.ok ? 200 : 422)
  })

  app.get("/connections/:id/repositories", async (c) => {
    const denied = await gated(c)
    if (denied) return denied
    const row = await visibleConnection(c.req.param("id"), managementKeys(c))
    if (!row) return c.json({ code: "connection_not_found" }, 404)
    const result = await service.listRepositories(row.id)
    if (!result.ok) return c.json({ code: result.code }, result.status)
    return c.json({ repositories: result.repositories })
  })

  app.put("/connections/:id/webhook-secret", async (c) => {
    const denied = await gated(c)
    if (denied) return denied
    const selected = await visibleTeamConnection(c.req.param("id"), managementKeys(c))
    if (selected.state === "missing") return c.json({ code: "connection_not_found" }, 404)
    if (selected.state === "personal") return c.json({ code: "team_connection_required" }, 403)
    const deniedTeamWrite = await options.teamWriteGate?.(c)
    if (deniedTeamWrite) return deniedTeamWrite
    const body = await c.req.json().catch(() => undefined) as { secret?: unknown } | undefined
    if (typeof body?.secret !== "string" || !body.secret.trim()) {
      return c.json({ ok: false, code: "invalid_webhook_secret" }, 422)
    }
    try {
      const result = await service.setWebhookSigningSecret(selected.row.id, body.secret)
      return c.json(result, result.ok ? 200 : 422)
    } catch (error) {
      if (error instanceof ConnectionsUnavailableError) return c.json({ ok: false, code: "connections_unavailable" }, 503)
      throw error
    }
  })

  app.delete("/connections/:id/webhook-secret", async (c) => {
    const denied = await gated(c)
    if (denied) return denied
    const selected = await visibleTeamConnection(c.req.param("id"), managementKeys(c))
    if (selected.state === "missing") return c.json({ code: "connection_not_found" }, 404)
    if (selected.state === "personal") return c.json({ code: "team_connection_required" }, 403)
    const deniedTeamWrite = await options.teamWriteGate?.(c)
    if (deniedTeamWrite) return deniedTeamWrite
    try {
      const result = await service.removeWebhookSigningSecret(selected.row.id)
      return c.json(result, result.ok ? 200 : 422)
    } catch (error) {
      if (error instanceof ConnectionsUnavailableError) return c.json({ ok: false, code: "connections_unavailable" }, 503)
      throw error
    }
  })

  app.post("/connections/:id/auth-failure", async (c) => {
    const denied = await gated(c, tokenGate)
    if (denied) return denied
    const row = await visibleConnection(c.req.param("id"), tokenKeys(c))
    if (!row) return c.json({ code: "connection_not_found" }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string }
    await service.reportAuthFailure(row.id, typeof body.reason === "string" ? body.reason : "unspecified")
    return c.body(null, 204)
  })

  app.get("/connections/:id/token", async (c) => {
    const denied = await gated(c, tokenGate)
    if (denied) return denied
    const row = await visibleConnection(c.req.param("id"), tokenKeys(c))
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
