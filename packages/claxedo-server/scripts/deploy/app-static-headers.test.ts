import { mkdir, mkdtemp, copyFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, expect, test } from "vitest"

const HEADERS = path.resolve(import.meta.dirname, "../../../claxedo-app/public/_headers")

let directory: string
let assets: Miniflare

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "app-static-headers-"))
  await mkdir(path.join(directory, "assets"))
  await copyFile(HEADERS, path.join(directory, "_headers"))
  await writeFile(path.join(directory, "index.html"), "<!doctype html>")
  await writeFile(path.join(directory, "assets", "main-abc123.js"), `export const source = "${"x".repeat(4096)}"`)
  await writeFile(path.join(directory, "assets", "main-abc123.css"), `:root { --source: "${"x".repeat(4096)}" }`)
  await writeFile(path.join(directory, "assets", "sprite-abc123.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><title>${"x".repeat(4096)}</title></svg>`)
  await writeFile(path.join(directory, "sw.js"), "self")
  assets = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 404 }) } }",
    assets: { directory, assetConfig: { not_found_handling: "single-page-application", html_handling: "auto-trailing-slash" } },
  })
})

afterAll(async () => {
  await assets?.dispose()
  if (directory) await rm(directory, { recursive: true, force: true })
})

const served = async (pathname: string) => {
  const response = await fetch(new URL(pathname, await assets.ready), { headers: { "accept-encoding": "br, gzip" } })
  await response.arrayBuffer()
  return response.headers
}

const cacheControl = async (pathname: string) => (await served(pathname)).get("cache-control")

test("the shell, its client routes and unhashed root files revalidate and refuse edge transformation", async () => {
  for (const pathname of ["/", "/w/workspace-1", "/index.html", "/sw.js"]) {
    expect(await cacheControl(pathname)).toBe("no-transform, public, max-age=0, must-revalidate")
  }
})

test("hashed assets are immutable and leave Cloudflare free to compress them", async () => {
  for (const pathname of ["/assets/main-abc123.js", "/assets/main-abc123.css", "/assets/sprite-abc123.svg"]) {
    expect(await cacheControl(pathname)).toBe("public, max-age=31536000, immutable")
  }
})

test("scripts, styles and images carry the publisher's single content type, which the edge compresses", async () => {
  const expected = {
    "/assets/main-abc123.js": "text/javascript; charset=utf-8",
    "/assets/main-abc123.css": "text/css; charset=utf-8",
    "/assets/sprite-abc123.svg": "image/svg+xml",
    "/sw.js": "text/javascript; charset=utf-8",
  }
  for (const [pathname, contentType] of Object.entries(expected)) {
    const headers = await served(pathname)
    expect(headers.get("content-type")).toBe(contentType)
    if (pathname.startsWith("/assets/")) expect(headers.get("content-encoding")).toBe("br")
  }
})
