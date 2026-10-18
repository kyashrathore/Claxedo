import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { decodeJwt } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import { parseTurnDelivery } from "@claxedo/harness/contract"
import { countD1Rounds, type D1Rounds } from "../test-support/d1-rounds"
import { DIRECTORY, WORKSPACE_ID, sessionHostPlane, type SessionHostPlane } from "../test-support/session-host-plane"

let plane: SessionHostPlane
let rounds: D1Rounds
const ROOT = "ses_pi_start"
const OTHER = "ses_pi_other"
const PLUGINS = { harnessLaunch: { pi: { generation: "g1", execution: { mode: "default" }, pluginRoots: [], mcpServers: [], notApplied: [] } }, mcp: {} }
const ROUNDS = 4
const STATEMENTS = 13

beforeAll(async () => {
  plane = await sessionHostPlane({
    plugins: async () => PLUGINS,
    database: (database) => {
      rounds = countD1Rounds(database)
      return rounds.database
    },
  })
  const accounts = plane.credentials(plane.orgId)
  await accounts.putCredential({ owner: plane.owner.principal!.userId, provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-owner" })
  await accounts.putCredential({ owner: plane.member.principal!.userId, provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-member" })
  await plane.createHostedSession(ROOT)
  await plane.createHostedSession(OTHER)
})

afterAll(async () => {
  await plane.close()
})

const hostProof = (who: SessionHostPlane["owner"], jti: string, sessionId = ROOT) =>
  plane.relayProof(who, { hostId: sessionHostId(sessionId), backing: "durable-object", sessionId, jti })
const acquire = (proof: string, turnId: string, sessionId = ROOT, body: Record<string, unknown> = { writeClass: "agent_turn" }) =>
  plane.post("/session-authorize", { action: "turn_acquire", sessionId, turnId, ...body }, proof)
const release = (proof: string, lease: { turnId: string; leaseId: string; fencingToken: number }) =>
  plane.post("/session-authorize", { action: "turn_release", sessionId: ROOT, turnId: lease.turnId, leaseId: lease.leaseId, fencingToken: lease.fencingToken }, proof)
const leaseRows = async () => (await plane.database.prepare("select turn_id from session_turn_leases where session_id = ? and released_at is null").bind(ROOT).all()).results

describe("a session host's turn starts on one control-plane request", () => {
  test("the owner's acquisition answers the lease and the turn's delivery, the same one /turn-delivery answers for that lease", async () => {
    const proof = await hostProof(plane.owner, "rat_owner_start")
    rounds.reset()
    const answer = await acquire(proof, "turn_owner_1")
    expect(answer.status, await answer.clone().text()).toBe(200)
    const body = await answer.json() as Record<string, unknown>
    const chain = { rounds: rounds.rounds(), statements: rounds.statements(), trace: rounds.trace().map((entry) => `${entry.round}: ${entry.sql}`) }
    const again = await plane.post("/turn-delivery", { turnLease: body.leaseId })
    expect((await release(proof, body as never)).status).toBe(200)
    expect(body).toMatchObject({ turnId: "turn_owner_1", fencingToken: expect.any(Number) })
    const delivery = parseTurnDelivery(body.delivery)
    expect(delivery).toBeDefined()
    const ownerId = plane.owner.principal!.userId
    expect(delivery).toMatchObject({ auth: { machineOwnerUserId: ownerId }, plugins: PLUGINS, directory: DIRECTORY })
    expect(Object.keys(delivery!.auth.direct![ownerId])).toEqual(["anthropic"])
    expect(delivery!.auth.direct![ownerId].anthropic).toMatchObject({ delivery: "direct", secret: "sk-ant-api03-owner" })
    expect(delivery!.firstPartyMcp).toMatchObject({ toolGroups: ["sessions"] })
    expect(delivery!.expiresAt).toBe(decodeJwt(body.leaseId as string).authority_expires_at)

    expect(again.status).toBe(200)
    const sameLease = parseTurnDelivery(await again.json())!
    expect({ ...sameLease, firstPartyMcp: undefined }).toEqual({ ...delivery!, firstPartyMcp: undefined })
    expect(sameLease.firstPartyMcp?.url).toBe(delivery!.firstPartyMcp?.url)

    // The serial D1 depth of the one request, against the 22 of the three it
    // replaced on 5a5f335a99: 3 for the write, 8 for the acquisition, 11 for
    // the delivery.
    expect(chain, chain.trace.join("\n")).toMatchObject({ rounds: ROUNDS, statements: STATEMENTS })
  })

  test("a send grantee's turn is admitted and spends the creator's accounts; a stranger's, a follow grantee's and a revoked token's are refused before any lease is taken", async () => {
    const memberId = plane.member.principal!.userId
    await plane.store.grantSessionShare!(plane.owner, { sessionId: ROOT, workspaceId: WORKSPACE_ID, grantedToUserId: memberId, level: "send" })
    const proof = await hostProof(plane.member, "rat_member_send")
    const admitted = await acquire(proof, "turn_member_1")
    expect(admitted.status, await admitted.clone().text()).toBe(200)
    const lease = await admitted.json() as { leaseId: string; fencingToken: number; turnId: string; delivery: unknown }
    expect((await release(proof, lease)).status).toBe(200)
    const delivery = parseTurnDelivery(lease.delivery)!
    const ownerId = plane.owner.principal!.userId
    expect(Object.keys(delivery.auth.direct!)).toEqual([ownerId])
    expect(delivery.auth.direct![ownerId].anthropic).toMatchObject({ secret: "sk-ant-api03-owner" })
    expect(delivery.firstPartyMcp).toBeUndefined()

    // The plane mints no token for someone outside the organization; what a
    // relay could forward for them is a host token over a live token's chain,
    // and the write is what refuses it.
    const forged = await mintRelayHostToken({
      principalKind: "user", actorId: plane.outsider.principal!.actorId, actorKind: "human", orgId: plane.orgId, workspaceId: WORKSPACE_ID,
      hostId: sessionHostId(ROOT), role: "editor", backing: "durable-object", sessionId: ROOT, jti: "rht_outsider", parentJti: "rat_member_send",
    }, plane.key.privateKey, "EdDSA")
    const outsider = await acquire(forged, "turn_outsider")
    expect(outsider.status).toBe(403)
    expect(await outsider.json()).toMatchObject({ error: { code: "workspace_authorization_denied" } })
    expect(await leaseRows()).toEqual([])

    // A share narrowed to follow, or withdrawn, ends the editor's token the
    // member holds, which the token's recheck answers ahead of the write.
    await plane.store.grantSessionShare!(plane.owner, { sessionId: ROOT, workspaceId: WORKSPACE_ID, grantedToUserId: memberId, level: "follow" })
    const following = await acquire(proof, "turn_member_follow")
    expect(following.status).toBe(401)
    expect(await following.json()).toMatchObject({ error: { code: "runtime_access_token_revoked" } })
    expect(await leaseRows()).toEqual([])

    await plane.store.revokeSessionShare!(plane.owner, { sessionId: ROOT, workspaceId: WORKSPACE_ID, grantedToUserId: memberId })
    const stranger = await acquire(proof, "turn_member_stranger")
    expect(stranger.status).toBe(401)
    expect(await leaseRows()).toEqual([])

    await plane.store.grantSessionShare!(plane.owner, { sessionId: ROOT, workspaceId: WORKSPACE_ID, grantedToUserId: memberId, level: "send" })
    const restored = await hostProof(plane.member, "rat_member_send_2")
    await plane.store.revokeRuntimeAccessToken(plane.owner, { jti: "rat_member_send_2", workspaceId: WORKSPACE_ID })
    const revoked = await acquire(restored, "turn_member_revoked")
    expect(revoked.status).toBe(401)
    expect(await revoked.json()).toMatchObject({ error: { code: "runtime_access_token_revoked" } })
    expect(await leaseRows()).toEqual([])
  })

  test("a token scoped to one session acquires no turn on another, and a session served by another host is refused as such", async () => {
    const proof = await hostProof(plane.owner, "rat_owner_scoped", OTHER)
    const elsewhere = await acquire(proof, "turn_scoped", ROOT)
    expect(elsewhere.status).toBe(403)
    expect(await elsewhere.json()).toMatchObject({ error: { code: "session_scope_denied" } })
    const misplaced = await acquire(await plane.relayProof(plane.owner, { hostId: sessionHostId(OTHER), backing: "durable-object", jti: "rat_owner_other_host" }), "turn_misplaced", ROOT)
    expect(misplaced.status).toBe(403)
    expect(await misplaced.json()).toMatchObject({ error: { code: "session_host_mismatch" } })
    expect(await leaseRows()).toEqual([])
  })

  test("an acquisition names its class: a bearer's without one, with session_control, or a grant's with one is refused unread", async () => {
    const proof = await hostProof(plane.owner, "rat_owner_class")
    for (const body of [{}, { writeClass: "session_control" }, { writeClass: "agent_turn", grant: "signed-grant" }]) {
      const refused = await acquire(proof, "turn_unnamed", ROOT, body)
      expect(refused.status, JSON.stringify(body)).toBe(400)
      expect(await refused.json()).toMatchObject({ error: { code: "session_authority_request_invalid" } })
    }
    expect(await leaseRows()).toEqual([])
  })

  test("a lease a host took over still reads its delivery from /turn-delivery, and that lease alone", async () => {
    const proof = await hostProof(plane.owner, "rat_owner_takeover")
    const lease = await plane.acquire(proof, ROOT, "turn_takeover")
    expect(lease.delivery).toBeDefined()
    expect((await plane.post("/turn-delivery", { turnLease: lease.leaseId })).status).toBe(200)
    await release(proof, lease)
    const released = await plane.post("/turn-delivery", { turnLease: lease.leaseId })
    expect(released.status).toBe(401)
  })
})
