import { testSessionRoutePorts } from "@claxedo/session-core/testing"
import { afterEach, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { type RuntimeStore, type SessionAccessPolicy, SessionRoutes, queuedPromptStore, remoteWorkspaceSessionAccessPolicy } from "@claxedo/session-core"
import { openRuntimeStore } from "../../../workspace-runtime/src/store-file"
import { createRelayHostAuthMiddleware } from "@claxedo/session-core/relay-host"
import { RuntimeSessionAuthorityRoutes } from "./runtime-session-authority"
import { fetchJsonBody, fetchUrl } from "../test-support/fetch-calls"
import {
  CHILD,
  CHILD_OPERATION,
  DIRECTORY,
  HOST,
  PARENT,
  WAKE_TURN,
  WORKSPACE,
  admitFinishedChild,
  grantRows,
  wakeRuntime,
  lifecycle,
  producers,
  registerChild,
  reopened,
  reserveChild,
  runtimeStoreRoot,
  seedFinishedChildStore,
  seedWakeWorkspace,
  storeBackedHostOptions,
  until,
  wake,
  type WakeAuthority,
} from "../test-support/child-wake-fixture"

const RAT = "rat_alice"
const AUTHORITY_URL = "https://control.test/api/runtime-authority/session-authorize"

type AuthorityCall = { action: string; authorization: string | null; grant: boolean; turnId?: string; status: number; code?: string }
type TurnAttempt = { actorId?: string; turnId: string; grant: boolean }

afterEach(async () => {
  vi.useRealTimers()
  await lifecycle.cleanup()
})

async function controlPlane(authority: WakeAuthority) {
  const runtimeKey = await generateKeyPair("EdDSA", { extractable: true })
  const relayKey = await generateKeyPair("EdDSA", { extractable: true })
  const app = new Hono().route("/api/runtime-authority", RuntimeSessionAuthorityRoutes({
    authority,
    turnAuthority: authority,
    env: {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(runtimeKey.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(runtimeKey.publicKey),
      CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(relayKey.publicKey),
    },
  }))
  return { app, relayKey }
}

/**
 * The runtime's view of that plane: every decision is a POST it can only reach
 * through `fetch`, recorded as sent and as answered. `attempts` records the
 * turns the host asks the policy for, which `calls` cannot: the policy refuses
 * an acquisition with neither credential nor grant before it sends anything,
 * so a host that asked for an unproven turn is indistinguishable at the wire
 * from one that never asked.
 */
function remotePolicy(plane: Hono) {
  const calls: AuthorityCall[] = []
  const attempts: TurnAttempt[] = []
  const policy = remoteWorkspaceSessionAccessPolicy({
    url: AUTHORITY_URL,
    fetch: async (input, init) => {
      const body = fetchJsonBody(init?.body)
      const response = await plane.request(fetchUrl(input), init)
      const answer = await response.clone().json().catch(() => undefined) as { error?: { code?: string } } | undefined
      calls.push({
        action: String(body.action),
        authorization: new Headers(init?.headers).get("authorization"),
        grant: typeof body.grant === "string",
        ...(typeof body.turnId === "string" ? { turnId: body.turnId } : {}),
        status: response.status,
        ...(answer?.error?.code ? { code: answer.error.code } : {}),
      })
      return response
    },
  })
  if (!policy.acquireTurn) throw new Error("A remote session access policy answers turn acquisitions")
  const recording: SessionAccessPolicy = {
    ...policy,
    acquireTurn: (input) => {
      attempts.push({ ...(input.actor ? { actorId: input.actor.actorId } : {}), turnId: input.turnId, grant: typeof input.grant === "string" })
      return policy.acquireTurn!(input)
    },
  }
  return { policy: recording, calls, attempts }
}

async function relayProof(relayKey: CryptoKey, who: SignedControlPlaneAuth, orgId: string, jti: string) {
  return await mintRelayHostToken({
    principalKind: "user",
    actorId: who.principal!.actorId,
    userId: who.user.subject,
    actorKind: "human",
    orgId,
    workspaceId: WORKSPACE,
    hostId: HOST,
    role: "owner",
    backing: "local-worktree",
    jti,
    parentJti: RAT,
  }, relayKey, "EdDSA")
}

function relayed(token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-workspace-id": WORKSPACE,
      "x-forwarded-by": "workspace-relay",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  }
}

/**
 * A host over the store behind the relay ingress. The same shape serves a
 * fresh process: it keeps nothing but the store, so what it delivers after a
 * restart is what the store says. `endsBeforeReceipt` is a process that ends
 * after a wake's turn started and before the receipt naming that delivery was
 * written.
 */
function hostOver(store: RuntimeStore, policy: SessionAccessPolicy, execution: Awaited<ReturnType<typeof wakeRuntime>>, relayKey: CryptoKey,
  options: { endsBeforeReceipt?: boolean } = {}) {
  const { runtime } = execution
  const stored = storeBackedHostOptions(store)
  const host = SessionRoutes(async () => runtime, { ...testSessionRoutePorts(),
    sessionAccessPolicy: policy,
    requestedSessionHarness: (requested) => requested ?? { id: "pi", access: "native" },
    queuedPrompts: () => queuedPromptStore(store),
    ...stored,
    childSessions: { ...stored.childSessions!, admit: async (parentSessionId, observation) => {
      if (options.endsBeforeReceipt && observation.wakeReceipt) throw new Error("the process ended before the delivery receipt was written")
      return await stored.childSessions!.admit(parentSessionId, observation)
    } },
  })
  const disposeRoutes = host.dispose
  host.dispose = async () => {
    await disposeRoutes()
    await execution.dispose()
  }
  lifecycle.host(() => host.dispose())
  const ingress = new Hono()
    .use("*", createRelayHostAuthMiddleware({ key: relayKey, workspaceId: WORKSPACE, hostId: HOST }))
    .route("/", host.routes)
  return { host, ingress }
}

/**
 * Alice creates a child under her parent through the relay: the reservation
 * she took on the plane, then the runtime's create with her live Relay Host
 * Token, every authority decision over the wire.
 */
async function childCreatedOverTheRelay() {
  const workspace = await seedWakeWorkspace("send")
  const { root, authority, alice, aliceRuntime, orgId } = workspace
  await authority.recordRuntimeAccessToken(alice, {
    jti: RAT, workspaceId: WORKSPACE, hostId: HOST, actorId: alice.principal!.actorId, actorKind: "human", role: "owner", expiresAt: Date.now() + 60 * 60_000,
  })
  await reserveChild(authority, aliceRuntime)
  const plane = await controlPlane(authority)
  const storeRoot = runtimeStoreRoot(root)
  const store = openRuntimeStore(storeRoot)
  lifecycle.closer(() => store.close())
  const { policy, calls } = remotePolicy(plane.app)
  const execution = await wakeRuntime(store)
  const { prompts } = execution
  const { host, ingress } = hostOver(store, policy, execution, plane.relayKey.publicKey)
  const token = await relayProof(plane.relayKey.privateKey, alice, orgId, "rht_alice_create")

  const created = await ingress.request(
    `http://localhost/session?directory=${encodeURIComponent(DIRECTORY)}`,
    relayed(token, { id: CHILD, parentID: PARENT }, { "x-claxedo-session-registration-operation": CHILD_OPERATION }),
  )
  expect(created.status, await created.clone().text()).toBe(201)
  const { subagentKey } = await created.json() as { id: string; subagentKey: string }
  const origin = store.subagentOrigin(PARENT, subagentKey)
  const grant = origin?.provenance === "relay-replayed" ? origin.grant : undefined
  if (!grant) throw new Error("The create recorded no grant beside the child's origin")
  return { ...workspace, plane, store, storeRoot, host, ingress, calls, prompts, subagentKey, grant, token }
}

/**
 * The child finishes and the process ends before the offer: what
 * `onTurnSettled` leaves in the store, and no host left to act on it. A live
 * host would offer, and so redeem, the moment the child settled.
 */
async function processEndedBeforeTheOffer(item: Awaited<ReturnType<typeof childCreatedOverTheRelay>>) {
  await item.host.dispose()
  admitFinishedChild(item.store, item.subagentKey)
  item.store.close()
}

/** A new process over the same store, with its own connection to the plane. */
async function restarted(item: { storeRoot: string; plane: Awaited<ReturnType<typeof controlPlane>> }, options: Parameters<typeof wakeRuntime>[1] = {},
  host: Parameters<typeof hostOver>[4] = {}) {
  const store = reopened(item.storeRoot)
  const { policy, calls, attempts } = remotePolicy(item.plane.app)
  const execution = await wakeRuntime(store, options)
  const { prompts } = execution
  const { host: restartedHost } = hostOver(store, policy, execution, item.plane.relayKey.publicKey, host)
  return { store, host: restartedHost, calls, attempts, prompts }
}

const bearer = (token: string) => `Bearer ${token}`

test("a child created over a Relay Host Token takes its grant over the wire and records it beside the origin", async () => {
  const { seeded, authority, store, calls, subagentKey, grant, token, alice, aliceRuntime } = await childCreatedOverTheRelay()

  expect(calls).toEqual([
    { action: "write", authorization: bearer(token), grant: false, status: 200 },
    { action: "start", authorization: bearer(token), grant: false, status: 200 },
    { action: "turn_grant", authorization: bearer(token), grant: false, status: 200 },
    { action: "register", authorization: bearer(token), grant: false, status: 200 },
  ])
  expect(store.subagentOrigin(PARENT, subagentKey)).toEqual({
    provenance: "relay-replayed",
    actor: { actorId: alice.principal!.actorId, actorKind: "human", userId: alice.user.subject },
    authority: { managed: true, workspaceId: WORKSPACE, orgId: expect.any(String), role: "owner" },
    grant,
  })
  expect(decodeJwt(grant)).toMatchObject({
    actor_id: alice.principal!.actorId, session_id: PARENT, subject_session_id: CHILD, intent: "child_completion", turn_id_prefix: `msg_wake_${CHILD}_`,
  })
  expect(await grantRows(seeded)).toEqual([{
    grant_id: decodeJwt(grant).jti,
    actor_id: alice.principal!.actorId,
    session_id: PARENT,
    subject_session_id: CHILD,
    turn_id: null,
    turn_id_prefix: `msg_wake_${CHILD}_`,
    redeemed_turn_id: null,
    revoked_at: null,
  }])
  expect(JSON.stringify(store.listSubagents(PARENT))).not.toContain(grant)
  expect(store.listSubagents(PARENT)).toMatchObject([{ subagentKey, childSessionId: CHILD, status: "pending" }])
  await expect(authority.authorizeRuntimeSession({ ...aliceRuntime, sessionId: CHILD, workspaceId: WORKSPACE, action: "write" })).resolves.toBeUndefined()
})

test("a restarted host delivers the wake as the original actor by presenting the grant, with no bearer, over turn_acquire", async () => {
  const item = await childCreatedOverTheRelay()
  const { seeded, authority, alice } = item
  await processEndedBeforeTheOffer(item)
  const { store, host, calls, attempts, prompts } = await restarted(item)
  expect(store.subagentOrigin(PARENT, item.subagentKey)).toMatchObject({ actor: { actorId: alice.principal!.actorId }, grant: item.grant })

  await wake(host)
  await until(() => store.listSubagents(PARENT)[0]?.wake === "delivered" && calls.some((call) => call.action === "turn_release"), "the wake to be delivered and its lease released")

  expect(attempts).toEqual([{ actorId: alice.principal!.actorId, turnId: WAKE_TURN, grant: true }])
  expect(calls).toEqual([
    { action: "turn_acquire", authorization: null, grant: true, turnId: WAKE_TURN, status: 200 },
    { action: "turn_release", authorization: null, grant: false, turnId: WAKE_TURN, status: 200 },
  ])
  expect(prompts).toEqual([{ sessionId: PARENT, messageId: WAKE_TURN }])
  const admitted = await producers(seeded)
  expect(admitted).toMatchObject([{ session_id: PARENT, turn_id: WAKE_TURN, actor_id: alice.principal!.actorId }])
  expect(await grantRows(seeded)).toMatchObject([{ redeemed_turn_id: WAKE_TURN }])

  await expect(authority.syncSessionMessages(alice, {
    updatedAt: Date.now(),
    sessionId: PARENT,
    workspaceId: WORKSPACE,
    fencingToken: admitted[0].fencing_token,
    maxEventOrdinal: 1,
    messages: [{ id: WAKE_TURN, role: "user", sessionID: PARENT, parts: [{ type: "text", text: "Subagent finished." }] }],
  })).resolves.toMatchObject({ ok: true })
  expect(await seeded.prepare(`SELECT author_actor_id FROM session_messages WHERE message_id = ?`).bind(WAKE_TURN).first())
    .toEqual({ author_actor_id: alice.principal!.actorId })
})

test("a workspace deleted before delivery refuses the redemption at the authority: no prompt, no producer, grant unredeemed, wake pending", async () => {
  const item = await childCreatedOverTheRelay()
  const { seeded, authority, alice } = item
  await processEndedBeforeTheOffer(item)
  await authority.deleteWorkspace(alice, { workspaceId: WORKSPACE })
  const { store, host, calls, prompts } = await restarted(item)

  await wake(host)
  await until(() => calls.some((call) => call.action === "turn_acquire"), "the wake to present its grant")

  expect(calls).toEqual([{ action: "turn_acquire", authorization: null, grant: true, turnId: WAKE_TURN, status: 403, code: "workspace_authorization_denied" }])
  expect(prompts).toEqual([])
  expect(await producers(seeded)).toEqual([])
  expect(await grantRows(seeded)).toMatchObject([{ redeemed_turn_id: null, revoked_at: null }])
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])
})

