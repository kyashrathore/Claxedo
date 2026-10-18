export type PublicOriginRoute = "control-plane" | "relay" | "assets"

/** The relay answers under this prefix on the public origin; the relay itself sees the path without it. */
export const RELAY_PATH_PREFIX = "/relay"

/**
 * Every path the control plane mounts outside `/api`: the relay resolver, the
 * OAuth metadata and JWKS, the egress broker a sandbox's vendor calls go
 * through, the deploy's health probe and the daemon-shaped `/global/health` and
 * `/path` the app reads on every server. `hosted-core-app.test.ts` checks the
 * control plane's routes against this list, so a new mount fails there before
 * a deploy loses it behind the app's single-page fallback.
 */
const CONTROL_PLANE_PREFIXES = ["/api/", "/internal/", "/.well-known/", "/bindings/"]
const CONTROL_PLANE_PATHS = ["/health", "/global/health", "/path"]

/** Which Worker a path of the public origin belongs to: the app's own assets unless the path is named here. */
export function publicOriginRoute(pathname: string): PublicOriginRoute {
  if (CONTROL_PLANE_PATHS.includes(pathname) || CONTROL_PLANE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return "control-plane"
  if (pathname.startsWith(`${RELAY_PATH_PREFIX}/`)) return "relay"
  return "assets"
}

/** `run_worker_first` for the app's Wrangler config: every forwarded path, and the hashed assets whose fallback the Worker refuses. */
export const WORKER_FIRST_PATHS = ["/assets/*", ...CONTROL_PLANE_PREFIXES.map((prefix) => `${prefix}*`), ...CONTROL_PLANE_PATHS, `${RELAY_PATH_PREFIX}/*`]
