/**
 * SQLite side of the shared connections store-port conformance suite.
 *
 * The same runner-neutral cases run against the memory stores inside
 * `@claxedo/connections` (`src/stores/memory.test.ts`). Both adapters must
 * agree on the three-way `list({owner})` partition semantics that
 * `connectionScopeOf` and the `ownerlessRows: "refuse"` route invariant
 * depend on — a divergence here silently leaks or hides connections.
 */
import { describe, expect, test, beforeEach, afterAll } from "vitest"
import { realpathSync, mkdirSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `connections-store-adapter-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
const registry = await import("@claxedo/server-core/credentials/registry")
const { ClaxedoDB } = await import("../platform/db")
ClaxedoDB.Drizzle()

const { createConnectionStoreAdapter, createCredentialStoreAdapter } = await import("./store-adapter")
const { connectionStoreConformance, credentialStoreConformance } = await import("@claxedo/connections")
import type { ControlPlaneCredentials } from "../authority/services"

function credentialsPort(): ControlPlaneCredentials {
  return {
    listCredentials: async () => registry.listCredentials(),
    getCredentialByProvider: async (providerId) => registry.getCredentialByProvider(providerId),
    resolveCredentialSecret: (providerId) => registry.resolveSecret(providerId),
    putCredential: (input) => registry.putCredential(input),
    deleteCredential: async (id) => registry.deleteCredential(id),
    deleteCredentialsByProvider: async (providerId) => registry.deleteCredentialsByProvider(providerId),
    updateCredentialStatus: async (id, status, error) => registry.updateCredentialStatus(id, status, error),
    syncLocalCredentials: async () => ({ synced: [], removed: [] }) as never,
  }
}

function reset() {
  setBackendOverride(createTestBackend())
  ClaxedoDB.use((db) => db.run(`DELETE FROM claxedo_connection`))
  ClaxedoDB.use((db) => db.run(`DELETE FROM claxedo_provider_credential`))
}

beforeEach(reset)

afterAll(async () => {
  setBackendOverride(undefined)
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
  process.env.CLAXEDO_DATA_DIR = prev
})

describe("SQLite ConnectionStorePort conformance", () => {
  for (const testCase of connectionStoreConformance(async () => {
    reset()
    return { store: createConnectionStoreAdapter() }
  })) {
    test(testCase.name, testCase.run)
  }
})

describe("SQLite CredentialStorePort conformance", () => {
  for (const testCase of credentialStoreConformance(async () => {
    reset()
    return { store: createCredentialStoreAdapter(credentialsPort()) }
  })) {
    test(testCase.name, testCase.run)
  }
})

describe("SQLite connection store persistence", () => {
  test("rows survive a fresh adapter instance", async () => {
    const first = createConnectionStoreAdapter()
    await first.upsert({
      id: "row-persist",
      integrationId: "notion",
      owner: "owner-a",
      grantedCapabilities: ["docs"],
      fields: { workspace: "acme" },
      createdAt: 5,
      updatedAt: 6,
    })
    const second = createConnectionStoreAdapter()
    expect(await second.get("notion", "owner-a")).toMatchObject({ id: "row-persist", owner: "owner-a" })
    expect(await second.get("notion")).toBeUndefined()
  })

  test("owner-absent rows persist as NULL, not the empty string", async () => {
    const store = createConnectionStoreAdapter()
    await store.upsert({
      id: "row-team",
      integrationId: "notion",
      grantedCapabilities: ["docs"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })
    const raw = ClaxedoDB.use((db) => db.all(`SELECT owner FROM claxedo_connection WHERE id = 'row-team'`)) as Array<{
      owner: string | null
    }>
    expect(raw).toEqual([{ owner: null }])
    // An empty-string owner is a distinct partition from the team partition.
    expect(await store.list({ owner: "" })).toEqual([])
  })
})
