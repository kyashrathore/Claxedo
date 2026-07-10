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
const { CONNECTION_TURN_HEADER, createConnectionTurnCredentials } = await import("./turn-credentials")
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
      id: "connection-notion",
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
    await credentials.put({ providerId: "integration:connection-notion", kind: "api_key", secret: "ntn-123" })
    expect(await credentials.get("integration:connection-notion")).toMatchObject({ kind: "api_key", status: "available" })
    expect(await credentials.resolveSecret("integration:connection-notion")).toBe("ntn-123")

    // readSecret works across a non-available status (re-verify path).
    await credentials.setStatus("integration:connection-notion", "error", "auth_failure_reported")
    expect(await credentials.resolveSecret("integration:connection-notion")).toBeNull()
    expect(await credentials.readSecret("integration:connection-notion")).toBe("ntn-123")

    await credentials.deleteByProvider("integration:connection-notion")
    expect(await credentials.get("integration:connection-notion")).toBeUndefined()
    expect(await connections.delete("connection-notion")).toBe(true)
    expect(await connections.delete("connection-notion")).toBe(false)
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

  test("gates: spoofed Host: 127.0.0.1 from a non-loopback peer never reaches credential routes", async () => {
    // External-bind regression (CLAXEDO_SERVER_HOST=0.0.0.0): the Host header
    // is client-controlled, so the gate must also verify the socket peer.
    const host = createConnectionsHost({ credentials: credentialsPort(), env: {} })
    const remoteEnv = { incoming: { socket: { remoteAddress: "203.0.113.7" } } }

    const list = await host.routes.request("http://127.0.0.1/", {}, remoteEnv)
    expect(list.status).toBeGreaterThanOrEqual(401)

    const token = await host.routes.request(
      "http://127.0.0.1/connections/notion/token?capability=docs",
      { headers: { [CONNECTIONS_TOKEN_HEADER]: "1" } },
      remoteEnv,
    )
    expect(token.status).toBe(403)
    expect(await token.json()).toEqual({ code: "connections_loopback_required" })

    // Same request from a genuine loopback peer still passes the gates.
    const localToken = await host.routes.request(
      "http://127.0.0.1/connections/notion/token?capability=docs",
      { headers: { [CONNECTIONS_TOKEN_HEADER]: "1" } },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    )
    expect(localToken.status).toBe(404)
    host.dispose()
  })

  test("signed subjects see and manage only their own personal connections", async () => {
    const host = createConnectionsHost({
      credentials: credentialsPort(),
      env: {},
      authConfig: { enabled: true, issuer: "https://issuer.example", jwksUrl: "https://issuer.example/jwks" },
      verifier: async (token) => ({
        mode: "signed",
        user: { subject: token, tokenIdentifier: token, issuer: "https://issuer.example" },
      }),
    })
    const connections = createConnectionStoreAdapter()
    await connections.upsert({
      id: "team-notion",
      integrationId: "notion",
      grantedCapabilities: ["docs"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })
    await connections.upsert({
      id: "user-a-notion",
      integrationId: "notion",
      owner: "user-a",
      grantedCapabilities: ["docs"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })

    const listFor = async (subject: string) =>
      await (await host.routes.request("http://relay.example/", { headers: { authorization: `Bearer ${subject}` } })).json() as {
        connections: Array<{ id: string; scope: string }>
      }

    expect((await listFor("user-a")).connections.map((connection) => connection.id).sort()).toEqual(["team-notion", "user-a-notion"])
    expect((await listFor("user-b")).connections.map((connection) => connection.id)).toEqual(["team-notion"])
    expect((await (await host.routes.request("http://127.0.0.1/")).json() as { connections: Array<{ id: string }> }).connections)
      .toEqual([expect.objectContaining({ id: "team-notion" })])

    const forbiddenDelete = await host.routes.request("http://relay.example/connections/user-a-notion", {
      method: "DELETE",
      headers: { authorization: "Bearer user-b" },
    })
    expect(forbiddenDelete.status).toBe(404)
    const forbiddenReverify = await host.routes.request("http://relay.example/connections/user-a-notion/reverify", {
      method: "POST",
      headers: { authorization: "Bearer user-b" },
    })
    expect(forbiddenReverify.status).toBe(404)
    host.dispose()
  })

  test("token resolution requires a valid subject-bearing turn credential for personal rows", async () => {
    const turns = createConnectionTurnCredentials()
    const host = createConnectionsHost({ credentials: credentialsPort(), env: {}, turnCredentials: turns })
    const connections = createConnectionStoreAdapter()
    const credentials = createCredentialStoreAdapter(credentialsPort())
    await connections.upsert({
      id: "team-notion",
      integrationId: "notion",
      grantedCapabilities: ["docs"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })
    await connections.upsert({
      id: "user-a-notion",
      integrationId: "notion",
      owner: "user-a",
      grantedCapabilities: ["docs"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })
    await credentials.put({ providerId: "integration:team-notion", kind: "api_key", secret: "team-token" })
    await credentials.put({ providerId: "integration:user-a-notion", kind: "api_key", secret: "personal-token" })

    const token = async (id: string, turn?: string) =>
      await host.routes.request(`http://127.0.0.1/connections/${id}/token?capability=docs`, {
        headers: {
          [CONNECTIONS_TOKEN_HEADER]: "1",
          ...(turn ? { [CONNECTION_TURN_HEADER]: turn } : {}),
        },
      })

    expect((await token("user-a-notion")).status).toBe(404)
    const interactive = turns.mint({ sessionId: "session-1", subject: "user-a" })
    expect(await (await token("user-a-notion", interactive)).json()).toMatchObject({ token: "personal-token" })
    expect(await (await token("team-notion", interactive)).json()).toMatchObject({ token: "team-token" })
    const unattended = turns.mint({ sessionId: "session-1" })
    expect((await token("user-a-notion", unattended)).status).toBe(404)
    expect((await token("user-a-notion", "unknown")).status).toBe(404)
    host.dispose()
    turns.dispose()
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
