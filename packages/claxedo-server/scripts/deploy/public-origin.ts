export type PublicOriginRoute = "control-plane" | "relay" | "assets"

/** The relay answers under this prefix on the public origin; the relay itself sees the path without it. */
export const RELAY_PATH_PREFIX = "/relay"

/**
 * Every path the control plane serves on the public origin: `/api`, the relay
 * resolver under `/internal`, the OAuth metadata and JWKS, the egress broker a
 * sandbox's vendor calls go through, the deploy's health probe and the
 * daemon-shaped `/global/health` and `/path` the app reads on every server.
 * Each is a prefix because it becomes a Worker route `<host><prefix>*`, and
 * route matching "considers the entire request URL, including the query
 * parameter string" while a pattern "may not contain any query parameters"
 * (developers.cloudflare.com/workers/configuration/routing/routes/), so
 * `/path?directory=…` is reachable only through `/path*`. `hosted-core-app.test.ts`
 * checks the control plane's mounts against this list, so a new mount fails
 * there before a deploy loses it behind the app's single-page fallback.
 */
const CONTROL_PLANE_PREFIXES = ["/api/", "/internal/", "/.well-known/", "/bindings/", "/health", "/global/health", "/path"]

/** Which Worker a path of the public origin belongs to: the app's own assets unless the path is named here. */
export function publicOriginRoute(pathname: string): PublicOriginRoute {
  if (CONTROL_PLANE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return "control-plane"
  if (pathname.startsWith(`${RELAY_PATH_PREFIX}/`)) return "relay"
  return "assets"
}

/** The Worker routes that put the control plane on the public origin's host, one per prefix. */
export function controlPlaneRoutePatterns(host: string): string[] {
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error(`the public origin's host must be a bare hostname, got ${JSON.stringify(host)}`)
  return CONTROL_PLANE_PREFIXES.map((prefix) => `${host}${prefix}*`)
}
