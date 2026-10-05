import { mkdir, mkdtemp, copyFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, expect, test } from "vitest"
import worker from "./app-assets-worker"

const HEADERS = path.resolve(import.meta.dirname, "../../../claxedo-app/public/_headers")

let directory: string
let assets: Miniflare

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "app-assets-worker-"))
  await mkdir(path.join(directory, "assets"))
  await copyFile(HEADERS, path.join(directory, "_headers"))
  await writeFile(path.join(directory, "index.html"), "<!doctype html><script type=\"module\" src=\"/assets/main-new.js\"></script>")
  await writeFile(path.join(directory, "assets", "main-new.js"), "export {}")
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

const env = { ASSETS: { fetch: (request: Request) => assets.dispatchFetch(request.url, { headers: request.headers }) as unknown as Promise<Response> } }

const serve = (pathname: string) => worker.fetch(new Request(`https://app.test${pathname}`), env)

test("a chunk a newer deploy removed answers 404 uncached, not the shell as a module", async () => {
  const response = await serve("/assets/terminal-creator-OLD.js")
  expect(response.status).toBe(404)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.text()).toBe("")
})

test("the bare assets binding answers a missing chunk with the shell labelled as an immutable script", async () => {
  const fallback = await assets.dispatchFetch("https://app.test/assets/terminal-creator-OLD.js")
  expect(fallback.status).toBe(200)
  expect(fallback.headers.get("content-type")).toContain("application/javascript")
  expect(fallback.headers.get("cache-control")).toContain("immutable")
  expect(await fallback.text()).toMatch(/^<!doctype html>/)
})

test("a present chunk passes through with its immutable caching", async () => {
  const response = await serve("/assets/main-new.js")
  expect(response.status).toBe(200)
  expect(await response.text()).toBe("export {}")
  expect(response.headers.get("cache-control")).toBe("no-transform, public, max-age=31536000, immutable")
})

test("client routes outside /assets keep the single-page fallback", async () => {
  const response = await serve("/w/workspace-1/session/ses_1")
  expect(response.status).toBe(200)
  expect(await response.text()).toContain("main-new.js")
})
