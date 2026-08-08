/**
 * Cross-surface guard: an EMPTY model catalog is never served silently.
 *
 * "No model results" has shipped repeatedly because every layer treats an empty
 * provider list as a legitimate answer. The engine failed to load (an external
 * that could not resolve in the packaged app), `configProvidersBody` caught the
 * error, and `/config/providers` returned `{providers: [], default: {}}` with a
 * 200 — indistinguishable from "this deployment genuinely has no providers".
 * Nothing in the UI, the HTTP status, or any user-visible log said otherwise.
 *
 * The tests below pin the distinction that was missing:
 *   healthy engine   → catalog is NON-EMPTY and passed through verbatim
 *   engine failure   → still 200 + empty (routes must not 500), but the
 *                      degradation is RECORDED so health can report it
 *
 * The matrix runs the surfaces that resolve providers differently — desktop
 * (embedded engine), cloud/hosted (remote engine URL), and a non-opencode
 * harness (control-plane catalog only) — because the bug has appeared in more
 * than one of them and a fix in one has never implied a fix in the others.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `provider-catalog-matrix-${randomUUID().slice(0, 8)}`)
const prevDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { Hono } = await import("hono")
const { OpenCodeCompatRoutes } = await import("./index")
const { configureOpenCodeEngine } = await import("@claxedo/server-core/opencode/engine")
const { engineDegradations, clearEngineDegradations } = await import("./provider-config")

const ENGINE = "http://127.0.0.1:65501"

const CATALOG = {
  providers: [
    { id: "anthropic", name: "Anthropic", models: { "claude-sonnet-5": { id: "claude-sonnet-5" } } },
    { id: "opencode", name: "OpenCode Zen", models: { "north-mini": { id: "north-mini" } } },
  ],
  default: { anthropic: "claude-sonnet-5" },
}

const app = new Hono()
app.route("/", OpenCodeCompatRoutes())

const originalFetch = globalThis.fetch

/** Engine reachable and healthy. */
function healthyEngine() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === "/config/providers") return Response.json(CATALOG)
    return new Response("not found", { status: 404 })
  }) as typeof globalThis.fetch
}

/**
 * Engine present but unloadable — the exact production failure. A bundled
 * external that cannot resolve makes the ESM import throw, so the transport
 * rejects rather than returning a non-200.
 */
function unloadableEngine() {
  globalThis.fetch = (async () => {
    throw new Error("Cannot find package 'jsonc-parser' imported from .../opencode-engine/node.js")
  }) as unknown as typeof globalThis.fetch
}

beforeEach(() => {
  clearEngineDegradations()
  configureOpenCodeEngine({ url: ENGINE })
  healthyEngine()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  clearEngineDegradations()
  configureOpenCodeEngine({ url: "http://127.0.0.1:4096" })
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
  if (prevDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = prevDataDir
})

// Each surface reaches /config/providers with a different query shape. All of
// them must produce a populated catalog when the engine is healthy.
const SURFACES = [
  { name: "desktop (embedded engine, unqualified request)", query: "" },
  { name: "desktop (explicit harness)", query: "?harness=opencode" },
  { name: "app composer (runner param)", query: "?runner=opencode" },
  { name: "cloud/hosted (directory-scoped request)", query: "?directory=%2Fworkspace&runner=opencode" },
]

describe("model catalog is populated on every surface", () => {
  for (const surface of SURFACES) {
    test(`${surface.name} serves a NON-EMPTY provider list`, async () => {
      const res = await app.request(`/config/providers${surface.query}`)
      expect(res.status, surface.name).toBe(200)

      const body = await res.json() as { providers?: unknown[] }
      // The assertion that would have caught the shipped bug: not just "the
      // route answered", but "it answered with models the picker can list".
      expect(Array.isArray(body.providers), surface.name).toBe(true)
      expect(body.providers!.length, `${surface.name}: empty catalog renders "No model results"`).toBeGreaterThan(0)

      const withModels = (body.providers as { models?: Record<string, unknown> }[]).filter(
        (p) => p.models && Object.keys(p.models).length > 0,
      )
      expect(withModels.length, `${surface.name}: providers present but every one has zero models`).toBeGreaterThan(0)
    })
  }

  test("a non-opencode harness serves an empty catalog WITHOUT recording a degradation", async () => {
    // Empty here is correct, not a failure: these harnesses carry no opencode
    // catalog. The distinction matters — health must not report degraded.
    const res = await app.request("/config/providers?harness=claude-acp")
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ providers: [], default: {} })
    expect(engineDegradations()).toEqual([])
  })
})

describe("an unloadable engine is degraded, not silently empty", () => {
  test("the route still answers 200 with an empty catalog", async () => {
    unloadableEngine()
    const res = await app.request("/config/providers?harness=opencode")
    // Routes must not 500: the rest of the app keeps working.
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ providers: [], default: {} })
  })

  test("the failure is RECORDED so it cannot pass for a healthy empty result", async () => {
    unloadableEngine()
    await app.request("/config/providers?harness=opencode")

    const degraded = engineDegradations()
    expect(degraded.length, "an engine failure left no trace — this is how the bug stayed invisible").toBeGreaterThan(0)
    expect(degraded[0]!.label).toBe("config providers")
    expect(degraded[0]!.error).toContain("jsonc-parser")
  })

  test("recovery clears the degradation", async () => {
    unloadableEngine()
    await app.request("/config/providers?harness=opencode")
    expect(engineDegradations().length).toBeGreaterThan(0)

    healthyEngine()
    const res = await app.request("/config/providers?harness=opencode")
    expect((await res.json() as { providers: unknown[] }).providers.length).toBeGreaterThan(0)
    expect(engineDegradations()).toEqual([])
  })
})
