import { guardedWaitUntil } from "@claxedo/server-core/platform/http/background-work"
import type { RelayTargetLookup, RelayTargetResult } from "@claxedo/server-core/adapters/relay-port"
import { Hono } from "hono"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { ControlPlaneRequestTimeoutError } from "../../platform/runtime/timeout"
import type { WorkspaceAuthority } from "../../authority/services"
import { timingSafeEqualStrings } from "@claxedo/server-core/platform/auth/web-crypto"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import { trimToUndefined } from "@claxedo/helpers/string"


function authorized(request: Request, expected: string | undefined) {
  const header = request.headers.get("authorization")
  if (expected) {
    if (!header) return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (!match) return false
    return timingSafeEqualStrings(match[1].trim(), expected)
  }
  // Without a configured token, only loopback callers may use the resolver routes.
  return isLoopbackLocalRequest(request)
}

export type RuntimeAccessRevocationLookup = (args: {
  jti: string
  workspaceId: string
  hostId: string
}) => Promise<unknown>

/**
 * Result of resolving a relay target for a `(workspaceId, hostId)` pair.
 *
 * `found:true` carries the data the relay needs to reach the sandbox.
 * `found:false` carries a stable error code so the resolver can distinguish
 * "workspace unknown" (404) from "host known but not reachable yet" (409).
 *
 * A machine dials *out* to the relay, so for a workspace it serves `baseUrl`
 * may be empty — the relay routes by `hostId` over the established tunnel.
 */
export type { RelayTargetLookup, RelayTargetResult } from "@claxedo/server-core/adapters/relay-port"

export type LocalRelayTargetExists = (args: {
  workspaceId: string
  hostId: string
}) => Promise<boolean>

export type InternalRelayResolverOptions = {
  /**
   * Resolve the relay target for a `(workspaceId, hostId)` pair. Injected so the
   * route stays free of any local disk store: the Node/local server injects a
   * `workspace-store`-backed lookup, the hosted Worker injects a hosted-state
   * (the authority) lookup. When omitted the `/internal/relay/target` route fails
   * closed.
   */
  targetLookup?: RelayTargetLookup
  /**
   * Loopback-only fallback used by `/internal/relay/revocation` to treat a
   * locally-resolvable workspace target as active when signed-token storage has
   * not recorded it yet. Injected (Node/local only); hosted deployments omit it.
   */
  localTargetExists?: LocalRelayTargetExists
  /**
   * Lookup that returns the selected authority's runtime-token state:
   *   { active: true } | { active: false, code: string, reason: string }
   * When omitted, `authority` must be injected; otherwise revocation fails
   * closed without selecting a storage adapter inside this route module.
   */
  revocationLookup?: RuntimeAccessRevocationLookup
  authority?: WorkspaceAuthority
  resolverToken?: string
}

function defaultRevocationLookup(authority: WorkspaceAuthority): RuntimeAccessRevocationLookup {
  return (args) =>
    authority.runtimeAccessTokenActive({
      jti: args.jti,
      workspaceId: args.workspaceId,
      hostId: args.hostId,
    })
}

