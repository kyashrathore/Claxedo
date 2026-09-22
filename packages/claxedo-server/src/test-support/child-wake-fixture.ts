import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type Database from "better-sqlite3"
import { createSqliteWorkspaceAuthority } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority"
import { openAuthorityDb } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { PrivateSessionRuntimePrincipal } from "@claxedo/server-core/platform/auth/private-session-authority"
import { RuntimeStore } from "../../../workspace-runtime/src/store"
import type { SessionRoutes } from "../../../workspace-runtime/src/routes/session"

/**
 * One child, one parent, two people, shared by the wake suites that put a
 * child-completion turn to a real SQLite authority: the embedded one decides
 * it in process, the remote one over `RuntimeSessionAuthorityRoutes`.
 */

export const DIRECTORY = process.cwd()
export const WORKSPACE = "workspace_wake"
export const HOST = "host_wake"
export const PARENT = "ses_wake_parent"
export const CHILD = "ses_wake_child"
export const CHILD_OPERATION = "op_child"
export const REPLY = "msg_child_reply"
export const WAKE_TURN = `msg_wake_${CHILD}_${REPLY}`

export type WakeAuthority = ReturnType<typeof createSqliteWorkspaceAuthority>
type HostOptions = NonNullable<Parameters<typeof SessionRoutes>[1]>
export type HostRuntime = NonNullable<Awaited<ReturnType<NonNullable<HostOptions["resolveRuntime"]>>>>

const hosts: Array<() => Promise<void>> = []
const closers: Array<() => void> = []
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
  closer(close: () => void) {
    closers.push(close)
  },
  async cleanup() {
    for (const dispose of hosts.splice(0)) await dispose()
    for (const close of closers.splice(0)) close()
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  },
}

export function signed(subject: string): SignedControlPlaneAuth {
  return {
    mode: "signed",
    token: `token_${subject}`,
    user: { subject, tokenIdentifier: `https://idp.example|${subject}`, issuer: "https://idp.example" },
  }
}

export function runtimePrincipal(who: SignedControlPlaneAuth): PrivateSessionRuntimePrincipal {
  return { principalKind: "user", actorId: who.user.tokenIdentifier, actorKind: "human" }
}

/**
 * Alice's workspace, Bob a member of it, and Alice's private parent session
 * shared with Bob at `parentShare`. The child is not yet reserved: the create
 * path under test reserves it before the runtime is asked, so each suite
 * takes it as far as the flow it exercises expects.
 */
export async function seedWakeWorkspace(parentShare: "follow" | "send") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-child-wake-"))
  directories.push(root)
  const databasePath = path.join(root, "authority.db")
  const authority = createSqliteWorkspaceAuthority({ path: databasePath })
  const seeded = openAuthorityDb({ path: databasePath })
  lifecycle.closer(() => authority.close())
  lifecycle.closer(() => seeded.close())
  const alice = signed("alice")
  const bob = signed("bob")
  await authority.usersMe(bob)
  await authority.createCloudWorkspace(alice, { workspaceId: WORKSPACE, displayName: "Wake" })
  const opened = await authority.openWorkspace(alice, { workspaceId: WORKSPACE })
  const orgId = opened.workspace!.org_id!
  member(seeded, orgId, opened.workspace!.project_id!, bob.user.tokenIdentifier)
  const bobRuntime = runtimePrincipal(bob)
  await authority.reserveSession(alice, { operationId: "op_parent", sessionId: PARENT, workspaceId: WORKSPACE, kind: "create" })
  await authority.registerRuntimeSession({ ...runtimePrincipal(alice), operationId: "op_parent", sessionId: PARENT, workspaceId: WORKSPACE })
  await setShare(authority, alice, bob, parentShare)
  return { root, authority, seeded, alice, bob, bobRuntime, orgId }
}

/** The reservation a client takes on the control plane before it asks the runtime to create the child. */
export async function reserveChild(authority: WakeAuthority, creator: PrivateSessionRuntimePrincipal) {
  await authority.reserveRuntimeSession(creator, {
    operationId: CHILD_OPERATION, sessionId: CHILD, workspaceId: WORKSPACE, kind: "fork", parentSessionId: PARENT,
  })
}

/** The registration the create route completes once the runtime holds the child. */
export async function registerChild(authority: WakeAuthority, creator: PrivateSessionRuntimePrincipal) {
  await authority.registerRuntimeSession({ ...creator, operationId: CHILD_OPERATION, sessionId: CHILD, workspaceId: WORKSPACE })
}

function member(seeded: () => Database.Database, orgId: string, projectId: string, tokenIdentifier: string) {
  const db = seeded()
  db.prepare(`INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at) VALUES (?, ?, 'member', 1, 1)`)
    .run(orgId, tokenIdentifier)
  db.prepare(`INSERT INTO project_memberships (project_id, token_identifier, role, created_at, updated_at) VALUES (?, ?, 'editor', 1, 1)`)
    .run(projectId, tokenIdentifier)
}

export async function setShare(
  authority: WakeAuthority,
  alice: SignedControlPlaneAuth,
  bob: SignedControlPlaneAuth,
  level: "follow" | "send" | null,
) {
  const target = { sessionId: PARENT, workspaceId: WORKSPACE, grantedToTokenIdentifier: bob.user.tokenIdentifier }
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
 * child admitted under the parent, finished, its wake pending, and Bob
 * recorded as the identity the wake is to run as, with the grant it presents.
 */
export function seedFinishedChildStore(root: string, origin?: { actorId: string; orgId: string; grant?: string }) {
  const store = new RuntimeStore(runtimeStoreRoot(root))
  store.bindSession({ sessionId: PARENT, directory: DIRECTORY, agentSessionId: PARENT })
  store.bindSession({ sessionId: CHILD, directory: DIRECTORY, agentSessionId: CHILD, parentSessionId: PARENT })
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
  const store = new RuntimeStore(storeRoot)
  lifecycle.closer(() => store.close())
  return store
}

/**
 * An agent runtime that admits every turn it is handed and records it. The
 * idle wait is the one seam a suite varies: a parent that never goes idle
 * keeps a queued prompt in the store for the next process to recover.
 */
export function hostRuntimeDouble(options: { whenIdle?: () => Promise<{ abandon(): void }> } = {}) {
  const prompts: Array<{ sessionId: string; messageId?: string }> = []
  const runtime = {
    turns: {
      whenIdle: options.whenIdle ?? (async () => ({ abandon() {} })),
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
  } as unknown as HostRuntime
  return { runtime, prompts }
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
      admission: { admit: (row) => store.admit(row), markPublished: (parent, id) => store.markPublished(parent, id) },
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

export function producers(seeded: () => Database.Database) {
  return seeded()
    .prepare(`SELECT session_id, turn_id, actor_id, fencing_token FROM session_turn_producers ORDER BY admitted_at`)
    .all() as Array<{ session_id: string; turn_id: string; actor_id: string; fencing_token: number }>
}

export function grantRows(seeded: () => Database.Database) {
  return seeded()
    .prepare(`SELECT grant_id, actor_id, session_id, subject_session_id, turn_id, turn_id_prefix, redeemed_turn_id, revoked_at FROM session_turn_grants ORDER BY issued_at`)
    .all() as Array<{
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
