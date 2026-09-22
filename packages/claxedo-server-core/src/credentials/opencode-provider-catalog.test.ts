import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, afterEach, describe, expect, test } from "vitest"
import type { CatalogFetch } from "./opencode-provider-catalog"

// The catalog reads the credential registry, so importing it opens a database.
// Point that at a scratch directory BEFORE the import or the suite migrates and
// writes the developer's real `~/.claxedo/claxedo.db`.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "claxedo-catalog-data-"))
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = dataDir
const [
  { opencodeProviderCatalog, OpenCodeCatalogUnavailableError, resolveModelsDevCatalog },
  { putCustomProvider },
  { deleteCredential, listCredentials, putCredential },
  { createTestBackend, setBackendOverride },
  { ClaxedoDB },
  { ClaxedoCustomProviderTable },
] = await Promise.all([
  import("./opencode-provider-catalog"),
  import("./custom-provider"),
  import("./registry"),
  import("./backend-registry"),
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

  test("a stored sandbox driver token does not connect the model provider that shares its id", async () => {
    // `putCredential` upserts on (org, provider_id, kind, account_id), so one
    // id legitimately holds a deploy token and a model key at once. Reading
    // whichever row sorts first answered the catalog with the deploy token.
    setBackendOverride(createTestBackend())
    const driver = await putCredential({
      provider_id: "vercel",
      kind: "sandbox_driver",
      source: "managed",
      secret: JSON.stringify({ access_token: "vc", team_id: "t", project_id: "p" }),
    })
    try {
      const catalog = await opencodeProviderCatalog({
        env: env(cacheFile()),
        fetchImpl: fetchOk({
          vercel: {
            id: "vercel",
            name: "Vercel",
            env: ["VERCEL_API_KEY"],
            models: { "v0-md": { id: "v0-md", name: "v0" } },
          },
        }),
      })
      expect(catalog.connected).not.toContain("vercel")
    } finally {
      await deleteCredential(driver.id)
      for (const row of listCredentials()) await deleteCredential(row.id)
      setBackendOverride(undefined)
    }
  })

  test("a Claude Code login connects the engine's Anthropic provider, which is the one it binds", async () => {
    // `reconcileCredentialsIntoSdk` binds a `claude-sdk` row to the engine's
    // `anthropic` provider, so a catalog that asked only for `anthropic`
    // called that provider unconnected while turns were already running on it.
    setBackendOverride(createTestBackend())
    const login = await putCredential({
      provider_id: "claude-sdk",
      kind: "oauth_token",
      source: "managed",
      secret: JSON.stringify({ access_token: "plan-token" }),
    })
    try {
      const catalog = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk() })
      expect(catalog.connected).toContain("anthropic")
    } finally {
      for (const row of listCredentials()) await deleteCredential(row.id)
      setBackendOverride(undefined)
    }
    void login
  })

  test("a harness login for one vendor does not connect another vendor's provider", async () => {
    setBackendOverride(createTestBackend())
    await putCredential({
      provider_id: "codex-app-server",
      kind: "oauth_token",
      source: "managed",
      secret: JSON.stringify({ access_token: "plan-token" }),
    })
    try {
      const catalog = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk() })
      expect(catalog.connected).not.toContain("anthropic")
    } finally {
      for (const row of listCredentials()) await deleteCredential(row.id)
      setBackendOverride(undefined)
    }
  })

  test("OpenCode Zen and providers with no env requirement are connected without credentials", async () => {
    const catalog = await opencodeProviderCatalog({
      env: env(cacheFile()),
      fetchImpl: fetchOk({
        ...CATALOG,
        opencode: {
          id: "opencode",
          name: "OpenCode Zen",
          env: ["OPENCODE_API_KEY"],
          models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } },
        },
        ollama: {
          id: "ollama",
          name: "Ollama",
          env: [],
          models: { llama: { id: "llama", name: "Llama" } },
        },
      }),
    })
    expect(catalog.connected).toEqual(["opencode", "ollama"])
    expect(catalog.connected).not.toContain("anthropic")
  })

  test("an unavailable catalog with nothing cached throws instead of returning empty", async () => {
    // "we cannot reach the catalog" is a different fact from "you have no
    // providers"; collapsing them would show an outage as an empty picker.
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
    const catalog = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk(), org: "org_custom" })

    const entry = catalog.all.find((provider) => provider.id === "acme")
    expect(entry).toMatchObject({ name: "Acme", source: "custom", options: { baseURL: acme.baseURL, headers: acme.headers } })
    expect(Object.keys(entry!.models).sort()).toEqual(["acme-a", "acme-b"])
    expect(catalog.default.acme).toBe("acme-a")
    expect(catalog.all.some((provider) => provider.id === "anthropic")).toBe(true)
  })

  test("another org's catalog does not carry it", async () => {
    putCustomProvider(acme, "org_custom")
    const catalog = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk(), org: "org_other" })
    expect(catalog.all.some((provider) => provider.id === "acme")).toBe(false)
  })

  test("it is connected exactly when its own environment variable is set", async () => {
    putCustomProvider(acme, "org_custom")
    const without = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk(), org: "org_custom" })
    expect(without.connected).not.toContain("acme")

    const with_ = await opencodeProviderCatalog({
      env: env(cacheFile(), { CLAXEDO_CUSTOM_PROVIDER_ACME_API_KEY: "sk-test" }),
      fetchImpl: fetchOk(),
      org: "org_custom",
    })
    expect(with_.connected).toContain("acme")
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
    })
    const entry = catalog.all.find((provider) => provider.id === "acme")
    expect(entry?.env).toEqual([])
    expect(catalog.connected).toContain("acme")
    expect(JSON.stringify(catalog)).not.toContain("CLAXEDO_CREDENTIALS_TOKEN")
  })

  test("a custom provider replaces the models.dev row it shadows", async () => {
    putCustomProvider({ ...acme, providerID: "anthropic", name: "Local Anthropic", env: ["CLAXEDO_CUSTOM_PROVIDER_ANTHROPIC_API_KEY"] }, "org_shadow")
    const catalog = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk(), org: "org_shadow" })
    const rows = catalog.all.filter((provider) => provider.id === "anthropic")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: "Local Anthropic", source: "custom" })
  })

  test("no configured secret reaches the served catalog", async () => {
    putCustomProvider(acme, "org_custom")
    const catalog = await opencodeProviderCatalog({ env: env(cacheFile()), fetchImpl: fetchOk(), org: "org_custom" })
    expect(JSON.stringify(catalog)).not.toContain("sk-")
  })
})
