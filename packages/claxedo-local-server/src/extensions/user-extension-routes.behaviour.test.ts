import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { UserExtensionRoutes } from "./user-extension-routes"

/**
 * Request-level, like the local-app behaviour suite: the interesting properties
 * here — traversal containment, symlink containment, the hosted-mode refusal —
 * are all invisible to a route-inventory check.
 */

let dataDir: string
const saved: Record<string, string | undefined> = {}

function extensionDir(name: string) {
  const dir = path.join(dataDir, "extensions", name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeExtension(name: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const dir = extensionDir(name)
  writeFileSync(path.join(dir, "claxedo-extension.json"), JSON.stringify(manifest))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), content)
  }
  return dir
}

function manifest(name: string, overrides: Record<string, unknown> = {}) {
  return { name, version: "1.0.0", entry: "main.js", apiVersion: 1, ...overrides }
}

function app(env: NodeJS.ProcessEnv = {}) {
  return UserExtensionRoutes({ env })
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-user-extensions-"))
  for (const key of ["CLAXEDO_DATA_DIR", "CLAXEDO_DEPLOYMENT_MODE", "CLAXEDO_SIGNED_CLOUD_AUTH"]) {
    saved[key] = process.env[key]
  }
  process.env.CLAXEDO_DATA_DIR = dataDir
  delete process.env.CLAXEDO_DEPLOYMENT_MODE
  delete process.env.CLAXEDO_SIGNED_CLOUD_AUTH
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dataDir, { recursive: true, force: true })
})

describe("listing", () => {
  test("returns valid manifests with renderer-facing entry paths", async () => {
    writeExtension("hello-clock", manifest("hello-clock", { displayName: "Hello Clock" }), { "main.js": "export {}" })

    const response = await app().request("http://localhost/")
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.extensions).toEqual([{
      name: "hello-clock",
      version: "1.0.0",
      entry: "main.js",
      apiVersion: 1,
      displayName: "Hello Clock",
      entryPath: "/api/claxedo/extensions/hello-clock/main.js",
    }])
    expect(body.skipped).toEqual([])
  })

  test("returns an empty list when the extensions directory does not exist", async () => {
    const response = await app().request("http://localhost/")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ extensions: [], skipped: [] })
  })

  test("skips — with a reason — rather than fails on hostile or broken manifests", async () => {
    writeExtension("good", manifest("good"), { "main.js": "export {}" })
    writeExtension("wrong-name", manifest("other-name"))
    writeExtension("traversal-entry", manifest("traversal-entry", { entry: "../escape.js" }))
    writeExtension("wrong-api", manifest("wrong-api", { apiVersion: 2 }))
    const broken = extensionDir("broken-json")
    writeFileSync(path.join(broken, "claxedo-extension.json"), "{ not json")
    extensionDir("no-manifest")

    const body = await (await app().request("http://localhost/")).json()

    expect(body.extensions.map((extension: { name: string }) => extension.name)).toEqual(["good"])
    expect(body.skipped.map((item: { directory: string }) => item.directory).sort()).toEqual([
      "broken-json",
      "no-manifest",
      "traversal-entry",
      "wrong-api",
      "wrong-name",
    ])
  })
})

describe("serving", () => {
  test("serves extension files with the module content type", async () => {
    writeExtension("hello-clock", manifest("hello-clock"), { "main.js": "export const marker = 42" })

    const response = await app().request("http://localhost/hello-clock/main.js")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect(await response.text()).toBe("export const marker = 42")
  })

  test("serves nested assets but refuses non-allowlisted file types", async () => {
    writeExtension("hello-clock", manifest("hello-clock"), {
      "assets/styles.css": "body {}",
      "assets/tool.sh": "#!/bin/sh",
    })

    const css = await app().request("http://localhost/hello-clock/assets/styles.css")
    const sh = await app().request("http://localhost/hello-clock/assets/tool.sh")

    expect(css.status).toBe(200)
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8")
    expect(sh.status).toBe(404)
  })

  test("contains plain and percent-encoded traversal inside the extension directory", async () => {
    writeExtension("hello-clock", manifest("hello-clock"), { "main.js": "export {}" })
    writeFileSync(path.join(dataDir, "secret.js"), "export const secret = true")

    for (const attempt of [
      "http://localhost/hello-clock/../secret.js",
      "http://localhost/hello-clock/..%2Fsecret.js",
      "http://localhost/hello-clock/%2e%2e/secret.js",
    ]) {
      const response = await app().request(attempt)
      expect(response.status, attempt).toBe(404)
    }
  })

  test("refuses symlinks that point outside the extension directory", async () => {
    const dir = writeExtension("hello-clock", manifest("hello-clock"))
    writeFileSync(path.join(dataDir, "outside.js"), "export const outside = true")
    symlinkSync(path.join(dataDir, "outside.js"), path.join(dir, "link.js"))

    const response = await app().request("http://localhost/hello-clock/link.js")

    expect(response.status).toBe(404)
  })
})

describe("deployment gate", () => {
  test("answers 403 for every path on a hosted deployment", async () => {
    writeExtension("hello-clock", manifest("hello-clock"), { "main.js": "export {}" })
    const hosted = app({ CLAXEDO_DEPLOYMENT_MODE: "hosted" })

    expect((await hosted.request("http://localhost/")).status).toBe(403)
    expect((await hosted.request("http://localhost/hello-clock/main.js")).status).toBe(403)
  })

  test("answers 403 when signed cloud auth is enabled", async () => {
    const signed = app({ CLAXEDO_SIGNED_CLOUD_AUTH: "1" })
    expect((await signed.request("http://localhost/")).status).toBe(403)
  })
})
