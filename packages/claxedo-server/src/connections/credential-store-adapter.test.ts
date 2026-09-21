/**
 * The shared `CredentialStorePort` conformance suite, run against the ONE
 * adapter over both of the credential stores that ship: the local SQLite
 * registry and the hosted envelope-encrypted per-org KV store.
 *
 * There used to be a hand-written adapter per host, and they disagreed about
 * the port's central rule — `readSecret` is the status-independent re-verify
 * seam, and the SQLite one repaired status while reading, so a re-verify that
 * still failed re-opened the token path onto a rejected secret. Running one
 * suite over one adapter on both backings is what keeps that from returning.
 */
import { describe, test, beforeEach, afterAll, expect, vi } from "vitest"
import { realpathSync, mkdirSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `credential-store-adapter-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
const registry = await import("@claxedo/server-core/credentials/registry")
const { ClaxedoDB } = await import("../platform/db")
ClaxedoDB.Drizzle()

const { createCredentialStoreAdapter } = await import("./credential-store-adapter")
const {
  connectionProviderId,
  createIntegrationRegistry,
  createTokenService,
  credentialStoreConformance,
  docsPort,
} = await import("@claxedo/connections")
const { CREDENTIALS_KEK_ENV } = await import("@claxedo/server-core/credentials/envelope")
const { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } = await import("../credentials/worker/index")
import { registryCredentialsPort } from "./test-helper"
import type { ConnectionRow } from "@claxedo/connections"

function resetSqlite() {
  setBackendOverride(createTestBackend())
  ClaxedoDB.use((db) => db.run(`DELETE FROM claxedo_provider_credential`))
}

beforeEach(resetSqlite)

afterAll(async () => {
  setBackendOverride(undefined)
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
  process.env.CLAXEDO_DATA_DIR = prev
})

/** A native KV binding double, so the hosted store runs without a REST seam. */
function hostedCredentials() {
  const values = new Map<string, string>()
  return hostedOrgCredentials("org-conformance", {
    [HOSTED_CREDENTIALS_FLAG]: "1",
    [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 7).toString("base64"),
    CLAXEDO_CREDENTIALS: {
      put: async (key: string, value: string) => { values.set(key, value) },
      get: async (key: string) => values.get(key) ?? null,
      delete: async (key: string) => { values.delete(key) },
      list: async () => ({ keys: [...values.keys()].map((name) => ({ name })), list_complete: true }),
    },
  } as never)
}

describe("CredentialStorePort conformance over the SQLite registry", () => {
  for (const testCase of credentialStoreConformance(async () => {
    resetSqlite()
    return { store: createCredentialStoreAdapter(registryCredentialsPort(registry)) }
  })) {
    test(testCase.name, testCase.run)
  }
})

describe("CredentialStorePort conformance over the hosted per-org KV store", () => {
  for (const testCase of credentialStoreConformance(async () => ({
    store: createCredentialStoreAdapter(hostedCredentials()),
  }))) {
    test(testCase.name, testCase.run)
  }
})

/**
 * `revoked` is the one status the conformance suite never sets: the port's
 * `setStatus` only writes `available` or `error`, so revocation reaches a store
 * through `ControlPlaneCredentials.updateCredentialStatus` alone. Both stores
 * must then answer the kit identically: the token path refuses before it can
 * refresh, and the re-verify path reads without repairing.
 */
describe.each([
  ["the SQLite registry", async () => { resetSqlite(); return registryCredentialsPort(registry) }],
  ["the hosted per-org KV store", async () => hostedCredentials()],
])("a revoked credential over %s", (_name, port) => {
  const ROW: ConnectionRow = {
    id: "revoked-connection",
    integrationId: "oauthy",
    grantedCapabilities: ["docs"],
    fields: {},
    createdAt: 0,
    updatedAt: 0,
  }
  const PROVIDER = connectionProviderId(ROW.id)

  async function revoked() {
    const credentials = await port()
    const store = createCredentialStoreAdapter(credentials)
    await store.put({
      providerId: PROVIDER,
      kind: "oauth_token",
      secret: JSON.stringify({ access: "old-access", refresh: "old-refresh" }),
      expiresAt: 1,
    })
    const meta = await credentials.getCredentialByProvider(PROVIDER)
    await credentials.updateCredentialStatus(meta!.id, "revoked")
    return store
  }

  test("the token path refuses it before any refresh runs", async () => {
    const store = await revoked()
    expect(await store.get(PROVIDER)).toMatchObject({ status: "revoked" })
    expect(await store.resolveSecret(PROVIDER)).toBeNull()

    const refresh = vi.fn(async () => ({ accessToken: "new-access", refreshToken: "new-refresh" }))
    const integrations = createIntegrationRegistry()
    integrations.register(
      { id: "oauthy", name: "OAuthy", methods: ["oauth"] },
      { actions: { docs: docsPort }, auth: { refresh } },
    )
    const tokens = createTokenService({ registry: integrations, credentials: store, now: () => 1_000_000 })

    await expect(tokens.getLiveToken(ROW)).rejects.toMatchObject({
      status: 409,
      code: "connection_not_available",
      credentialStatus: "revoked",
    })
    expect(refresh).not.toHaveBeenCalled()
    expect(await store.get(PROVIDER)).toMatchObject({ status: "revoked" })
  })

  test("the re-verify path reads it without repairing it", async () => {
    const store = await revoked()
    expect(await store.readSecret(PROVIDER)).toEqual(expect.any(String))
    expect(await store.get(PROVIDER)).toMatchObject({ status: "revoked" })
    expect(await store.resolveSecret(PROVIDER)).toBeNull()
  })
})
