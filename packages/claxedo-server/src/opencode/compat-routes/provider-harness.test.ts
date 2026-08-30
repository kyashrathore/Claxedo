/**
 * Regression: the opencode provider/model catalog is served for a request that
 * names NO harness.
 *
 * `?harness=` is optional — an absent one means "no preference", which resolves
 * to the CONFIGURED default harness (opencode unless something says otherwise).
 * Two handlers compared the raw query value against `"opencode"` instead of the
 * resolved id, so every unqualified request was treated as "not opencode":
 * `/config/providers` answered with an empty catalog and `/provider/auth` with
 * the ACP method map. `routes/bootstrap.ts` holds a near-copy of both functions
 * that always resolved first, which is why the bootstrap payload looked healthy
 * while the standalone routes did not.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `opencode-compat-harness-${randomUUID().slice(0, 8)}`)
const prevDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { Hono } = await import("hono")
const { OpenCodeCompatRoutes } = await import("@claxedo/local-server/opencode/compat-routes/index")
const { configureOpenCodeEngine } = await import("@claxedo/server-core/opencode/engine")
const { ProviderAuthRoutes } = await import("@claxedo/local-server/credentials/routes/provider-auth")

const ENGINE = "http://127.0.0.1:65500"

const ENGINE_CONFIG_PROVIDERS = {
  providers: [{ id: "anthropic", name: "Anthropic", models: { "claude-sonnet-5": { id: "claude-sonnet-5" } } }],
  default: { anthropic: "claude-sonnet-5" },
}
const ENGINE_PROVIDER_AUTH = {
  anthropic: [{ type: "oauth", label: "Claude Pro/Max" }, { type: "api", label: "API Key" }],
  "github-copilot": [{ type: "oauth", label: "GitHub" }],
}

const app = new Hono()
app.route("/", OpenCodeCompatRoutes())

const originalFetch = globalThis.fetch

beforeEach(() => {
  configureOpenCodeEngine({ url: ENGINE })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === "/config/providers") return Response.json(ENGINE_CONFIG_PROVIDERS)
    if (url.pathname === "/provider/auth") return Response.json(ENGINE_PROVIDER_AUTH)
    return new Response("not found", { status: 404 })
  }) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  configureOpenCodeEngine({ url: "http://127.0.0.1:4096" })
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
  if (prevDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = prevDataDir
})

describe("opencode compat provider routes resolve the harness before comparing it", () => {
  test("/config/providers serves the engine catalog with and without ?harness=", async () => {
    for (const query of ["", "?harness=opencode", "?runner=opencode"]) {
      const res = await app.request(`/config/providers${query}`)
      expect(res.status, query).toBe(200)
      await expect(res.json(), query).resolves.toEqual(ENGINE_CONFIG_PROVIDERS)
    }
  })

  test("/config/providers still serves an empty catalog for a non-opencode harness", async () => {
    const res = await app.request("/config/providers?harness=claude-sdk")
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ providers: [], default: {} })
  })

  test("/provider/auth overlays the engine methods with and without ?harness=", async () => {
    for (const query of ["", "?harness=opencode"]) {
      const res = await app.request(`/provider/auth${query}`)
      expect(res.status, query).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body, query).toMatchObject(ENGINE_PROVIDER_AUTH)
      // The control plane's own methods survive the overlay — the engine adds
      // to them rather than replacing them.
      expect(body["codex-app-server"], query).toBeDefined()
    }
  })

  test("/provider/auth exposes engine failure instead of a partial method catalog", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof globalThis.fetch
    const res = await app.request("/provider/auth?harness=opencode")
    expect(res.status).toBe(502)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "provider_auth_unavailable" },
    })
  })

  test("/provider/auth serves only the control-plane methods for a non-opencode harness", async () => {
    const res = await app.request("/provider/auth?harness=claude-sdk")
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.anthropic).toBeUndefined()
    expect(Object.keys(body).sort()).toEqual(
      ["claude-sdk", "codex-app-server", "cursor-sdk", "openai"],
    )
  })
})

/**
 * `ProviderAuthRoutes` is mounted BEFORE the compat routes, and Hono runs the
 * first registered match, so its `/provider/auth` shadowed the compat one
 * outright: an opencode workspace got the credential registry's fixed ACP map
 * and the connect dialog fell back to "API Key" for every opencode provider,
 * because none of them appear in that map. `deferToHarnessRoute` hands those
 * requests on instead of reordering the mounts, which would take every other
 * harness's credential flow with it.
 */
describe("control-plane provider auth defers opencode to the compat route", () => {
  const registryMethods = { "claude-sdk": [{ type: "api", label: "API Key" }] }
  const services = () => ({ credentials: {} }) as never
  const service = { methods: () => registryMethods } as never

  function mounted(deferToHarnessRoute?: (harness: string | undefined) => boolean) {
    const host = new Hono()
    host.route("/", ProviderAuthRoutes(services(), {
      service,
      ...(deferToHarnessRoute ? { deferToHarnessRoute } : {}),
    }))
    host.get("/provider/auth", (c) => c.json({ servedBy: "later-route" }))
    return host
  }

  test("answers from the credential registry when nothing defers", async () => {
    const res = await mounted().request("/provider/auth")
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(registryMethods)
  })

  test("falls through to the later-registered handler when it defers", async () => {
    const seen: Array<string | undefined> = []
    const host = mounted((harness) => {
      seen.push(harness)
      return harness === "opencode"
    })

    await expect((await host.request("/provider/auth?harness=opencode")).json())
      .resolves.toEqual({ servedBy: "later-route" })
    // Legacy `?runner=` reaches the same predicate.
    await expect((await host.request("/provider/auth?runner=opencode")).json())
      .resolves.toEqual({ servedBy: "later-route" })
    // A harness it does not defer still gets the registry's answer.
    await expect((await host.request("/provider/auth?harness=claude-sdk")).json())
      .resolves.toEqual(registryMethods)

    expect(seen).toEqual(["opencode", "opencode", "claude-sdk"])
  })
})
