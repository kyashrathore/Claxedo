import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { brotliDecompressSync, gunzipSync } from "node:zlib"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { unstable_getMiniflareWorkerOptions } from "wrangler"
import { prepareBrowserArtifactsForWorkers } from "./browser-app"
import { controlPlaneRoutePatterns, publicOriginRoute } from "./public-origin"
import { shellPreloadLinks } from "./shell-preloads"
import { renderAppWranglerConfig } from "./wrangler-config"
import { WORKERS_COMPATIBILITY_DATE } from "./hosted-worker-bundle"

const HEADERS = path.resolve(import.meta.dirname, "../../../claxedo-app/public/_headers")
const SOURCE = {
  "main-new.js": `export const source = "${"x".repeat(4096)}"`,
  "main-new.css": `:root { --source: "${"x".repeat(4096)}" }`,
  "sprite-new.svg": `<svg xmlns="http://www.w3.org/2000/svg"><title>${"x".repeat(4096)}</title></svg>`,
  "tiny-new.js": "1",
}

const RELAY_STUB = `
export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (request.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair()
      const [client, server] = [pair[0], pair[1]]
      server.accept()
      server.addEventListener("message", (event) => server.send("echo " + url.pathname + " " + event.data))
      server.addEventListener("close", (event) => server.close(event.code, event.reason))
      return new Response(null, { status: 101, webSocket: client })
    }
    return Response.json({ url: request.url, authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie"), clientAcceptEncoding: request.cf?.clientAcceptEncoding ?? null })
  },
}
`

let directory: string
let app: Miniflare
let bareAssets: Miniflare
let origin: URL

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "app-worker-"))
  const browser = path.join(directory, "dist")
  await mkdir(path.join(browser, "assets"), { recursive: true })
  await copyFile(HEADERS, path.join(browser, "_headers"))
  await writeFile(path.join(browser, "index.html"), "<!doctype html><script type=\"module\" src=\"/assets/main-new.js\"></script>")
  await writeFile(path.join(browser, "login.html"), "<!doctype html><script type=\"module\" src=\"/assets/login-new.js\"></script>")
  await writeFile(path.join(browser, "browser-preview.html"), "<!doctype html><title>Browser preview</title>")
  for (const [name, source] of Object.entries(SOURCE)) await writeFile(path.join(browser, "assets", name), source)
  await prepareBrowserArtifactsForWorkers(browser)

  const config = path.join(directory, "app-wrangler.toml")
  await writeFile(config, renderAppWranglerConfig({ appWorkerName: "app-worker-test", relayWorkerName: "relay-stub", browserDirectory: browser }))
  const { workerOptions, main } = unstable_getMiniflareWorkerOptions(config)
  if (main === undefined) throw new Error("the app Wrangler config names no main module")
  const { outputFiles: [script] } = await build({ entryPoints: [main], bundle: true, format: "esm", platform: "neutral", write: false })
  if (script === undefined) throw new Error("esbuild wrote no bundle for the app Worker")
  // `cf: false` keeps Miniflare from fetching a `request.cf` sample into `.wrangler/` under the working directory.
  app = new Miniflare({
    cf: false,
    workers: [
      { ...workerOptions, modules: true, script: script.text },
      { name: "relay-stub", modules: true, script: RELAY_STUB, compatibilityDate: WORKERS_COMPATIBILITY_DATE },
    ],
  })
  origin = await app.ready

  bareAssets = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 404 }) } }",
    assets: { directory: browser, assetConfig: { not_found_handling: "single-page-application", html_handling: "none" } },
  })
}, 120_000)

afterAll(async () => {
  await app?.dispose()
  await bareAssets?.dispose()
  if (directory) await rm(directory, { recursive: true, force: true })
})

type Served = { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

/** The raw bytes on the wire: `fetch` would decode them and hide what the Worker sent. */
function serve(pathname: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<Served>((resolve, reject) => {
    const request = http.request(new URL(pathname, origin), { method, headers }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on("error", reject)
    })
    request.on("error", reject)
    request.end()
  })
}

function decoded({ headers, body }: Served) {
  if (headers["content-encoding"] === "br") return brotliDecompressSync(body).toString()
  if (headers["content-encoding"] === "gzip") return gunzipSync(body).toString()
  return body.toString()
}

const stored = (name: string) => readFile(path.join(directory, "dist", "assets", name))

