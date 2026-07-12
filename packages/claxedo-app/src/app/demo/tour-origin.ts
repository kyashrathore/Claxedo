/**
 * Origin allow-list for the demo tour's `postMessage` channel.
 *
 * The demo app is embedded as an iframe on the marketing site (see
 * claxedo-web `try.astro`) and the parent frame drives the tour by posting
 * `{ type: "tour-step", action }` messages. Without an origin check, ANY page
 * that embeds or opens the demo could post a message and drive its UI. This is
 * a strict allow-list: same-origin, the known marketing origins, and — only in
 * local dev (loopback app) — a loopback parent.
 */
export const TRUSTED_TOUR_ORIGINS = ["https://claxedo.com", "https://www.claxedo.com"] as const

function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin)
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  } catch {
    return false
  }
}

export function isTrustedTourOrigin(origin: string, selfOrigin: string): boolean {
  if (!origin) return false
  if (origin === selfOrigin) return true
  if ((TRUSTED_TOUR_ORIGINS as readonly string[]).includes(origin)) return true
  // Local dev: the marketing site runs on a sibling loopback port. Only trust a
  // loopback parent when the app itself is served from loopback.
  if (isLoopbackOrigin(selfOrigin) && isLoopbackOrigin(origin)) return true
  return false
}
