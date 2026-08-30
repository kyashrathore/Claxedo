import { mkdtempSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import { BootstrapRoutes } from "./bootstrap"

const root = path.join(os.tmpdir(), `claxedo-bootstrap-route-${Date.now()}-${Math.random().toString(16).slice(2)}`)
const previous = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}

process.env.ANTHROPIC_API_KEY = "sk-ambient-should-not-count"
process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

afterAll(async () => {
  if (previous.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = previous.ANTHROPIC_API_KEY
  if (previous.CLAXEDO_DATA_DIR === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous.CLAXEDO_DATA_DIR
  if (previous.CLAXEDO_STATE_DIR === undefined) delete process.env.CLAXEDO_STATE_DIR
  else process.env.CLAXEDO_STATE_DIR = previous.CLAXEDO_STATE_DIR
  await fs.rm(root, { recursive: true, force: true })
})

const catalogCacheDir = mkdtempSync(path.join(os.tmpdir(), "claxedo-bootstrap-catalog-"))

describe("BootstrapRoutes", () => {
  test("uses injected env for provider status instead of ambient process env", async () => {
    await fs.mkdir(process.env.CLAXEDO_DATA_DIR!, { recursive: true })
    await fs.mkdir(process.env.CLAXEDO_STATE_DIR!, { recursive: true })

    const emptyEnvApp = BootstrapRoutes({ env: {} })
    const configuredEnvApp = BootstrapRoutes({
      env: {
        ANTHROPIC_API_KEY: "sk-injected",
        npm_package_version: "9.9.9-test",
      },
    })

    const empty = await emptyEnvApp.request("/api/claxedo/bootstrap?runner=claude-acp")
    const configured = await configuredEnvApp.request("/api/claxedo/bootstrap?runner=claude-acp")

    expect(empty.status).toBe(200)
    expect(configured.status).toBe(200)

    const emptyBody = await empty.json()
    const configuredBody = await configured.json()

    expect(emptyBody.provider.connected).not.toContain("claude-acp")
    expect(emptyBody.provider.all.find((item: { id: string }) => item.id === "claude-acp")?.source).toBe("config")
    expect(configuredBody.version).toBe("9.9.9-test")
    expect(configuredBody.provider.connected).toContain("claude-acp")
    expect(configuredBody.provider.all.find((item: { id: string }) => item.id === "claude-acp")?.source).toBe("env")
  })

  test("uses the injected OpenCode credential environment for the embedded SDK catalog", async () => {
    const previousFetch = globalThis.fetch
    let calls = 0
    const fakeFetch = Object.assign(async (input: URL | RequestInfo) => {
      calls += 1
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      // Claxedo owns the OpenCode catalog now (R7: it must work without raw
      // engine control routes), so it reads models.dev directly rather than
      // proxying the engine's /provider. Same assertions, new source.
      if (url.hostname === "models.dev") {
        return Response.json({
          opencode: {
            id: "opencode",
            name: "OpenCode",
            env: ["OPENCODE_API_KEY"],
            models: {
              "big-pickle": { id: "big-pickle", name: "Big Pickle" },
              "unused-model": { id: "unused-model", name: "Unused" },
            },
          },
        })
      }
      if (url.pathname === "/provider/auth") return Response.json({ opencode: [{ type: "api" }] })
      if (url.pathname === "/config/providers") return Response.json({ providers: [{ id: "opencode" }], default: {} })
      if (url.pathname === "/global/config") return Response.json({ model: "opencode/test", provider: {}, mcp: {} })
      return Response.json({}, { status: 404 })
    }, { preconnect: previousFetch.preconnect })
    globalThis.fetch = fakeFetch

    try {
      const ambientIgnored = await BootstrapRoutes({
        // Connectivity is now derived from a real credential/env signal rather
        // than the engine simply asserting it, so supply the key models.dev
        // names for this provider. Still not the disable flag, which is what
        // this test is actually about.
        env: {
          OPENCODE_API_KEY: "test-key",
          CLAXEDO_OPENCODE_CATALOG_CACHE: `${catalogCacheDir}/served.json`,
        },
      }).request("/api/claxedo/bootstrap?runner=opencode")
      expect(ambientIgnored.status).toBe(200)
      const ambientIgnoredBody = await ambientIgnored.json()
      // "big-pickle" sorts before "unused-model", so it is the default, and
      // providerCatalogView surfaces only the default model of a connected
      // provider — the same shape the engine-backed catalog produced.
      expect(ambientIgnoredBody.provider.connected).toEqual(["opencode"])
      expect(ambientIgnoredBody.provider.all).toEqual([{
        id: "opencode",
        name: "OpenCode",
        models: {
          "big-pickle": {
            id: "big-pickle",
            name: "Big Pickle",
            attachment: false,
            reasoning: false,
            tool_call: true,
            temperature: false,
          },
        },
      }])
      expect(calls).toBeGreaterThan(0)

    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("fails bootstrap explicitly when the OpenCode catalog is unavailable", async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = Object.assign(async (input: URL | RequestInfo) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === "/provider" || url.pathname === "/config/providers") {
        return Response.json({ error: { message: "offline" } }, { status: 503 })
      }
      if (url.hostname === "models.dev") return Response.json({ error: { message: "offline" } }, { status: 503 })
      if (url.pathname === "/global/config") return Response.json({ error: { message: "offline" } }, { status: 503 })
      return Response.json({}, { status: 404 })
    }, { preconnect: previousFetch.preconnect })

    try {
      const res = await BootstrapRoutes({
        // A cache would legitimately mask the outage — serving a day-old model
        // list beats an empty picker — so this points somewhere that cannot
        // exist to exercise the genuinely-unavailable path.
        env: { CLAXEDO_OPENCODE_CATALOG_CACHE: `${catalogCacheDir}/absent/none.json` },
      }).request("/api/claxedo/bootstrap?runner=opencode")

      expect(res.status).toBe(502)
      const body = await res.json()
      // The invariant that matters is unchanged: an unreachable catalog is an
      // explicit 502 with no fabricated provider payload, never an empty list.
      expect(body.error).toContain("model catalog is unavailable")
      expect(body.provider).toBeUndefined()
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("allows loopback browser bootstrap even when bearer auth is attached", async () => {
    const res = await BootstrapRoutes({
      authConfig: { enabled: false, mode: "local-only", reason: "local test" },
      env: {},
    }).request("http://127.0.0.1/api/claxedo/bootstrap?runner=opencode", {
      headers: {
        Authorization: "Bearer local-test-token",
        Origin: "http://127.0.0.1:4444",
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      provider: { all: [], default: {}, connected: [] },
    })
  })
})
