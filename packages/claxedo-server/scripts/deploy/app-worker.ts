import { PRECOMPRESSED_ASSET, acceptsBrotli, brotliSibling } from "./app-asset-encoding"
import { RELAY_PATH_PREFIX, publicOriginRoute } from "./public-origin"
import { shellPreloadLinks } from "./shell-preloads"
import { carriesSessionCookie } from "../../src/platform/auth/session-cookie"

type Fetcher = { fetch(request: Request): Promise<Response> }

export type AppWorkerEnv = {
  ASSETS: Fetcher
  CONTROL_PLANE: Fetcher
  RELAY: Fetcher
}

/**
 * `cf` is the edge's view of the client, which workerd attaches to an incoming
 * request and accepts back in an init: Cloudflare overwrites a Worker's
 * incoming `Accept-Encoding` with `br, gzip` and keeps the client's own value
 * here, and the relay places a workspace's room by the edge country.
 */
type EdgeRequest = Request & { readonly cf?: { clientAcceptEncoding?: string } }
type EdgeRequestInit = RequestInit & { cf?: object }
type WorkerResponseInit = ResponseInit & { encodeBody?: "automatic" | "manual" }

let shellEtag: Promise<string | null> | undefined

/** The shell's ETag, read once per isolate: a deploy that changes the shell replaces the isolate. */
function shell(assets: Fetcher, origin: string): Promise<string | null> {
  shellEtag ??= assets.fetch(new Request(`${origin}/index.html`, { method: "HEAD" })).then(
    (response) => response.headers.get("etag"),
    () => { shellEtag = undefined; return null },
  )
  return shellEtag
}

async function isShell(response: Response, assets: Fetcher, origin: string) {
  const etag = response.headers.get("etag")
  return etag !== null && etag === await shell(assets, origin)
}

const removedChunk = () => new Response(null, { status: 404, headers: { "cache-control": "no-store" } })

/**
 * The Brotli copy of a precompressed asset under the asset's own type, or null
 * when the asset has no copy. `encodeBody: "manual"` sends the stored bytes as
 * they are; without it the runtime would compress them again.
 */
async function brotliAsset(request: Request, url: URL, assets: Fetcher): Promise<Response | null> {
  const [asset, encoded] = await Promise.all([
    assets.fetch(new Request(url, { method: "HEAD" })),
    assets.fetch(new Request(new URL(brotliSibling(url.pathname), url), request)),
  ])
  if (await isShell(asset, assets, url.origin)) {
    await encoded.body?.cancel()
    return removedChunk()
  }
  const contentType = asset.headers.get("content-type")
  const usable = asset.ok && contentType !== null && (encoded.status === 200 || encoded.status === 304)
  if (!usable || await isShell(encoded, assets, url.origin)) {
    await encoded.body?.cancel()
    return null
  }
  const headers = new Headers(encoded.headers)
  headers.set("content-type", contentType)
  headers.set("content-encoding", "br")
  headers.set("vary", "accept-encoding")
  const init: WorkerResponseInit = { status: encoded.status, headers, encodeBody: "manual" }
  return new Response(encoded.body, init)
}

/**
 * The shell for a client route, with the reads a signed-in app makes at boot
 * declared as preloads so they leave with the document's response. The cookie
 * is the only sign the edge has of a signed-in browser: a signed-out visitor
 * gets the shell as the assets serve it, and a browser whose cookie no longer
 * names a session preloads once for nothing, since the session read's answer
 * clears the cookie. A 304 carries the header too, as the browser applies the
 * revalidated shell's headers to the copy it kept.
 */
async function shellForRoute(request: EdgeRequest, env: AppWorkerEnv, url: URL): Promise<Response> {
  const response = await env.ASSETS.fetch(request)
  if (!carriesSessionCookie(request.headers.get("cookie")) || !await isShell(response, env.ASSETS, url.origin)) return response
  const preloaded = new Response(response.body, response)
  preloaded.headers.set("link", shellPreloadLinks(url.pathname))
  return preloaded
}

/**
 * Runs ahead of the static assets. Vite writes nothing but hashed scripts,
 * styles and media under `/assets`, so the shell coming back there is the
 * single-page-application fallback standing in for a chunk a newer deploy
 * removed. The `_headers` rule for `/assets/*` caches that answer for a year,
 * so the browser keeps an HTML document where a module should be and the chunk
 * can never load; an uncached 404 lets the app reload instead.
 *
 * Scripts, styles and sprites go to a client that accepts br as the Brotli
 * copy the build stored beside them; anyone else, and any Range request, gets
 * the asset itself, which the edge compresses on the way out.
 */
async function asset(request: EdgeRequest, env: AppWorkerEnv, url: URL): Promise<Response> {
  if (!url.pathname.startsWith("/assets/")) return shellForRoute(request, env, url)
  const precompressed = PRECOMPRESSED_ASSET.test(url.pathname)
  const readsWhole = (request.method === "GET" || request.method === "HEAD") && !request.headers.has("range")
  if (precompressed && readsWhole && acceptsBrotli(request.cf?.clientAcceptEncoding)) {
    const encoded = await brotliAsset(request, url, env.ASSETS)
    if (encoded) return encoded
  }
  const response = await env.ASSETS.fetch(request)
  if (await isShell(response, env.ASSETS, url.origin)) {
    await response.body?.cancel()
    return removedChunk()
  }
  if (!precompressed) return response
  const varied = new Response(response.body, response)
  varied.headers.set("vary", "accept-encoding")
  return varied
}

/** The request as the bound Worker receives it, on the same origin so the control plane's own origin check holds, with the edge's `cf`. */
function forwarded(request: EdgeRequest, url: URL, headers: Headers = request.headers): Request {
  const init: EdgeRequestInit = { method: request.method, headers, body: request.body, redirect: "manual", cf: request.cf }
  return new Request(url, init)
}

/** The relay authenticates by bearer token or WebSocket subprotocol; the session cookie the browser sends along on the shared origin is not for it. */
function withoutCookie(headers: Headers): Headers {
  const stripped = new Headers(headers)
  stripped.delete("cookie")
  return stripped
}

/**
 * The public origin: the browser app's assets, and beside them the control
 * plane and the relay over service bindings, so a browser opens one connection
 * and sends no CORS preflight. A WebSocket upgrade or a streaming body passes
 * through as the bound Worker answered it.
 */
export default {
  async fetch(request: EdgeRequest, env: AppWorkerEnv): Promise<Response> {
    const url = new URL(request.url)
    const route = publicOriginRoute(url.pathname)
    if (route === "control-plane") return env.CONTROL_PLANE.fetch(forwarded(request, url))
    if (route === "relay") {
      url.pathname = url.pathname.slice(RELAY_PATH_PREFIX.length)
      return env.RELAY.fetch(forwarded(request, url, withoutCookie(request.headers)))
    }
    return asset(request, env, url)
  },
}
