import type { MiddlewareHandler } from "hono"
import {
  ControlPlaneAuthError,
  controlPlaneAuthConfig,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "../authority/auth"

/**
 * The per-route bearer gate for control-plane routers that have no finer-grained
 * authorization of their own.
 *
 * This exists because "no auth options passed at the mount site" is silently
 * safe in one deployment posture and silently open in another, which is a very
 * easy thing to miss in review. `unsignedLocalRequestGuard` returns `next()`
 * immediately when `authConfig.enabled` — by design, because per-route bearer
 * verification is supposed to take over from there. A router that never
 * implemented that verification is therefore protected only by the loopback
 * guard, and only while the box is unsigned. Self-host deployments enable signed
 * auth (`CLAXEDO_EMBEDDED_AUTH=1`) precisely in order to be reachable remotely,
 * so that is exactly when the protection disappears.
 *
 * Policy, matching `network-policy.ts` / `remote-access.ts`:
 * - unsigned local-only → pass, whatever the Authorization header says; the
 *   global loopback guard is the gate and requiring a bearer here would break
 *   the desktop app.
 * - `misconfigured` (signed auth requested but its env is incomplete) → 503,
 *   raised by `controlPlaneAuthContext`. Fails closed, deliberately.
 * - signed → a verified signed identity is required.
 *
 * The unsigned-local branch ignores the bearer instead of rejecting it because
 * in that posture no bearer can ever succeed: `controlPlaneAuthContext`
 * short-circuits on `!config.enabled` and returns `unsigned-local`, so the
 * `mode !== "signed"` check below is unsatisfiable and every token — valid,
 * stale, or nonsense — became a 401. This gate skipped its pass-through the
 * moment ANY Authorization header was present, so an anonymous caller was
 * served while the same caller presenting a token was refused, and refused with
 * `missing_bearer_token`, which was not true of a request that carried one.
 * That is not a gate (drop the header and walk in) and the inaccurate code sent
 * readers hunting for a token that was already there. Ignoring the header is
 * what `network-policy.ts`'s `routeAuth` already resolves this case to.
 */
export type ControlPlaneRouteAuthOptions = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
}

export async function requireSignedControlPlaneRoute(
  request: Request,
  options: ControlPlaneRouteAuthOptions,
) {
  const config = options.authConfig ?? controlPlaneAuthConfig()
  if (!config.enabled && config.mode === "local-only") return
  const context = await controlPlaneAuthContext(request, {
    config,
    ...(options.verifier ? { verifier: options.verifier } : {}),
  })
  // Belt and braces, not the live refusal path: past the early return the config
  // is either `misconfigured` (503 from the call above) or enabled, and enabled
  // only ever returns a signed context or throws its own accurate 401
  // (`missing_bearer_token` / `invalid_bearer_token`). This catches a verifier
  // that resolves to something else.
  if (context.mode !== "signed") {
    throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
  }
}

/**
 * Hono middleware form. Mount it path-scoped — `.use("/provider/*", ...)`, or
 * once per route path as `opencode-compat.ts` does — NOT as `.use("*", ...)`
 * unless the router is mounted under a prefix of its own. `app.route("/", sub)`
 * re-registers a sub-app's middleware onto the parent router, so a `"*"`
 * middleware inside a router mounted at `/` also runs for every parent route
 * registered after it, and would reject callers that authenticate with
 * something other than a control-plane bearer (installation tokens, runtime
 * access tokens).
 */
export function controlPlaneRouteAuth(options: ControlPlaneRouteAuthOptions): MiddlewareHandler {
  return async (c, next) => {
    try {
      await requireSignedControlPlaneRoute(c.req.raw, options)
    } catch (err) {
      if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
      throw err
    }
    await next()
  }
}
