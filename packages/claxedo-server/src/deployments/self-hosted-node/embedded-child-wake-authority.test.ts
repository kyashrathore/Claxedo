import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type Database from "better-sqlite3"
import { afterEach, expect, test } from "vitest"
import { createSqliteWorkspaceAuthority } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority"
import { openAuthorityDb } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { RuntimeStore } from "../../../../workspace-runtime/src/store"
import { SessionRoutes } from "../../../../workspace-runtime/src/routes/session"
import { embeddedManagedPrivateSessionPolicy } from "./app"

/**
 * A child's completion wake, end to end against the authority that decides it.
 *
 * The wake is a turn on the parent, started by the runtime long after the
 * request that created the child returned, and after a restart with nothing
 * left in memory. What it runs as comes back out of the runtime store, and the
 * authority re-decides it then: a grant revoked in between is what stops the
 * child's text from reaching the parent, and the turn the authority does admit
 * is the producer row the parent's transcript is resolved against.
 */

const DIRECTORY = "/workspace"
const WORKSPACE = "workspace_wake"
const PARENT = "ses_wake_parent"
const CHILD = "ses_wake_child"
const REPLY = "msg_child_reply"
const WAKE_TURN = `msg_wake_${CHILD}_${REPLY}`

/**
 * Shutdown order is the test's own correctness: a host disposed after its
 * store is closed finishes its in-flight turn against a closed database, which
 * surfaces as an unhandled error rather than a failure. Hosts first, awaited,
 * then stores, then the authority.
 */
const hosts: Array<() => Promise<void>> = []
const closers: Array<() => void> = []
const directories: string[] = []

