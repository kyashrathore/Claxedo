import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, describe, expect, test } from "vitest"

// Custom providers live in the database, so importing their store opens it.
// Point that at a scratch directory BEFORE the import or the suite writes the
// developer's real `~/.claxedo/claxedo.db`.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "claxedo-destinations-data-"))
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = dataDir
const [{ hasProviderDestination, providerDestination }, { putCustomProvider }, { ClaxedoDB }] = await Promise.all([
  import("./destinations"),
  import("./custom-provider"),
  import("../platform/db/index"),
])

afterAll(() => {
  ClaxedoDB.close()
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

const acme = {
  providerID: "acme",
  name: "Acme",
  baseURL: "https://api.acme.test/v1/",
  env: [],
  headers: {},
  credentialHeader: { name: "Authorization", scheme: "Bearer" as const },
  models: { "acme-1": { name: "Acme One" } },
}

describe("a custom provider's destination", () => {
  test("is its own base URL, reached with the key as a bearer token, in the org that declared it", () => {
    putCustomProvider(acme, "org_dest")

    expect(providerDestination({ providerId: "acme", kind: "api_key", secret: "sk-acme", org: "org_dest" })).toEqual({
      origin: "https://api.acme.test",
      methods: ["POST", "GET"],
      pathPrefixes: ["/v1/"],
      apiPath: "/v1",
      injection: { header: "Authorization", scheme: "Bearer" },
      value: "sk-acme",
    })
    expect(hasProviderDestination("acme", "org_dest")).toBe(true)
  })

  test("injects the key at the header the operator declared for it", () => {
    putCustomProvider({ ...acme, providerID: "gemini-proxy", credentialHeader: { name: "X-Goog-Api-Key" } }, "org_dest")
    expect(providerDestination({ providerId: "gemini-proxy", kind: "api_key", secret: "sk-g", org: "org_dest" })?.injection)
      .toEqual({ header: "X-Goog-Api-Key" })
  })

  test("does not exist for another org or for a caller naming none", () => {
    putCustomProvider(acme, "org_dest")

    expect(hasProviderDestination("acme", "org_other")).toBe(false)
    expect(hasProviderDestination("acme")).toBe(false)
  })

  test("replaces the vendor row it shadows, in its org only", () => {
    putCustomProvider({ ...acme, providerID: "anthropic" }, "org_shadow")

    expect(providerDestination({ providerId: "anthropic", kind: "api_key", secret: "sk", org: "org_shadow" })?.origin)
      .toBe("https://api.acme.test")
    expect(providerDestination({ providerId: "anthropic", kind: "api_key", secret: "sk" })?.origin)
      .toBe("https://api.anthropic.com")
  })
})

describe("Cursor SDK 1.0.24 dist/esm/index.js service descriptors", () => {
  test("the standard row declares each Agent, Bidi, Dashboard and ServerConfig method and excludes Analytics", () => {
    const destination = providerDestination({ providerId: "cursor-sdk", kind: "api_key", secret: "cursor-key" })!
    expect(destination.exchange).toEqual({ path: "/auth/exchange_user_api_key", tokenField: "accessToken" })
    expect(destination.pathPrefixes).toEqual([])
    expect(destination.exactPaths).toHaveLength(552)
    expect(new Set(destination.exactPaths).size).toBe(552)
    expect(destination.exactPaths).toContain("/v1/models")
    expect(destination.exactPaths).toContain("/agent.v1.AgentService/RunSSE")
    expect(destination.exactPaths).toContain("/aiserver.v1.BidiService/BidiAppend")
    expect(destination.exactPaths).toContain("/aiserver.v1.DashboardService/GetTeamReposOrEmptyIfNotInTeam")
    expect(destination.exactPaths).toContain("/aiserver.v1.DashboardService/CreateOrganizationApiKey")
    expect(destination.exactPaths).toContain("/aiserver.v1.ServerConfigService/GetServerConfig")
    expect(destination.exactPaths?.some((path) => path.includes("AnalyticsService"))).toBe(false)
    expect(destination.exactPaths?.every((path) => !path.endsWith("/"))).toBe(true)
  })
})
