import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import type { ControlPlaneCredentials } from "../authority/services"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "../credentials/worker/index"
import { controlPlaneMigrations, miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { RuntimeSessionAuthorityRoutes } from "./runtime-session-authority"

async function fixture(store?: ControlPlaneCredentials) {
  const keys = await generateKeyPair("EdDSA", { extractable: true })
  const descriptor = { connectionId: "custom-acp", providerKey: "acp", configRevision: 3, enabled: true,
    config: {}, secretRefs: { token: "credential-1" } }
  const metadata = { id: "credential-1", incarnation: "incarnation-1", org_id: "org-1", owner: "user-1" as string | null, scope: "shared",
    source: "managed", status: "available", revision: 2, expires_at: null as number | null }
  const readSecret = vi.fn(async () => "test-secret")
  const active = vi.fn(async () => ({ active: true }))
  const options = {
    authority: { runtimeAccessTokenActive: active } as never,
    env: { CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(keys.publicKey) },
    connectionSecrets: {
      resolveWorkspaceOwner: async () => ({ userId: "user-1", actorId: "actor-1", orgId: "org-1", projectId: "project-1" }),
      readConnections: async () => ({ "custom-acp": descriptor }),
      credentials: () => store ?? ({ getCredential: async () => ({ ...metadata }), resolveCredentialSecretById: readSecret }) as never,
    },
  }
  const app = RuntimeSessionAuthorityRoutes(options)
  const request = async (workspaceId = "workspace-1", configRevision = 3, role: "owner" | "editor" | "viewer" = "owner",
    sender = "actor-1", sessionOwner = "user-1") => {
    const token = await mintRelayHostToken({ principalKind: "user", actorId: sender, actorKind: "human", orgId: "org-1",
      workspaceId, hostId: "host-1", role, backing: "cloud-vm", jti: "proof-1", parentJti: "parent-1" }, keys.privateKey, "EdDSA")
    return app.request("/connection-secrets/workspace-1", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ connectionId: "custom-acp", providerKey: "acp", configRevision, ownerUserId: sessionOwner }) })
  }
  return { request, metadata, descriptor, active, readSecret }
}

