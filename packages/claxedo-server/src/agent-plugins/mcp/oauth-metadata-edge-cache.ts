import { edgeCachedFetch, type EdgeCache } from "../edge-cached-fetch"

/**
 * MCP OAuth discovery's metadata reads, cached at the edge across isolates.
 *
 * Discovering a server's authorization walks `/.well-known/` documents on the
 * resource and on its issuer, trying several candidate paths in order; the
 * documents change rarely, and the 404 that says "not this path" is as
 * stable as the document that follows it. Both the catalog (one discovery per
 * MCP server per candidate) and the desktop's runtime pull (one per server
 * per request) walked those documents live, which was the bulk of their wall
 * time. The probe that elicits the bearer challenge is a POST and is never
 * cached; a dynamic client registration is a POST too.
 */
const METADATA_TTL_SECONDS = 600
const KEPT_STATUSES = [200, 404] as const

function oauthMetadataPolicy(url: URL): { ttlSeconds: number; statuses: readonly number[] } | undefined {
  if (url.protocol !== "https:") return undefined
  if (!url.pathname.includes("/.well-known/")) return undefined
  return { ttlSeconds: METADATA_TTL_SECONDS, statuses: KEPT_STATUSES }
}

export function oauthMetadataEdgeCachedFetch(input: {
  /** Resolved per call: `caches.default` exists only inside a Worker isolate. */
  cache: () => EdgeCache | undefined
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  waitUntil?: (work: Promise<unknown>) => void
}): (url: string, init?: RequestInit) => Promise<Response> {
  const upstream = input.fetch
  const cached = edgeCachedFetch({
    cache: input.cache,
    ...(upstream
      ? { fetch: (request: RequestInfo | URL, init?: RequestInit) => upstream(typeof request === "string" ? request : request instanceof URL ? request.href : request.url, init) }
      : {}),
    ...(input.waitUntil ? { waitUntil: input.waitUntil } : {}),
    policy: oauthMetadataPolicy,
  })
  return (url, init) => cached(url, init)
}
