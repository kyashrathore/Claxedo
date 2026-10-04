/**
 * Strips the brackets off an IPv6 literal so `[::1]` and `::1` normalize alike.
 * RFC 3986 brackets an IPv6 literal and nothing else, so an unbalanced `[::1`
 * and a bracketed IPv4 `[127.0.0.1]` are malformed and keep their brackets —
 * stripping those would let a malformed `Host` normalize into a loopback match.
 */
function normalizeHostname(hostname: string | undefined | null): string {
  const value = (hostname ?? "").trim().toLowerCase()
  if (value.startsWith("[") && value.endsWith("]") && value.includes(":")) return value.slice(1, -1)
  return value
}

/**
 * The loopback host itself and nothing else — not `*.localhost`, not the rest
 * of 127.0.0.0/8, not `::` or `0.0.0.0`. Broadening this is fail-OPEN: it gates
 * unsigned-local trust on a client-settable `Host` header.
 */
export function isLoopbackHostname(hostname: string | undefined | null): boolean {
  const normalized = normalizeHostname(hostname)
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1"
}

/**
 * Loopback plus `*.localhost`. Only claxedo-server-core needs it today, and it
 * stays separate from isLoopbackHostname anyway: broadening HERE is fail-SAFE,
 * because it only makes the server treat a request as plaintext, so HSTS is
 * never stamped on a developer's `.localhost` origin.
 */
export function isLocalDevelopmentHostname(hostname: string | undefined | null): boolean {
  return isLoopbackHostname(hostname) || normalizeHostname(hostname).endsWith(".localhost")
}

/**
 * "Is this server this machine's own, so requests to it need no signed-web
 * auth". The https: arm is deliberate here and must NOT be copied into a
 * callback-target check. WHATWG URL always yields the bracketed `[::1]`.
 */
export function isLoopbackHttpUrl(input: string | undefined): boolean {
  if (!input) return false
  try {
    const url = new URL(input)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  } catch {
    return false
  }
}

/**
 * Joins a PATH onto a base; an input that parses as an absolute URL is
 * rejected, because `new URL` would otherwise let it replace the base.
 *
 * Both normalizations are load-bearing: stripping leading slashes from the
 * pathname keeps a base that already carries a path from being reset to its
 * origin, and forcing exactly one trailing slash on the base keeps `new URL`
 * from dropping the base's last segment.
 */
export function joinUrl(base: string, pathname: string): string {
  // WHATWG also reads `\` as a separator on special schemes, so stripping only
  // `/` would leave `\\host` able to retarget the join.
  const segment = pathname.replace(/^[\\/]+/, "")
  if (URL.canParse(segment)) throw new Error(`joinUrl takes a path, not an absolute URL: ${JSON.stringify(pathname)}`)
  return new URL(segment, `${base.replace(/\/+$/, "")}/`).toString()
}

/** Does not preserve a lone root: "/" and "///" both return "". */
export function stripTrailingSlashes(value: string): string {
  return value.trim().replace(/\/+$/, "")
}