test("a grant past its expiry is refused over the wire and the wake stays pending", async () => {
  const item = await childCreatedOverTheRelay()
  const { seeded } = item
  await processEndedBeforeTheOffer(item)
  const { store, host, calls, prompts } = await restarted(item)
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(decodeJwt(item.grant).exp! * 1_000 + 1_000)

  await wake(host)
  await until(() => calls.some((call) => call.action === "turn_acquire"), "the wake to present its grant")

  expect(calls).toEqual([{ action: "turn_acquire", authorization: null, grant: true, turnId: WAKE_TURN, status: 401, code: "session_turn_grant_expired" }])
  expect(prompts).toEqual([])
  expect(await producers(seeded)).toEqual([])
  expect(await grantRows(seeded)).toMatchObject([{ redeemed_turn_id: null }])
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])
})

test("a second result naming the delivered reply re-offers the redeemed wake turn, which is refused, and no second producer is written", async () => {
  const item = await childCreatedOverTheRelay()
  const { seeded } = item
  await processEndedBeforeTheOffer(item)
  const delivered = await restarted(item)
  await wake(delivered.host)
  await until(() => delivered.store.listSubagents(PARENT)[0]?.wake === "delivered" && delivered.calls.some((call) => call.action === "turn_release"), "the first delivery")
  await delivered.host.dispose()
  admitFinishedChild(delivered.store, item.subagentKey, "finished-again")
  delivered.store.close()
  const { store, host, calls, prompts } = await restarted(item)
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])

  await wake(host)
  await until(() => calls.some((call) => call.action === "turn_acquire"), "the re-offer to present its grant")

  expect(calls).toEqual([{ action: "turn_acquire", authorization: null, grant: true, turnId: WAKE_TURN, status: 401, code: "session_turn_grant_redeemed" }])
  expect(prompts).toEqual([])
  expect(await producers(seeded)).toHaveLength(1)
  expect(await grantRows(seeded)).toMatchObject([{ redeemed_turn_id: WAKE_TURN }])
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])
})