describe("sandbox connection secret lease", () => {
  test("leases the owner's configured secret using the active runtime principal", async () => {
    const f = await fixture()
    const response = await f.request()
    expect(response.status).toBe(200)
    const lease = await response.json()
    expect(lease.secrets).toEqual({ token: "test-secret" })
    expect(lease.secretLeaseGeneration).toEqual(expect.any(String))
    expect(lease.expiresAt).toBeGreaterThan(Date.now())
    expect(f.active).toHaveBeenCalledWith({ jti: "parent-1", workspaceId: "workspace-1", hostId: "host-1", minimumRole: "editor" })
    f.metadata.revision++
    expect((await (await f.request()).json()).secretLeaseGeneration).not.toBe(lease.secretLeaseGeneration)
  })
  test("refuses another workspace's runtime token without reading secrets", async () => {
    const f = await fixture()
    expect((await f.request("workspace-2")).status).toBe(403)
    expect(f.readSecret).not.toHaveBeenCalled()
  })
  test("refuses revoked secrets", async () => {
    const f = await fixture()
    f.metadata.status = "revoked"
    expect((await f.request()).status).toBe(409)
    expect(f.readSecret).not.toHaveBeenCalled()
  })
  test("refuses disabled connections, stale revisions, local secrets, and viewer principals", async () => {
    const f = await fixture()
    f.descriptor.enabled = false
    expect((await f.request()).status).toBe(409)
    f.descriptor.enabled = true
    expect((await f.request("workspace-1", 2)).status).toBe(409)
    f.metadata.scope = "local"
    expect((await f.request()).status).toBe(409)
    expect((await f.request("workspace-1", 3, "viewer")).status).toBe(403)
    expect(f.readSecret).not.toHaveBeenCalled()
  })
  test("refuses another owner's credential and an expired credential", async () => {
    const f = await fixture()
    f.metadata.owner = "user-2"
    expect((await f.request()).status).toBe(409)
    f.metadata.owner = "user-1"
    f.metadata.expires_at = Date.now() - 1
    expect((await f.request()).status).toBe(409)
    expect(f.readSecret).not.toHaveBeenCalled()
  })
  test("refuses descriptor changes and rotation during secret resolution", async () => {
    const f = await fixture()
    f.readSecret.mockImplementation(async () => { f.descriptor.enabled = false; return "test-secret" })
    expect((await f.request()).status).toBe(409)
    f.descriptor.enabled = true
    f.readSecret.mockImplementation(async () => { f.metadata.revision++; return "test-secret" })
    expect((await f.request()).status).toBe(409)
    f.readSecret.mockImplementation(async () => { f.metadata.incarnation = `${f.metadata.incarnation}-recreated`; return "test-secret" })
    expect((await f.request()).status).toBe(409)
  })
  test("refuses revocation during secret resolution", async () => {
    const f = await fixture()
    f.readSecret.mockImplementation(async () => { f.metadata.status = "revoked"; return "test-secret" })
    expect((await f.request()).status).toBe(409)
  })
  test("a sandbox never leases a member's own credential into the owner's workspace, whoever sends the turn", async () => {
    const f = await fixture()
    f.metadata.owner = "user-carol"
    expect((await f.request("workspace-1", 3, "editor", "actor-bob", "user-carol")).status).toBe(409)
    expect(f.readSecret).not.toHaveBeenCalled()
  })
  test("a session whose owner holds no credential is unavailable and never spends the workspace owner's", async () => {
    const f = await fixture()
    const response = await f.request("workspace-1", 3, "owner", "actor-1", "user-dave")
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: { code: "connection_unavailable" } })
    expect(f.readSecret).not.toHaveBeenCalled()
    expect((await f.request("workspace-1", 3, "owner", "actor-1", "outsider")).status).toBe(409)
  })
  test("an editor's turn on the owner's session leases a team credential of its own org", async () => {
    const f = await fixture()
    f.metadata.owner = null
    const response = await f.request("workspace-1", 3, "editor", "actor-bob")
    expect(response.status).toBe(200)
    expect((await response.json()).secrets).toEqual({ token: "test-secret" })
  })
  test("the owner's session is refused another member's personal credential and a team credential of another org", async () => {
    const f = await fixture()
    f.metadata.owner = "user-carol"
    expect((await f.request("workspace-1", 3, "editor", "actor-bob")).status).toBe(409)
    f.metadata.owner = null
    f.metadata.org_id = "org-2"
    expect((await f.request("workspace-1", 3, "editor", "actor-bob")).status).toBe(409)
    expect(f.readSecret).not.toHaveBeenCalled()
  })
  test("refuses a revoked parent runtime token", async () => {
    const f = await fixture()
    f.active.mockResolvedValue({ active: false })
    expect((await f.request()).status).toBe(403)
    expect(f.readSecret).not.toHaveBeenCalled()
  })
})

