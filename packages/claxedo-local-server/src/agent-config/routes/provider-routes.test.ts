import { afterAll, beforeAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-provider-route-"))
const previous = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root
const [{ agentConfigProviderRoutes }, { putCredential }, { listCustomProviders }, { createTestBackend, setBackendOverride }, { ClaxedoDB }] = await Promise.all([
  import("./provider-routes"),
  import("@claxedo/server-core/credentials/registry"),
  import("@claxedo/server-core/credentials/custom-provider"),
  import("@claxedo/server-core/credentials/backend-registry"),
  import("@claxedo/server-core/platform/db/index"),
])

const ACME = {
  providerID: "acme",
  name: "Acme",
  baseURL: "https://api.acme.test/v1",
  env: ["ACME_API_KEY"],
  headers: { "X-Acme-Tenant": "prod" },
  models: { "acme-1": { name: "Acme One" } },
}

function putCustom(org: string, body: unknown) {
  return app.request("/providers/custom?nativeHarness=opencode", {
    method: "PUT",
    headers: { authorization: `Bearer ${org}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}
const app = agentConfigProviderRoutes({
  authConfig: { enabled: true, issuer: "https://auth.test", jwksUrl: "custom:test" },
  verifier: async (token) => ({
    mode: "signed",
    user: { subject: token, orgId: token, issuer: "https://auth.test", tokenIdentifier: token },
  }),
})

beforeAll(async () => {
  setBackendOverride(createTestBackend())
  await putCredential({ provider_id: "openai", kind: "api_key", source: "managed", secret: "test-key-a" }, "org_a")
  await putCredential({ provider_id: "anthropic", kind: "api_key", source: "managed", secret: "test-key-b" }, "org_b")
  await putCredential({ provider_id: "anthropic", kind: "api_key", source: "managed", secret: "host-key" })
})
afterAll(async () => {
  ClaxedoDB.close()
  setBackendOverride(undefined)
  if (previous === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous
  await fs.rm(root, { recursive: true, force: true })
})

describe("control-plane Pi catalog", () => {
  test("serves only the signed tenant's connected providers; machine runtime owns model discovery", async () => {
    const response = await app.request("/providers?nativeHarness=pi&workspaceId=org_b", { headers: { authorization: "Bearer org_a" } })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.connected).toEqual(["openai"])
    const openai = body.all.find((provider: { id: string }) => provider.id === "openai")
    expect(openai.source).toBe("api")
    expect(openai.models).toEqual({})
    expect(JSON.stringify(body)).not.toContain("test-key")
    const other = await app.request("/providers?nativeHarness=pi", { headers: { authorization: "Bearer org_b" } })
    expect((await other.json()).connected).toEqual(["anthropic"])
  })

  test("authenticates both catalog endpoints before returning data", async () => {
    for (const route of ["/providers", "/providers/auth"]) {
      const response = await app.request(`${route}?nativeHarness=pi`)
      expect(response.status).toBe(401)
    }
  })

  test("rejects absent, external, and conflicting selectors", async () => {
    for (const query of ["", "?nativeHarness=claude", "?connectionId=remote", "?nativeHarness=pi&connectionId=remote"]) {
      const response = await app.request(`/providers${query}`, { headers: { authorization: "Bearer org_a" } })
      expect(response.status).toBe(400)
      expect((await response.json()).error.code).toBe("provider_catalog_unsupported")
    }
  })

  test("serves credential-owner authentication methods without a workspace", async () => {
    const response = await app.request("/providers/auth?nativeHarness=pi", { headers: { authorization: "Bearer org_a" } })
    expect(response.status).toBe(200)
    expect((await response.json()).anthropic).toEqual([
      { type: "token", label: "Claude subscription token", command: "claude setup-token" },
      { type: "api", label: "API Key" },
    ])
  })
})

describe("declaring a custom OpenAI-compatible provider", () => {
  test("persists the configuration under the signed tenant", async () => {
    const response = await putCustom("org_custom", ACME)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(ACME)
    expect(listCustomProviders("org_custom")).toEqual([ACME])
    expect(listCustomProviders("org_a")).toEqual([])
  })

  test("refuses a body carrying secret material instead of storing it", async () => {
    const response = await putCustom("org_secret", { ...ACME, secret: "sk-live" })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("custom_provider_invalid")
    expect(listCustomProviders("org_secret")).toEqual([])
  })

  test("requires authentication and the OpenCode harness", async () => {
    const anonymous = await app.request("/providers/custom?nativeHarness=opencode", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ACME),
    })
    expect(anonymous.status).toBe(401)

    const wrongHarness = await app.request("/providers/custom?nativeHarness=pi", {
      method: "PUT",
      headers: { authorization: "Bearer org_custom", "content-type": "application/json" },
      body: JSON.stringify(ACME),
    })
    expect(wrongHarness.status).toBe(400)
    expect((await wrongHarness.json()).error.code).toBe("provider_custom_unsupported")
  })
})