export function InternalRelayResolverRoutes(options: InternalRelayResolverOptions = {}) {
  const app = new Hono()

  const revocationLookup: RuntimeAccessRevocationLookup =
    options.revocationLookup ??
    (options.authority
      ? defaultRevocationLookup(options.authority)
      : async () => ({
          active: false,
          code: "runtime_access_token_lookup_unconfigured",
          reason: "Runtime Access Token revocation authority is not configured",
        }))

  app.use("/internal/relay/*", async (c, next) => {
    if (!authorized(c.req.raw, trimToUndefined(options.resolverToken))) {
      return c.json(
        errorBody("relay_resolver_unauthorized", "Relay resolver requires loopback access or a matching bearer token"),
        401,
      )
    }
    await next()
    return undefined
  })

  app.get("/internal/relay/target", async (c) => {
    const workspaceId = trimToUndefined(c.req.query("workspaceId"))
    const hostId = trimToUndefined(c.req.query("hostId"))
    if (!workspaceId || !hostId) {
      return c.json(errorBody("relay_resolver_target_required", "workspaceId and hostId are required"), 400)
    }
    if (!options.targetLookup) {
      return c.json(
        errorBody("relay_resolver_target_unconfigured", "Relay target resolution is not configured for this deployment"),
        501,
      )
    }
    const waitUntil = guardedWaitUntil(c)
    const target = await options.targetLookup({
      workspaceId,
      hostId,
      ...(waitUntil ? { waitUntil } : {}),
    }).catch((error) => {
      if (error instanceof ControlPlaneRequestTimeoutError) {
        return c.json(errorBody(error.code, error.message), error.status)
      }
      throw error
    })
    if (target instanceof Response) return target
    if (!target.found) {
      const status = target.code === "relay_resolver_workspace_not_found" ? 404 : 409
      const message =
        target.code === "relay_resolver_workspace_not_found"
          ? "Workspace not found"
          : "Workspace target is not available"
      return c.json(errorBody(target.code, message), status)
    }
    return c.json({
      workspaceId,
      hostId,
      baseUrl: target.baseUrl.replace(/\/+$/, ""),
      backing: target.backing,
      ...(target.upstreamHeaders ? { upstreamHeaders: target.upstreamHeaders } : {}),
    })
  })

  /**
   * The serving generation a host tunnel must carry to be admitted, read from
   * the same enrollment row the machine verifier reads. A paused enrollment
   * answers `revoked: true` as well: its beats are refused, so its tunnel
   * must close. 404 for an enrollment this authority does not know.
   */
  app.get("/internal/relay/host-generation", async (c) => {
    const enrollmentId = trimToUndefined(c.req.query("enrollmentId"))
    if (!enrollmentId) {
      return c.json(errorBody("relay_resolver_enrollment_required", "enrollmentId is required"), 400)
    }
    const lookup = options.authority?.machineAuth
    if (!lookup) {
      return c.json(
        errorBody("relay_resolver_host_generation_unconfigured", "Host generation lookup is not configured for this deployment"),
        501,
      )
    }
    const row = await lookup.lookupEnrollment(enrollmentId)
    if (!row) return c.json(errorBody("relay_resolver_enrollment_not_found", "Enrollment not found"), 404)
    return c.json({
      enrollmentId: row.enrollment_id,
      generation: row.serving_generation,
      revoked: row.revoked_at !== null || row.paused_at !== null,
    })
  })

  app.get("/internal/relay/revocation", async (c) => {
    const jti = trimToUndefined(c.req.query("jti"))
    const workspaceId = trimToUndefined(c.req.query("workspaceId"))
    const hostId = trimToUndefined(c.req.query("hostId"))
    if (!jti || !workspaceId || !hostId) {
      return c.json(errorBody("relay_resolver_revocation_required", "jti, workspaceId, and hostId are required"), 400)
    }

    try {
      const result = await revocationLookup({ jti, workspaceId, hostId })
      // Pass through whatever the selected authority returned. If for any reason the shape
      // is unexpected we fall back to fail-closed.
      if (result && typeof result === "object" && "active" in result) {
        if (
          result.active === false &&
          (asRecord(result) ?? {}).code === "runtime_access_token_workspace_not_found" &&
          !trimToUndefined(options.resolverToken) &&
          isLoopbackLocalRequest(c.req.raw) &&
          options.localTargetExists &&
          await options.localTargetExists({ workspaceId, hostId })
        ) {
          return c.json({ active: true })
        }
        return c.json(result as Record<string, unknown>)
      }
      return c.json({
        active: false,
        code: "runtime_access_token_lookup_invalid",
        reason: "Runtime Access Token lookup returned an unexpected shape",
      })
    } catch (err) {
      return c.json({
        active: false,
        code: "runtime_access_token_lookup_failed",
        reason: err instanceof Error ? err.message : "Runtime Access Token lookup failed",
      })
    }
  })

  return app
}

