import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, expect, test } from "vitest"
import type { ProviderCatalogEntry } from "@claxedo/harness/contract"

// The formatter reads the org's custom providers and stored accounts, so
// importing it opens a database. Point that at a scratch directory BEFORE the
// import or the suite writes the developer's real `~/.claxedo/claxedo.db`.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "claxedo-catalog-data-"))
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = dataDir
const [{ opencodeProviderCatalog }, { putCustomProvider }, { putCredential, updateCredentialStatus }, { createTestBackend, setBackendOverride }, { ClaxedoDB }] = await Promise.all([
  import("./opencode-provider-catalog"),
  import("./custom-provider"),
  import("./registry"),
  import("./backend-registry"),
  import("../platform/db/index"),
])
setBackendOverride(createTestBackend())

afterAll(() => {
  setBackendOverride(undefined)
  ClaxedoDB.close()
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

const engine = (...entries: ProviderCatalogEntry[]) => entries

test("a runnable provider carries the engine's models, costs and variants", async () => {
  const catalog = opencodeProviderCatalog({ actor: "person_a", org: "org_engine", engine: engine({ id: "zen", name: "Zen", env: ["ZEN_KEY"], connected: true, models: [
    { providerID: "zen", id: "two", name: "Zen Two", variants: ["high"], cost: [{ input: 1, output: 2 }] },
    { providerID: "zen", id: "one", name: "Zen One", cost: [{ input: 0, output: 0 }] },
  ] }) })
  expect(catalog.connected).toEqual(["zen"])
  expect(catalog.modelAvailability).toBe("available")
  expect(catalog.default).toEqual({ zen: "one" })
  expect(catalog.all).toEqual([{ id: "zen", name: "Zen", env: ["ZEN_KEY"], source: "config", models: {
    two: { id: "two", name: "Zen Two", connected: true, free: false, variants: { high: {} } },
    one: { id: "one", name: "Zen One", connected: true, free: true },
  } }])
})

test("a discovered provider the engine cannot run stays listed disconnected", async () => {
  const catalog = opencodeProviderCatalog({ actor: "person_a", org: "org_discovered", engine: engine(
    { id: "groq", name: "Groq", env: ["GROQ_API_KEY"], connected: false, models: [] },
  ) })
  expect(catalog.connected).toEqual([])
  expect(catalog.all).toEqual([{ id: "groq", name: "Groq", env: ["GROQ_API_KEY"], source: "config", models: {} }])
})

test("a vendor the org stored an account for is managed by that account, connected or refused", async () => {
  await putCredential({ owner: "person_a", provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-openai" }, "org_api")
  await putCredential({ owner: "person_a", provider_id: "claude-sdk", kind: "api_key", source: "managed", secret: "sk-claude" }, "org_api")
  const catalog = opencodeProviderCatalog({ actor: "person_a", org: "org_api", engine: engine(
    { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], connected: false, models: [] },
    { id: "anthropic", name: "Anthropic", env: [], connected: true, models: [{ providerID: "anthropic", id: "sonnet", cost: [] }] },
    { id: "groq", name: "Groq", env: [], connected: false, models: [] },
  ) })
  expect(Object.fromEntries(catalog.all.map((provider) => [provider.id, provider.source]))).toEqual({ openai: "api", anthropic: "api", groq: "config" })
  expect(catalog.connected).toEqual(["anthropic"])
  const colleague = opencodeProviderCatalog({ actor: "person_b", org: "org_api", engine: engine({ id: "openai", name: "OpenAI", env: [], connected: false, models: [] }) })
  expect(colleague.all[0]?.source).toBe("config")
  const other = opencodeProviderCatalog({ actor: "person_a", org: "org_other", engine: engine({ id: "openai", name: "OpenAI", env: [], connected: false, models: [] }) })
  expect(other.all[0]?.source).toBe("config")
})

test("a declared provider keeps its custom row whether or not the engine runs it, and never crosses orgs", async () => {
  const acme = { providerID: "acme", name: "Acme", baseURL: "https://api.acme.test/v1", env: [], headers: { "X-Title": "prod" },
    credentialHeader: { name: "Authorization", scheme: "Bearer" as const }, models: { "acme-1": { name: "Acme One" } } }
  putCustomProvider(acme, "org_custom")
  putCustomProvider({ ...acme, providerID: "offline", name: "Offline" }, "org_custom")
  const catalog = opencodeProviderCatalog({ actor: "person_a", org: "org_custom", engine: engine(
    { id: "acme", name: "acme", env: [], connected: true, models: [{ providerID: "acme", id: "acme-1", name: "Acme One", cost: [] }] },
  ) })
  expect(catalog.all).toEqual([
    { id: "acme", name: "Acme", env: [], source: "custom", options: { baseURL: acme.baseURL, headers: acme.headers },
      models: { "acme-1": { id: "acme-1", name: "Acme One", connected: true, free: false } } },
    { id: "offline", name: "Offline", env: [], source: "custom", options: { baseURL: acme.baseURL, headers: acme.headers },
      models: { "acme-1": { id: "acme-1", name: "Acme One", connected: false, free: false } } },
  ])
  expect(catalog.connected).toEqual(["acme"])
  const other = opencodeProviderCatalog({ actor: "person_a", org: "org_elsewhere", engine: engine() })
  expect(other.all).toEqual([])
})

test("with no engine to ask, the vendors and declared providers are listed, connected by the accounts the org holds", async () => {
  await putCredential({ owner: "person_a", provider_id: "claude-sdk", kind: "api_key", source: "managed", secret: "sk-claude" }, "org_accounts")
  const refused = await putCredential({ owner: "person_a", provider_id: "keyed", kind: "api_key", source: "managed", secret: "sk-keyed" }, "org_accounts")
  updateCredentialStatus(refused.id, "revoked", undefined, "org_accounts")
  const declared = { providerID: "keyless", name: "Keyless", baseURL: "http://127.0.0.1:11434/v1", env: [], headers: {},
    credentialHeader: { name: "Authorization", scheme: "Bearer" as const }, models: { local: { name: "Local" } } }
  putCustomProvider(declared, "org_accounts")
  putCustomProvider({ ...declared, providerID: "keyed", name: "Keyed" }, "org_accounts")
  const catalog = opencodeProviderCatalog({ actor: "person_a", org: "org_accounts", engine: undefined })
  expect(catalog.modelAvailability).toBe("runtime_required")
  expect(catalog.all.map((provider) => [provider.id, provider.source])).toEqual([
    ["anthropic", "api"], ["openai", "config"], ["openrouter", "config"], ["google", "config"], ["groq", "config"], ["xai", "config"],
    ["keyed", "custom"], ["keyless", "custom"],
  ])
  expect(catalog.all.find((provider) => provider.id === "anthropic")).toMatchObject({ name: "Anthropic", models: {} })
  expect(catalog.connected).toEqual(["anthropic", "keyless"])
  expect(catalog.default).toEqual({ keyed: "local", keyless: "local" })
})
