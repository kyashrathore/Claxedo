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
  await writeFile(path.join(directory, "assets", "main-abc123.js"), "export {}")
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

const cacheControl = async (pathname: string) => {
  const response = await assets.dispatchFetch(`https://app.test${pathname}`)
  await response.arrayBuffer()
  return response.headers.get("cache-control")
}

test("the shell, its client routes and unhashed root files revalidate and refuse edge transformation", async () => {
  for (const pathname of ["/", "/w/workspace-1", "/index.html", "/sw.js"]) {
    expect(await cacheControl(pathname)).toBe("no-transform, public, max-age=0, must-revalidate")
  }
})

test("hashed assets are immutable, with no revalidation joined to them", async () => {
  expect(await cacheControl("/assets/main-abc123.js")).toBe("no-transform, public, max-age=31536000, immutable")
})
