// Browser-origin allowlist policy shared by the Bun adapter and the
// Cloudflare adapter. The relay ships with Claxedo's own app origins as the
// DEFAULT list, but a self-hosted deployment can fully REPLACE that list with
// `allowedOrigins` (Bun options) / `CLAXEDO_RELAY_ALLOWED_ORIGINS` (env) —
// the built-in product domains are a default, not a hardwired grant.
//
// Pattern grammar (comma-separated in env form):
//   https://app.example.com     exact origin match
//   https://*.example.com       any subdomain of example.com (not the apex)
//   http://localhost:*          any localhost port (dev)
//   http://127.0.0.1:*          any loopback port (dev)

export const DEFAULT_RELAY_APP_ORIGINS = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "https://claxedo.com",
  "https://*.claxedo.com",
]

export function parseAllowedOrigins(raw: string | undefined): string[] | undefined {
  const entries = (raw ?? "").split(",").map((item) => item.trim()).filter(Boolean)
  return entries.length ? entries : undefined
}

export function createOriginMatcher(patterns: string[]): (origin: string) => boolean {
  const exact = new Set<string>()
  const httpsSuffixes: string[] = []
  const httpPortPrefixes: string[] = []
  for (const pattern of patterns) {
    if (pattern.startsWith("https://*.")) {
      httpsSuffixes.push(pattern.slice("https://*".length))
    } else if (pattern.startsWith("http://") && pattern.endsWith(":*")) {
      httpPortPrefixes.push(pattern.slice(0, -1))
    } else {
      exact.add(pattern)
    }
  }
  return (origin: string) => {
    if (exact.has(origin)) return true
    if (origin.startsWith("https://")) {
      return httpsSuffixes.some(
        (suffix) => origin.endsWith(suffix) && origin.length > "https://".length + suffix.length,
      )
    }
    if (origin.startsWith("http://")) {
      return httpPortPrefixes.some(
        (prefix) => origin.startsWith(prefix) && /^\d+$/.test(origin.slice(prefix.length)),
      )
    }
    return false
  }
}
