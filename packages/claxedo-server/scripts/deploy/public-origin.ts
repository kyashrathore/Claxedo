export type PublicOriginRoute = "control-plane" | "relay" | "assets"

/** The relay answers under this prefix on the public origin; the relay itself sees the path without it. */
export const RELAY_PATH_PREFIX = "/relay"

const CONTROL_PLANE_PREFIXES = ["/api/", "/internal/", "/.well-known/"]

/** Which Worker a path of the public origin belongs to: the app's own assets unless the path is named here. */
export function publicOriginRoute(pathname: string): PublicOriginRoute {
  if (pathname === "/health" || CONTROL_PLANE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return "control-plane"
  if (pathname.startsWith(`${RELAY_PATH_PREFIX}/`)) return "relay"
  return "assets"
}

/** `run_worker_first` for the app's Wrangler config: every forwarded path, and the hashed assets whose fallback the Worker refuses. */
export const WORKER_FIRST_PATHS = ["/assets/*", "/api/*", "/internal/*", "/.well-known/*", "/health", `${RELAY_PATH_PREFIX}/*`]
