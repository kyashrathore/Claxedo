import { describe, expect, test, beforeEach, afterAll } from "vitest"
import { realpathSync, mkdirSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `connections-host-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("../credentials/store")
const registry = await import("../credentials/registry")
const { ClaxedoDB } = await import("../storage/db")
ClaxedoDB.Drizzle()

const { createConnectionsHost, CONNECTIONS_TOKEN_HEADER } = await import("./connections-host")
const { createConnectionStoreAdapter, createCredentialStoreAdapter } = await import("./store-adapter")
import type { ControlPlaneCredentials } from "../control-plane/services"

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
    ClaxedoDB.use((db) => db.run(`DELETE FROM claxedo_connection`))
  })

  afterAll(async () => {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  test("store adapters round-trip: connection rows + namespaced credential", async () => {
    const connections = createConnectionStoreAdapter()
    await connections.upsert({
      integrationId: "notion",
      accountLabel: "Acme Bot",
      grantedCapabilities: ["docs"],
      fields: { workspace: "acme" },
      createdAt: 1,
      updatedAt: 2,
    })
    expect(await connections.get("notion")).toMatchObject({
      integrationId: "notion",
      accountLabel: "Acme Bot",
      grantedCapabilities: ["docs"],
      fields: { workspace: "acme" },
    })
    expect(await connections.list()).toHaveLength(1)

    const credentials = createCredentialStoreAdapter(credentialsPort())
    await credentials.put({ providerId: "integration:notion", kind: "api_key", secret: "ntn-123" })
    expect(await credentials.get("integration:notion")).toMatchObject({ kind: "api_key", status: "available" })
    expect(await credentials.resolveSecret("integration:notion")).toBe("ntn-123")

    // readSecret works across a non-available status (re-verify path).
    await credentials.setStatus("integration:notion", "error", "auth_failure_reported")
    expect(await credentials.resolveSecret("integration:notion")).toBeNull()
    expect(await credentials.readSecret("integration:notion")).toBe("ntn-123")

    await credentials.deleteByProvider("integration:notion")
    expect(await credentials.get("integration:notion")).toBeUndefined()
    expect(await connections.delete("notion")).toBe(true)
    expect(await connections.delete("notion")).toBe(false)
  })

  test("connection credentials stay out of the shared fanout", async () => {
    const credentials = createCredentialStoreAdapter(credentialsPort())
    await credentials.put({ providerId: "integration:github", kind: "api_key", secret: "ghp-secret" })
    await registry.putCredential({ provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-1" })
    expect(await registry.resolveSecretsForScope("shared")).toEqual({ openai: "sk-1" })
  })

  test("gates: loopback required in unsigned-local; token routes need the header", async () => {
    const host = createConnectionsHost({ credentials: credentialsPort(), env: {} })

    // Non-loopback origin → gated (unsigned-local auth resolves only for loopback).
    const remote = await host.routes.request("http://relay.example/")
    expect(remote.status).toBeGreaterThanOrEqual(401)

    // Loopback list passes the gate.
    const local = await host.routes.request("http://127.0.0.1/")
    expect(local.status).toBe(200)
    const body = (await local.json()) as { integrations: Array<{ id: string }> }
    expect(body.integrations.map((integration) => integration.id).sort()).toEqual(["atlassian", "github", "notion"])

    // Token endpooint: loopback without header → 403; with header → 404 (no connection).
    const noHeader = await host.routes.request("http://127.0.0.1/connections/notion/token?capability=docs")
    expect(noHeader.status).toBe(403)
    expect(await noHeader.json()).toEqual({ code: "connections_header_required" })

    const withHeader = await host.routes.request("http://127.0.0.1/connections/notion/token?capability=docs", {
      headers: { [CONNECTIONS_TOKEN_HEADER]: "1" },
    })
    expect(withHeader.status).toBe(404)

    // Token endpoint from non-loopback → 403 loopback_required even with header.
    const remoteToken = await host.routes.request("http://relay.example/connections/notion/token?capability=docs", {
      headers: { [CONNECTIONS_TOKEN_HEADER]: "1" },
    })
    expect(remoteToken.status).toBe(403)
    host.dispose()
  })

  test("integrations routes are never proxied into workspace runtimes", async () => {
    const { routeOwnership, RouteHandler } = await import("../route-ownership")
    for (const pathname of [
      "/api/claxedo/integrations",
      "/api/claxedo/integrations/callback",
      "/api/claxedo/integrations/connections/notion/token",
    ]) {
      expect(routeOwnership(pathname).handler).not.toBe(RouteHandler.SandboxRuntime)
    }
  })

  test("google integration registers only when host env provides client credentials", () => {
    const without = createConnectionsHost({ credentials: credentialsPort(), env: {} })
    expect(without.service.listIntegrations().map((i) => i.id)).not.toContain("google")
    without.dispose()

    const withGoogle = createConnectionsHost({
      credentials: credentialsPort(),
      env: {
        CLAXEDO_INTEGRATION_GOOGLE_CLIENT_ID: "cid",
        CLAXEDO_INTEGRATION_GOOGLE_CLIENT_SECRET: "cs",
      },
      publicUrl: "https://host.example",
    })
    expect(withGoogle.service.listIntegrations().map((i) => i.id)).toContain("google")
    withGoogle.dispose()
  })
})
