import { Hono } from "hono"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { ConnectionsService } from "./service.js"
import type { ConnectionScope, IntegrationCapability } from "./types.js"
import { bool, record, stringRecord, text } from "./json.js"
import { CAPABILITIES } from "./ports/index.js"
import { ConnectionExistsError, ConnectionsUnavailableError, connectionScopeOf } from "./types.js"

export type RouteGate = (c: Context) => Promise<Response | null> | Response | null
export type RouteOwnerResolver = (c: Context) => string | undefined

/**
 * What a route admits, stated at the route rather than assembled inside its
 * handler.
 *
 *   - `public` — served to an unauthenticated caller. Only the OAuth
 *     callback, which a provider's browser redirect reaches and which carries
 *     its own single-use `state`.
 *   - `authenticated` — `gate`.
 *   - `turn-credential` — `gate`, then `tokenGate`: the caller proves a turn,
 *     not a management session.
 *   - `team-write` — `gate`, and `teamWriteGate` for a team-scoped target.
 *     Which target that is comes out of the request body or the stored row,
 *     so the handler decides it with the gate this policy hands it; the
 *     declaration is what makes a handler that never calls it visible.
 */
export const ROUTE_POLICIES = ["public", "authenticated", "turn-credential", "team-write"] as const
export type RoutePolicy = (typeof ROUTE_POLICIES)[number]