test("a wake whose delivery receipt was lost is re-offered after a restart and refused as redeemed, with no second prompt or producer", async () => {
  const item = await childCreatedOverTheRelay()
  const { seeded } = item
  await processEndedBeforeTheOffer(item)
  const delivering = await restarted(item, {}, { endsBeforeReceipt: true })
  await wake(delivering.host)
  await until(() => delivering.calls.some((call) => call.action === "turn_release"), "the first delivery")
  expect(delivering.prompts).toEqual([{ sessionId: PARENT, messageId: WAKE_TURN }])
  expect(delivering.store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])
  await delivering.host.dispose()
  delivering.store.close()
  const { store, host, calls, prompts } = await restarted(item)

  await wake(host)
  await until(() => calls.some((call) => call.action === "turn_acquire"), "the re-offer to present its grant")

  expect(calls).toEqual([{ action: "turn_acquire", authorization: null, grant: true, turnId: WAKE_TURN, status: 401, code: "session_turn_grant_redeemed" }])
  expect(prompts).toEqual([])
  expect(await producers(seeded)).toHaveLength(1)
  expect(await grantRows(seeded)).toMatchObject([{ redeemed_turn_id: WAKE_TURN }])
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])
})

test("a legacy row recorded without a grant never reaches the authority, and never runs as the workspace owner", async () => {
  const { root, authority, seeded, bob, aliceRuntime, orgId } = await seedWakeWorkspace("send")
  await reserveChild(authority, aliceRuntime)
  await registerChild(authority, aliceRuntime)
  const plane = await controlPlane(authority)
  const storeRoot = await seedFinishedChildStore(root, { actorId: bob.principal!.actorId, orgId })
  const { store, host, calls, attempts, prompts } = await restarted({ storeRoot, plane })
  expect(store.subagentOrigin(PARENT, "subagent_wake")).not.toHaveProperty("grant")

  await wake(host)
  await new Promise((resolve) => setTimeout(resolve, 100))

  expect(attempts).toEqual([])
  expect(calls).toEqual([])
  expect(prompts).toEqual([])
  expect(await producers(seeded)).toEqual([])
  expect(await grantRows(seeded)).toEqual([])
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])
})

