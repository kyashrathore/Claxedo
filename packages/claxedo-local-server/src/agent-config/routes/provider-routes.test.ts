import { afterAll, beforeAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-provider-route-"))
const previous = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root
const [{ agentConfigProviderRoutes }, { putCredential }, { createTestBackend, setBackendOverride }, { ClaxedoDB }] = await Promise.all([
  import("./provider-routes"),
  import("@claxedo/server-core/credentials/registry"),
  import("@claxedo/server-core/credentials/backend-registry"),
  import("@claxedo/server-core/platform/db/index"),
])
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
    expect((await response.json()).anthropic).toEqual([{ type: "api", label: "API Key" }])
  })
})
