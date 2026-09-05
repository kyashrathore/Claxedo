import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  opencodeProviderCatalog,
  OpenCodeCatalogUnavailableError,
  resolveModelsDevCatalog,
  type CatalogFetch,
} from "./opencode-provider-catalog"

const dirs: string[] = []

function cacheFile(name = "catalog.json") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "claxedo-catalog-"))
  dirs.push(dir)
  return path.join(dir, name)
}

function env(cache: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { CLAXEDO_OPENCODE_CATALOG_CACHE: cache, ...extra }
}

const CATALOG = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "claude-b": { id: "claude-b", name: "B", reasoning: true, attachment: true },
      "claude-a": { id: "claude-a", name: "A" },
    },
  },
  empty: { id: "empty", name: "No Models", env: [], models: {} },
}

function fetchOk(body: unknown = CATALOG): CatalogFetch {
  return async () => new Response(JSON.stringify(body), { status: 200 })
}

function fetchFails(): CatalogFetch {
  return async () => new Response("nope", { status: 503 })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("opencodeProviderCatalog", () => {
  test("maps models.dev providers and models", async () => {
    const catalog = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk() })
    const anthropic = catalog.all.find((p) => p.id === "anthropic")
    expect(anthropic?.name).toBe("Anthropic")
    expect(Object.keys(anthropic!.models).sort()).toEqual(["claude-a", "claude-b"])
    expect(anthropic!.models["claude-b"]).toMatchObject({ reasoning: true, attachment: true, tool_call: true })
  })

  test("drops providers with no models rather than listing an empty one", async () => {
    const catalog = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk() })
    expect(catalog.all.some((p) => p.id === "empty")).toBe(false)
  })

  test("default model is deterministic, not whichever key came first", async () => {
    const catalog = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk() })
    // models.dev key order is not guaranteed; "claude-a" sorts first.
    expect(catalog.default.anthropic).toBe("claude-a")
  })

  test("a provider is connected when its models.dev env key is present", async () => {
    const cache = cacheFile()
    const without = await opencodeProviderCatalog({ env: env(cache), fetchImpl: fetchOk() })
    expect(without.connected).not.toContain("anthropic")

    const with_ = await opencodeProviderCatalog({
      env: env(cacheFile(), { ANTHROPIC_API_KEY: "sk-test" }),
      fetchImpl: fetchOk(),
    })
    expect(with_.connected).toContain("anthropic")
  })

  test("an unavailable catalog with nothing cached throws instead of returning empty", async () => {
    // "we cannot reach the catalog" is a different fact from "you have no
    // providers"; collapsing them is what R8 forbids.
    await expect(
      opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchFails() }),
    ).rejects.toBeInstanceOf(OpenCodeCatalogUnavailableError)
  })

  test("a stale cache is served when the network is down", async () => {
    const cache = cacheFile()
    await opencodeProviderCatalog({ env: env(cache), fetchImpl: fetchOk() })
    // Well past the TTL, and the network now fails: a day-old model list still
    // beats an empty picker.
    const catalog = await opencodeProviderCatalog({
      env: env(cache),
      fetchImpl: fetchFails(),
      now: Date.now() + 30 * 24 * 60 * 60 * 1000,
    })
    expect(catalog.all.some((p) => p.id === "anthropic")).toBe(true)
  })

  test("a fresh cache is served without touching the network", async () => {
    const cache = cacheFile()
    await resolveModelsDevCatalog({ env: env(cache), fetchImpl: fetchOk() })
    let calls = 0
    await resolveModelsDevCatalog({
      env: env(cache),
      fetchImpl: async () => {
        calls += 1
        return new Response("{}", { status: 200 })
      },
    })
    expect(calls).toBe(0)
  })

  test("a corrupt cache is refetched, not fatal", async () => {
    const cache = cacheFile()
    writeFileSync(cache, "{ not json")
    const catalog = await opencodeProviderCatalog({ env: env(cache), fetchImpl: fetchOk() })
    expect(catalog.all.length).toBeGreaterThan(0)
  })
})
