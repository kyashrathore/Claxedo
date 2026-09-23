import path from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { Hono } from "hono"
import Database from "better-sqlite3"
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { RuntimeStore } from "../../../../workspace-runtime/src/store"
import { SessionRoutes } from "../../../../workspace-runtime/src/routes/session"
import { remoteWorkspaceSessionAccessPolicy } from "../../../../workspace-runtime/src/remote-session-authority"
import { createRelayHostAuthMiddleware } from "../../../../workspace-runtime/src/workspace-host-service-auth"
import type { SessionAccessPolicy } from "../../../../workspace-runtime/src/session-access-policy"
import type { SessionDeliveryStore } from "../../../../workspace-runtime/src/session/delivery-owner"
import { RuntimeSessionAuthorityRoutes } from "../../routes/runtime-session-authority"
import { fetchJsonBody, fetchUrl } from "../../test-support/fetch-calls"
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
  hostRuntimeDouble,
  lifecycle,
  producers,
  registerChild,
  reopened,
  reserveChild,
  runtimeStoreRoot,
  seedFinishedChildStore,
  seedWakeWorkspace,
  setShare,
  storeBackedHostOptions,
  until,
  wake,
  type HostRuntime,
  type WakeAuthority,
} from "../../test-support/child-wake-fixture"

/**
 * The remote half of the embedded suite next door: the same child-completion
 * wake and the same recovered queued prompt, on a host whose only authority
 * is `RuntimeSessionAuthorityRoutes` at the other end of a fetch. Nothing is
 * decided in process. The request that creates the child, or queues the
 * prompt, arrives through the relay ingress with Bob's Relay Host Token and
 * mints a grant while that token can still prove the parent turn; the host
 * that later delivers the turn has been restarted, holds only the store, and
 * presents that grant in place of a credential it no longer has.
 */

const RAT = "rat_bob"
const AUTHORITY_URL = "https://control.test/api/runtime-authority/session-authorize"
const CONFIG = { harness: { id: "codex" as const, access: "native" as const }, variant: null, agent: null }

type HostAdapter = Awaited<ReturnType<Parameters<typeof SessionRoutes>[0]>>
type AuthorityCall = { action: string; authorization: string | null; grant: boolean; turnId?: string; status: number; code?: string }
type TurnAttempt = { actorId?: string; turnId: string; grant: boolean }

afterEach(async () => {
  vi.useRealTimers()
  await lifecycle.cleanup()
})

/** The control plane: the authority routes over the real SQLite authority, signing with its own runtime key. */
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

