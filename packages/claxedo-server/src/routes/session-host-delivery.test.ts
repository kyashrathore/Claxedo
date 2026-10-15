import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { decodeJwt, importPKCS8, SignJWT } from "jose"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import { sandboxRuntimeBootFailedError } from "@claxedo/sandbox-manager"
import { parseTurnDelivery, parseTurnExecutionAccess } from "@claxedo/harness/contract"
import { ORG_ACCOUNT_UNAVAILABLE } from "@claxedo/agent-runtime-contract"
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
    expect(delivery!.firstPartyMcp?.name).toBe("claxedo")
    expect(delivery!.directory).toBe(DIRECTORY)

    await release(proof, ROOT, lease)
    const released = await plane.post("/turn-delivery", { turnLease: lease.leaseId })
    expect(released.status).toBe(401)
  })

  test("a provider the owner chose the organization's account for, where it has none, is handed over as that refusal instead of their own account", async () => {
    const ownerId = plane.owner.principal!.userId
    const accounts = plane.credentials(plane.orgId)
    await accounts.setAccountSources(["anthropic"], "org", plane.orgId, ownerId)
    try {
      const proof = await hostProof("rat_delivery_org")
      const lease = await plane.acquire(proof, ROOT, "turn_delivery_org")
      const delivery = parseTurnDelivery(await (await plane.post("/turn-delivery", { turnLease: lease.leaseId })).json())
      expect(delivery!.auth.accounts).toEqual({ [ownerId]: { anthropic: { unavailable: true, reason: ORG_ACCOUNT_UNAVAILABLE } } })
      expect(delivery!.auth.direct?.[ownerId]?.anthropic).toBeUndefined()
      await release(proof, ROOT, lease)
    } finally {
      await accounts.setAccountSources(["anthropic"], "own", plane.orgId, ownerId)
    }
  })

  test("a machine's lease gets nothing for the session it serves", async () => {
    const lease = await plane.acquire(await vmProof("rat_vm_delivery"), VM, "turn_vm_delivery")
    expect((await plane.post("/turn-delivery", { turnLease: lease.leaseId })).status).toBe(403)
  })

  test("a member's turn spends the owner's accounts but gets no owner-identity MCP server, until the member can no longer send", async () => {
    await plane.store.grantSessionShare!(plane.owner, { sessionId: ROOT, workspaceId: WORKSPACE_ID, grantedToUserId: plane.member.principal!.userId, level: "send" })
    const proof = await plane.relayProof(plane.member, { hostId: sessionHostId(ROOT), backing: "durable-object", sessionId: ROOT, jti: "rat_member" })
    await plane.database.prepare("update session_turn_leases set released_at = ? where session_id = ?").bind(Date.now(), ROOT).run()
    const lease = await plane.acquire(proof, ROOT, "turn_member")
    const allowed = parseTurnDelivery(await (await plane.post("/turn-delivery", { turnLease: lease.leaseId })).json())
    expect(Object.keys(allowed!.auth.direct!)).toEqual([plane.owner.principal!.userId])
    expect(allowed!.firstPartyMcp).toBeUndefined()
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

describe("/turn-credential-refused", () => {
  test("two refusals of the account the turn spent mark it, after its lease was released too; another person's, another harness's or an unknown account marks nothing", async () => {
    const root = "ses_pi_refused"
    const proof = await plane.createHostedSession(root)
    const accounts = plane.credentials(plane.orgId)
    const ownerId = plane.owner.principal!.userId
    const spent = await accounts.putCredential({ owner: ownerId, provider_id: "groq", kind: "api_key", source: "managed", secret: "gsk-owner" })
    const members = await accounts.putCredential({ owner: plane.member.principal!.userId, provider_id: "groq", kind: "api_key", source: "managed", secret: "gsk-member" })
    const cursor = await accounts.putCredential({ owner: ownerId, provider_id: "cursor-sdk", kind: "api_key", source: "managed", secret: "cursor-owner-2" })
    const health = async (id: string) => (await accounts.getCredential!(id))?.health ?? null
    const lease = await plane.acquire(proof, root, "turn_refused")
    const refused = (credentialId: string, turnLease = lease.leaseId) => plane.post("/turn-credential-refused", { turnLease, credentialId })

    const first = await refused(spent.id)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ refusal: "waiting" })
    expect(await health(spent.id)).toBeNull()

    await release(proof, root, lease)
    const second = await refused(spent.id)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ refusal: "marked" })
    expect(await health(spent.id)).toBe("auth_failed")

    expect((await refused(members.id)).status).toBe(403)
    expect((await refused(cursor.id)).status).toBe(403)
    expect((await refused("cred_unknown")).status).toBe(403)
    expect(await health(members.id)).toBeNull()
    expect(await health(cursor.id)).toBeNull()
    expect((await refused(spent.id, await expiredLease())).status).toBe(401)
    expect((await plane.post("/turn-credential-refused", { turnLease: lease.leaseId })).status).toBe(400)
  })
})

