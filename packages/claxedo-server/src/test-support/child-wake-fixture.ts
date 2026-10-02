import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { D1Database } from "@cloudflare/workers-types"
import { d1Authority } from "./d1-authority"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { PrivateSessionRuntimePrincipal } from "@claxedo/server-core/platform/auth/private-session-authority"
import { randomUUID } from "node:crypto"
import type { RuntimeStore } from "../../../workspace-runtime/src/store"
import { openRuntimeStore } from "../../../workspace-runtime/src/store-file"
import type { SessionRoutes } from "../../../workspace-runtime/src/routes/session"
import { composeHost } from "../../../workspace-runtime/src/test-support/host-composition"
import { FakeTransport } from "../../../workspace-runtime/src/test-support/fake-transport"
import { removeTestDataDir } from "./test-data-dir"

export const DIRECTORY = process.cwd()
export const WORKSPACE = "workspace_wake"
export const HOST = "host_wake"
export const PARENT = "ses_wake_parent"
export const CHILD = "ses_wake_child"
export const CHILD_OPERATION = "op_child"
export const REPLY = "msg_child_reply"
export const WAKE_TURN = `msg_wake_${CHILD}_${REPLY}`

export type WakeAuthority = Awaited<ReturnType<typeof d1Authority>>["authority"]
type HostOptions = Parameters<typeof SessionRoutes>[1]

const hosts: Array<() => Promise<void>> = []
const closers: Array<() => void | Promise<void>> = []
const directories: string[] = []

/**
 * Shutdown order is the test's own correctness: a host disposed after its
 * store is closed finishes its in-flight turn against a closed database, which
 * surfaces as an unhandled error rather than a failure. Hosts first, awaited,
 * then stores, then the authority.
 */
export const lifecycle = {
  host(dispose: () => Promise<void>) {
    hosts.push(dispose)
  },
  closer(close: () => void | Promise<void>) {
    closers.push(close)
  },
  async cleanup() {
    for (const dispose of hosts.splice(0)) await dispose()
    for (const close of closers.splice(0)) await close()
    for (const directory of directories.splice(0)) removeTestDataDir(directory)
  },
}

export function runtimePrincipal(who: SignedControlPlaneAuth): PrivateSessionRuntimePrincipal {
  return { principalKind: "user", actorId: who.principal!.actorId, actorKind: "human" }
}

/**
 * Alice's workspace, Bob a member of its organization, and Alice's private
 * parent session shared with Bob at `parentShare`. The child is not yet
 * reserved: the create path under test reserves it before the runtime is
 * asked, so each suite takes it as far as the flow it exercises expects.
 */
export async function seedWakeWorkspace(parentShare: "follow" | "send") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-child-wake-"))
  directories.push(root)
  const fixture = await d1Authority()
  const { authority, database: seeded } = fixture
  lifecycle.closer(fixture.dispose)
  const alice = await fixture.signIn("alice")
  const bob = await fixture.signIn("bob")
  await authority.createCloudWorkspace(alice, { workspaceId: WORKSPACE, displayName: "Wake" })
  const opened = await authority.openWorkspace(alice, { workspaceId: WORKSPACE })
  const orgId = opened.workspace!.org_id!
  await fixture.addMember(alice, bob, orgId)
  const aliceRuntime = runtimePrincipal(alice)
  const bobRuntime = runtimePrincipal(bob)
  await authority.reserveSession(alice, { operationId: "op_parent", sessionId: PARENT, workspaceId: WORKSPACE, kind: "create" })
  await authority.registerRuntimeSession({ ...aliceRuntime, operationId: "op_parent", sessionId: PARENT, workspaceId: WORKSPACE, createdAt: Date.now(), updatedAt: Date.now() })
  await setShare(authority, alice, bob, parentShare)
  return { root, authority, seeded, alice, bob, aliceRuntime, bobRuntime, orgId }
}

/** The reservation a client takes on the control plane before it asks the runtime to create the child. */
export async function reserveChild(authority: WakeAuthority, creator: PrivateSessionRuntimePrincipal) {
  await authority.reserveRuntimeSession(creator, {
    operationId: CHILD_OPERATION, sessionId: CHILD, workspaceId: WORKSPACE, kind: "fork", parentSessionId: PARENT,
  })
}

/** The registration the create route completes once the runtime holds the child. */
export async function registerChild(authority: WakeAuthority, creator: PrivateSessionRuntimePrincipal) {
  await authority.registerRuntimeSession({ ...creator, operationId: CHILD_OPERATION, sessionId: CHILD, workspaceId: WORKSPACE, createdAt: Date.now(), updatedAt: Date.now() })
}

export async function setShare(
  authority: WakeAuthority,
  alice: SignedControlPlaneAuth,
  bob: SignedControlPlaneAuth,
  level: "follow" | "send" | null,
) {
  const target = { sessionId: PARENT, workspaceId: WORKSPACE, grantedToUserId: bob.principal!.userId }
  if (level) await authority.grantSessionShare!(alice, { ...target, level })
  else await authority.revokeSessionShare!(alice, target)
}

export function runtimeStoreRoot(root: string) {
  return path.join(root, "runtime")
}

/** The rows `onTurnSettled` writes when the child's turn ends: finished, and its parent owed a wake. */
export function admitFinishedChild(store: RuntimeStore, subagentKey: string) {
  store.admit({
    parentSessionId: PARENT,
    observation: { observationId: "finished", subagentKey, status: "completed", wake: "pending" },
    allocateKey: () => "unused",
  })
  store.markPublished(PARENT, "finished")
}

/**
 * The runtime store as the create route leaves it: both sessions bound, the
 * child admitted under the parent, finished, its wake pending, and `origin`
 * recorded as the identity the wake is to run as, with the grant it presents.
 */
