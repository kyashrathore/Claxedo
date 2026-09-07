import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, test } from "vitest"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-custom-provider-"))
const previous = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root
const [{ listCustomProviders, putCustomProvider, readCustomProvider, CustomProviderInvalidError }, { ClaxedoDB }] =
  await Promise.all([import("./custom-provider"), import("../platform/db/index")])

const ACME = {
  providerID: "acme",
  name: "Acme",
  baseURL: "https://api.acme.test/v1",
  env: ["ACME_API_KEY"],
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

  test("defaults the optional collections rather than demanding them", () => {
    expect(readCustomProvider({ providerID: "a", name: "A", baseURL: "http://a.test", models: { m: { name: "M" } } }))
      .toEqual({ providerID: "a", name: "A", baseURL: "http://a.test", env: [], headers: {}, models: { m: { name: "M" } } })
  })

  test.each([
    ["a secret smuggled beside the config", { ...ACME, secret: "sk-live" }],
    ["a secret disguised as a provider field", { ...ACME, apiKey: "sk-live" }],
    ["an Authorization header", { ...ACME, headers: { Authorization: "Bearer sk-live" } }],
    ["an engine field the operator may not set", { ...ACME, npm: "@evil/provider" }],
    ["an unsupported model field", { ...ACME, models: { "acme-1": { name: "One", cost: 0 } } }],
    ["an uppercase provider id", { ...ACME, providerID: "Acme" }],
    ["a non-http base URL", { ...ACME, baseURL: "file:///etc/passwd" }],
    ["no models at all", { ...ACME, models: {} }],
    ["a non-object body", "acme"],
  ])("rejects %s", (_label, body) => {
    expect(() => readCustomProvider(body)).toThrow(CustomProviderInvalidError)
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
})