async function relayProof(relayKey: CryptoKey, bob: SignedControlPlaneAuth, orgId: string, jti: string) {
  return await mintRelayHostToken({
    principalKind: "user",
    actorId: bob.user.tokenIdentifier,
    actorKind: "human",
    orgId,
    workspaceId: WORKSPACE,
    hostId: HOST,
    role: "editor",
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

function queuedPromptStore(store: RuntimeStore): SessionDeliveryStore {
  return {
    queuePrompt: (input) => store.queuePrompt(input),
    deleteQueuedPrompt: (sessionId, seq) => store.deleteQueuedPrompt(sessionId, seq),
    replaceQueuedPromptParts: (sessionId, seq, parts) => store.replaceQueuedPromptParts(sessionId, seq, parts),
    listQueuedPrompts: () => store.listQueuedPrompts(),
    claimQueuedPromptDelivery: (sessionId, seq, operationId, mode) => store.claimQueuedPromptDelivery(sessionId, seq, operationId, mode),
    settleQueuedPromptDelivery: (sessionId, seq, steering) => store.settleQueuedPromptDelivery(sessionId, seq, steering),
    setQueuedPromptHeld: (sessionId, seq, held) => store.setQueuedPromptHeld(sessionId, seq, held),
    completeQueuedPrompt: (sessionId, seq, operationId) => store.completeQueuedPrompt(sessionId, seq, operationId),
    sessionDirectory: (sessionId) => store.getSession(sessionId)?.directory,
  }
}

const adapter = { instructionChannel: "turn-system-prompt", deleteSession: async () => {} } as Pick<HostAdapter, "instructionChannel" | "deleteSession">

/**
 * A host over the store behind the relay ingress. The same shape serves a
 * fresh process: it keeps nothing but the store, so what it delivers after a
 * restart is what the store says.
 */
function hostOver(store: RuntimeStore, policy: SessionAccessPolicy, runtime: HostRuntime, relayKey: CryptoKey) {
  const host = SessionRoutes(() => adapter as HostAdapter, {
    sessionAccessPolicy: policy,
    resolveRuntime: () => runtime,
    resolveExecutionBinding: ({ sessionId, directory }) => ({ workspaceId: WORKSPACE, directory, sessionId, connectionId: "connection_wake", upstreamSessionId: sessionId }),
    createSession: async (_c, directory, title, id, create) => {
      if (!id) throw new Error("A managed create carries the id its reservation named")
      store.bindSession({
        sessionId: id,
        directory,
        agentSessionId: id,
        ...(title ? { title } : {}),
        ...(create?.parentID ? { parentSessionId: create.parentID } : {}),
      })
      return { id }
    },
    getSessionConfig: async () => CONFIG,
    queuedPrompts: () => queuedPromptStore(store),
    ...storeBackedHostOptions(store),
  })
  lifecycle.host(() => host.dispose())
  const ingress = new Hono()
    .use("*", createRelayHostAuthMiddleware({ key: relayKey, workspaceId: WORKSPACE, hostId: HOST }))
    .route("/", host.routes)
  return { host, ingress }
}

/**
 * Bob, a `send` grantee on Alice's parent, creates a child under it through
 * the relay: the reservation he took on the plane, then the runtime's create
 * with his live Relay Host Token, every authority decision over the wire.
 */
async function childCreatedOverTheRelay(parentShare: "follow" | "send" = "send") {
  const workspace = await seedWakeWorkspace(parentShare)
  const { root, authority, bob, bobRuntime, orgId } = workspace
  await authority.recordRuntimeAccessToken(bob, {
    jti: RAT, workspaceId: WORKSPACE, hostId: HOST, actorId: bob.user.tokenIdentifier, actorKind: "human", role: "editor", expiresAt: Date.now() + 60 * 60_000,
  })
  await reserveChild(authority, bobRuntime)
  const plane = await controlPlane(authority)
  const storeRoot = runtimeStoreRoot(root)
  const store = new RuntimeStore(storeRoot)
  lifecycle.closer(() => store.close())
  store.bindSession({ sessionId: PARENT, directory: DIRECTORY, agentSessionId: PARENT })
  const { policy, calls } = remotePolicy(plane.app)
  const { runtime, prompts } = hostRuntimeDouble()
  const { host, ingress } = hostOver(store, policy, runtime, plane.relayKey.publicKey)
  const token = await relayProof(plane.relayKey.privateKey, bob, orgId, "rht_bob_create")

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
function restarted(item: { storeRoot: string; plane: Awaited<ReturnType<typeof controlPlane>> }, options: Parameters<typeof hostRuntimeDouble>[0] = {}) {
  const store = reopened(item.storeRoot)
  const { policy, calls, attempts } = remotePolicy(item.plane.app)
  const { runtime, prompts } = hostRuntimeDouble(options)
  const { host } = hostOver(store, policy, runtime, item.plane.relayKey.publicKey)
  return { store, host, calls, attempts, prompts }
}

function resetWake(storeRoot: string, subagentKey: string) {
  const db = new Database(path.join(storeRoot, "state.db"))
  try {
    const reset = db.prepare(`UPDATE session_subagent SET wake = 'pending' WHERE parent_session_id = ? AND subagent_key = ?`).run(PARENT, subagentKey)
    expect(reset.changes).toBe(1)
  } finally {
    db.close()
  }
}

const bearer = (token: string) => `Bearer ${token}`

test("a child created over a Relay Host Token by a send grantee takes its grant over the wire and records it beside the origin", async () => {
  const { seeded, authority, store, calls, subagentKey, grant, token, bob, bobRuntime } = await childCreatedOverTheRelay()

  expect(calls).toEqual([
    { action: "write", authorization: bearer(token), grant: false, status: 200 },
    { action: "start", authorization: bearer(token), grant: false, status: 200 },
    { action: "turn_grant", authorization: bearer(token), grant: false, status: 200 },
    { action: "register", authorization: bearer(token), grant: false, status: 200 },
  ])
  expect(store.subagentOrigin(PARENT, subagentKey)).toEqual({
    provenance: "relay-replayed",
    actor: { actorId: bob.user.tokenIdentifier, actorKind: "human" },
    authority: { managed: true, workspaceId: WORKSPACE, orgId: expect.any(String), role: "editor" },
    grant,
  })
  expect(decodeJwt(grant)).toMatchObject({
    actor_id: bob.user.tokenIdentifier, session_id: PARENT, subject_session_id: CHILD, intent: "child_completion", turn_id_prefix: `msg_wake_${CHILD}_`,
  })
  expect(grantRows(seeded)).toEqual([{
    grant_id: decodeJwt(grant).jti,
    actor_id: bob.user.tokenIdentifier,
    session_id: PARENT,
    subject_session_id: CHILD,
    turn_id: null,
    turn_id_prefix: `msg_wake_${CHILD}_`,
    redeemed_turn_id: null,
    revoked_at: null,
  }])
  expect(JSON.stringify(store.listSubagents(PARENT))).not.toContain(grant)
  expect(store.listSubagents(PARENT)).toMatchObject([{ subagentKey, childSessionId: CHILD, status: "pending" }])
  await expect(authority.authorizeRuntimeSession({ ...bobRuntime, sessionId: CHILD, workspaceId: WORKSPACE, action: "write" })).resolves.toBeUndefined()
})

test("a restarted host delivers the wake as the original actor by presenting the grant, with no bearer, over turn_acquire", async () => {
  const item = await childCreatedOverTheRelay()
  const { seeded, authority, alice, bob } = item
  await processEndedBeforeTheOffer(item)
  const { store, host, calls, attempts, prompts } = restarted(item)
  expect(store.subagentOrigin(PARENT, item.subagentKey)).toMatchObject({ actor: { actorId: bob.user.tokenIdentifier }, grant: item.grant })

  await wake(host)
  await until(() => store.listSubagents(PARENT)[0]?.wake === "delivered" && calls.some((call) => call.action === "turn_release"), "the wake to be delivered and its lease released")

  expect(attempts).toEqual([{ actorId: bob.user.tokenIdentifier, turnId: WAKE_TURN, grant: true }])
  expect(calls).toEqual([
    { action: "turn_acquire", authorization: null, grant: true, turnId: WAKE_TURN, status: 200 },
    { action: "turn_release", authorization: null, grant: false, turnId: WAKE_TURN, status: 200 },
  ])
  expect(prompts).toEqual([{ sessionId: PARENT, messageId: WAKE_TURN }])
  const admitted = producers(seeded)
  expect(admitted).toMatchObject([{ session_id: PARENT, turn_id: WAKE_TURN, actor_id: bob.user.tokenIdentifier }])
  expect(grantRows(seeded)).toMatchObject([{ redeemed_turn_id: WAKE_TURN }])

  await expect(authority.syncSessionMessages(alice, {
    sessionId: PARENT,
    workspaceId: WORKSPACE,
    fencingToken: admitted[0].fencing_token,
    maxEventOrdinal: 1,
    messages: [{ id: WAKE_TURN, role: "user", sessionID: PARENT, parts: [{ type: "text", text: "Subagent finished." }] }],
  })).resolves.toMatchObject({ ok: true })
  expect(seeded().prepare(`SELECT author_actor_id FROM session_messages WHERE message_id = ?`).get(WAKE_TURN))
    .toEqual({ author_actor_id: bob.user.tokenIdentifier })
})

test("a parent share revoked before delivery refuses the redemption at the authority: no prompt, no producer, grant unredeemed, wake pending", async () => {
  const item = await childCreatedOverTheRelay()
  const { seeded, authority, alice, bob } = item
  await processEndedBeforeTheOffer(item)
  await setShare(authority, alice, bob, null)
  const { store, host, calls, prompts } = restarted(item)

  await wake(host)
  await until(() => calls.some((call) => call.action === "turn_acquire"), "the wake to present its grant")

  expect(calls).toEqual([{ action: "turn_acquire", authorization: null, grant: true, turnId: WAKE_TURN, status: 403, code: "workspace_authorization_denied" }])
  expect(prompts).toEqual([])
  expect(producers(seeded)).toEqual([])
  expect(grantRows(seeded)).toMatchObject([{ redeemed_turn_id: null, revoked_at: null }])
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])
})

test("a grant past its expiry is refused over the wire and the wake stays pending", async () => {
  const item = await childCreatedOverTheRelay()
  const { seeded } = item
  await processEndedBeforeTheOffer(item)
  const { store, host, calls, prompts } = restarted(item)
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(decodeJwt(item.grant).exp! * 1_000 + 1_000)

  await wake(host)
  await until(() => calls.some((call) => call.action === "turn_acquire"), "the wake to present its grant")

  expect(calls).toEqual([{ action: "turn_acquire", authorization: null, grant: true, turnId: WAKE_TURN, status: 401, code: "session_turn_grant_expired" }])
  expect(prompts).toEqual([])
  expect(producers(seeded)).toEqual([])
  expect(grantRows(seeded)).toMatchObject([{ redeemed_turn_id: null }])
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])
})

