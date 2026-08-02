import { Hono, type Context } from "hono"
import { isLoopbackLocalRequest } from "./local-only-projection"
import { errorBody } from "./http"
import { createConvexAuthority } from "../control-plane/adapters/convex/authority"
import { ControlPlaneRequestTimeoutError } from "../control-plane/adapters/convex/timeout"
import type { WorkspaceAuthority } from "../control-plane/services"
import { timingSafeEqualStrings } from "../control-plane/web-crypto"

function clean(input: string | undefined) {
  const value = input?.trim()
  return value ? value : undefined
}

function authorized(request: Request, expected: string | undefined) {
  const header = request.headers.get("authorization")
  if (expected) {
    if (!header) return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (!match) return false
    return timingSafeEqualStrings(match[1]!.trim(), expected)
  }
  // Without a configured token, only loopback callers may use the resolver routes.
  return isLoopbackLocalRequest(request)
}

/**
 * Worker-safe background scheduler: on Cloudflare Workers this is
 * `executionCtx.waitUntil` (keeps fire-and-forget work alive past the
 * response); on Node `executionCtx` throws, so callers fall back to `void`.
 */
function guardedWaitUntil(c: Context): ((promise: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx
    if (typeof ctx?.waitUntil !== "function") return undefined
    return (promise) => ctx.waitUntil(promise)
  } catch {
    return undefined
  }
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
 * For user-hosted workspaces the host dials *out* to the relay, so `baseUrl`
 * may be empty — the relay routes by `hostId` over the established tunnel.
 */
export type RelayTargetResult =
  | {
      found: true
      baseUrl: string
      access: "cloud" | "user-hosted"
      backing: "cloud-vm" | "local-worktree"
      upstreamHeaders?: Record<string, string>
    }
  | {
      found: false
      code: "relay_resolver_workspace_not_found" | "relay_resolver_workspace_target_unavailable"
    }

export type RelayTargetLookup = (args: {
  workspaceId: string
  hostId: string
  /**
   * When provided (Cloudflare Worker), background work spawned by the lookup
   * (sandbox touch + its telemetry) should be scheduled through this so the
   * runtime does not cancel it after the response is returned.
   */
  waitUntil?: (promise: Promise<unknown>) => void
}) => Promise<RelayTargetResult>

export type LocalRelayTargetExists = (args: {
  workspaceId: string
  hostId: string
}) => Promise<boolean>

export type InternalRelayResolverOptions = {
  /**
   * Resolve the relay target for a `(workspaceId, hostId)` pair. Injected so the
   * route stays free of any local disk store: the Node/local server injects a
   * `workspace-store`-backed lookup, the hosted Worker injects a hosted-state
   * (Convex) lookup. When omitted the `/internal/relay/target` route fails
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
   * Lookup that returns the Convex `runtimeAccessTokens.active` shape:
   *   { active: true } | { active: false, code: string, reason: string }
   * Defaults to the shared ConvexAuthority instance.
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

  let cachedAuthority: WorkspaceAuthority | undefined = options.authority
  const revocationLookup: RuntimeAccessRevocationLookup =
    options.revocationLookup ??
    ((args) => {
      if (!cachedAuthority) cachedAuthority = createConvexAuthority()
      return defaultRevocationLookup(cachedAuthority)(args)
    })

  app.use("/internal/relay/*", async (c, next) => {
    if (!authorized(c.req.raw, clean(options.resolverToken))) {
      return c.json(
        errorBody("relay_resolver_unauthorized", "Relay resolver requires loopback access or a matching bearer token"),
        401,
      )
    }
    await next()
  })

  app.get("/internal/relay/target", async (c) => {
    const workspaceId = clean(c.req.query("workspaceId"))
    const hostId = clean(c.req.query("hostId"))
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
      access: target.access,
      backing: target.backing,
      ...(target.upstreamHeaders ? { upstreamHeaders: target.upstreamHeaders } : {}),
    })
  })

  app.get("/internal/relay/revocation", async (c) => {
    const jti = clean(c.req.query("jti"))
    const workspaceId = clean(c.req.query("workspaceId"))
    const hostId = clean(c.req.query("hostId"))
    if (!jti || !workspaceId || !hostId) {
      return c.json(errorBody("relay_resolver_revocation_required", "jti, workspaceId, and hostId are required"), 400)
    }

    try {
      const result = await revocationLookup({ jti, workspaceId, hostId })
      // Pass through whatever the Convex query returned. If for any reason the shape
      // is unexpected we fall back to fail-closed.
      if (result && typeof result === "object" && "active" in result) {
        if (
          result.active === false &&
          rec(result).code === "runtime_access_token_workspace_not_found" &&
          !clean(options.resolverToken) &&
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

function rec(input: unknown) {
  return input && typeof input === "object" ? input as Record<string, unknown> : {}
}