/** A decoded answer, with the socket of an upgrade and the stream of an event stream as the bound Worker gave them. */
const dispatch = (pathname: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) => app.dispatchFetch(`https://app.test${pathname}`, init)

describe("the public origin's routes", () => {
  test("names the control plane's route patterns on the origin's host, one per prefix", () => {
    expect(controlPlaneRoutePatterns("app.example.com")).toEqual([
      "app.example.com/api/*", "app.example.com/internal/*", "app.example.com/.well-known/*", "app.example.com/bindings/*",
      "app.example.com/health*", "app.example.com/global/health*", "app.example.com/path*",
    ])
    expect(() => controlPlaneRoutePatterns("https://app.example.com")).toThrow(/bare hostname/)
  })

  test("names the Worker a path belongs to", () => {
    expect(publicOriginRoute("/api/claxedo/mode")).toBe("control-plane")
    expect(publicOriginRoute("/internal/relay/target")).toBe("control-plane")
    expect(publicOriginRoute("/.well-known/jwks.json")).toBe("control-plane")
    expect(publicOriginRoute("/health")).toBe("control-plane")
    expect(publicOriginRoute("/bindings/b_1/v1/messages")).toBe("control-plane")
    expect(publicOriginRoute("/global/health")).toBe("control-plane")
    expect(publicOriginRoute("/path")).toBe("control-plane")
    expect(publicOriginRoute("/path?directory=%2Fwork")).toBe("control-plane")
    expect(publicOriginRoute("/paths")).toBe("control-plane")
    expect(publicOriginRoute("/relay/workspaces/ws_1/session")).toBe("relay")
    expect(publicOriginRoute("/relay")).toBe("assets")
    expect(publicOriginRoute("/relayed")).toBe("assets")
    expect(publicOriginRoute("/healthy")).toBe("control-plane")
    expect(publicOriginRoute("/w/ws_1/session/ses_1")).toBe("assets")
    expect(publicOriginRoute("/assets/main.js")).toBe("assets")
  })
})

describe("a control-plane path that reaches the app Worker", () => {
  test("is answered as a deploy window the clients retry, never as the shell", async () => {
    for (const pathname of ["/api/claxedo/mode", "/api/auth/get-session", "/internal/relay/target?workspaceId=ws_1", "/.well-known/oauth-authorization-server", "/health", "/global/health", "/path?directory=%2Fwork", "/bindings/b_1/v1/messages"]) {
      const response = await dispatch(pathname, { headers: { cookie: "__Secure-claxedo.session_token=held" } })
      expect(response.status).toBe(503)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(await response.json()).toEqual({ error: { code: "deployment_candidate_unavailable" } })
    }
    const posted = await dispatch("/api/workspace/create", { method: "POST", headers: { "content-type": "application/json" }, body: "{\"name\":\"ws\"}" })
    expect(posted.status).toBe(503)
  })
})

describe("the relay behind the public origin", () => {
  test("sees the path without the prefix, the bearer token and the edge's cf, never the browser's session cookie", async () => {
    const response = await dispatch("/relay/workspaces/ws_1/api/wr/health?region=apac", { headers: { authorization: "Bearer rat", "accept-encoding": "gzip", cookie: "__Secure-claxedo.session_token=held" } })
    expect(await response.json()).toEqual({ url: "https://app.test/workspaces/ws_1/api/wr/health?region=apac", authorization: "Bearer rat", cookie: null, clientAcceptEncoding: "gzip" })
  })

  test("passes a WebSocket upgrade through and the socket carries frames both ways", async () => {
    const response = await dispatch("/relay/workspaces/ws_1/pty", { headers: { upgrade: "websocket" } })
    expect(response.status).toBe(101)
    const socket = response.webSocket
    if (!socket) throw new Error("the upgrade answered no socket")
    socket.accept()
    const echoed = new Promise<string>((resolve) => socket.addEventListener("message", (event) => resolve(typeof event.data === "string" ? event.data : "")))
    socket.send("keys")
    expect(await echoed).toBe("echo /workspaces/ws_1/pty keys")
    const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve()))
    socket.close()
    await closed
  })
})