test("the same wake re-offered after delivery is refused as redeemed, and no second producer is written", async () => {
  const item = await childCreatedOverTheRelay()
  const { seeded } = item
  await processEndedBeforeTheOffer(item)
  const delivered = restarted(item)
  await wake(delivered.host)
  await until(() => delivered.store.listSubagents(PARENT)[0]?.wake === "delivered" && delivered.calls.some((call) => call.action === "turn_release"), "the first delivery")
  await delivered.host.dispose()
  delivered.store.close()
  resetWake(item.storeRoot, item.subagentKey)
  const { store, host, calls, prompts } = restarted(item)
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])

  await wake(host)
  await until(() => calls.some((call) => call.action === "turn_acquire"), "the re-offer to present its grant")

  expect(calls).toEqual([{ action: "turn_acquire", authorization: null, grant: true, turnId: WAKE_TURN, status: 401, code: "session_turn_grant_redeemed" }])
  expect(prompts).toEqual([])
  expect(producers(seeded)).toHaveLength(1)
  expect(grantRows(seeded)).toMatchObject([{ redeemed_turn_id: WAKE_TURN }])
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])
})

test("a legacy row recorded without a grant never reaches the authority, and never runs as the workspace owner", async () => {
  const { root, authority, seeded, bob, bobRuntime, orgId } = await seedWakeWorkspace("send")
  await reserveChild(authority, bobRuntime)
  await registerChild(authority, bobRuntime)
  const plane = await controlPlane(authority)
  const storeRoot = seedFinishedChildStore(root, { actorId: bob.user.tokenIdentifier, orgId })
  const { store, host, calls, attempts, prompts } = restarted({ storeRoot, plane })
  expect(store.subagentOrigin(PARENT, "subagent_wake")).not.toHaveProperty("grant")

  await wake(host)
  await new Promise((resolve) => setTimeout(resolve, 100))

  expect(attempts).toEqual([])
  expect(calls).toEqual([])
  expect(prompts).toEqual([])
  expect(producers(seeded)).toEqual([])
  expect(grantRows(seeded)).toEqual([])
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])
})