export async function seedFinishedChildStore(root: string, origin?: { actorId: string; orgId: string; grant?: string }) {
  const store = openRuntimeStore(runtimeStoreRoot(root))
  const { runtime } = await wakeRuntime(store, { createChild: true })
  await runtime.dispose()
  store.admit({
    parentSessionId: PARENT,
    observation: {
      observationId: "create",
      subagentKey: "subagent_wake",
      status: "pending",
      mode: "background",
      providerKind: "claxedo",
      providerId: CHILD,
      childSessionId: CHILD,
      transcript: { kind: "live" },
    },
    allocateKey: () => "unused",
  })
  store.markPublished(PARENT, "create")
  admitFinishedChild(store, "subagent_wake")
  if (origin) {
    store.recordSubagentOrigin(PARENT, "subagent_wake", {
      provenance: "relay-replayed",
      actor: { actorId: origin.actorId, actorKind: "human" },
      authority: { managed: true, workspaceId: WORKSPACE, orgId: origin.orgId, role: "editor" },
      ...(origin.grant ? { grant: origin.grant } : {}),
    })
  }
  store.close()
  return runtimeStoreRoot(root)
}

/** The store as a restarted process finds it: reopened from disk, nothing carried over. */
export function reopened(storeRoot: string) {
  const store = openRuntimeStore(storeRoot)
  lifecycle.closer(() => store.close())
  return store
}

export async function wakeRuntime(store: RuntimeStore, options: { holdParent?: boolean; createChild?: boolean } = {}) {
  const prompts: Array<{ sessionId: string; messageId?: string }> = []
  let releaseParent!: () => void
  const parentHeld = new Promise<void>((resolve) => {
    releaseParent = resolve
  })
  const transport = new FakeTransport({
    turn: async function* ({ session, turn }) {
      if (turn.userMessageId === "msg_hold_parent") {
        await parentHeld
      } else prompts.push({ sessionId: session.binding.sessionId, messageId: turn.userMessageId })
      yield { type: "finish", sessionId: session.binding.sessionId }
    },
  })
  const { runtime } = composeHost({ store, transports: { pi: transport }, workspaceId: WORKSPACE })
  for (const id of options.createChild ? [PARENT, CHILD] : [PARENT]) {
    if (!store.getSession(id)) {
      await runtime.sessions.create({
        id,
        workspaceId: WORKSPACE,
        directory: DIRECTORY,
        harness: { id: "pi", access: "native" },
        owner: { kind: "machine-owner" },
        origin: { actor: { kind: "machine-owner" }, via: "loopback", reissued: false },
        ...(id === CHILD ? { parentID: PARENT } : {}),
      })
    }
  }
  if (options.holdParent) {
    await runtime.turns.start({
      sessionId: PARENT,
      messageId: "msg_hold_parent",
      text: "hold",
      origin: { actor: { kind: "machine-owner" }, via: "loopback", reissued: false },
    })
    await until(() => transport.activeTurns === 1, "the parent turn to start")
  }
  return {
    runtime,
    prompts,
    dispose: async () => {
      releaseParent()
      await runtime.dispose()
    },
  }
}

/** What a host lends the session routes out of its store, plus the child's one reply. */
export function storeBackedHostOptions(store: RuntimeStore): Pick<HostOptions, "listSubagents" | "getSession" | "getMessages" | "childSessions"> {
  return {
    listSubagents: ({ parentSessionId }) => store.listSubagents(parentSessionId),
    getSession: ({ sessionId }) => store.getSession(sessionId),
    getMessages: ({ sessionId }) => (sessionId === CHILD
      ? [{ info: { id: REPLY, role: "assistant", sessionID: CHILD }, parts: [{ id: "p1", sessionID: CHILD, messageID: REPLY, type: "text", text: "Ship it." }] }]
      : []),
    childSessions: {
      admit: async (parentSessionId, observation) => {
        const admitted = store.admit({ parentSessionId, observation, allocateKey: () => randomUUID() })
        store.markPublished(parentSessionId, admitted.observationId)
        return admitted.event
      },
      secret: () => store.runtimeSecret("child-session"),
      pendingWakes: () => store.listPendingSubagentWakes(),
      origins: {
        record: (parent, key, origin) => store.recordSubagentOrigin(parent, key, origin),
        read: (parent, key) => store.subagentOrigin(parent, key),
      },
    },
  }
}

/** Recovery runs off the first request the restarted host serves. */
export async function wake(host: ReturnType<typeof SessionRoutes>) {
  await host.routes.request(`http://localhost/session/${PARENT}?directory=${encodeURIComponent(DIRECTORY)}`)
  await new Promise((resolve) => setTimeout(resolve, 50))
}

/** Polls on the real timer, so it holds while a suite fakes `Date`. */
export async function until(condition: () => boolean, what: string, timeoutMs = 2_000) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 5) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

export async function producers(seeded: D1Database) {
  return (await seeded
    .prepare(`SELECT session_id, turn_id, actor_id, fencing_token FROM session_turn_producers ORDER BY admitted_at`)
    .all()).results as Array<{ session_id: string; turn_id: string; actor_id: string; fencing_token: number }>
}

export async function grantRows(seeded: D1Database) {
  return (await seeded
    .prepare(`SELECT grant_id, actor_id, session_id, subject_session_id, turn_id, turn_id_prefix, redeemed_turn_id, revoked_at FROM session_turn_grants ORDER BY issued_at`)
    .all()).results as Array<{
      grant_id: string
      actor_id: string
      session_id: string
      subject_session_id: string | null
      turn_id: string | null
      turn_id_prefix: string | null
      redeemed_turn_id: string | null
      revoked_at: number | null
    }>
}
