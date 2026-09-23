import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, afterEach, describe, expect, test } from "vitest"
import type { CatalogFetch, OpenCodeEngineModel } from "./opencode-provider-catalog"

// The catalog reads the custom-provider table, so importing it opens a database.
// Point that at a scratch directory BEFORE the import or the suite migrates and
// writes the developer's real `~/.claxedo/claxedo.db`.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "claxedo-catalog-data-"))
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = dataDir
const [
  { opencodeProviderCatalog, OpenCodeCatalogUnavailableError, resolveModelsDevCatalog },
  { putCustomProvider },
  { ClaxedoDB },
  { ClaxedoCustomProviderTable },
] = await Promise.all([
  import("./opencode-provider-catalog"),
  import("./custom-provider"),
  import("../platform/db/index"),
  import("./custom-provider.sql"),
])
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

function engine(...models: OpenCodeEngineModel[]) {
  return async () => models
}

const ZEN_CATALOG = {
  ...CATALOG,
  opencode: {
    id: "opencode",
    name: "OpenCode Zen",
    env: ["OPENCODE_API_KEY"],
    models: {
      "deepseek-paid": { id: "deepseek-paid", name: "DeepSeek", cost: { input: 0.3, output: 1.2 } },
      "pickle-free": { id: "pickle-free", name: "Pickle", cost: { input: 0, output: 0 } },
    },
  },
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

afterAll(() => {
  ClaxedoDB.close()
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

describe("opencodeProviderCatalog", () => {
  test("maps models.dev providers and models", async () => {
    const catalog = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk(), engineModels: engine() })
    const anthropic = catalog.all.find((p) => p.id === "anthropic")
    expect(anthropic?.name).toBe("Anthropic")
    expect(Object.keys(anthropic!.models).sort()).toEqual(["claude-a", "claude-b"])
    expect(anthropic!.models["claude-b"]).toMatchObject({ reasoning: true, attachment: true, tool_call: true })
  })

  test("a model is connected exactly when the engine runs it, whatever keys the environment holds", async () => {
    const catalog = await opencodeProviderCatalog({
      env: env(cacheFile(), { ANTHROPIC_API_KEY: "sk-test", OPENCODE_API_KEY: "sk-zen" }),
      fetchImpl: fetchOk(ZEN_CATALOG),
      engineModels: engine({ providerID: "opencode", id: "pickle-free", cost: [{ input: 0, output: 0 }] }),
    })
    const zen = catalog.all.find((p) => p.id === "opencode")!.models
    expect(zen["pickle-free"]).toMatchObject({ connected: true, free: true })
    expect(zen["deepseek-paid"]).toMatchObject({ connected: false, free: false })
    expect(catalog.connected).toEqual(["opencode"])
    const anthropic = catalog.all.find((p) => p.id === "anthropic")!.models
    expect(Object.values(anthropic).every((model) => !model.connected)).toBe(true)
  })

  test("free is the engine's price for every tier being zero, never a missing price", async () => {
    const catalog = await opencodeProviderCatalog({
      env: env(cacheFile()),
      fetchImpl: fetchOk(ZEN_CATALOG),
      engineModels: engine(
        { providerID: "opencode", id: "pickle-free", cost: [{ input: 0, output: 0 }, { input: 0, output: 0.5 }] },
        { providerID: "opencode", id: "deepseek-paid", cost: [] },
      ),
    })
    const zen = catalog.all.find((p) => p.id === "opencode")!.models
    expect(zen["pickle-free"].free).toBe(false)
    expect(zen["deepseek-paid"]).toMatchObject({ connected: true, free: false })
  })

  test("a provider defaults to its first runnable model, not its first model", async () => {
    const catalog = await opencodeProviderCatalog({
      env: env(cacheFile()),
      fetchImpl: fetchOk(ZEN_CATALOG),
      engineModels: engine({ providerID: "opencode", id: "pickle-free", cost: [{ input: 0, output: 0 }] }),
    })
    expect(catalog.default.opencode).toBe("pickle-free")
    expect(catalog.default.anthropic).toBe("claude-a")
  })

  test("a model the engine runs that models.dev does not list is still offered", async () => {
    const catalog = await opencodeProviderCatalog({
      env: env(cacheFile()),
      fetchImpl: fetchOk(),
      engineModels: engine(
        { providerID: "anthropic", id: "claude-z", name: "Z", cost: [] },
        { providerID: "ollama", id: "llama", name: "Llama", cost: [{ input: 0, output: 0 }] },
      ),
    })
    expect(catalog.all.find((p) => p.id === "anthropic")!.models["claude-z"]).toMatchObject({ name: "Z", connected: true })
    expect(catalog.all.find((p) => p.id === "ollama")!.models.llama).toMatchObject({ name: "Llama", connected: true, free: true })
    expect(catalog.connected.sort()).toEqual(["anthropic", "ollama"])
  })

  test("carries the engine's effort variants onto the catalog rows it resolves", async () => {
    const catalog = await opencodeProviderCatalog({
      env: env(cacheFile()),
      fetchImpl: fetchOk(),
      engineModels: engine(
        { providerID: "anthropic", id: "claude-b", variants: ["high", "max"], cost: [] },
        { providerID: "anthropic", id: "claude-a", cost: [] },
      ),
    })
    const models = catalog.all.find((p) => p.id === "anthropic")!.models
    expect(models["claude-b"].variants).toEqual({ high: {}, max: {} })
    expect(models["claude-a"]).not.toHaveProperty("variants")
  })

  test("an engine that cannot list its models makes the catalog unavailable rather than disconnected", async () => {
    await expect(opencodeProviderCatalog({
      env: env(cacheFile()),
      fetchImpl: fetchOk(),
      engineModels: async () => { throw new Error("engine not ready") },
    })).rejects.toBeInstanceOf(OpenCodeCatalogUnavailableError)
  })

  test("drops providers with no models rather than listing an empty one", async () => {
    const catalog = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk(), engineModels: engine() })
    expect(catalog.all.some((p) => p.id === "empty")).toBe(false)
  })

  test("deprecated models are not listed and cannot become the default", async () => {
    const catalog = await opencodeProviderCatalog({
      env: env(cacheFile()),
      fetchImpl: fetchOk({
        opencode: {
          id: "opencode",
          name: "OpenCode Zen",
          env: [],
          models: {
            "a-retired-free": { id: "a-retired-free", name: "Retired", status: "deprecated" },
            "b-live-free": { id: "b-live-free", name: "Live", status: "beta" },
          },
        },
        gone: { id: "gone", name: "Gone", env: [], models: { old: { id: "old", status: "deprecated" } } },
      }),
      engineModels: engine(),
    })
    const zen = catalog.all.find((p) => p.id === "opencode")!
    expect(Object.keys(zen.models)).toEqual(["b-live-free"])
    expect(catalog.default.opencode).toBe("b-live-free")
    expect(catalog.all.some((p) => p.id === "gone")).toBe(false)
  })

  test("default model is deterministic, not whichever key came first", async () => {
    const catalog = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk(), engineModels: engine() })
    // models.dev key order is not guaranteed; "claude-a" sorts first.
    expect(catalog.default.anthropic).toBe("claude-a")
  })

  test("an unavailable catalog with nothing cached throws instead of returning empty", async () => {
    // "we cannot reach the catalog" is a different fact from "you have no
    // providers"; collapsing them would show an outage as an empty picker.
    await expect(
      opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchFails(), engineModels: engine() }),
    ).rejects.toBeInstanceOf(OpenCodeCatalogUnavailableError)
  })

  test("a stale cache is served when the network is down", async () => {
    const cache = cacheFile()
    await opencodeProviderCatalog({ env: env(cache), fetchImpl: fetchOk(), engineModels: engine() })
    // Well past the TTL, and the network now fails: a day-old model list still
    // beats an empty picker.
    const catalog = await opencodeProviderCatalog({
      env: env(cache),
      fetchImpl: fetchFails(),
      now: Date.now() + 30 * 24 * 60 * 60 * 1000,
      engineModels: engine(),
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
    const catalog = await opencodeProviderCatalog({ env: env(cache), fetchImpl: fetchOk(), engineModels: engine() })
    expect(catalog.all.length).toBeGreaterThan(0)
  })
})

