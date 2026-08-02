import { afterAll, beforeEach, describe, expect, test } from "vitest"
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { ConnectionIDSchema, type WorkGraphContext } from "@claxedo/workgraph/contracts"

const root = path.join(realpathSync(os.tmpdir()), `connections-workgraph-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("../../adapters/credentials/store")
const registry = await import("../../adapters/credentials/registry")
const { ClaxedoDB } = await import("../../adapters/storage/db")
ClaxedoDB.Drizzle()

const { createConnectionsHost } = await import("./index")
const { createConnectionStoreAdapter } = await import("./store-adapter")
const { createWorkGraphConnectionsPort } = await import("../workgraph/connections")
import type { ControlPlaneCredentials } from "../../authority/services"

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

function workGraphContext(): WorkGraphContext {
  return {
    organizationId: "local" as never,
    ownerUserId: "local" as never,
    actor: { type: "user", id: "local" as never },
    requestId: `request_${randomUUID()}` as never,
    access: { mode: "owner" },
  }
}

describe("self-host Connections composition with WorkGraph", () => {
  const realFetch = globalThis.fetch

  beforeEach(async () => {
    globalThis.fetch = (async () =>
      Response.json({ login: "octocat" })) as unknown as typeof fetch
    setBackendOverride(createTestBackend())
    ClaxedoDB.use((db) => db.run("DELETE FROM claxedo_connection"))
    for (const credential of registry.listCredentials()) {
      await registry.deleteCredentialsByProvider(credential.provider_id)
    }
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = previousDataDir
  })

  test("WorkGraph resolves the ownerless team Connection written through the real routes", async () => {
    const host = createConnectionsHost({ credentials: credentialsPort(), env: {} })
    const connect = await host.routes.request("http://127.0.0.1/github/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "selfhost-github-secret" }),
    })
    expect(connect.status).toBe(200)
    const row = (await createConnectionStoreAdapter().list({}))[0]!

    const handles = await createWorkGraphConnectionsPort({
      service: host.service,
      resolveTeamOwner: () => undefined,
    })
      .resolveCapabilities(workGraphContext(), {
        connectionIds: [ConnectionIDSchema.parse(row.id)],
        capability: "code-host",
      })

    expect(row.owner).toBeUndefined()
    expect(handles).toHaveLength(1)
    expect(await handles[0]!.withAuthorization(async (response) => response))
      .toMatchObject({ token: "selfhost-github-secret" })
    expect(JSON.stringify(handles[0]!)).not.toContain("selfhost-github-secret")
    host.dispose()
  })
})
