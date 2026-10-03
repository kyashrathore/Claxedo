import { expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("another person in the same org can neither change nor delete someone else's account", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "credential-person-isolation-"))
  process.env.CLAXEDO_DATA_DIR = root
  const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
  const { putCredential, credentialById } = await import("@claxedo/server-core/credentials/registry")
  const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
  const { defaultControlPlaneCredentials } = await import("@claxedo/server-core/authority/default-credentials")
  const { CredentialRoutes } = await import("@claxedo/server-core/credentials/routes/credential")
  setBackendOverride(createTestBackend())
  try {
    const owned = await putCredential({ owner: "A", provider_id: "openai", kind: "api_key", source: "managed", secret: "key-A" }, "__local__")
    const shared = await putCredential({ owner: null, provider_id: "claude-sdk", kind: "api_key", source: "managed", secret: "local-org-key" }, "__local__")
    const foreign = await putCredential({ owner: null, provider_id: "claude-sdk", kind: "api_key", source: "managed", secret: "other-org-key" }, "other-org")
    const app = CredentialRoutes(defaultControlPlaneCredentials(), {
      authConfig: { enabled: true, issuer: "test", jwksUrl: "https://identity.test/jwks" },
      verifier: async (token) => ({ mode: "signed", user: { subject: token, tokenIdentifier: token, issuer: "test", orgId: "__local__" } }),
    })
    const as = (person: string, method: string, body?: unknown) => ({
      method, headers: { authorization: `Bearer ${person}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    expect((await app.request(`http://localhost/${owned.id}/status`, as("B", "PATCH", { status: "revoked" }))).status).toBe(404)
    expect((await app.request(`http://localhost/${owned.id}/scope`, as("B", "PATCH", { scope: "shared" }))).status).toBe(404)
    expect(await (await app.request(`http://localhost/${owned.id}`, as("B", "DELETE"))).json()).toEqual({ deleted: false })
    expect(await (await app.request("http://localhost/provider/openai", as("B", "DELETE"))).json()).toEqual({ deleted: 0 })
    expect(credentialById(owned.id, { onOutage: "throw" }, "__local__")).toMatchObject({ status: "available", scope: "local" })

    for (const person of ["A", "B"]) {
      const sources = await (await app.request("http://localhost/account-sources", as(person, "GET"))).json()
      expect(sources).toMatchObject({ can_remove_org_accounts: false, org: [expect.objectContaining({ id: shared.id })] })
      expect(await (await app.request(`http://localhost/${shared.id}`, as(person, "DELETE"))).json()).toEqual({ deleted: false })
    }
    expect((await app.request(`http://localhost/${shared.id}`, as("local", "DELETE"))).status).toBe(401)

    const local = CredentialRoutes(defaultControlPlaneCredentials(), {})
    expect(await (await local.request("http://localhost/account-sources")).json()).toMatchObject({ can_remove_org_accounts: true })
    expect(await (await local.request(`http://localhost/${owned.id}`, { method: "DELETE" })).json()).toEqual({ deleted: false })
    expect(await (await local.request(`http://localhost/${foreign.id}`, { method: "DELETE" })).json()).toEqual({ deleted: false })
    expect(await (await local.request(`http://localhost/${shared.id}`, { method: "DELETE", headers: { "x-forwarded-for": "203.0.113.10" } })).json()).toEqual({ deleted: false })
    expect(credentialById(shared.id, { onOutage: "throw" }, "__local__")).toBeDefined()
    expect(await (await local.request(`http://localhost/${shared.id}`, { method: "DELETE" })).json()).toEqual({ deleted: true })
    expect(credentialById(shared.id, { onOutage: "throw" }, "__local__")).toBeUndefined()
    expect(await (await local.request("http://localhost/account-sources")).json()).toMatchObject({ org: [] })
    expect(credentialById(foreign.id, { onOutage: "throw" }, "other-org")).toBeDefined()

    expect(await (await app.request("http://localhost/provider/openai", as("A", "DELETE"))).json()).toEqual({ deleted: 1 })
    expect(credentialById(owned.id, { onOutage: "throw" }, "__local__")).toBeUndefined()
  } finally {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    delete process.env.CLAXEDO_DATA_DIR
    await fs.rm(root, { recursive: true, force: true })
  }
})