describe("/turn-execution", () => {
  const NOT_RUNNING = { status: "unavailable", reason: "runtime_lease_not_ready", leaseStatus: "acquiring", retryAfterMs: 1_500 } as const

  test("refuses a machine that is not running at once and starts nothing for a call that does not ask, then answers a token for this session on that machine", async () => {
    const root = "ses_pi_execution"
    const proof = await plane.createHostedSession(root)
    const lease = await plane.acquire(proof, root, "turn_execution")
    plane.serve(NOT_RUNNING)
    const starts = plane.starts.length
    const provisioning = await plane.post("/turn-execution", { turnLease: lease.leaseId })
    expect(provisioning.status).toBe(409)
    expect(await provisioning.json()).toEqual({ error: { code: "cloud_runtime_unavailable" } })
    expect(plane.starts.length).toBe(starts)

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

  test("a call that asks starts a machine that is not running as the workspace's owner and answers at once that this call started it, when to ask again, and, joining that start, how long it has run", async () => {
    const root = "ses_pi_execution_start"
    const proof = await plane.createHostedSession(root)
    const lease = await plane.acquire(proof, root, "turn_execution_start")
    plane.serve(NOT_RUNNING)
    const starts = plane.starts.length
    plane.starting({ status: "provisioning", epoch: 2, retryAfterMs: 2_000, homeRegion: "us-east" })
    const started = await plane.post("/turn-execution", { turnLease: lease.leaseId, start: true })
    expect(started.status).toBe(409)
    expect(await started.json()).toEqual({ error: { code: "cloud_runtime_starting", started: true, retryAfterMs: 2_000 } })
    const requestedAt = Date.now() - 35_000
    plane.serve({ ...NOT_RUNNING, start: { epoch: 2, requestedAt, startedAt: requestedAt, markedAt: requestedAt, bootMode: "resume", phases: [] } })
    plane.starting({ status: "provisioning", epoch: 2, retryAfterMs: 2_000, homeRegion: "us-east", joined: true })
    const joined = await plane.post("/turn-execution", { turnLease: lease.leaseId, start: true })
    const answer = (await joined.json()) as { error: { sinceStartMs: number } }
    expect(answer).toEqual({ error: { code: "cloud_runtime_starting", started: false, retryAfterMs: 2_000, sinceStartMs: expect.any(Number) } })
    expect(answer.error.sinceStartMs).toBeGreaterThanOrEqual(35_000)
    expect(answer.error.sinceStartMs).toBeLessThan(45_000)
    expect(plane.starts.slice(starts)).toEqual([{ workspaceId: WORKSPACE_ID }, { workspaceId: WORKSPACE_ID }])
    expect(plane.entitledOrgs.at(-1)).toBe(plane.orgId)
  })

  test("a start the plane refuses answers its reason: a boot that failed, a start that failed, the deployment's admission", async () => {
    const root = "ses_pi_execution_start_refused"
    const proof = await plane.createHostedSession(root)
    const lease = await plane.acquire(proof, root, "turn_execution_start_refused")
    plane.serve(NOT_RUNNING)
    const refusal = async () => await (await plane.post("/turn-execution", { turnLease: lease.leaseId, start: true })).json()
    plane.starting({ status: "unavailable", homeRegion: "us-east", retryAfterMs: 0, error: sandboxRuntimeBootFailedError("the branch main is gone") })
    expect(await refusal()).toEqual({ error: { code: "cloud_runtime_start_refused", message: "The cloud workspace could not start: the branch main is gone" } })
    plane.starting({ status: "failed", code: "runtime_prepare_failed", message: "the settings could not be prepared" })
    expect(await refusal()).toEqual({ error: { code: "cloud_runtime_start_refused", message: "The cloud workspace could not start: the settings could not be prepared" } })
    const starts = plane.starts.length
    plane.entitle({ status: 402, body: { error: { code: "cloud_workspace_plan_required", message: "this organization's plan runs no cloud workspaces" } } })
    try {
      expect(await refusal()).toEqual({ error: { code: "cloud_runtime_start_refused", message: "The cloud workspace could not start: this organization's plan runs no cloud workspaces" } })
    } finally { plane.entitle(undefined) }
    expect(plane.starts.length).toBe(starts)
  })

  test("a start that failed and is backing off is refused with the provider's reason and when it is tried again, never answered as starting", async () => {
    const root = "ses_pi_execution_start_backoff"
    const proof = await plane.createHostedSession(root)
    const lease = await plane.acquire(proof, root, "turn_execution_start_backoff")
    plane.serve(NOT_RUNNING)
    const refusal = async () => await (await plane.post("/turn-execution", { turnLease: lease.leaseId, start: true })).json()
    plane.starting({ status: "unavailable", homeRegion: "us-east", epoch: 3, retryAfterMs: 30_000, error: "boat_rate_limited: 429 Too Many Requests\nretry later" })
    expect(await refusal()).toEqual({ error: {
      code: "cloud_runtime_start_refused", message: "The cloud workspace could not start: boat_rate_limited: 429 Too Many Requests", retryAfterMs: 30_000,
    } })
    plane.starting({ status: "unavailable", homeRegion: "us-east", epoch: 3, error: "runtime_lease_stopped" })
    expect(await refusal()).toEqual({ error: { code: "cloud_runtime_start_refused", message: "The cloud workspace could not start: it was stopped or replaced while it started" } })
    plane.starting({ status: "provisioning", epoch: 3, retryAfterMs: 12_000, homeRegion: "us-east", joined: true, failure: "boat_rate_limited: 429 Too Many Requests" })
    expect(await refusal()).toEqual({ error: {
      code: "cloud_runtime_start_refused", message: "The cloud workspace could not start: boat_rate_limited: 429 Too Many Requests", retryAfterMs: 12_000,
    } })
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
