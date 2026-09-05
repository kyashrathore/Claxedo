/**
 * A fetch whose eligible GET responses are cached at the edge across isolates.
 *
 * A Worker isolate is short-lived, so an in-memory memo rarely survives
 * between two reads and every cold read pays the upstream round trip again.
 * The policy names which GETs are worth keeping and for how long; everything
 * else goes straight through. Writes are best-effort and never fail a read.
 */
export type EdgeCache = Pick<Cache, "match" | "put">

export type EdgeCachePolicy = (url: URL) => { ttlSeconds: number; statuses?: readonly number[] } | undefined

export type EdgeCachedFetchInput = {
  /** Resolved per call: `caches.default` exists only inside a Worker isolate. */
  cache: () => EdgeCache | undefined
  fetch?: (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /** Keeps the write alive past the response when a Worker context is available. */
  waitUntil?: (work: Promise<unknown>) => void
  policy: EdgeCachePolicy
}

export function edgeCachedFetch(input: EdgeCachedFetchInput) {
  const upstream = input.fetch ?? globalThis.fetch
  return async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase()
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url)
    const rule = method === "GET" ? input.policy(url) : undefined
    const cache = rule === undefined ? undefined : input.cache()
    if (!cache || !rule) return upstream(request, init)
    const key = new Request(url.href, { method: "GET" })
    const hit = await cache.match(key).catch(() => undefined)
    if (hit) return hit
    const response = await upstream(request, init)
    const keep = rule.statuses ? rule.statuses.includes(response.status) : response.ok
    if (!keep) return response
    const stored = new Response(response.clone().body, response)
    stored.headers.set("cache-control", `public, max-age=${rule.ttlSeconds}`)
    stored.headers.delete("set-cookie")
    const write = cache.put(key, stored).catch(() => undefined)
    if (input.waitUntil) input.waitUntil(write)
    return response
  }
}