test("a prompt queued over the relay mints a grant for its message id, survives a restart, and is delivered as its requester through that grant", async () => {
  const { root, authority, seeded, bob, orgId } = await seedWakeWorkspace("send")
  await authority.recordRuntimeAccessToken(bob, {
    jti: RAT, workspaceId: WORKSPACE, hostId: HOST, actorId: bob.user.tokenIdentifier, actorKind: "human", role: "editor", expiresAt: Date.now() + 60 * 60_000,
  })
  const plane = await controlPlane(authority)
  const storeRoot = runtimeStoreRoot(root)
  const store = new RuntimeStore(storeRoot)
  lifecycle.closer(() => store.close())
  store.bindSession({ sessionId: PARENT, directory: DIRECTORY, agentSessionId: PARENT })
  const busy = remotePolicy(plane.app)
  const busyRuntime = hostRuntimeDouble({ whenIdle: () => new Promise(() => {}) })
  const first = hostOver(store, busy.policy, busyRuntime.runtime, plane.relayKey.publicKey)
  const token = await relayProof(plane.relayKey.privateKey, bob, orgId, "rht_bob_queue")

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
  const [row] = store.listQueuedPrompts()
  expect(row).toMatchObject({ sessionId: PARENT, messageId: "msg_queued_1", provenance: "relay-replayed", actor: { actorId: bob.user.tokenIdentifier, actorKind: "human" } })
  const grant = row.grant
  if (!grant) throw new Error("The queue recorded no grant beside the row")
  expect(decodeJwt(grant)).toMatchObject({ actor_id: bob.user.tokenIdentifier, session_id: PARENT, intent: "queued_prompt", turn_id: "msg_queued_1" })
  expect(grantRows(seeded)).toMatchObject([{ grant_id: decodeJwt(grant).jti, actor_id: bob.user.tokenIdentifier, turn_id: "msg_queued_1", redeemed_turn_id: null }])
  expect(busyRuntime.prompts).toEqual([])
  await first.host.dispose()
  store.close()

  const { store: recovered, host, calls, attempts, prompts } = restarted({ storeRoot, plane })
  expect(recovered.listQueuedPrompts()).toMatchObject([{ messageId: "msg_queued_1", grant }])
  await host.recoverQueuedPrompts()
  await until(() => recovered.listQueuedPrompts().length === 0 && calls.some((call) => call.action === "turn_release"), "the recovered prompt to be delivered and its lease released")

  expect(attempts).toEqual([{ actorId: bob.user.tokenIdentifier, turnId: "msg_queued_1", grant: true }])
  expect(calls).toEqual([
    { action: "turn_acquire", authorization: null, grant: true, turnId: "msg_queued_1", status: 200 },
    { action: "turn_release", authorization: null, grant: false, turnId: "msg_queued_1", status: 200 },
  ])
  expect(prompts).toEqual([{ sessionId: PARENT, messageId: "msg_queued_1" }])
  expect(producers(seeded)).toMatchObject([{ session_id: PARENT, turn_id: "msg_queued_1", actor_id: bob.user.tokenIdentifier }])
  expect(grantRows(seeded)).toMatchObject([{ redeemed_turn_id: "msg_queued_1" }])
})