describe("the app's assets", () => {
  test("a browser that accepts br gets the stored Brotli copy byte for byte under the asset's own type", async () => {
    const types = { "main-new.js": "text/javascript; charset=utf-8", "main-new.css": "text/css; charset=utf-8", "sprite-new.svg": "image/svg+xml" }
    for (const [name, contentType] of Object.entries(types)) {
      const response = await serve(`/assets/${name}`, { "accept-encoding": "br" })
      expect(response.status).toBe(200)
      expect(response.headers["content-encoding"]).toBe("br")
      expect(response.headers["content-type"]).toBe(contentType)
      expect(response.headers.vary).toBe("accept-encoding")
      expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable")
      expect(response.headers["x-content-type-options"]).toBe("nosniff")
      expect(response.body.equals(await stored(`${name}.br`))).toBe(true)
      expect(decoded(response)).toBe(SOURCE[name as keyof typeof SOURCE])
    }
  })

  test("a client without br gets the asset itself for the edge to compress, varied on Accept-Encoding", async () => {
    const brotli = await serve("/assets/main-new.js", { "accept-encoding": "br" })
    for (const acceptEncoding of ["gzip", "identity", "br;q=0, gzip"]) {
      const response = await serve("/assets/main-new.js", { "accept-encoding": acceptEncoding })
      expect(response.status).toBe(200)
      expect(response.headers["content-encoding"]).not.toBe("br")
      expect(response.headers.etag).not.toBe(brotli.headers.etag)
      expect(response.headers.vary).toBe("accept-encoding")
      expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable")
      expect(decoded(response)).toBe(SOURCE["main-new.js"])
    }
  })

  test("revalidating the Brotli copy answers 304 with the same representation headers", async () => {
    const first = await serve("/assets/main-new.css", { "accept-encoding": "br" })
    const response = await serve("/assets/main-new.css", { "accept-encoding": "br", "if-none-match": first.headers.etag! })
    expect(response.status).toBe(304)
    expect(response.body.byteLength).toBe(0)
    expect(response.headers.etag).toBe(first.headers.etag)
    expect(response.headers["content-encoding"]).toBe("br")
    expect(response.headers.vary).toBe("accept-encoding")
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable")
  })

  test("HEAD describes the Brotli copy without a body", async () => {
    const response = await serve("/assets/main-new.js", { "accept-encoding": "br" }, "HEAD")
    expect(response.status).toBe(200)
    expect(response.body.byteLength).toBe(0)
    expect(response.headers["content-encoding"]).toBe("br")
    expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8")
  })

  test("a Range request and an asset without a smaller Brotli copy are served as the asset itself", async () => {
    const identity = await serve("/assets/main-new.js", { "accept-encoding": "identity" })
    const ranged = await serve("/assets/main-new.js", { "accept-encoding": "br", range: "bytes=0-9" })
    expect(ranged.headers.etag).toBe(identity.headers.etag)
    expect(decoded(ranged)).toBe(SOURCE["main-new.js"])

    const tiny = await serve("/assets/tiny-new.js", { "accept-encoding": "br" })
    expect(tiny.status).toBe(200)
    expect(tiny.headers.vary).toBe("accept-encoding")
    expect(decoded(tiny)).toBe("1")
  })

  test("a chunk a newer deploy removed answers 404 uncached, not the shell as a module", async () => {
    for (const acceptEncoding of ["br", "gzip"]) {
      const response = await serve("/assets/terminal-creator-OLD.js", { "accept-encoding": acceptEncoding })
      expect(response.status).toBe(404)
      expect(response.headers["cache-control"]).toBe("no-store")
      expect(decoded(response)).toBe("")
    }
  })

  test("the bare assets binding answers a missing chunk with the shell cached as immutable", async () => {
    const fallback = await bareAssets.dispatchFetch("https://app.test/assets/terminal-creator-OLD.js")
    expect(fallback.status).toBe(200)
    expect(fallback.headers.get("content-type")).toContain("text/html")
    expect(fallback.headers.get("cache-control")).toContain("immutable")
    expect(await fallback.text()).toMatch(/^<!doctype html>/)
  })

  test("client routes outside the control plane's and the relay's paths keep the single-page fallback", async () => {
    for (const pathname of ["/w/workspace-1/session/ses_1", "/relay", "/relayed", "/settings", "/invitations", "/device", "/oauth/consent", "/login/"]) {
      const response = await serve(pathname, { "accept-encoding": "identity" })
      expect(response.status).toBe(200)
      expect(decoded(response)).toContain("main-new.js")
    }
  })

  test("a document is served at its own path only, with no redirect", async () => {
    for (const [pathname, marker] of [["/index.html", "main-new.js"], ["/login.html", "login-new.js"], ["/browser-preview.html", "Browser preview"]]) {
      const response = await serve(pathname, { "accept-encoding": "identity" })
      expect(response.status, pathname).toBe(200)
      expect(decoded(response)).toContain(marker)
    }
  })
})

