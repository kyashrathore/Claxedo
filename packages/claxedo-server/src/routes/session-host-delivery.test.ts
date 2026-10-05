import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { decodeJwt, importPKCS8, SignJWT } from "jose"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import { parseTurnDelivery, parseTurnExecutionAccess } from "@claxedo/harness/contract"
import { DIRECTORY, WORKSPACE_ID, sessionHostPlane, type SessionHostPlane } from "../test-support/session-host-plane"

let plane: SessionHostPlane
const PI_PLUGINS = {
  harnessLaunch: { pi: {
    generation: "generation-1",
    execution: { mode: "default" },
    pluginRoots: [{ pluginInstanceId: "claxedo/docs", root: "/plugins/docs", dataRoot: "/plugins/data/docs", skillNames: ["docs"] }],
    mcpServers: [{ kind: "http", name: "docs", origin: "plugin", url: "https://gateway.test/api/claxedo/plugins/mcp/docs", headers: { Authorization: "Bearer gateway-token" } }],
    notApplied: [],
  } },
  mcp: {},
}
const pluginReads: string[] = []
let pluginFailure: Error | undefined
const ROOT = "ses_pi_root"
const VM = "ses_vm"
const VM_HOST = "host_vm"

beforeAll(async () => {
  plane = await sessionHostPlane({ plugins: async (workspaceId) => {
    if (pluginFailure) throw pluginFailure
    pluginReads.push(workspaceId)
    return PI_PLUGINS
  } })
  const ownerId = plane.owner.principal!.userId
  const memberId = plane.member.principal!.userId
  const accounts = plane.credentials(plane.orgId)
  await accounts.putCredential({ owner: ownerId, provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-owner" })
  await accounts.putCredential({ owner: memberId, provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-member" })
  await accounts.putCredential({ owner: ownerId, provider_id: "cursor-sdk", kind: "api_key", source: "managed", secret: "cursor-owner" })
  await plane.createHostedSession(ROOT)
  await plane.createVmSession(VM)
})

afterAll(async () => {
  await plane.close()
})

const sessionRow = async (sessionId: string) => await plane.database
  .prepare("select session_host_root, status from sessions where session_id = ?")
  .bind(sessionId)
  .first<{ session_host_root: string | null; status: string | null }>()

const hostProof = (jti: string, sessionId = ROOT) => plane.relayProof(plane.owner, { hostId: sessionHostId(sessionId), backing: "durable-object", jti })
const vmProof = (jti: string) => plane.relayProof(plane.owner, { hostId: VM_HOST, backing: "cloud-vm", jti })
const release = (proof: string, sessionId: string, lease: { turnId: string; leaseId: string; fencingToken: number }) =>
  plane.post("/session-authorize", { action: "turn_release", sessionId, turnId: lease.turnId, leaseId: lease.leaseId, fencingToken: lease.fencingToken }, proof)

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

describe("a session placed in its own host answers to that host alone", () => {
  test("the reservation places it, the host's registration records it, and the root never changes", async () => {
    expect(await sessionRow(ROOT)).toMatchObject({ session_host_root: ROOT })
    expect(await sessionRow(VM)).toMatchObject({ session_host_root: null })
    await expect(plane.database.prepare("update sessions set session_host_root = 'ses_other' where session_id = ?").bind(ROOT).run()).rejects.toThrow()
    await expect(plane.database.prepare("update session_registration_operations set session_host_root = null where session_id = ?").bind(ROOT).run()).rejects.toThrow()
  })

  test("a machine's proof reaches no action of a session placed in its own host", async () => {
    const proof = await vmProof("rat_vm_on_hosted")
    for (const body of [
      { action: "read", sessionId: ROOT },
      { action: "turn_acquire", sessionId: ROOT, turnId: "turn_vm" },
      { action: "turn_grant", sessionId: ROOT, intent: "queued_prompt", turnId: "turn_vm_grant" },
    ]) {
      const answer = await plane.post("/session-authorize", body, proof)
      expect(answer.status, body.action).toBe(403)
      expect(await answer.json()).toMatchObject({ error: { code: "session_host_mismatch" } })
    }
  })

  test("each runtime registers only the session its reservation placed with it", async () => {
    await plane.store.reserveSession(plane.owner, { operationId: "op_pi_misrouted", sessionId: "ses_pi_misrouted", workspaceId: WORKSPACE_ID, kind: "create", harnessId: "pi" })
    await plane.store.reserveSession(plane.owner, { operationId: "op_vm_misrouted", sessionId: "ses_vm_misrouted", workspaceId: WORKSPACE_ID, kind: "create", harnessId: "codex" })
    const times = { createdAt: Date.now(), updatedAt: Date.now() }
    const onVm = await plane.post("/session-authorize", { action: "register", sessionId: "ses_pi_misrouted", operationId: "op_pi_misrouted", ...times }, await vmProof("rat_vm_misrouted"))
    expect(onVm.status).toBe(403)
    const onHost = await plane.post("/session-authorize", { action: "register", sessionId: "ses_vm_misrouted", operationId: "op_vm_misrouted", ...times }, await hostProof("rat_host_misrouted", "ses_vm_misrouted"))
    expect(onHost.status).toBe(403)
    expect(await sessionRow("ses_pi_misrouted")).toBeNull()
    expect(await sessionRow("ses_vm_misrouted")).toBeNull()
  })

  test("a host reaches no other session, reserves nothing, adopts nothing and reads no workspace", async () => {
    const proof = await hostProof("rat_confined")
    const other = await plane.post("/session-authorize", { action: "read", sessionId: VM }, proof)
    expect(other.status).toBe(403)
    const reserve = await plane.post("/session-authorize", { action: "reserve", sessionId: "ses_fork", parentSessionId: ROOT }, proof)
    expect(reserve.status).toBe(403)
    const adopt = await plane.post("/session-authorize", { action: "adopt", sessionId: ROOT, createdAt: 1, updatedAt: 1 }, proof)
    expect(adopt.status).toBe(403)
    expect((await plane.post("/session-authorize", { action: "host_read" }, proof)).status).toBe(403)
  })

  test("an admitted turn marks the session busy for a list nobody watches, its release idle, and a lapsed lease reads interrupted", async () => {
    const proof = await hostProof("rat_turn_status")
    const lease = await plane.acquire(proof, ROOT, "turn_status")
    expect((await sessionRow(ROOT))?.status).toBe("busy")
    expect(await (await release(proof, ROOT, lease)).json()).toMatchObject({ released: true })
    expect((await sessionRow(ROOT))?.status).toBe("idle")

    const lapsed = await plane.acquire(proof, ROOT, "turn_lapsed")
    await plane.database.prepare("update session_turn_leases set expires_at = ? where session_id = ?").bind(Date.now() - 1, ROOT).run()
    const page = await plane.store.listSessionPage(plane.owner, { workspaceId: WORKSPACE_ID, sort: "updated_desc", archived: "all", settled: "all", limit: 10 })
    expect(page.find((row) => row.session_id === ROOT)).toMatchObject({ status: "interrupted" })
    expect((await sessionRow(ROOT))?.status).toBe("busy")
    void lapsed
  })
})

describe("/turn-delivery", () => {
  test("hands the session's own host the owner's Pi accounts as direct secrets and nothing else", async () => {
    const proof = await hostProof("rat_delivery")
    const lease = await plane.acquire(proof, ROOT, "turn_delivery")
    const answer = await plane.post("/turn-delivery", { turnLease: lease.leaseId })
    expect(answer.status).toBe(200)
    expect(answer.headers.get("cache-control")).toBe("no-store")
    const delivery = parseTurnDelivery(await answer.json())
    const ownerId = plane.owner.principal!.userId
    expect(delivery).toMatchObject({ auth: { machineOwnerUserId: ownerId, accounts: {} }, plugins: PI_PLUGINS, providerDefinitions: [] })
    expect(pluginReads).toEqual([WORKSPACE_ID])
    expect(delivery!.auth.direct).toEqual({
      [ownerId]: { anthropic: expect.objectContaining({ delivery: "direct", baseUrl: "https://api.anthropic.com", secret: "sk-ant-api03-owner", authKind: "api-key" }) },
    })
    expect(delivery!.expiresAt).toBe(decodeJwt(lease.leaseId).authority_expires_at)

    await release(proof, ROOT, lease)
    const released = await plane.post("/turn-delivery", { turnLease: lease.leaseId })
    expect(released.status).toBe(401)
  })

  test("a machine's lease gets nothing for the session it serves", async () => {
    const lease = await plane.acquire(await vmProof("rat_vm_delivery"), VM, "turn_vm_delivery")
    expect((await plane.post("/turn-delivery", { turnLease: lease.leaseId })).status).toBe(403)
  })

  test("a member's turn spends the owner's accounts, until the member can no longer send", async () => {
    await plane.store.grantSessionShare!(plane.owner, { sessionId: ROOT, workspaceId: WORKSPACE_ID, grantedToUserId: plane.member.principal!.userId, level: "send" })
    const proof = await plane.relayProof(plane.member, { hostId: sessionHostId(ROOT), backing: "durable-object", sessionId: ROOT, jti: "rat_member" })
    await plane.database.prepare("update session_turn_leases set released_at = ? where session_id = ?").bind(Date.now(), ROOT).run()
    const lease = await plane.acquire(proof, ROOT, "turn_member")
    const allowed = parseTurnDelivery(await (await plane.post("/turn-delivery", { turnLease: lease.leaseId })).json())
    expect(Object.keys(allowed!.auth.direct!)).toEqual([plane.owner.principal!.userId])
    await plane.store.revokeSessionShare!(plane.owner, { sessionId: ROOT, workspaceId: WORKSPACE_ID, grantedToUserId: plane.member.principal!.userId })
    const revoked = await plane.post("/turn-delivery", { turnLease: lease.leaseId })
    expect(revoked.status).toBe(403)
    expect(await revoked.json()).toEqual({ error: { code: "turn_delivery_denied" } })
  })

  test("a queued turn's grant carries the host it was asked from, so its lease is delivered to", async () => {
    const root = "ses_pi_grant"
    const proof = await plane.createHostedSession(root)
    const granted = await plane.post("/session-authorize", { action: "turn_grant", sessionId: root, intent: "queued_prompt", turnId: "turn_queued" }, proof)
    expect(granted.status).toBe(200)
    const { grant } = await granted.json() as { grant: string }
    expect(decodeJwt(grant).host_id).toBe(sessionHostId(root))
    const acquired = await plane.post("/session-authorize", { action: "turn_acquire", sessionId: root, turnId: "turn_queued", grant })
    expect(acquired.status).toBe(200)
    const { leaseId } = await acquired.json() as { leaseId: string }
    expect((await plane.post("/turn-delivery", { turnLease: leaseId })).status).toBe(200)
  })

  test("a machine that cannot apply the owner's plugins fails the turn with a typed answer", async () => {
    const root = "ses_pi_plugins_unapplied"
    const proof = await plane.createHostedSession(root)
    const lease = await plane.acquire(proof, root, "turn_plugins_unapplied")
    pluginFailure = new Error("Agent Plugins runtime apply failed (404)")
    try {
      const answer = await plane.post("/turn-delivery", { turnLease: lease.leaseId })
      expect(answer.status).toBe(502)
      expect(await answer.json()).toEqual({ error: { code: "agent_plugins_unavailable" } })
    } finally {
      pluginFailure = undefined
    }
  })

  test("refuses an expired, forged or malformed lease", async () => {
    expect((await plane.post("/turn-delivery", { turnLease: await expiredLease() })).status).toBe(401)
    expect((await plane.post("/turn-delivery", { turnLease: "not-a-lease" })).status).toBe(401)
    expect((await plane.post("/turn-delivery", { turnLease: "x", extra: true })).status).toBe(400)
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

    plane.serve({ status: "ready", workspaceId: WORKSPACE_ID, sandboxId: "sbx", url: "https://vm.test", hostId: VM_HOST, routingId: "route_1", epoch: 1, homeRegion: "us-east" })
    const answer = await plane.post("/turn-execution", { turnLease: lease.leaseId })
    expect(answer.status).toBe(200)
    const access = parseTurnExecutionAccess(await answer.json())
    expect(access).toMatchObject({ relayUrl: "https://relay.test", workspaceId: WORKSPACE_ID, hostId: VM_HOST, routingId: "route_1", directory: DIRECTORY })
    expect(decodeJwt(access!.runtimeAccessToken)).toMatchObject({
      scope: "session", session_id: root, role: "editor", host_id: VM_HOST, routing_id: "route_1", actor_id: plane.owner.principal!.actorId, purpose: "turn-execution",
    })
    const jti = String(decodeJwt(access!.runtimeAccessToken).jti)
    expect(await plane.store.runtimeAccessTokenActive({ jti, workspaceId: WORKSPACE_ID, hostId: VM_HOST })).toEqual({ active: true })
  })

  test("a machine target the store refuses answers the store's refusal, never an anonymous failure", async () => {
    const root = "ses_pi_execution_refused"
    const proof = await plane.createHostedSession(root)
    const lease = await plane.acquire(proof, root, "turn_execution_refused")
    plane.serve({ status: "ready", workspaceId: WORKSPACE_ID, sandboxId: "sbx", url: "https://vm.test", hostId: sessionHostId(ROOT), epoch: 1, homeRegion: "us-east" })
    const answer = await plane.post("/turn-execution", { turnLease: lease.leaseId })
    expect(answer.status).toBe(403)
    expect(await answer.json()).toMatchObject({ error: { code: "workspace_authorization_denied" } })
  })

  test("a machine target the store cannot record answers a typed failure", async () => {
    const root = "ses_pi_execution_failed"
    const proof = await plane.createHostedSession(root)
    const lease = await plane.acquire(proof, root, "turn_execution_failed")
    plane.serve({ status: "ready", workspaceId: WORKSPACE_ID, sandboxId: "sbx", url: "https://vm.test", hostId: "", epoch: 1, homeRegion: "us-east" })
    const answer = await plane.post("/turn-execution", { turnLease: lease.leaseId })
    expect(answer.status).toBe(500)
    expect(await answer.json()).toEqual({ error: { code: "session_host_authority_failed" } })
  })

  test("a session-scoped editor token reaches the session's own host, or its machine for a turn, and nothing else", async () => {
    const actorId = plane.owner.principal!.actorId
    const expiresAt = Date.now() + 60_000
    await expect(plane.store.recordTurnRuntimeAccessToken(actorId, { jti: "rat_vm_editor", workspaceId: WORKSPACE_ID, hostId: VM_HOST, sessionId: VM, expiresAt }))
      .rejects.toThrow(/served by its own host/)
    await expect(plane.store.recordRuntimeAccessToken(plane.owner, {
      jti: "rat_signed_vm_editor", workspaceId: WORKSPACE_ID, hostId: VM_HOST, actorId, actorKind: "human", role: "editor", sessionId: ROOT, expiresAt,
    })).rejects.toThrow(/session's own host/)
  })
})

describe("/session-host-delete", () => {
  const deleted = async (sessionId: string) => (await plane.database.prepare("select deleted_at from sessions where session_id = ?").bind(sessionId).first<{ deleted_at: number | null }>())?.deleted_at
  const remove = (sessionId: string, proof: string) => plane.post("/session-host-delete", { sessionId }, proof)

  test("deletes the row for the session's own host, as an actor who controls the session, and the host is never admitted again", async () => {
    const root = "ses_pi_delete"
    const proof = await plane.createHostedSession(root)
    const answer = await remove(root, proof)
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ deleted: true })
    expect(await deleted(root)).toEqual(expect.any(Number))
    expect((await plane.post("/session-authorize", { action: "read", sessionId: root }, proof)).status).toBe(403)
    expect((await remove(root, proof)).status).toBe(403)
  })

  test("refuses another host, a machine, a member who may only send, and a forged proof", async () => {
    const root = "ses_pi_delete_refused"
    await plane.createHostedSession(root)
    await plane.store.grantSessionShare!(plane.owner, { sessionId: root, workspaceId: WORKSPACE_ID, grantedToUserId: plane.member.principal!.userId, level: "send" })
    const member = await plane.relayProof(plane.member, { hostId: sessionHostId(root), backing: "durable-object", sessionId: root, jti: "rat_member_delete" })
    for (const proof of [await hostProof("rat_other_host_delete", ROOT), await vmProof("rat_vm_delete"), member]) {
      const answer = await remove(root, proof)
      expect(answer.status).toBe(403)
      expect(await answer.json()).toEqual({ error: { code: "session_host_delete_denied" } })
    }
    expect((await remove(root, "not-a-token")).status).toBe(401)
    expect((await remove(VM, await vmProof("rat_vm_delete_own"))).status).toBe(403)
    expect(await deleted(root)).toBeNull()
    expect(await deleted(VM)).toBeNull()
  })
})
