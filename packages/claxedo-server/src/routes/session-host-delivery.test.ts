import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { decodeJwt, importPKCS8, SignJWT } from "jose"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import { parseTurnDelivery, parseTurnExecutionAccess } from "@claxedo/harness/contract"
import { DIRECTORY, WORKSPACE_ID, sessionHostPlane, type SessionHostPlane } from "../test-support/session-host-plane"

let plane: SessionHostPlane
const ROOT = "ses_pi_root"

beforeAll(async () => {
  plane = await sessionHostPlane()
  const ownerId = plane.owner.principal!.userId
  const memberId = plane.member.principal!.userId
  const accounts = plane.credentials(plane.orgId)
  await accounts.putCredential({ owner: ownerId, provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-owner" })
  await accounts.putCredential({ owner: memberId, provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-member" })
  await accounts.putCredential({ owner: ownerId, provider_id: "cursor-sdk", kind: "api_key", source: "managed", secret: "cursor-owner" })
  await plane.createHostedSession(ROOT)
})

afterAll(async () => {
  await plane.close()
})

const sessionRow = async (sessionId: string) => await plane.database
  .prepare("select session_host_root, status from sessions where session_id = ?")
  .bind(sessionId)
  .first<{ session_host_root: string | null; status: string | null }>()

async function expiredLease() {
  const now = Math.floor(Date.now() / 1_000)
  return await new SignJWT({
    principal_kind: "user", actor_id: plane.owner.principal!.actorId, actor_kind: "human", org_id: plane.orgId,
    workspace_id: WORKSPACE_ID, transport: "relay-host", host_id: sessionHostId(ROOT), parent_jti: `rat_create_${ROOT}`,
    session_id: ROOT, action: "write", turn_id: "turn_old", authority_lease_id: "lease_old", fencing_token: 1,
    acquired_at: (now - 120) * 1_000, authority_expires_at: (now - 60) * 1_000,
  })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer("claxedo-control-plane")
    .setAudience("workspace-runtime-session-turn")
    .setIssuedAt(now - 120)
    .setExpirationTime(now - 60)
    .sign(await importPKCS8(plane.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM, "EdDSA"))
}

describe("a session served by its own host registers with the control plane", () => {
  test("the host's registration records the root, and the root never changes", async () => {
    expect(await sessionRow(ROOT)).toMatchObject({ session_host_root: ROOT })
    await expect(plane.database.prepare("update sessions set session_host_root = 'ses_other' where session_id = ?").bind(ROOT).run()).rejects.toThrow()
    expect(await plane.store.readSessionHostPlacement({ workspaceId: WORKSPACE_ID, sessionId: ROOT }))
      .toEqual({ workspace: { orgId: plane.orgId, backing: "cloud-vm", directory: DIRECTORY }, session: { workspaceId: WORKSPACE_ID, sessionHostRoot: ROOT } })
  })

  test("a session host reaches no other session, reserves nothing and adopts nothing", async () => {
    await plane.store.reserveSession(plane.owner, { operationId: "op_elsewhere", sessionId: "ses_elsewhere", workspaceId: WORKSPACE_ID, kind: "create" })
    const proof = await plane.relayProof(plane.owner, { hostId: sessionHostId("ses_confined"), backing: "durable-object", jti: "rat_confined" })
    const register = await plane.post("/session-authorize", { action: "register", sessionId: "ses_elsewhere", operationId: "op_elsewhere", createdAt: Date.now(), updatedAt: Date.now() }, proof)
    expect(register.status).toBe(403)
    expect(await register.json()).toMatchObject({ error: { code: "session_scope_denied" } })
    const reserve = await plane.post("/session-authorize", { action: "reserve", sessionId: "ses_confined", parentSessionId: ROOT }, proof)
    expect(reserve.status).toBe(401)
    const adopt = await plane.post("/session-authorize", { action: "adopt", sessionId: "ses_confined", createdAt: 1, updatedAt: 1 }, proof)
    expect(adopt.status).toBe(403)
    expect(await adopt.json()).toMatchObject({ error: { code: "session_adoption_requires_host_owner" } })
    const host = await plane.post("/session-authorize", { action: "host_read" }, proof)
    expect(host.status).toBe(403)
  })

  test("an admitted turn marks the session busy for a list nobody watches, and its release idle", async () => {
    const proof = await plane.relayProof(plane.owner, { hostId: sessionHostId(ROOT), backing: "durable-object", jti: "rat_turn_status" })
    const lease = await plane.acquire(proof, ROOT, "turn_status")
    expect((await sessionRow(ROOT))?.status).toBe("busy")
    const release = await plane.post("/session-authorize", { action: "turn_release", sessionId: ROOT, turnId: "turn_status", leaseId: lease.leaseId, fencingToken: lease.fencingToken }, proof)
    expect(await release.json()).toMatchObject({ released: true })
    expect((await sessionRow(ROOT))?.status).toBe("idle")
  })
})

describe("/turn-delivery", () => {
  test("hands the turn the session owner's Pi accounts as direct secrets and nothing else", async () => {
    const proof = await plane.relayProof(plane.owner, { hostId: sessionHostId(ROOT), backing: "durable-object", jti: "rat_delivery" })
    const lease = await plane.acquire(proof, ROOT, "turn_delivery")
    const answer = await plane.post("/turn-delivery", { turnLease: lease.leaseId })
    expect(answer.status).toBe(200)
    expect(answer.headers.get("cache-control")).toBe("no-store")
    const delivery = parseTurnDelivery(await answer.json())
    const ownerId = plane.owner.principal!.userId
    expect(delivery).toMatchObject({ auth: { machineOwnerUserId: ownerId, accounts: {} }, plugins: { harnessLaunch: {}, mcp: {} }, providerDefinitions: [] })
    expect(delivery!.auth.direct).toEqual({
      [ownerId]: { anthropic: expect.objectContaining({ delivery: "direct", baseUrl: "https://api.anthropic.com", secret: "sk-ant-api03-owner", authKind: "api-key" }) },
    })
    expect(delivery!.expiresAt).toBe(decodeJwt(lease.leaseId).authority_expires_at)
    await plane.post("/session-authorize", { action: "turn_release", sessionId: ROOT, turnId: "turn_delivery", leaseId: lease.leaseId, fencingToken: lease.fencingToken }, proof)
  })

  test("a member's turn spends the owner's accounts, until the member can no longer send", async () => {
    await plane.store.grantSessionShare!(plane.owner, { sessionId: ROOT, workspaceId: WORKSPACE_ID, grantedToUserId: plane.member.principal!.userId, level: "send" })
    const proof = await plane.relayProof(plane.member, { hostId: sessionHostId(ROOT), backing: "durable-object", sessionId: ROOT, jti: "rat_member" })
    const lease = await plane.acquire(proof, ROOT, "turn_member")
    const allowed = parseTurnDelivery(await (await plane.post("/turn-delivery", { turnLease: lease.leaseId })).json())
    expect(Object.keys(allowed!.auth.direct!)).toEqual([plane.owner.principal!.userId])
    await plane.store.revokeSessionShare!(plane.owner, { sessionId: ROOT, workspaceId: WORKSPACE_ID, grantedToUserId: plane.member.principal!.userId })
    const revoked = await plane.post("/turn-delivery", { turnLease: lease.leaseId })
    expect(revoked.status).toBe(403)
    expect(await revoked.json()).toEqual({ error: { code: "turn_delivery_denied" } })
  })

  test("refuses an expired or forged lease, and a session not served by its own host", async () => {
    expect((await plane.post("/turn-delivery", { turnLease: await expiredLease() })).status).toBe(401)
    expect((await plane.post("/turn-delivery", { turnLease: "not-a-lease" })).status).toBe(401)
    expect((await plane.post("/turn-delivery", { turnLease: "x", extra: true })).status).toBe(400)
    await plane.store.reserveSession(plane.owner, { operationId: "op_vm", sessionId: "ses_vm", workspaceId: WORKSPACE_ID, kind: "create" })
    const vmProof = await plane.relayProof(plane.owner, { hostId: "host_vm", backing: "cloud-vm", jti: "rat_vm" })
    for (const action of ["start", "register"]) {
      const times = action === "register" ? { createdAt: Date.now(), updatedAt: Date.now() } : {}
      expect((await plane.post("/session-authorize", { action, sessionId: "ses_vm", operationId: "op_vm", ...times }, vmProof)).status).toBe(200)
    }
    expect(await sessionRow("ses_vm")).toMatchObject({ session_host_root: null })
    const lease = await plane.acquire(vmProof, "ses_vm", "turn_vm")
    const answer = await plane.post("/turn-delivery", { turnLease: lease.leaseId })
    expect(answer.status).toBe(403)
  })
})

describe("/turn-execution", () => {
  test("answers a provisioning machine with its retry, then a token for this session on that machine", async () => {
    const root = "ses_pi_execution"
    const proof = await plane.createHostedSession(root)
    const lease = await plane.acquire(proof, root, "turn_execution")
    plane.serve({ status: "unavailable", reason: "runtime_lease_not_ready", leaseStatus: "acquiring", retryAfterMs: 1_500 })
    const provisioning = await plane.post("/turn-execution", { turnLease: lease.leaseId })
    expect(provisioning.status).toBe(409)
    expect(await provisioning.json()).toEqual({ error: { code: "cloud_runtime_unavailable", retryAfterMs: 1_500 } })

    plane.serve({ status: "ready", workspaceId: WORKSPACE_ID, sandboxId: "sbx", url: "https://vm.test", hostId: "host_vm", routingId: "route_1", epoch: 1, homeRegion: "us-east" })
    const answer = await plane.post("/turn-execution", { turnLease: lease.leaseId })
    expect(answer.status).toBe(200)
    const access = parseTurnExecutionAccess(await answer.json())
    expect(access).toMatchObject({ relayUrl: "https://relay.test", workspaceId: WORKSPACE_ID, hostId: "host_vm", routingId: "route_1", directory: DIRECTORY })
    expect(decodeJwt(access!.runtimeAccessToken)).toMatchObject({
      scope: "session", session_id: root, role: "editor", host_id: "host_vm", routing_id: "route_1", actor_id: plane.owner.principal!.actorId,
    })
    const jti = String(decodeJwt(access!.runtimeAccessToken).jti)
    expect(await plane.store.runtimeAccessTokenActive({ jti, workspaceId: WORKSPACE_ID, hostId: "host_vm" })).toEqual({ active: true })
  })

  test("no editor token is recorded for a session that runs in the workspace's runtime", async () => {
    await expect(plane.store.recordTurnRuntimeAccessToken(plane.owner.principal!.actorId, {
      jti: "rat_vm_editor", workspaceId: WORKSPACE_ID, hostId: "host_vm", sessionId: "ses_vm", expiresAt: Date.now() + 60_000,
    })).rejects.toThrow(/viewer/)
  })
})
