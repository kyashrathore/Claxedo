import { RELAY_PATH_PREFIX, publicOriginRoute } from "./public-origin"

type Fetcher = { fetch(request: Request): Promise<Response> }

export type AppWorkerEnv = {
  ASSETS: Fetcher
  CONTROL_PLANE: Fetcher
  RELAY: Fetcher
}

let shellEtag: Promise<string | null> | undefined

/** The shell's ETag, read once per isolate: a deploy that changes the shell replaces the isolate. */
function shell(assets: Fetcher, origin: string): Promise<string | null> {
  shellEtag ??= assets.fetch(new Request(`${origin}/index.html`)).then(
    (response) => { void response.body?.cancel(); return response.headers.get("etag") },
    () => { shellEtag = undefined; return null },
  )
  return shellEtag
}

/**
 * Vite writes nothing but hashed scripts, styles and media under `/assets`, so
 * the shell coming back there is the single-page-application fallback standing
 * in for a chunk a newer deploy removed. The `_headers` rule for `/assets/*`
 * caches that answer for a year, so the browser keeps an HTML document where a
 * module should be and the chunk can never load; an uncached 404 lets the app
 * reload instead.
 */
async function asset(request: Request, env: AppWorkerEnv, url: URL): Promise<Response> {
  const response = await env.ASSETS.fetch(request)
  if (!url.pathname.startsWith("/assets/")) return response
  const etag = response.headers.get("etag")
  if (etag === null || etag !== await shell(env.ASSETS, url.origin)) return response
  return new Response(null, { status: 404, headers: { "cache-control": "no-store" } })
}

/**
 * The request as the bound Worker receives it, on the same origin so the
 * control plane's own origin check holds; `cf` is carried because the relay
 * places a workspace's room by the edge country of whoever first reaches it.
 */
function forwarded(request: Request, url: URL): Request {
  return new Request(url, { ...({ cf: (request as Request & { cf?: unknown }).cf } as RequestInit), method: request.method, headers: request.headers, body: request.body, redirect: "manual" })
}

/**
 * The public origin: the browser app's assets, and beside them the control
 * plane and the relay over service bindings, so a browser opens one connection
 * and sends no CORS preflight. A WebSocket upgrade or a streaming body passes
 * through as the bound Worker answered it.
 */
export default {
  async fetch(request: Request, env: AppWorkerEnv): Promise<Response> {
    const url = new URL(request.url)
    switch (publicOriginRoute(url.pathname)) {
      case "control-plane":
        return env.CONTROL_PLANE.fetch(forwarded(request, url))
      case "relay":
        url.pathname = url.pathname.slice(RELAY_PATH_PREFIX.length)
        return env.RELAY.fetch(forwarded(request, url))
      case "assets":
        return asset(request, env, url)
    }
  },
}