export type IntegrationsRouteOptions = {
  /**
   * Authorization for every gated route. Required — the kit ships no
   * implicit allow-all, so a host that intentionally serves unsigned
   * traffic (a loopback-only self-host, or an app that authenticated the
   * request upstream of these routes) states that policy by passing
   * `() => null`.
   */
  gate: RouteGate
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

function isCapability(value: string | undefined): value is IntegrationCapability {
  return !!value && (CAPABILITIES as readonly string[]).includes(value)
}

const CALLBACK_PAGE = (ok: boolean) =>
  `<!doctype html><html><body style="font-family:sans-serif;padding:2rem"><h2>${
    ok ? "Connection complete" : "Connection failed"
  }</h2><p>You can close this window and return to the app.</p></body></html>`

function scopeFrom(scope: unknown): ConnectionScope | undefined {
  if (scope === undefined) return "team"
  if (scope === "team" || scope === "personal") return scope
  return undefined
}

export function createIntegrationsRoutes(service: ConnectionsService, options: IntegrationsRouteOptions) {
  // Runtime fence for JS callers, which never see the type error: route
  // policy must be stated, so composition without a gate fails LOUDLY here
  // rather than silently serving unauthenticated management routes.
  if (typeof options?.gate !== "function") {
    throw new Error("createIntegrationsRoutes requires an explicit gate; pass () => null for intentionally open routes")
  }
  const app = new Hono()

  // The service decides `connection_exists` from a RETURNED code, having read
  // the partition first. A store that only discovers the duplicate at write
  // time — the race where two concurrent connects both read no existing row
  // and both mint a fresh id — can reach the client no other way than by
  // throwing, and without this the loser surfaced as a bare 500. Every other
  // cause is a real fault and is rethrown to the enclosing app unchanged.
  app.onError((cause, c) => {
    if (cause instanceof ConnectionExistsError) return c.json({ ok: false, code: "connection_exists" }, 409)
    throw cause
  })
  const gate = options.gate
  const tokenGate: RouteGate = options.tokenGate ?? (() => null)
  const teamWriteGate: RouteGate = options.teamWriteGate ?? (() => null)
  const refuseOwnerless = options.ownerlessRows === "refuse"

  /**
   * The one way a route reaches the app. The policy is an argument because a
   * route that forgot to state one must not register: `GET /callback` is the
   * single public route in this kit, and the next route added next to it
   * would otherwise inherit that silence by omission rather than by decision.
   */
  const declared = new Set<string>()
  // Generic in the path so the handler keeps Hono's literal `param()` typing:
  // a `string` parameter here would widen every `c.req.param("id")` in this
  // file to `string | undefined`.
  const route = <P extends string>(
    method: "get" | "post" | "delete",
    path: P,
    policy: RoutePolicy,
    handler: (c: Context<BlankEnv, P>, teamWrite: RouteGate) => Promise<Response> | Response,
  ) => {
    if (!(ROUTE_POLICIES as readonly string[]).includes(policy)) {
      throw new Error(`createIntegrationsRoutes: ${method.toUpperCase()} ${path} declares no route policy`)
    }
    declared.add(`${method.toUpperCase()} ${path}`)
    app[method](path, async (c) => {
      if (policy !== "public") {
        const denied = await gate(c)
        if (denied) return denied
      }
      if (policy === "turn-credential") {
        const denied = await tokenGate(c)
        if (denied) return denied
      }
      return handler(c, policy === "team-write" ? teamWriteGate : () => null)
    })
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

  route("get", "/", "authenticated", async (c) => {
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

  route("post", "/:id/connect", "team-write", async (c, teamWrite) => {
    const integrationId = c.req.param("id")
    const body = record(await c.req.json().catch(() => ({}))) ?? {}
    const confirmReplace = bool(body.confirmReplace)
    const secret = text(body.secret)
    const scope = scopeFrom(body.scope)
    if (!scope) return c.json({ ok: false, code: "invalid_connection_scope" }, 422)
    if (scope === "team") {
      const denied = await teamWrite(c)
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
        ...(confirmReplace !== undefined ? { confirmReplace } : {}),
      })
      if (!result.ok) return c.json(result, result.code === "connection_exists" ? 409 : 404)
      return c.json(result)
    }
    if (!secret?.trim()) {
      return c.json({ ok: false, code: "connection_verify_failed", reason: "unauthorized" }, 422)
    }
    const result = await service.connect({
      integrationId,
      ...(owner.owner !== undefined ? { owner: owner.owner } : {}),
      fields: stringRecord(body.fields),
      secret,
      ...(confirmReplace !== undefined ? { confirmReplace } : {}),
    })
    if (!result.ok) {
      const status = result.code === "connection_exists" ? 409 : result.code === "unknown_integration" ? 404 : 422
      return c.json(result, status)
    }
    return c.json(result)
  })

  route("get", "/callback", "public", async (c) => {
    const state = c.req.query("state") ?? ""
    const code = c.req.query("code")
    const issuer = c.req.query("iss")
    const outcome = state ? await service.handleCallback(state, code, issuer === undefined ? undefined : { issuer }) : { ok: false }
    return c.html(CALLBACK_PAGE(outcome.ok), outcome.ok ? 200 : 400)
  })

  // Polling this route is what ADVANCES a device grant — there is no callback
  // to settle it. For a redirect attempt the poll is a plain read, so the two
  // oauth shapes share one route and one client-side polling loop.
  route("get", "/attempts/:state", "authenticated", async (c) => {
    const status = await service.pollAttempt(c.req.param("state"))
    if (!status) return c.json({ code: "attempt_not_found" }, 404)
    return c.json(status)
  })

  route("delete", "/connections/:id", "team-write", async (c, teamWrite) => {
    const row = await visibleConnection(c.req.param("id"), managementKeys(c))
    if (!row) return c.json({ code: "connection_not_found" }, 404)
    if (connectionScopeOf(row.owner, managementKeys(c).team) === "team") {
      const denied = await teamWrite(c)
      if (denied) return denied
    }
    await service.remove(row.id)
    return c.json({ ok: true })
  })

  route("post", "/connections/:id/reverify", "team-write", async (c, teamWrite) => {
    const row = await visibleConnection(c.req.param("id"), managementKeys(c))
    if (!row) return c.json({ code: "connection_not_found" }, 404)
    if (connectionScopeOf(row.owner, managementKeys(c).team) === "team") {
      const denied = await teamWrite(c)
      if (denied) return denied
    }
    const result = await service.reverify(row.id)
    return c.json(result, result.ok ? 200 : 422)
  })

  route("get", "/connections/:id/repositories", "authenticated", async (c) => {
    const row = await visibleConnection(c.req.param("id"), managementKeys(c))
    if (!row) return c.json({ code: "connection_not_found" }, 404)
    const result = await service.listRepositories(row.id)
    if (!result.ok) return c.json({ code: result.code }, result.status)
    return c.json({ repositories: result.repositories })
  })

  route("post", "/connections/:id/auth-failure", "turn-credential", async (c) => {
    const row = await visibleConnection(c.req.param("id"), tokenKeys(c))
    if (!row) return c.json({ code: "connection_not_found" }, 404)
    const reason = text(record(await c.req.json().catch(() => ({})))?.reason)
    await service.reportAuthFailure(row.id, reason ?? "unspecified")
    return c.body(null, 204)
  })

  route("get", "/connections/:id/token", "turn-credential", async (c) => {
    const row = await visibleConnection(c.req.param("id"), tokenKeys(c))
    if (!row) return c.json({ code: "connection_not_found" }, 404)
    const capabilityRaw = c.req.query("capability")
    const capability = isCapability(capabilityRaw) ? capabilityRaw : undefined
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

  // A route that reached the app any other way — an `app.get` added beside
  // these — has no policy, and an unstated policy here reads as "open" at
  // every deployment. It fails the composition instead, on the first build,
  // rather than on the request that finds it.
  for (const registered of app.routes) {
    if (!declared.has(`${registered.method.toUpperCase()} ${registered.path}`)) {
      throw new Error(`createIntegrationsRoutes: ${registered.method} ${registered.path} declares no route policy`)
    }
  }

  return app
}
