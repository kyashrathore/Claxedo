type Assets = { fetch(request: Request): Promise<Response> }

let shellEtag: Promise<string | null> | undefined

/** The shell's ETag, read once per isolate: a deploy that changes the shell replaces the isolate. */
function shell(assets: Assets, origin: string): Promise<string | null> {
  shellEtag ??= assets.fetch(new Request(`${origin}/index.html`, { method: "HEAD" })).then(
    (response) => response.headers.get("etag"),
    () => { shellEtag = undefined; return null },
  )
  return shellEtag
}

/**
 * Runs ahead of the static assets for `/assets/*` only. Vite writes nothing
 * but hashed scripts, styles and media under `/assets`, so the shell coming
 * back there is the single-page-application fallback standing in for a chunk
 * a newer deploy removed. The `_headers` rules label that answer as a script
 * and cache it for a year, so the browser parses HTML as a module
 * ("Unexpected token '<'") and keeps it; a 404 lets the app reload instead.
 */
export default {
  async fetch(request: Request, env: { ASSETS: Assets }): Promise<Response> {
    const url = new URL(request.url)
    const response = await env.ASSETS.fetch(request)
    if (!url.pathname.startsWith("/assets/")) return response
    const etag = response.headers.get("etag")
    if (etag === null || etag !== await shell(env.ASSETS, url.origin)) return response
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } })
  },
}