async function turnFixture() {
  const relayKeys = await generateKeyPair("EdDSA", { extractable: true })
  const turnKeys = await generateKeyPair("EdDSA", { extractable: true })
  const descriptor = { connectionId: "custom-acp", providerKey: "acp", configRevision: 3, enabled: true,
    config: {}, secretRefs: { token: "credential-1" } }
  const metadata = { id: "credential-1", incarnation: "incarnation-1", org_id: "org-1", owner: "user-1", scope: "shared",
    source: "managed", status: "available", revision: 2, expires_at: null as number | null }
  const active = vi.fn(async () => ({ active: true }))
  const app = RuntimeSessionAuthorityRoutes({
    authority: { runtimeAccessTokenActive: active, authorizeRuntimeSession: async () => {} } as never,
    turnAuthority: {
      acquireSessionTurn: async (turn: { sessionId: string; workspaceId: string; turnId: string }) => ({
        ...turn, leaseId: "authority-lease-1", fencingToken: 1, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000,
      }),
    } as never,
    env: {
      CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(relayKeys.publicKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(turnKeys.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(turnKeys.publicKey),
    },
    connectionSecrets: {
      resolveWorkspaceOwner: async () => ({ userId: "user-1", actorId: "actor-1", orgId: "org-1", projectId: "project-1" }),
      readConnections: async () => ({ "custom-acp": descriptor }),
      credentials: () => ({ getCredential: async () => ({ ...metadata }), resolveCredentialSecretById: async () => "test-secret" }) as never,
    },
  })
  const relayProof = (workspaceId: string, now = Date.now()) => mintRelayHostToken({ principalKind: "user", actorId: "actor-1",
    actorKind: "human", orgId: "org-1", workspaceId, hostId: "host-1", role: "owner", backing: "cloud-vm", jti: "proof-1",
    parentJti: "parent-1", now, ttlSeconds: 60 }, relayKeys.privateKey, "EdDSA")
  const acquireTurn = async (workspaceId = "workspace-1") => {
    const response = await app.request("/session-authorize", { method: "POST",
      headers: { authorization: `Bearer ${await relayProof(workspaceId)}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses-1", action: "turn_acquire", turnId: "msg-1" }) })
    expect(response.status).toBe(200)
    return (await response.json() as { leaseId: string }).leaseId
  }
  const lease = (proof: { turnLease?: string; bearer?: string }) => app.request("/connection-secrets/workspace-1", { method: "POST",
    headers: { "content-type": "application/json", ...(proof.bearer ? { authorization: `Bearer ${proof.bearer}` } : {}) },
    body: JSON.stringify({ connectionId: "custom-acp", providerKey: "acp", configRevision: 3, ownerUserId: "user-1",
      ...(proof.turnLease ? { turnLease: proof.turnLease } : {}) }) })
  return { acquireTurn, relayProof, lease, active }
}

describe("sandbox connection secret lease proven by a turn lease", () => {
  test("a turn admitted under a relay proof that has since expired leases with its own turn lease", async () => {
    const f = await turnFixture()
    const turnLease = await f.acquireTurn()
    const expired = await f.relayProof("workspace-1", Date.now() - 120_000)
    expect((await f.lease({ bearer: expired })).status).toBe(401)
    const response = await f.lease({ turnLease })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ secrets: { token: "test-secret" } })
  })
  test("refuses a turn lease issued for another workspace, a forged lease, and a proof in both places", async () => {
    const f = await turnFixture()
    expect((await f.lease({ turnLease: await f.acquireTurn("workspace-2") })).status).toBe(403)
    const forged = await f.lease({ turnLease: `${await f.acquireTurn()}x` })
    expect(forged.status).toBe(401)
    expect(await forged.json()).toMatchObject({ error: { code: "session_turn_lease_invalid" } })
    const both = await f.lease({ turnLease: await f.acquireTurn(), bearer: await f.relayProof("workspace-1") })
    expect(both.status).toBe(401)
    expect(await both.json()).toMatchObject({ error: { code: "connection_secret_proof_required" } })
    expect((await f.lease({})).status).toBe(401)
  })
  test("refuses a turn lease whose parent runtime token was revoked", async () => {
    const f = await turnFixture()
    const turnLease = await f.acquireTurn()
    f.active.mockResolvedValue({ active: false })
    expect((await f.lease({ turnLease })).status).toBe(403)
  })
})

describe("sandbox connection secret lease over the hosted credential store", () => {
  let controlPlane: ControlPlaneDatabase
  beforeAll(async () => {
    controlPlane = await miniflareControlPlaneDatabase(controlPlaneMigrations())
  })
  afterAll(async () => {
    await controlPlane.dispose()
  })

  test("a credential deleted and recreated under the same provider id is a new row, and leases a new generation", async () => {
    const store = hostedOrgCredentials("org-1", { database: controlPlane.database,
      env: { [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 7).toString("base64"), [HOSTED_CREDENTIALS_FLAG]: "1" } })
    const write = { owner: "user-1", provider_id: "credential-1", kind: "api_key" as const, source: "managed" as const }
    const first = await store.putCredential({ ...write, secret: "first-secret" })
    const f = await fixture(store)
    f.descriptor.secretRefs.token = first.id
    const before = await (await f.request()).json()
    expect(before.secrets).toEqual({ token: "first-secret" })

    expect(await store.deleteCredential(first.id)).toBe(true)
    const second = await store.putCredential({ ...write, secret: "second-secret" })
    expect(second.id).not.toBe(first.id)
    expect(second.revision).toBe(first.revision)
    expect((await f.request()).status).toBe(409)

    f.descriptor.secretRefs.token = second.id
    const after = await (await f.request()).json()
    expect(after.secrets).toEqual({ token: "second-secret" })
    expect(after.secretLeaseGeneration).not.toBe(before.secretLeaseGeneration)
  })
})
