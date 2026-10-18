import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { brotliDecompressSync, gunzipSync } from "node:zlib"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, expect, test } from "vitest"
import { unstable_getMiniflareWorkerOptions } from "wrangler"
import { prepareBrowserArtifactsForWorkers } from "./browser-app"
import { renderAppWranglerConfig } from "./wrangler-config"

const HEADERS = path.resolve(import.meta.dirname, "../../../claxedo-app/public/_headers")
const SOURCE = {
  "main-new.js": `export const source = "${"x".repeat(4096)}"`,
  "main-new.css": `:root { --source: "${"x".repeat(4096)}" }`,
  "sprite-new.svg": `<svg xmlns="http://www.w3.org/2000/svg"><title>${"x".repeat(4096)}</title></svg>`,
  "tiny-new.js": "1",
}

let directory: string
let app: Miniflare
let bareAssets: Miniflare
let origin: URL

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "app-assets-worker-"))
  const browser = path.join(directory, "dist")
  await mkdir(path.join(browser, "assets"), { recursive: true })
  await copyFile(HEADERS, path.join(browser, "_headers"))
  await writeFile(path.join(browser, "index.html"), "<!doctype html><script type=\"module\" src=\"/assets/main-new.js\"></script>")
  for (const [name, source] of Object.entries(SOURCE)) await writeFile(path.join(browser, "assets", name), source)
  await prepareBrowserArtifactsForWorkers(browser)

  const config = path.join(directory, "app-wrangler.toml")
  await writeFile(config, renderAppWranglerConfig({ appWorkerName: "app-assets-worker-test", browserDirectory: browser }))
  const { workerOptions, main } = unstable_getMiniflareWorkerOptions(config)
  const bundle = await build({ entryPoints: [main], bundle: true, format: "esm", platform: "neutral", write: false })
  // `cf: false` keeps Miniflare from fetching a `request.cf` sample into `.wrangler/` under the working directory.
  app = new Miniflare({ ...workerOptions, cf: false, modules: true, script: bundle.outputFiles[0]!.text })
  origin = await app.ready

  bareAssets = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 404 }) } }",
    assets: { directory: browser, assetConfig: { not_found_handling: "single-page-application", html_handling: "auto-trailing-slash" } },
  })
})

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

test("client routes outside /assets keep the single-page fallback", async () => {
  const response = await serve("/w/workspace-1/session/ses_1", { "accept-encoding": "identity" })
  expect(response.status).toBe(200)
  expect(decoded(response)).toContain("main-new.js")
})
