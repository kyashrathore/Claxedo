import { afterAll, beforeEach, describe, expect, test } from "vitest"
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `connections-host-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
const registry = await import("@claxedo/server-core/credentials/registry")
const { ClaxedoDB } = await import("../platform/db")
ClaxedoDB.Drizzle()

const { createConnectionsHost, CONNECTIONS_TOKEN_HEADER } = await import("./index")
const { createConnectionStoreAdapter, createCredentialStoreAdapter } = await import("./store-adapter")
const { CONNECTION_TURN_HEADER, createConnectionTurnCredentials } = await import("./turn-credentials")
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

describe("connections host", () => {
  beforeEach(() => {
    setBackendOverride(createTestBackend())
    ClaxedoDB.use((db) => db.run("DELETE FROM claxedo_connection"))
  })

  afterAll(async () => {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
  })

  test("store adapters round-trip connection-scoped credentials without legacy fallback", async () => {
    const connections = createConnectionStoreAdapter()
    const credentials = createCredentialStoreAdapter(credentialsPort())
    await connections.upsert({
      id: "connection-notion",
      integrationId: "notion",
      accountLabel: "Acme Bot",
      grantedCapabilities: ["docs"],
      fields: { workspace: "acme" },
      createdAt: 1,
      updatedAt: 2,
    })
    await credentials.put({
      providerId: "integration:connection-notion",
      kind: "api_key",
      secret: "ntn-123",
    })

    expect(await connections.get("notion")).toMatchObject({
      id: "connection-notion",
      accountLabel: "Acme Bot",
    })
    expect(await credentials.resolveSecret("integration:connection-notion")).toBe("ntn-123")

    await credentials.put({
      providerId: "integration:notion",
      kind: "api_key",
      secret: "legacy-secret",
    })
    expect(await credentials.get("integration:missing-connection")).toBeUndefined()
    expect(await credentials.resolveSecret("integration:missing-connection")).toBeNull()
  })

  test("unsigned routes require loopback and credential routes require the custom header", async () => {
    const host = createConnectionsHost({ credentials: credentialsPort(), env: {} })

    expect((await host.routes.request("http://relay.example/")).status).toBeGreaterThanOrEqual(401)
    expect((await host.routes.request("http://127.0.0.1/")).status).toBe(200)
    expect((await host.routes.request(
      "http://127.0.0.1/connections/missing/token?capability=docs",
    )).status).toBe(403)
    expect((await host.routes.request(
      "http://127.0.0.1/connections/missing/token?capability=docs",
      { headers: { [CONNECTIONS_TOKEN_HEADER]: "1" } },
    )).status).toBe(404)

    const spoofed = await host.routes.request(
      "http://127.0.0.1/connections/missing/token?capability=docs",
      { headers: { [CONNECTIONS_TOKEN_HEADER]: "1" } },
      { incoming: { socket: { remoteAddress: "203.0.113.7" } } },
    )
    expect(spoofed.status).toBe(403)
    expect(await spoofed.json()).toEqual({ code: "connections_loopback_required" })
    host.dispose()
  })

  test("signed subjects see their personal rows plus the ownerless team partition", async () => {
    const host = createConnectionsHost({
      credentials: credentialsPort(),
      env: {},
      authConfig: {
        enabled: true,
        issuer: "https://issuer.example",
        jwksUrl: "https://issuer.example/jwks",
      },
      verifier: async (token) => ({
        mode: "signed",
        user: {
          subject: token,
          tokenIdentifier: `https://issuer.example|${token}`,
          issuer: "https://issuer.example",
        },
      }),
    })
    const connections = createConnectionStoreAdapter()
    const row = (id: string, owner?: string) => ({
      id,
      integrationId: "notion",
      ...(owner === undefined ? {} : { owner }),
      grantedCapabilities: ["docs" as const],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })
    await connections.upsert(row("team"))
    await connections.upsert(row("alice", "alice"))
    await connections.upsert(row("bob", "bob"))

    const response = await host.routes.request("http://cp.example/", {
      headers: { authorization: "Bearer alice" },
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { connections: Array<{ id: string }> }).connections.map((item) => item.id).sort())
      .toEqual(["alice", "team"])
    host.dispose()
  })

  test("turn credentials scope loopback token reads to their signed subject", async () => {
    const turns = createConnectionTurnCredentials()
    const host = createConnectionsHost({
      credentials: credentialsPort(),
      env: {},
      turnCredentials: turns,
    })
    const connections = createConnectionStoreAdapter()
    const credentials = createCredentialStoreAdapter(credentialsPort())
    await connections.upsert({
      id: "alice-notion",
      integrationId: "notion",
      owner: "alice",
      grantedCapabilities: ["docs"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })
    await credentials.put({
      providerId: "integration:alice-notion",
      kind: "api_key",
      secret: "alice-secret",
    })
    const turn = turns.mint({ sessionId: "session-1", subject: "alice" })

    const response = await host.routes.request(
      "http://127.0.0.1/connections/alice-notion/token?capability=docs",
      {
        headers: {
          [CONNECTIONS_TOKEN_HEADER]: "1",
          [CONNECTION_TURN_HEADER]: turn,
        },
      },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ token: "alice-secret" })
    host.dispose()
    turns.dispose()
  })

  test("Google registers only when client credentials are configured", () => {
    const without = createConnectionsHost({ credentials: credentialsPort(), env: {} })
    expect(without.service.listIntegrations().map((integration) => integration.id)).not.toContain("google")
    without.dispose()

    const withGoogle = createConnectionsHost({
      credentials: credentialsPort(),
      env: {
        CLAXEDO_INTEGRATION_GOOGLE_CLIENT_ID: "client-id",
        CLAXEDO_INTEGRATION_GOOGLE_CLIENT_SECRET: "client-secret",
      },
      publicUrl: "https://host.example",
    })
    expect(withGoogle.service.listIntegrations().map((integration) => integration.id)).toContain("google")
    withGoogle.dispose()
  })
})