test("a prompt queued over the relay mints a grant for its message id, survives a restart, and is delivered as its requester through that grant", async () => {
  const { root, authority, seeded, alice, orgId } = await seedWakeWorkspace("send")
  await authority.recordRuntimeAccessToken(alice, {
    jti: RAT, workspaceId: WORKSPACE, hostId: HOST, actorId: alice.principal!.actorId, actorKind: "human", role: "owner", expiresAt: Date.now() + 60 * 60_000,
  })
  const plane = await controlPlane(authority)
  const storeRoot = runtimeStoreRoot(root)
  const store = openRuntimeStore(storeRoot)
  lifecycle.closer(() => store.close())
  const busy = remotePolicy(plane.app)
  const busyRuntime = await wakeRuntime(store, { holdParent: true })
  const first = hostOver(store, busy.policy, busyRuntime, plane.relayKey.publicKey)
  const token = await relayProof(plane.relayKey.privateKey, alice, orgId, "rht_alice_queue")

  const queued = await first.ingress.request(
    `http://localhost/session/${PARENT}/message?directory=${encodeURIComponent(DIRECTORY)}`,
    relayed(token, { messageID: "msg_queued_1", parts: [{ type: "text", text: "then run the tests" }], delivery: "queue" }),
  )
  expect(queued.status, await queued.clone().text()).toBe(202)
  expect(await queued.json()).toEqual({ delivery: "queue", messageID: "msg_queued_1" })
  expect(busy.calls).toEqual([
    { action: "write", authorization: bearer(token), grant: false, status: 200 },
    { action: "turn_grant", authorization: bearer(token), grant: false, turnId: "msg_queued_1", status: 200 },
  ])
  const [row] = store.deliveryQueue.listQueuedPrompts()
  expect(row).toMatchObject({ sessionId: PARENT, messageId: "msg_queued_1", provenance: "relay-replayed", actor: { actorId: alice.principal!.actorId, actorKind: "human" } })
  const grant = row.grant
  if (!grant) throw new Error("The queue recorded no grant beside the row")
  expect(decodeJwt(grant)).toMatchObject({ actor_id: alice.principal!.actorId, session_id: PARENT, intent: "queued_prompt", turn_id: "msg_queued_1" })
  expect(await grantRows(seeded)).toMatchObject([{ grant_id: decodeJwt(grant).jti, actor_id: alice.principal!.actorId, turn_id: "msg_queued_1", redeemed_turn_id: null }])
  expect(busyRuntime.prompts).toEqual([])
  await first.host.dispose()
  store.close()

  const { store: recovered, host, calls, attempts, prompts } = await restarted({ storeRoot, plane })
  expect(recovered.deliveryQueue.listQueuedPrompts()).toMatchObject([{ messageId: "msg_queued_1", grant }])
  await host.recoverQueuedPrompts()
  await until(() => recovered.deliveryQueue.listQueuedPrompts().length === 0 && calls.some((call) => call.action === "turn_release"), "the recovered prompt to be delivered and its lease released")

  expect(attempts).toEqual([{ actorId: alice.principal!.actorId, turnId: "msg_queued_1", grant: true }])
  expect(calls).toEqual([
    { action: "turn_acquire", authorization: null, grant: true, turnId: "msg_queued_1", status: 200 },
    { action: "turn_release", authorization: null, grant: false, turnId: "msg_queued_1", status: 200 },
  ])
  expect(prompts).toEqual([{ sessionId: PARENT, messageId: "msg_queued_1" }])
  expect(await producers(seeded)).toMatchObject([{ session_id: PARENT, turn_id: "msg_queued_1", actor_id: alice.principal!.actorId }])
  expect(await grantRows(seeded)).toMatchObject([{ redeemed_turn_id: "msg_queued_1" }])
})
