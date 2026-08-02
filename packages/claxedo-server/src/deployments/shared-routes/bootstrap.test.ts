import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import { BootstrapRoutes } from "./bootstrap"
import { configureOpenCodeEngine } from "../../opencode/engine"

// External-URL mode so the injected opencode transport routes to the test's
// fake upstream (intercepted via globalThis.fetch below). Bootstrap no longer
// takes an opencodeUrl option — it rides the shared engine transport.
configureOpenCodeEngine({ url: "http://127.0.0.1:1" })

const root = path.join(os.tmpdir(), `claxedo-bootstrap-route-${Date.now()}-${Math.random().toString(16).slice(2)}`)
const previous = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CLAXEDO_DISABLE_OPENCODE_COMPAT: process.env.CLAXEDO_DISABLE_OPENCODE_COMPAT,
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}

process.env.ANTHROPIC_API_KEY = "sk-ambient-should-not-count"
process.env.CLAXEDO_DISABLE_OPENCODE_COMPAT = "1"
process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

afterAll(async () => {
  if (previous.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = previous.ANTHROPIC_API_KEY
  if (previous.CLAXEDO_DISABLE_OPENCODE_COMPAT === undefined) delete process.env.CLAXEDO_DISABLE_OPENCODE_COMPAT
  else process.env.CLAXEDO_DISABLE_OPENCODE_COMPAT = previous.CLAXEDO_DISABLE_OPENCODE_COMPAT
  if (previous.CLAXEDO_DATA_DIR === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous.CLAXEDO_DATA_DIR
  if (previous.CLAXEDO_STATE_DIR === undefined) delete process.env.CLAXEDO_STATE_DIR
  else process.env.CLAXEDO_STATE_DIR = previous.CLAXEDO_STATE_DIR
  await fs.rm(root, { recursive: true, force: true })
})

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

  test("uses injected env for OpenCode compatibility disable flag instead of ambient process env", async () => {
    const previousFetch = globalThis.fetch
    let calls = 0
    const fakeFetch = Object.assign(async (input: URL | RequestInfo) => {
      calls += 1
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === "/provider") {
        return Response.json({
          all: [{ id: "opencode", name: "OpenCode", models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } } }],
          default: { opencode: "test/model" },
          connected: ["opencode"],
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
        env: {},
      }).request("/api/claxedo/bootstrap?runner=opencode")
      expect(ambientIgnored.status).toBe(200)
      const ambientIgnoredBody = await ambientIgnored.json()
      expect(ambientIgnoredBody.provider.connected).toEqual(["opencode"])
      expect(calls).toBeGreaterThan(0)

      calls = 0
      const injectedDisabled = await BootstrapRoutes({
        env: { CLAXEDO_DISABLE_OPENCODE_COMPAT: "1" },
      }).request("/api/claxedo/bootstrap?runner=opencode")
      expect(injectedDisabled.status).toBe(200)
      const injectedDisabledBody = await injectedDisabled.json()
      expect(injectedDisabledBody.provider).toEqual({ all: [], default: {}, connected: [] })
      expect(injectedDisabledBody.provider_auth["codex-acp"]).toEqual([
        { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
        { type: "api", label: "API Key" },
      ])
      expect(injectedDisabledBody.provider_auth["claude-acp"]).toEqual([{ type: "api", label: "API Key" }])
      expect(injectedDisabledBody.provider_auth["claude-sdk"]).toEqual([{ type: "api", label: "API Key" }])
      expect(injectedDisabledBody.provider_auth["codex-app-server"]).toEqual([{ type: "api", label: "API Key" }])
      expect(injectedDisabledBody.config_providers).toEqual({ providers: [], default: {} })
      expect(calls).toBe(0)
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("keeps bootstrap usable when OpenCode catalog routes are offline", async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = Object.assign(async (input: URL | RequestInfo) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === "/provider" || url.pathname === "/config/providers") {
        return Response.json({ error: { message: "offline" } }, { status: 503 })
      }
      if (url.pathname === "/global/config") return Response.json({ error: { message: "offline" } }, { status: 503 })
      return Response.json({}, { status: 404 })
    }, { preconnect: previousFetch.preconnect })

    try {
      const res = await BootstrapRoutes({
        env: {},
      }).request("/api/claxedo/bootstrap?runner=opencode")

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.provider).toEqual({ all: [], default: {}, connected: [] })
      expect(body.config_providers).toEqual({ providers: [], default: {} })
      expect(body.config).toMatchObject({ provider: {}, mcp: {} })
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("allows loopback browser bootstrap even when bearer auth is attached", async () => {
    const res = await BootstrapRoutes({
      authConfig: { enabled: false, mode: "local-only", reason: "local test" },
      env: { CLAXEDO_DISABLE_OPENCODE_COMPAT: "1" },
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
