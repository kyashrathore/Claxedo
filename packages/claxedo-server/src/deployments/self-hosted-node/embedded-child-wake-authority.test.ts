import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { PrivateSessionRuntimePrincipal } from "@claxedo/server-core/platform/auth/private-session-authority"
import type { RuntimeStore } from "../../../../workspace-runtime/src/store"
import { SessionRoutes } from "../../../../workspace-runtime/src/routes/session"
import { deferredTurnGrantClaims, mintDeferredTurnGrant } from "../../session/deferred-turn-grant"
import {
  CHILD,
  CHILD_OPERATION,
  PARENT,
  WAKE_TURN,
  WORKSPACE,
  hostRuntimeDouble,
  lifecycle,
  producers,
  registerChild,
  reopened,
  reserveChild,
  seedFinishedChildStore,
  seedWakeWorkspace,
  setShare,
  storeBackedHostOptions,
  wake,
  type WakeAuthority,
} from "../../test-support/child-wake-fixture"
import { embeddedManagedPrivateSessionPolicy } from "./app"

/**
 * A child's completion wake, end to end against the authority that decides it.
 *
 * The wake is a turn on the parent, started by the runtime long after the
 * request that created the child returned, and after a restart with nothing
 * left in memory. What it runs as comes back out of the runtime store — the
 * actor and the deferred grant the create minted while that request could
 * still prove the parent turn — and the authority re-decides it then: a share
 * revoked in between is what stops the child's text from reaching the parent,
 * and the turn the authority does admit is the producer row the parent's
 * transcript is resolved against.
 */

const previousKeys = {
  privateKey: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM,
  publicKey: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM,
}

beforeAll(async () => {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = await exportPKCS8(key.privateKey)
  process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = await exportSPKI(key.publicKey)
})

afterAll(() => {
  for (const [name, value] of [
    ["CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM", previousKeys.privateKey],
    ["CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM", previousKeys.publicKey],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

afterEach(() => lifecycle.cleanup())

/**
 * The state the create route leaves behind once P-92's parent-turn admission
 * has passed: Bob's child reserved and registered under Alice's parent.
 */
async function seed(parentShare: "follow" | "send") {
  const workspace = await seedWakeWorkspace(parentShare)
  await reserveChild(workspace.authority, workspace.bobRuntime)
  await registerChild(workspace.authority, workspace.bobRuntime)
  return workspace
}

/**
 * The grant the create route minted for Bob's child while his request could
 * still prove `agent_turn` on the parent — the same row and token the embedded
 * policy's `grantTurn` produces.
 */
async function childWakeGrant(authority: WakeAuthority, bobRuntime: PrivateSessionRuntimePrincipal, orgId: string) {
  const granted = await authority.grantSessionTurn({
    ...bobRuntime,
    sessionId: PARENT,
    workspaceId: WORKSPACE,
    intent: "child_completion",
    subjectSessionId: CHILD,
    registrationOperationId: CHILD_OPERATION,
  })
  return (await mintDeferredTurnGrant(deferredTurnGrantClaims(bobRuntime, orgId, granted), process.env)).grant
}

/**
 * A restarted host over that store: nothing in memory, so the wake it re-offers
 * on its first request carries only what the store kept.
 */
function restartedHost(store: RuntimeStore, authority: unknown) {
  const { runtime, prompts } = hostRuntimeDouble()
  const host = SessionRoutes(() => ({}) as never, {
    sessionAccessPolicy: embeddedManagedPrivateSessionPolicy(authority as never),
    resolveRuntime: () => runtime,
    ...storeBackedHostOptions(store),
  })
  lifecycle.host(() => host.dispose())
  return { host, prompts }
}

test("a wake recovered after restart redeems the grant its create minted, runs as that actor, and its transcript resolves to that actor", async () => {
  const { root, authority, seeded, alice, bob, bobRuntime, orgId } = await seed("send")
  const grant = await childWakeGrant(authority, bobRuntime, orgId)
  const storeRoot = seedFinishedChildStore(root, { actorId: bob.user.tokenIdentifier, orgId, grant })
  const store = reopened(storeRoot)
  expect(store.subagentOrigin(PARENT, "subagent_wake")).toMatchObject({ actor: { actorId: bob.user.tokenIdentifier }, grant })
  const { host, prompts } = restartedHost(store, authority)

  await wake(host)

  expect(prompts).toEqual([{ sessionId: PARENT, messageId: WAKE_TURN }])
  const admitted = producers(seeded)
  expect(admitted).toMatchObject([{ session_id: PARENT, turn_id: WAKE_TURN, actor_id: bob.user.tokenIdentifier }])
  expect(seeded().prepare(`SELECT redeemed_turn_id FROM session_turn_grants`).all()).toEqual([{ redeemed_turn_id: WAKE_TURN }])
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "delivered" }])

  // The durable transcript only accepts a user message the authority admitted
  // a producer for, and attributes it to that producer rather than to whoever
  // is syncing.
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

test("a wake whose actor lost the parent share after the grant was minted is refused, leaving no prompt and no producer", async () => {
  const { root, authority, seeded, alice, bob, bobRuntime, orgId } = await seed("send")
  const grant = await childWakeGrant(authority, bobRuntime, orgId)
  const storeRoot = seedFinishedChildStore(root, { actorId: bob.user.tokenIdentifier, orgId, grant })
  await setShare(authority, alice, bob, null)
  const store = reopened(storeRoot)
  const { host, prompts } = restartedHost(store, authority)

  await wake(host)

  expect(prompts).toEqual([])
  expect(producers(seeded)).toEqual([])
  expect(seeded().prepare(`SELECT redeemed_turn_id FROM session_turn_grants`).all()).toEqual([{ redeemed_turn_id: null }])
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])
})

test("a recorded origin without a grant is refused rather than re-authorized from the stored actor, and stays pending", async () => {
  const { root, authority, seeded, bob, orgId } = await seed("send")
  const store = reopened(seedFinishedChildStore(root, { actorId: bob.user.tokenIdentifier, orgId }))
  expect(store.subagentOrigin(PARENT, "subagent_wake")).not.toHaveProperty("grant")
  const { host, prompts } = restartedHost(store, authority)

  await wake(host)

  expect(prompts).toEqual([])
  expect(producers(seeded)).toEqual([])
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])
})

test("a wake with no recorded origin is refused rather than run as the workspace's owner", async () => {
  const { root, authority, seeded } = await seed("send")
  const store = reopened(seedFinishedChildStore(root))
  expect(store.subagentOrigin(PARENT, "subagent_wake")).toBeUndefined()
  const { host, prompts } = restartedHost(store, authority)

  await wake(host)

  expect(prompts).toEqual([])
  expect(producers(seeded)).toEqual([])
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])
})
