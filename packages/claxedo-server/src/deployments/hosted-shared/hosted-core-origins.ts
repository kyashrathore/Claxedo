import { cors } from "hono/cors"
import { isBrokerPath } from "@claxedo/egress-broker"

/**
 * Where to send a human who lands on the control plane's root.
 *
 * The first EXACT origin in the allow-list, ignoring `https://*.` wildcard
 * entries — a wildcard names a shape, not a destination, and redirecting to
 * one produces a URL with a literal asterisk in it.
 */
export function coreAppHomeOrigin(raw: string | undefined) {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .find((item) => item.startsWith("https://") && !item.startsWith("https://*."))
}

export function configuredCoreAppOrigins(raw: string | undefined) {
  const entries = (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  const exact = new Set<string>()
  const suffixes: string[] = []
  for (const entry of entries) {
    if (entry.startsWith("https://*.")) suffixes.push(entry.slice("https://*".length))
    else exact.add(entry)
  }
  return (origin: string) => {
    if (exact.has(origin)) return true
    if (!origin.startsWith("https://")) return false
    return suffixes.some((suffix) => origin.endsWith(suffix) && origin.length > "https://".length + suffix.length)
  }
}

/** The CORS a bearer-transport plane stamps for the app origins it admits; the credential broker's paths get none. */
export function corsMiddleware(appOriginAllowed: (origin: string) => boolean, originPatterns: RegExp[]) {
  return cors({
    origin: (origin, c) => {
      // The broker turns a placeholder into a stored key; no browser origin is
      // ever granted it, whatever the app allow-list admits elsewhere.
      if (!origin || isBrokerPath(c.req.path)) return undefined
      if (originPatterns.some((pattern) => pattern.test(origin))) return origin
      return appOriginAllowed(origin) ? origin : undefined
    },
    maxAge: 86400,
  })
}