describe("the signed-out document", () => {
  const signedOut: Record<string, string>[] = [{ "accept-encoding": "identity" }, { "accept-encoding": "identity", cookie: "theme=dark; __Secure-claxedo.session_token=" }]

  test("a browser without the session cookie gets it at the home and at /login, revalidating as its own document, and the shell nowhere else", async () => {
    for (const headers of signedOut) {
      for (const pathname of ["/", "/login", "/login?response_type=code&client_id=c&redirect_uri=r&state=s"]) {
        const response = await serve(pathname, headers)
        expect(response.status, pathname).toBe(200)
        expect(decoded(response)).toContain("login-new.js")
        expect(response.headers.link).toBeUndefined()
        expect(response.headers["cache-control"]).toBe("no-transform, public, max-age=0, must-revalidate")
        const revalidated = await serve(pathname, { ...headers, "if-none-match": response.headers.etag! })
        expect(revalidated.status).toBe(304)
      }
      const elsewhere = await serve("/w/workspace-1/session/ses_1", headers)
      expect(decoded(elsewhere)).toContain("main-new.js")
    }
  })

  test("the cookie turns the same URL into the shell with its preloads, and a stale ETag of the other document answers 200", async () => {
    const session = { cookie: "__Secure-claxedo.session_token=held", "accept-encoding": "identity" }
    const login = await serve("/", { "accept-encoding": "identity" })
    const shell = await serve("/", { ...session, "if-none-match": login.headers.etag! })
    expect(shell.status).toBe(200)
    expect(decoded(shell)).toContain("main-new.js")
    expect(shell.headers.link).toBe(shellPreloadLinks())
    expect((await serve("/login", session)).headers.link).toBe(shellPreloadLinks())
    const signedOutAgain = await serve("/", { "accept-encoding": "identity", "if-none-match": shell.headers.etag! })
    expect(signedOutAgain.status).toBe(200)
    expect(decoded(signedOutAgain)).toContain("login-new.js")
  })
})

describe("the shell's preloads", () => {
  const session = { cookie: "__Secure-claxedo.session_token=held", "accept-encoding": "identity" }

  test("a signed-in browser's shell names its boot reads as credentialed preloads, the same on every route, the workspace's connection not among them", async () => {
    const response = await serve("/w/workspace-1/session/ses_1", session)
    expect(response.status).toBe(200)
    expect(decoded(response)).toContain("main-new.js")
    expect(response.headers.link).toBe(shellPreloadLinks())
    expect(response.headers.link).toContain("</api/auth/get-session>; rel=preload; as=fetch; crossorigin=use-credentials")
    expect(response.headers.link).not.toMatch(/\/api\/workspace\/[^/]+\/connection>/)
    expect(response.headers["cache-control"]).toBe("no-transform, public, max-age=0, must-revalidate")
    expect((await serve("/", session)).headers.link).toBe(response.headers.link)
  })

  test("a revalidated shell carries the preloads on its 304", async () => {
    const first = await serve("/w/workspace-1/session/ses_1", session)
    const response = await serve("/w/workspace-1/session/ses_1", { ...session, "if-none-match": first.headers.etag! })
    expect(response.status).toBe(304)
    expect(response.headers.link).toBe(first.headers.link)
  })

  test("a browser without the session cookie gets the shell as the assets serve it", async () => {
    const stale: Record<string, string>[] = [{ "accept-encoding": "identity" }, { "accept-encoding": "identity", cookie: "theme=dark; __Secure-claxedo.session_token=" }]
    for (const headers of stale) {
      const response = await serve("/w/workspace-1/session/ses_1", headers)
      expect(response.status).toBe(200)
      expect(response.headers.link).toBeUndefined()
    }
  })

  test("the cookie preloads nothing for a file or a removed chunk", async () => {
    const chunk = await serve("/assets/terminal-creator-OLD.js", session)
    expect(chunk.status).toBe(404)
    expect(chunk.headers.link).toBeUndefined()
    const file = await serve("/assets/tiny-new.js", session)
    expect(file.status).toBe(200)
    expect(file.headers.link).toBeUndefined()
  })
})