describe("operator-declared providers in the OpenCode catalog", () => {
  const acme = {
    providerID: "acme",
    name: "Acme",
    baseURL: "https://api.acme.test/v1",
    env: ["CLAXEDO_CUSTOM_PROVIDER_ACME_API_KEY"],
    headers: { "X-Acme-Tenant": "prod" },
    models: { "acme-b": { name: "Acme B" }, "acme-a": { name: "Acme A" } },
  }

  test("a custom provider joins models.dev's rows with its base URL, headers and models", async () => {
    putCustomProvider(acme, "org_custom")
    const catalog = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk(), org: "org_custom", engineModels: engine() })

    const entry = catalog.all.find((provider) => provider.id === "acme")
    expect(entry).toMatchObject({ name: "Acme", source: "custom", options: { baseURL: acme.baseURL, headers: acme.headers } })
    expect(Object.keys(entry!.models).sort()).toEqual(["acme-a", "acme-b"])
    expect(catalog.default.acme).toBe("acme-a")
    expect(catalog.all.some((provider) => provider.id === "anthropic")).toBe(true)
  })

  test("another org's catalog does not carry it", async () => {
    putCustomProvider(acme, "org_custom")
    const catalog = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk(), org: "org_other", engineModels: engine() })
    expect(catalog.all.some((provider) => provider.id === "acme")).toBe(false)
  })

  test("it is connected only when the engine runs it, not when its environment variable is set", async () => {
    putCustomProvider(acme, "org_custom")
    const keyed = await opencodeProviderCatalog({
      env: env(cacheFile(), { CLAXEDO_CUSTOM_PROVIDER_ACME_API_KEY: "sk-test" }),
      fetchImpl: fetchOk(),
      org: "org_custom",
      engineModels: engine(),
    })
    expect(keyed.connected).not.toContain("acme")

    const run = await opencodeProviderCatalog({
      env: env(cacheFile()),
      fetchImpl: fetchOk(),
      org: "org_custom",
      engineModels: engine({ providerID: "acme", id: "acme-b", cost: [] }),
    })
    expect(run.connected).toContain("acme")
    expect(run.default.acme).toBe("acme-b")
  })

  test("a process secret named on a stored row never connects or ships in the catalog", async () => {
    // The parse boundary refuses foreign env names; a row carrying one anyway
    // (written before the policy, or by a path that skipped it) must still be
    // neutralized on the way out.
    const now = Date.now()
    ClaxedoDB.use((db) =>
      db
        .insert(ClaxedoCustomProviderTable)
        .values({
          org_id: "org_secret_env",
          provider_id: "acme",
          name: "Acme",
          base_url: "https://api.acme.test/v1",
          env_json: JSON.stringify(["CLAXEDO_CREDENTIALS_TOKEN"]),
          headers_json: "{}",
          models_json: JSON.stringify({ "acme-1": { name: "Acme One" } }),
          created_at: now,
          updated_at: now,
        })
        .run(),
    )
    const catalog = await opencodeProviderCatalog({
      env: env(cacheFile(), { CLAXEDO_CREDENTIALS_TOKEN: "internal-secret" }),
      fetchImpl: fetchOk(),
      org: "org_secret_env",
      engineModels: engine(),
    })
    const entry = catalog.all.find((provider) => provider.id === "acme")
    expect(entry?.env).toEqual([])
    expect(catalog.connected).not.toContain("acme")
    expect(JSON.stringify(catalog)).not.toContain("CLAXEDO_CREDENTIALS_TOKEN")
  })

  test("a custom provider replaces the models.dev row it shadows", async () => {
    putCustomProvider({ ...acme, providerID: "anthropic", name: "Local Anthropic", env: ["CLAXEDO_CUSTOM_PROVIDER_ANTHROPIC_API_KEY"] }, "org_shadow")
    const catalog = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk(), org: "org_shadow", engineModels: engine() })
    const rows = catalog.all.filter((provider) => provider.id === "anthropic")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: "Local Anthropic", source: "custom" })
  })

  test("no configured secret reaches the served catalog", async () => {
    putCustomProvider(acme, "org_custom")
    const catalog = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk(), org: "org_custom", engineModels: engine() })
    expect(JSON.stringify(catalog)).not.toContain("sk-")
  })
})