afterEach(async () => {
  for (const dispose of hosts.splice(0)) await dispose()
  for (const close of closers.splice(0)) close()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function signed(subject: string): SignedControlPlaneAuth {
  return {
    mode: "signed",
    token: `token_${subject}`,
    user: { subject, tokenIdentifier: `https://idp.example|${subject}`, issuer: "https://idp.example" },
  }
}

/**
 * Alice's workspace, Bob a member of it, Alice's private parent session, and a
 * child Bob reserved and registered under it — the state the create route
 * leaves behind once P-92's parent-turn admission has passed.
 */
async function seed(parentShare: "follow" | "send") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-child-wake-"))
  directories.push(root)
  const databasePath = path.join(root, "authority.db")
  const authority = createSqliteWorkspaceAuthority({ path: databasePath })
  const seeded = openAuthorityDb({ path: databasePath })
  closers.push(() => authority.close(), () => seeded.close())
  const alice = signed("alice")
  const bob = signed("bob")
  await authority.usersMe(bob)
  await authority.createCloudWorkspace(alice, { workspaceId: WORKSPACE, displayName: "Wake" })
  const opened = await authority.openWorkspace(alice, { workspaceId: WORKSPACE })
  const orgId = opened.workspace!.org_id!
  member(seeded, orgId, opened.workspace!.project_id!, bob.user.tokenIdentifier)

  const aliceRuntime = { principalKind: "user" as const, actorId: alice.user.tokenIdentifier, actorKind: "human" as const }
  const bobRuntime = { principalKind: "user" as const, actorId: bob.user.tokenIdentifier, actorKind: "human" as const }
  await authority.reserveSession(alice, { operationId: "op_parent", sessionId: PARENT, workspaceId: WORKSPACE, kind: "create" })
  await authority.registerRuntimeSession({ ...aliceRuntime, operationId: "op_parent", sessionId: PARENT, workspaceId: WORKSPACE })
  await setShare(authority, alice, bob, parentShare)
  await authority.reserveRuntimeSession(bobRuntime, {
    operationId: "op_child", sessionId: CHILD, workspaceId: WORKSPACE, kind: "fork", parentSessionId: PARENT,
  })
  await authority.registerRuntimeSession({ ...bobRuntime, operationId: "op_child", sessionId: CHILD, workspaceId: WORKSPACE })
  return { root, authority, seeded, alice, bob, orgId }
}

function member(seeded: () => Database.Database, orgId: string, projectId: string, tokenIdentifier: string) {
  const db = seeded()
  db.prepare(`INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at) VALUES (?, ?, 'member', 1, 1)`)
    .run(orgId, tokenIdentifier)
  db.prepare(`INSERT INTO project_memberships (project_id, token_identifier, role, created_at, updated_at) VALUES (?, ?, 'editor', 1, 1)`)
    .run(projectId, tokenIdentifier)
}

async function setShare(
  authority: Awaited<ReturnType<typeof createSqliteWorkspaceAuthority>>,
  alice: SignedControlPlaneAuth,
  bob: SignedControlPlaneAuth,
  level: "follow" | "send" | null,
) {
  const target = { sessionId: PARENT, workspaceId: WORKSPACE, grantedToTokenIdentifier: bob.user.tokenIdentifier }
  if (level) await authority.grantSessionShare!(alice, { ...target, level })
  else await authority.revokeSessionShare!(alice, target)
}

/**
 * The runtime store as the create route leaves it: both sessions bound, the
 * child admitted under the parent, finished, its wake pending, and Bob
 * recorded as the identity the wake is to run as.
 */
function runtimeStore(root: string, origin?: { actorId: string; orgId: string }) {
  const store = new RuntimeStore(path.join(root, "runtime"))
  store.bindSession({ sessionId: PARENT, directory: DIRECTORY, agentSessionId: PARENT })
  store.bindSession({ sessionId: CHILD, directory: DIRECTORY, agentSessionId: CHILD, parentSessionId: PARENT })
  for (const [observationId, observation] of [
    ["create", { status: "pending", mode: "background", providerKind: "claxedo", providerId: CHILD, childSessionId: CHILD, transcript: { kind: "live" } }],
    ["finished", { status: "completed", wake: "pending" }],
  ] as const) {
    store.admit({ parentSessionId: PARENT, observation: { observationId, subagentKey: "subagent_wake", ...observation }, allocateKey: () => "unused" })
    store.markPublished(PARENT, observationId)
  }
  if (origin) {
    store.recordSubagentOrigin(PARENT, "subagent_wake", {
      provenance: "relay-replayed",
      actor: { actorId: origin.actorId, actorKind: "human" },
      authority: { managed: true, workspaceId: WORKSPACE, orgId: origin.orgId, role: "editor" },
    })
  }
  store.close()
  return path.join(root, "runtime")
}

/** The store as a restarted process finds it: reopened from disk, nothing carried over. */
function reopened(storeRoot: string) {
  const store = new RuntimeStore(storeRoot)
  closers.push(() => store.close())
  return store
}

/**
 * A restarted host over that store: nothing in memory, so the wake it re-offers
 * on its first request carries only what the store kept.
 */
function restartedHost(store: RuntimeStore, authority: unknown) {
  const prompts: Array<{ sessionId: string; messageId?: string }> = []
  const runtime = {
    turns: {
      whenIdle: async () => ({ abandon() {} }),
      abort: async () => {},
      start: async (input: { sessionId: string; messageId: string; parts: unknown[]; onAdmitted?: () => void }) => {
        prompts.push({ sessionId: input.sessionId, messageId: input.messageId })
        input.onAdmitted?.()
        return {
          sessionId: input.sessionId,
          userMessageId: input.messageId,
          assistantMessageId: "reply",
          delivery: "start",
          prompt: { userMessageId: input.messageId, assistantMessageId: "reply", parts: input.parts, agent: "build", model: { providerID: "test", modelID: "fixture" } },
        }
      },
    },
    events: { list: async () => [], subscribe: () => (async function* () {})() },
  }
  const host = SessionRoutes(() => ({}) as never, {
    sessionAccessPolicy: embeddedManagedPrivateSessionPolicy(authority as never),
    resolveRuntime: () => runtime as never,
    listSubagents: ({ parentSessionId }) => store.listSubagents(parentSessionId),
    getSession: ({ sessionId }) => store.getSession(sessionId),
    getMessages: ({ sessionId }) => (sessionId === CHILD
      ? [{ info: { id: REPLY, role: "assistant" as const, sessionID: CHILD }, parts: [{ id: "p1", sessionID: CHILD, messageID: REPLY, type: "text" as const, text: "Ship it." }] }]
      : []),
    childSessions: {
      admission: { admit: (row) => store.admit(row), markPublished: (parent, id) => store.markPublished(parent, id) },
      secret: () => store.runtimeSecret("child-session"),
      pendingWakes: () => store.listPendingSubagentWakes(),
      origins: {
        record: (parent, key, origin) => store.recordSubagentOrigin(parent, key, origin),
        read: (parent, key) => store.subagentOrigin(parent, key),
      },
    },
  })
  hosts.push(() => host.dispose())
  return { host, prompts }
}

/** Recovery runs off the first request the restarted host serves. */
async function wake(host: ReturnType<typeof restartedHost>["host"]) {
  await host.routes.request(`http://localhost/session/${PARENT}?directory=${encodeURIComponent(DIRECTORY)}`)
  await new Promise((resolve) => setTimeout(resolve, 50))
}

function producers(seeded: () => Database.Database) {
  return seeded()
    .prepare(`SELECT session_id, turn_id, actor_id, fencing_token FROM session_turn_producers ORDER BY admitted_at`)
    .all() as Array<{ session_id: string; turn_id: string; actor_id: string; fencing_token: number }>
}

test("a wake recovered after restart is admitted as the actor that created the child, and its transcript resolves to that actor", async () => {
  const { root, authority, seeded, alice, bob, orgId } = await seed("send")
  const storeRoot = runtimeStore(root, { actorId: bob.user.tokenIdentifier, orgId })
  const store = reopened(storeRoot)
  expect(store.subagentOrigin(PARENT, "subagent_wake")).toMatchObject({ actor: { actorId: bob.user.tokenIdentifier } })
  const { host, prompts } = restartedHost(store, authority)

  await wake(host)

  expect(prompts).toEqual([{ sessionId: PARENT, messageId: WAKE_TURN }])
  const admitted = producers(seeded)
  expect(admitted).toMatchObject([{ session_id: PARENT, turn_id: WAKE_TURN, actor_id: bob.user.tokenIdentifier }])
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

test("a wake whose actor lost the parent grant before it ran is refused, leaving no prompt and no producer", async () => {
  const { root, authority, seeded, alice, bob, orgId } = await seed("send")
  const storeRoot = runtimeStore(root, { actorId: bob.user.tokenIdentifier, orgId })
  await setShare(authority, alice, bob, null)
  const store = reopened(storeRoot)
  const { host, prompts } = restartedHost(store, authority)

  await wake(host)

  expect(prompts).toEqual([])
  expect(producers(seeded)).toEqual([])
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])
})

test("a wake with no recorded origin is refused rather than run as the workspace's owner", async () => {
  const { root, authority, seeded } = await seed("send")
  const store = reopened(runtimeStore(root))
  expect(store.subagentOrigin(PARENT, "subagent_wake")).toBeUndefined()
  const { host, prompts } = restartedHost(store, authority)

  await wake(host)

  expect(prompts).toEqual([])
  expect(producers(seeded)).toEqual([])
  expect(store.listSubagents(PARENT)).toMatchObject([{ wake: "pending" }])
})
