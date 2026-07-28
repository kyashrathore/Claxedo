import type { MiddlewareHandler } from "hono"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthConfig,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "../control-plane/auth"

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
 * - unsigned local-only with no bearer presented → pass; the global loopback
 *   guard is the gate and requiring a bearer here would break the desktop app.
 * - anything else → a verified signed identity is required.
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
  if (!config.enabled && config.mode === "local-only" && !bearerToken(request.headers.get("authorization"))) return
  const context = await controlPlaneAuthContext(request, {
    config,
    ...(options.verifier ? { verifier: options.verifier } : {}),
  })
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
