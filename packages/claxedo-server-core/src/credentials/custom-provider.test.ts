import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, test } from "vitest"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-custom-provider-"))
const previous = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root
const [
  {
    listCustomProviders,
    putCustomProvider,
    readCustomProvider,
    customProviderEnvName,
    CustomProviderInvalidError,
  },
  { ClaxedoDB },
  { ClaxedoCustomProviderTable },
] = await Promise.all([
  import("./custom-provider"),
  import("../platform/db/index"),
  import("./custom-provider.sql"),
])

const ACME = {
  providerID: "acme",
  name: "Acme",
  baseURL: "https://api.acme.test/v1",
  env: ["CLAXEDO_CUSTOM_PROVIDER_ACME_API_KEY"],
  headers: { "X-Acme-Tenant": "prod" },
  models: { "acme-1": { name: "Acme One" } },
}

afterAll(async () => {
  ClaxedoDB.close()
  if (previous === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous
  await fs.rm(root, { recursive: true, force: true })
})

describe("readCustomProvider", () => {
  test("round-trips the allowlisted configuration", () => {
    expect(readCustomProvider(ACME)).toEqual(ACME)
  })

  test("names the one environment variable a provider may read", () => {
    expect(customProviderEnvName("acme")).toBe("CLAXEDO_CUSTOM_PROVIDER_ACME_API_KEY")
    expect(customProviderEnvName("acme-pro")).toBe("CLAXEDO_CUSTOM_PROVIDER_ACME_PRO_API_KEY")
  })

  test("defaults the optional collections rather than demanding them", () => {
    expect(readCustomProvider({ providerID: "a", name: "A", baseURL: "https://a.test", models: { m: { name: "M" } } }))
      .toEqual({ providerID: "a", name: "A", baseURL: "https://a.test", env: [], headers: {}, models: { m: { name: "M" } } })
  })

  test("admits a loopback HTTP base URL only where the deployment allows it", () => {
    const local = { providerID: "a", name: "A", baseURL: "http://127.0.0.1:11434/v1", models: { m: { name: "M" } } }
    expect(() => readCustomProvider(local)).toThrow(CustomProviderInvalidError)
    expect(() => readCustomProvider(local, { allowInsecureLoopback: false })).toThrow(CustomProviderInvalidError)
    for (const baseURL of ["http://127.0.0.1:11434/v1", "http://localhost:8080", "http://[::1]:9000/v1"]) {
      expect(readCustomProvider({ ...local, baseURL }, { allowInsecureLoopback: true }).baseURL).toBe(baseURL)
    }
  })

  test.each([
    ["a secret smuggled beside the config", { ...ACME, secret: "sk-live" }],
    ["a secret disguised as a provider field", { ...ACME, apiKey: "sk-live" }],
    ["an Authorization header", { ...ACME, headers: { Authorization: "Bearer sk-live" } }],
    ["an engine field the operator may not set", { ...ACME, npm: "@evil/provider" }],
    ["an unsupported model field", { ...ACME, models: { "acme-1": { name: "One", cost: 0 } } }],
    ["an uppercase provider id", { ...ACME, providerID: "Acme" }],
    ["a non-http base URL", { ...ACME, baseURL: "file:///etc/passwd" }],
    ["a cleartext base URL off the loopback interface", { ...ACME, baseURL: "http://api.acme.test/v1" }],
    ["a loopback lookalike host", { ...ACME, baseURL: "http://127.0.0.1.evil.test/v1" }],
    ["a base URL carrying credentials", { ...ACME, baseURL: "https://key:secret@api.acme.test/v1" }],
    ["a base URL carrying a query", { ...ACME, baseURL: "https://api.acme.test/v1?key=sk-live" }],
    ["an env name holding an internal secret", { ...ACME, env: ["CLAXEDO_CREDENTIALS_TOKEN"] }],
    ["an env name holding another vendor's credential", { ...ACME, env: ["ANTHROPIC_API_KEY"] }],
    ["an env name that looks provider-shaped but is not this provider's", { ...ACME, env: ["ACME_API_KEY"] }],
    ["another provider's variable beside its own", { ...ACME, env: [...ACME.env, "CLAXEDO_CUSTOM_PROVIDER_OTHER_API_KEY"] }],
    ["no models at all", { ...ACME, models: {} }],
    ["a non-object body", "acme"],
  ])("rejects %s", (_label, body) => {
    expect(() => readCustomProvider(body)).toThrow(CustomProviderInvalidError)
    expect(() => readCustomProvider(body, { allowInsecureLoopback: true })).toThrow(CustomProviderInvalidError)
  })
})

describe("the custom-provider store", () => {
  test("persists per org and never lets one org read or overwrite another's", () => {
    putCustomProvider(readCustomProvider(ACME), "org_a")
    putCustomProvider(readCustomProvider({ ...ACME, name: "Acme B", baseURL: "https://b.acme.test/v1" }), "org_b")

    expect(listCustomProviders("org_a")).toEqual([ACME])
    expect(listCustomProviders("org_b")).toEqual([{ ...ACME, name: "Acme B", baseURL: "https://b.acme.test/v1" }])
    expect(listCustomProviders()).toEqual([])
  })

  test("a second write to the same id replaces the row instead of adding one", () => {
    putCustomProvider(readCustomProvider(ACME), "org_c")
    putCustomProvider(
      readCustomProvider({ ...ACME, models: { "acme-2": { name: "Acme Two" } }, headers: {} }),
      "org_c",
    )
    expect(listCustomProviders("org_c")).toEqual([
      { ...ACME, headers: {}, models: { "acme-2": { name: "Acme Two" } } },
    ])
  })

  test("refuses to persist a config that skipped the parse boundary", () => {
    expect(() =>
      putCustomProvider({ ...ACME, env: ["CLAXEDO_CREDENTIALS_TOKEN"] }, "org_d"),
    ).toThrow(CustomProviderInvalidError)
    expect(() =>
      putCustomProvider({ ...ACME, baseURL: "http://api.acme.test/v1" }, "org_d"),
    ).toThrow(CustomProviderInvalidError)
    expect(listCustomProviders("org_d")).toEqual([])
  })

  test("a row persisted before the env-name policy serves without the foreign name", () => {
    const now = Date.now()
    ClaxedoDB.use((db) =>
      db
        .insert(ClaxedoCustomProviderTable)
        .values({
          org_id: "org_legacy",
          provider_id: "legacy",
          name: "Legacy",
          base_url: "https://api.legacy.test/v1",
          env_json: JSON.stringify(["CLAXEDO_CREDENTIALS_TOKEN", "CLAXEDO_CUSTOM_PROVIDER_LEGACY_API_KEY"]),
          headers_json: "{}",
          models_json: JSON.stringify({ "legacy-1": { name: "Legacy One" } }),
          created_at: now,
          updated_at: now,
        })
        .run(),
    )
    expect(listCustomProviders("org_legacy")).toEqual([
      {
        providerID: "legacy",
        name: "Legacy",
        baseURL: "https://api.legacy.test/v1",
        env: ["CLAXEDO_CUSTOM_PROVIDER_LEGACY_API_KEY"],
        headers: {},
        models: { "legacy-1": { name: "Legacy One" } },
      },
    ])
  })
})
