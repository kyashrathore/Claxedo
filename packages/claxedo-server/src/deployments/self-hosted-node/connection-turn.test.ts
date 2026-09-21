import { mkdirSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { afterAll, beforeEach, describe, expect, test } from "vitest"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"

const root = path.join(realpathSync(os.tmpdir()), `connection-turn-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
const registry = await import("@claxedo/server-core/credentials/registry")
const { ClaxedoDB } = await import("../../platform/db")
ClaxedoDB.Drizzle()

const { createConnectionsHost, CONNECTIONS_TOKEN_HEADER } = await import("../../connections")
const { createConnectionStoreAdapter } = await import("../../connections/store-adapter")
const { createCredentialStoreAdapter } = await import("../../connections/credential-store-adapter")
const { CONNECTION_TURN_HEADER, createConnectionTurnCredentials } = await import("../../connections/turn-credentials")
const { RuntimeSessionAuthorityRoutes } = await import("../../routes/runtime-session-authority")
import { registryCredentialsPort } from "../../connections/test-helper"

/**
 * The turn credential the session authority mints at admission must be the
 * one the connections token routes resolve — this mounts the real HTTP oracle
 * and the real token route over one store, the same two owners the
 * self-hosted composition wires through `createSelfHostedApp`.
 */

const relayInput = {
  principalKind: "user" as const,
  actorId: "actor_alice",
  actorKind: "human" as const,
  orgId: "org_1",
  workspaceId: "ws_1",
  hostId: "host_1",
  role: "editor" as const,
  backing: "local-worktree" as const,
  jti: "rht_1",
  parentJti: "rat_parent_1",
}

const transitionStubs = {
  authorizeRuntimeSessionStartStatus: async () => {},
  authorizeRuntimeSessionStart: async () => {},
  registerRuntimeSession: async () => ({} as never),
  markSessionRegistrationAmbiguous: async () => ({} as never),
  beginSessionCompensation: async () => ({} as never),
  completeSessionCompensation: async () => ({} as never),
  authorizeRuntimeSession: async () => {},
  runtimeAccessTokenActive: async () => ({ active: true }),
}

function request(target: Hono, token: string | undefined, body: Record<string, unknown>) {
  return target.request("/api/runtime-authority/session-authorize", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe("connection turn credentials on the session authority", () => {
  beforeEach(() => {
    setBackendOverride(createTestBackend())
    ClaxedoDB.use((db) => db.run("DELETE FROM claxedo_connection"))
    ClaxedoDB.use((db) => db.run("DELETE FROM claxedo_provider_credential"))
  })

  afterAll(async () => {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
  })

  async function target(overrides: { resolveRuntimeMachineAccess?: (actorId: string) => Promise<{ actorId: string; actorKind: "human"; orgId: string; role: "editor"; userId: string }> } = {}) {
    const relayKey = await generateKeyPair("EdDSA", { extractable: true })
    const turnKey = await generateKeyPair("EdDSA", { extractable: true })
    const turns = createConnectionTurnCredentials()
    const host = createConnectionsHost({
      credentials: registryCredentialsPort(registry),
      env: {},
      turnCredentials: turns,
    })
    const turnAuthority = {
      acquireSessionTurn: async (input: { sessionId: string; workspaceId: string; turnId: string }) => ({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        turnId: input.turnId,
        leaseId: `lease_${input.turnId}`,
        fencingToken: 1,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
      renewSessionTurn: async (input: { sessionId: string; workspaceId: string; turnId: string; leaseId: string; fencingToken: number }) => ({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        turnId: input.turnId,
        leaseId: input.leaseId,
        fencingToken: input.fencingToken,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
      releaseSessionTurn: async (input: { sessionId: string; turnId: string; fencingToken: number }) => ({
        released: true,
        sessionId: input.sessionId,
        turnId: input.turnId,
        fencingToken: input.fencingToken,
      }),
    }
    const app = new Hono()
      .route("/api/runtime-authority", RuntimeSessionAuthorityRoutes({
        authority: {
          ...transitionStubs,
          resolveRuntimeMachineAccess: overrides.resolveRuntimeMachineAccess ?? (async (actorId: string) => ({
            actorId,
            actorKind: "human" as const,
            orgId: "org_1",
            role: "editor" as const,
            userId: actorId === "actor_alice" ? "alice" : "bob",
          })),
        },
        turnAuthority,
        turnCredentials: turns,
        env: {
          CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(relayKey.publicKey),
          CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(turnKey.privateKey),
          CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(turnKey.publicKey),
        },
      }))
      .route("/api/claxedo/integrations", host.routes)
    const connections = createConnectionStoreAdapter()
    const credentials = createCredentialStoreAdapter(registryCredentialsPort(registry))
    await connections.upsert({
      id: "conn_alice",
      integrationId: "notion",
      owner: "alice",
      grantedCapabilities: ["docs"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })
    await credentials.put({ providerId: "integration:conn_alice", kind: "api_key", secret: "alice-secret" })
    const relayToken = (input: typeof relayInput) => mintRelayHostToken(input, relayKey.privateKey, "EdDSA")
    const readToken = (credential?: string) => app.request(
      "http://127.0.0.1/api/claxedo/integrations/connections/conn_alice/token?capability=docs",
      {
        headers: {
          [CONNECTIONS_TOKEN_HEADER]: "1",
          ...(credential ? { [CONNECTION_TURN_HEADER]: credential } : {}),
        },
      },
    )
    return { app, turns, host, relayToken, readToken }
  }

  test("a real signed-session admission mints the credential the token route resolves, and release retires it", async () => {
    const { app, readToken, relayToken, host } = await target()
    try {
      const token = await relayToken(relayInput)
      const acquired = await request(app, token, { action: "turn_acquire", sessionId: "ses_1", turnId: "msg_1" })
      expect(acquired.status).toBe(200)
      const body = await acquired.json() as { connectionCredential?: string; leaseId: string; fencingToken: number }
      expect(body.connectionCredential).toBeDefined()

      // The admitted turn reads the session owner's connection over the real
      // token route; the same request without the credential cannot.
      expect((await readToken()).status).toBe(404)
      const allowed = await readToken(body.connectionCredential)
      expect(allowed.status).toBe(200)
      expect(await allowed.json()).toMatchObject({ token: "alice-secret" })

      const released = await request(app, undefined, {
        action: "turn_release",
        sessionId: "ses_1",
        turnId: "msg_1",
        leaseId: body.leaseId,
        fencingToken: body.fencingToken,
      })
      expect(released.status).toBe(200)
      expect((await readToken(body.connectionCredential)).status).toBe(404)
    } finally {
      host.dispose()
    }
  })

  test("a credential minted for a foreign session reads none of this session's personal rows", async () => {
    const { app, readToken, relayToken, host } = await target()
    try {
      const foreign = await relayToken({ ...relayInput, actorId: "actor_bob", jti: "rht_2" })
      const acquired = await request(app, foreign, { action: "turn_acquire", sessionId: "ses_2", turnId: "msg_9" })
      expect(acquired.status).toBe(200)
      const body = await acquired.json() as { connectionCredential?: string }
      expect(body.connectionCredential).toBeDefined()

      // `bob`'s partition on this box holds no `conn_alice` row — the minted
      // credential binds the session's own subject, not the row's owner.
      expect((await readToken(body.connectionCredential)).status).toBe(404)
    } finally {
      host.dispose()
    }
  })
})
