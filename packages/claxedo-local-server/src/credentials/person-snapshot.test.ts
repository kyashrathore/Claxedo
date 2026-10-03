import { expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("the credential producer preserves two people's selections and broker identities", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "person-snapshot-"))
  process.env.CLAXEDO_DATA_DIR = root
  const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
  const { putCredential, setActiveCredentials, clearActiveCredentials, listCredentials } = await import("@claxedo/server-core/credentials/registry")
  const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
  const { createLocalCredentialBroker } = await import("./broker")
  setBackendOverride(createTestBackend())
  try {
    for (const owner of ["A", "B"]) {
      await putCredential({ owner, provider_id: "openai", kind: "api_key", source: "managed", secret: `fixture-${owner}` })
    }
    const broker = createLocalCredentialBroker({ dataDir: root, brokerOrigin: "http://127.0.0.1:48300", machineOwnerUserId: () => "A" })
    const snapshot = await broker.projectAuth({ workspaceId: "ws" })
    expect(snapshot.machineOwnerUserId).toBe("A")
    expect(Object.keys(snapshot.accounts).sort()).toEqual(["A", "B"])
    for (const person of ["A", "B"]) {
      const projection = snapshot.accounts[person].openai
      if ("unavailable" in projection) throw new Error(projection.reason)
      const id = projection.baseUrl.split("/bindings/")[1]
      expect((await broker.authority.resolve(id))?.binding.userId).toBe(person)
      expect((await broker.authority.resolve(id))?.value).toBe(`fixture-${person}`)
    }
    const alternate = await putCredential({ owner: "A", provider_id: "openai", kind: "api_key", source: "managed", account_id: "alternate", secret: "alternate-A" })
    const { CredentialRoutes } = await import("@claxedo/server-core/credentials/routes/credential")
    const { defaultControlPlaneCredentials } = await import("@claxedo/server-core/authority/default-credentials")
    const app = CredentialRoutes({ ...defaultControlPlaneCredentials(),
      setActiveCredentials: async (ids, org, actor) => setActiveCredentials(ids, org, actor),
      clearActiveCredentials: async (ids, org, actor) => clearActiveCredentials(ids, org, actor),
    }, {
      authConfig: { enabled: true, issuer: "test", jwksUrl: "https://identity.test/jwks" },
      verifier: async (token) => ({ mode: "signed", user: { subject: token, tokenIdentifier: token, issuer: "test", orgId: "__local__" } }),
    })
    const activate = (person: string) => app.request("http://localhost/activate", {
      method: "POST", headers: { authorization: `Bearer ${person}`, "content-type": "application/json" },
      body: JSON.stringify({ ids: [alternate.id] }),
    })
    expect((await activate("B")).status).toBe(404)
    expect((await activate("A")).status).toBe(200)
    expect(listCredentials().filter((row) => row.is_active).map((row) => row.owner).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(["A", "B"])
    const next = await broker.projectAuth({ workspaceId: "ws" })
    for (const person of ["A", "B"]) {
      const projection = next.accounts[person].openai
      if ("unavailable" in projection) throw new Error(projection.reason)
      expect((await broker.authority.resolve(projection.baseUrl.split("/bindings/")[1]))?.value)
        .toBe(person === "A" ? "alternate-A" : "fixture-B")
    }
  } finally {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    delete process.env.CLAXEDO_DATA_DIR
    await fs.rm(root, { recursive: true, force: true })
  }
})
