import { PRECOMPRESSED_ASSET, acceptsBrotli, brotliSibling } from "./app-asset-encoding"

type Assets = { fetch(request: Request): Promise<Response> }
/** Cloudflare overwrites a Worker's incoming `Accept-Encoding` with `br, gzip` and keeps the client's own value here. */
type IncomingRequest = Request & { cf?: { clientAcceptEncoding?: string } }
type WorkerResponseInit = ResponseInit & { encodeBody?: "automatic" | "manual" }

let shellEtag: Promise<string | null> | undefined

/** The shell's ETag, read once per isolate: a deploy that changes the shell replaces the isolate. */
function shell(assets: Assets, origin: string): Promise<string | null> {
  shellEtag ??= assets.fetch(new Request(`${origin}/index.html`, { method: "HEAD" })).then(
    (response) => response.headers.get("etag"),
    () => { shellEtag = undefined; return null },
  )
  return shellEtag
}

async function isShell(response: Response, assets: Assets, origin: string) {
  const etag = response.headers.get("etag")
  return etag !== null && etag === await shell(assets, origin)
}

const removedChunk = () => new Response(null, { status: 404, headers: { "cache-control": "no-store" } })

/**
 * The Brotli copy of a precompressed asset under the asset's own type, or null
 * when the asset has no copy. `encodeBody: "manual"` sends the stored bytes as
 * they are; without it the runtime would compress them again.
 */
async function brotliAsset(request: Request, url: URL, assets: Assets): Promise<Response | null> {
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
 * Runs ahead of the static assets for `/assets/*` only. Vite writes nothing
 * but hashed scripts, styles and media under `/assets`, so the shell coming
 * back there is the single-page-application fallback standing in for a chunk
 * a newer deploy removed. The `_headers` rule for `/assets/*` caches that answer
 * for a year, so the browser keeps an HTML document where a module should be
 * and the chunk can never load; an uncached 404 lets the app reload instead.
 *
 * Scripts, styles and sprites go to a client that accepts br as the Brotli
 * copy the build stored beside them; anyone else, and any Range request, gets
 * the asset itself, which the edge compresses on the way out.
 */
export default {
  async fetch(request: IncomingRequest, env: { ASSETS: Assets }): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith("/assets/")) return env.ASSETS.fetch(request)
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
  },
}
