// `node:test`'s `describe`/`test` return a promise the runner already owns: it
// settles when the suite finishes and reports failures through the runner
// rather than rejecting, so every registration below is deliberately `void`ed.
import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import { createRequire } from "module"
import os from "os"
import path from "path"
import { createSubagentAdmissionBoundary } from "@claxedo/agent-sdk-runtime"
import { AgentMessagePageError, AgentRuntimeStaleTurnError } from "@claxedo/agent-sdk-runtime/adapters"
import {
  messagePartUpdated,
  messageUpdated,
  messageCompleted,
  messagePartDelta,
  permissionAsked,
  questionAsked,
  sessionIdle,
  sessionUsage,
  sessionUpdated,
  todoUpdated,
} from "./compat-events"
import { RuntimeStore as RuntimeStoreImpl } from "./store"

const roots: string[] = []
const stores: RuntimeStoreImpl[] = []

class RuntimeStore extends RuntimeStoreImpl {
  constructor(...args: ConstructorParameters<typeof RuntimeStoreImpl>) {
    super(...args)
    stores.push(this)
  }
}

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-store-"))
  roots.push(root)
  return root
}

function journal(root: string, sessionId: string) {
  const store = new RuntimeStore(root)
  const rows = (
    store as unknown as {
      db: {
        prepare(sql: string): {
          all(...params: unknown[]): unknown[]
        }
      }
    }
  ).db
    .prepare(
      `
    SELECT seq, kind, type, payload_json
    FROM runtime_journal
    WHERE session_id = ?
    ORDER BY seq ASC
  `,
    )
    .all(sessionId) as Array<{ seq: number; kind: string; type: string; payload_json: string }>
  store.close()
  return rows.map((row) => ({
    ...row,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  }))
}

function sessionColumns(store: RuntimeStore) {
  return (
    (
      store as unknown as {
        db: {
          prepare(sql: string): {
            all(...params: unknown[]): unknown[]
          }
        }
      }
    ).db
      .prepare("PRAGMA table_info(session)")
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
}

function db(store: RuntimeStore) {
  return (
    store as unknown as {
      db: {
        exec(sql: string): unknown
        prepare(sql: string): {
          run(...params: unknown[]): unknown
          get(...params: unknown[]): unknown
          all(...params: unknown[]): unknown[]
        }
      }
    }
  ).db
}

/**
 * Finish a turn as the holder of its session's lease. These cases are about
 * what the journal and the projection do, not about fencing; the fencing cases
 * below pass a lease the session does not hold, on purpose.
 */
function finishHeldTurn(
  store: RuntimeStore,
  input: Omit<Parameters<RuntimeStore["finishTurn"]>[0], "leaseId">,
) {
  const leaseId = store.readTurnAuthority(input.sessionId)?.leaseId ?? store.acquireTurnLease(input.sessionId)
  assert.ok(leaseId, "the session has a turn lease to finish under")
  return store.finishTurn({ ...input, leaseId })
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true })
  }
})

void describe("RuntimeStore", () => {
  void it("turn leases survive runtime-store reconstruction", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    const reconstructed = new RuntimeStore(root)
    const lease = first.acquireTurnLease("ses_durable_turn")
    assert.equal(typeof lease, "string")
    assert.equal(reconstructed.acquireTurnLease("ses_durable_turn"), undefined)

    reconstructed.recoverBusySessions()
    const recoveredLease = reconstructed.acquireTurnLease("ses_durable_turn")
    assert.equal(typeof recoveredLease, "string")

    // A delayed release from the pre-recovery owner must not delete the new
    // runtime's lease.
    first.releaseTurnLease("ses_durable_turn", lease!)
    assert.equal(reconstructed.acquireTurnLease("ses_durable_turn"), undefined)
    reconstructed.releaseTurnLease("ses_durable_turn", recoveredLease!)
    assert.equal(typeof reconstructed.acquireTurnLease("ses_durable_turn"), "string")
  })

  void it("queued prompts survive a runtime restart with their payload and requester", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    const queued = first.queuePrompt({
      sessionId: "ses_queue",
      messageId: "msg_queued",
      parts: [{ type: "text", text: "then run the tests" }],
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      tools: { bash: false },
      format: { type: "json_schema", name: "report" },
      system: "be brief",
      variant: "thinking",
      permissionMode: "ask",
      delivery: "queue",
      actor: { actorId: "actor_1", actorKind: "human" },
      author: { id: "pub_1", name: "Yash", avatarUrl: "https://avatars.example/y.png", kind: "human" },
    })
    const second = first.queuePrompt({
      sessionId: "ses_queue",
      parts: [{ type: "text", text: "and open a PR" }],
      delivery: "queue",
    })
    assert.deepEqual([queued.seq, second.seq], [1, 2])

    const restarted = new RuntimeStore(root)
    restarted.recoverBusySessions()
    const rows = restarted.listQueuedPrompts()
    assert.deepEqual(rows.map((row) => row.seq), [1, 2])
    assert.deepEqual(rows[0], {
      sessionId: "ses_queue",
      seq: 1,
      messageId: "msg_queued",
      parts: [{ type: "text", text: "then run the tests" }],
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      tools: { bash: false },
      format: { type: "json_schema", name: "report" },
      system: "be brief",
      variant: "thinking",
      permissionMode: "ask",
      delivery: "queue",
      actor: { actorId: "actor_1", actorKind: "human" },
      author: { id: "pub_1", name: "Yash", avatarUrl: "https://avatars.example/y.png", kind: "human" },
      queuedAt: rows[0].queuedAt,
    })
    assert.deepEqual(rows[1], {
      sessionId: "ses_queue",
      seq: 2,
      parts: [{ type: "text", text: "and open a PR" }],
      delivery: "queue",
      queuedAt: rows[1].queuedAt,
    })

    assert.equal(restarted.replaceQueuedPromptParts("ses_queue", 2, [{ type: "text", text: "and open a draft PR" }]), true)
    assert.equal(restarted.replaceQueuedPromptParts("ses_queue", 3, [{ type: "text", text: "nothing to edit" }]), false)
    assert.deepEqual(new RuntimeStore(root).listQueuedPrompts()[1]?.parts, [{ type: "text", text: "and open a draft PR" }])

    restarted.deleteQueuedPrompt("ses_queue", 1)
    assert.deepEqual(restarted.listQueuedPrompts().map((row) => row.seq), [2])
    assert.deepEqual(new RuntimeStore(root).listQueuedPrompts().map((row) => row.seq), [2])
  })

  void it("queue identities are not reused after deletion and restart", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    const input = { sessionId: "ses_queue", parts: [{ type: "text" as const, text: "S" }], delivery: "queue" as const }
    const old = first.queuePrompt(input)
    first.deleteQueuedPrompt(old.sessionId, old.seq)
    first.close()
    const restarted = new RuntimeStore(root)
    const next = restarted.queuePrompt(input)
    assert.equal(next.seq, old.seq + 1)
    restarted.deleteQueuedPrompt(old.sessionId, old.seq)
    assert.equal(restarted.replaceQueuedPromptParts(old.sessionId, old.seq, []), false)
    assert.equal(restarted.claimQueuedPromptDelivery(old.sessionId, old.seq, "stale", "steer"), false)
    assert.deepEqual(restarted.listQueuedPrompts(), [next])
  })

  void it("queue persistence deduplicates by session and message identity across store handles", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    const second = new RuntimeStore(root)
    const input = { sessionId: "ses_queue", messageId: "same-id", parts: [{ type: "text" as const, text: "same text" }], delivery: "queue" as const }
    const original = first.queuePrompt(input)
    assert.deepEqual(second.queuePrompt({ ...input, parts: [] }), original)
    assert.equal(first.listQueuedPrompts().length, 1)
    // Identical text with another id is a distinct input; another session is isolated.
    assert.equal(second.queuePrompt({ ...input, messageId: "other-id" }).seq, original.seq + 1)
    assert.equal(second.queuePrompt({ ...input, sessionId: "other-session" }).seq, 1)
    assert.equal(first.listQueuedPrompts().length, 3)
  })

  void it("deleting a session forgets the prompts queued for it", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "ses_gone", directory: "/workspace", agentSessionId: "agent_gone" })
    store.queuePrompt({
      sessionId: "ses_gone",
      parts: [{ type: "text", text: "never runs" }],
      delivery: "queue",
    })
    store.queuePrompt({
      sessionId: "ses_kept",
      parts: [{ type: "text", text: "still runs" }],
      delivery: "queue",
    })

    store.deleteSession("ses_gone")
    assert.deepEqual(store.listQueuedPrompts().map((row) => row.sessionId), ["ses_kept"])
  })

  void it("creates new session storage with harness columns instead of runner columns", () => {
    const store = new RuntimeStore(tmp())
    const columns = sessionColumns(store)
    assert(columns.includes("harness_id"))
    assert(columns.includes("harness_access"))
    assert(columns.includes("parent_id"))
    assert(!columns.some((name) => name.startsWith("runner_")))
  })

  void it("a queued prompt keeps its deferred turn grant across a restart", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    const grant = "eyJ.queued-grant-token.sig"
    const authority = { managed: true as const, workspaceId: "workspace_1", orgId: "org_1", role: "editor" as const }
    const queued = first.queuePrompt({
      sessionId: "ses_queue",
      messageId: "msg_queued",
      parts: [{ type: "text", text: "then run the tests" }],
      delivery: "queue",
      actor: { actorId: "actor_1", actorKind: "human" },
      authority,
      provenance: "relay-replayed",
      grant,
    })
    assert.equal(queued.grant, grant)
    assert.equal(first.queuePrompt({ sessionId: "ses_queue", messageId: "msg_queued", parts: [], delivery: "queue" }).grant, grant)
    const ungranted = first.queuePrompt({ sessionId: "ses_queue", parts: [], delivery: "queue", provenance: "relay-replayed", actor: { actorId: "actor_1", actorKind: "human" }, authority })
    assert.equal("grant" in ungranted, false)
    first.close()

    const restarted = new RuntimeStore(root)
    const rows = restarted.listQueuedPrompts()
    assert.deepEqual(rows.map((row) => row.grant), [grant, undefined])
    assert.equal("grant" in (rows[1] ?? {}), false)
    restarted.close()
  })

  void it("persists explicit child Session ownership across updates and reopen", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "parent", directory: "/work", agentSessionId: "provider-parent", createdAt: 1 })
    store.bindSession({
      sessionId: "child",
      parentSessionId: "parent",
      directory: "/work",
      agentSessionId: "provider-child",
      createdAt: 2,
    })
    store.updateSession("child", { title: "Child transcript", time: { archived: 3 } })
    store.bindSession({ sessionId: "child", directory: "/work", agentSessionId: "provider-child", createdAt: 4 })

    assert.partialDeepStrictEqual(store.getSession("child"), {
      id: "child",
      parentID: "parent",
      title: "Child transcript",
      time: { archived: 3 },
    })
    store.close()

    const reopened = new RuntimeStore(root)
    assert.equal((reopened.getSession("child") as { parentID?: string } | null)?.parentID, "parent")
    reopened.close()
  })

  void it("durably admits revisioned subagents and rehydrates correlation after reopen", async () => {
    const root = tmp()
    const published: Array<{ parentSessionId: string; revision: number }> = []
    const store = new RuntimeStore(root)
    const boundary = createSubagentAdmissionBoundary({
      store,
      allocateKey: () => "host-child",
      publish: (parentSessionId, event) => {
        published.push({ parentSessionId, revision: event.revision })
      },
    })
    const spawn = await boundary.admit("parent", {
      observationId: "spawn",
      harnessExecutionId: "run",
      toolCallId: "tool-1",
      toolCallRole: "spawn",
      status: "running",
      transcript: { kind: "messages", ref: "handle-1" },
    })
    const bound = await boundary.admit("parent", {
      observationId: "bound",
      harnessExecutionId: "run",
      toolCallId: "tool-1",
      toolCallRole: "spawn",
      providerKind: "claude-agent",
      providerId: "agent-1",
      childSessionId: "child-session",
      status: "completed",
    })

    assert.equal(bound.subagentKey, spawn.subagentKey)
    assert.equal(bound.revision, 2)
    assert.deepEqual(published, [
      { parentSessionId: "parent", revision: 1 },
      { parentSessionId: "parent", revision: 2 },
    ])
    store.close()

    const reopened = new RuntimeStore(root)
    const next = createSubagentAdmissionBoundary({
      store: reopened,
      allocateKey: () => "replacement-must-not-be-used",
      publish: () => {},
    })
    const interaction = await next.admit("parent", {
      observationId: "interaction",
      harnessExecutionId: "run",
      providerKind: "claude-agent",
      providerId: "agent-1",
      toolCallId: "send-1",
      toolCallRole: "interaction",
      status: "completed",
    })

    assert.equal(interaction.subagentKey, spawn.subagentKey)
    assert.equal(interaction.revision, 3)
    const rows = reopened.listSubagents("parent")
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.subagentKey, spawn.subagentKey)
    assert.equal(rows[0]?.revision, 3)
    assert.equal(rows[0]?.providerId, "agent-1")
    assert.equal(rows[0]?.childSessionId, "child-session")
    assert.deepEqual(rows[0]?.transcript, { kind: "messages", ref: "handle-1" })
    assert.deepEqual(rows[0]?.toolCallEdges, [
      { toolCallId: "tool-1", role: "spawn", revision: 1 },
      { toolCallId: "send-1", role: "interaction", revision: 3 },
    ])
    reopened.close()
  })

  void it("persists attention counts, wake state and a stable runtime secret across reopen", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    const secret = store.runtimeSecret("child-session")
    assert.match(secret, /^[0-9a-f]{64}$/)
    assert.equal(store.runtimeSecret("child-session"), secret)
    assert.notEqual(store.runtimeSecret("other"), secret)
    store.bindSession({ sessionId: "parent", directory: "/workspace", agentSessionId: "parent" })
    store.bindSession({ sessionId: "child", directory: "/workspace", agentSessionId: "child", parentSessionId: "parent" })
    const observations: Array<[string, Record<string, unknown>]> = [
      ["create", { status: "pending", providerKind: "claxedo", providerId: "child", childSessionId: "child", transcript: { kind: "live" } }],
      ["attention-2", { attention: 2 }],
      ["attention-0", { attention: 0 }],
      ["finished", { status: "completed", wake: "pending" }],
    ]
    for (const [observationId, observation] of observations) {
      store.admit({
        parentSessionId: "parent",
        observation: { observationId, subagentKey: "subagent_host", ...observation },
        allocateKey: () => "unused",
      })
      store.markPublished("parent", observationId)
    }
    assert.deepEqual(store.listPendingSubagentWakes(), [
      { parentSessionId: "parent", subagentKey: "subagent_host", childSessionId: "child", directory: "/workspace" },
    ])
    store.close()

    const reopened = new RuntimeStore(root)
    assert.equal(reopened.runtimeSecret("child-session"), secret)
    const row = reopened.listSubagents("parent")[0]
    assert.equal(row?.status, "completed")
    assert.equal(row?.attention, 0)
    assert.equal(row?.wake, "pending")
    reopened.admit({
      parentSessionId: "parent",
      observation: { observationId: "woken", subagentKey: "subagent_host", wake: "delivered" },
      allocateKey: () => "unused",
    })
    assert.equal(reopened.listSubagents("parent")[0]?.wake, "delivered")
    assert.deepEqual(reopened.listPendingSubagentWakes(), [])
    reopened.close()
  })

  void it("keeps a child's origin actor and authority across reopen, and later observations cannot move it", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "parent", directory: "/workspace", agentSessionId: "parent" })
    store.admit({
      parentSessionId: "parent",
      observation: { observationId: "create", subagentKey: "subagent_host", status: "pending", childSessionId: "child" },
      allocateKey: () => "unused",
    })
    store.markPublished("parent", "create")
    const origin = {
      provenance: "relay-replayed" as const,
      actor: { actorId: "https://idp.example|bob", actorKind: "human" as const },
      authority: { managed: true as const, workspaceId: "workspace_1", orgId: "org_1", role: "editor" as const },
    }
    store.recordSubagentOrigin("parent", "subagent_host", origin)
    store.recordSubagentOrigin("parent", "subagent_host", {
      provenance: "relay-replayed",
      actor: { actorId: "https://idp.example|mallory", actorKind: "human" },
      authority: { managed: true, workspaceId: "workspace_1", orgId: "org_1", role: "owner" },
    })
    assert.deepEqual(store.subagentOrigin("parent", "subagent_host"), origin)
    store.admit({
      parentSessionId: "parent",
      observation: { observationId: "finished", subagentKey: "subagent_host", status: "completed", wake: "pending" },
      allocateKey: () => "unused",
    })
    store.markPublished("parent", "finished")
    store.close()

    const reopened = new RuntimeStore(root)
    assert.deepEqual(reopened.subagentOrigin("parent", "subagent_host"), origin)
    assert.equal(reopened.subagentOrigin("parent", "unknown_subagent"), undefined)
    // The origin is identity for admission, not something the parent's
    // subagent list hands to whoever may read the session.
    assert.equal("origin" in (reopened.listSubagents("parent")[0] ?? {}), false)
    // A row that is not there cannot quietly swallow the identity: the child
    // would exist and never be able to wake anyone.
    assert.throws(
      () => reopened.recordSubagentOrigin("parent", "subagent_absent", origin),
      /has no row to record a turn origin on/,
    )
    reopened.close()
  })

  void it("keeps a child's deferred turn grant across reopen and out of the subagent listing", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "parent", directory: "/workspace", agentSessionId: "parent" })
    store.admit({
      parentSessionId: "parent",
      observation: { observationId: "create", subagentKey: "subagent_host", status: "pending", childSessionId: "child" },
      allocateKey: () => "unused",
    })
    store.markPublished("parent", "create")
    const grant = "eyJ.deferred-grant-token.sig"
    const origin = {
      provenance: "relay-replayed" as const,
      actor: { actorId: "https://idp.example|bob", actorKind: "human" as const },
      authority: { managed: true as const, workspaceId: "workspace_1", orgId: "org_1", role: "editor" as const },
      grant,
    }
    store.recordSubagentOrigin("parent", "subagent_host", origin)
    store.recordSubagentOrigin("parent", "subagent_host", { ...origin, grant: "eyJ.another-grant.sig" })
    assert.deepEqual(store.subagentOrigin("parent", "subagent_host"), origin)
    store.close()

    const reopened = new RuntimeStore(root)
    assert.deepEqual(reopened.subagentOrigin("parent", "subagent_host"), origin)
    assert.equal(JSON.stringify(reopened.listSubagents("parent")).includes(grant), false)
    assert.equal(JSON.stringify(reopened.listPendingSubagentWakes()).includes(grant), false)
    reopened.close()
  })

  void it("a relayed origin recorded without a grant reads back without one", () => {
    const store = new RuntimeStore(tmp())
    store.bindSession({ sessionId: "parent", directory: "/workspace", agentSessionId: "parent" })
    store.admit({
      parentSessionId: "parent",
      observation: { observationId: "create", subagentKey: "subagent_host", status: "pending", childSessionId: "child" },
      allocateKey: () => "unused",
    })
    store.markPublished("parent", "create")
    const origin = {
      provenance: "relay-replayed" as const,
      actor: { actorId: "https://idp.example|bob", actorKind: "human" as const },
      authority: { managed: true as const, workspaceId: "workspace_1", orgId: "org_1", role: "editor" as const },
    }
    store.recordSubagentOrigin("parent", "subagent_host", origin)
    assert.deepEqual(store.subagentOrigin("parent", "subagent_host"), origin)
    assert.equal("grant" in (store.subagentOrigin("parent", "subagent_host") ?? {}), false)
    store.close()
  })

  void it("cannot upgrade or reassign an origin a pre-provenance build already recorded", () => {
    const root = tmp()
    const historical = new RuntimeStore(root)
    historical.bindSession({ sessionId: "parent", directory: "/workspace", agentSessionId: "parent" })
    historical.admit({
      parentSessionId: "parent",
      observation: { observationId: "create", subagentKey: "subagent_legacy", status: "pending" },
      allocateKey: () => "unused",
    })
    historical.markPublished("parent", "create")
    // The row an earlier build left: actor and authority recorded, the column
    // naming how they were admitted not yet invented.
    db(historical)
      .prepare(`UPDATE session_subagent SET origin_actor_id = ?, origin_actor_kind = 'human', origin_authority_json = ?
        WHERE parent_session_id = 'parent' AND subagent_key = 'subagent_legacy'`)
      .run("https://idp.example|bob", JSON.stringify({ managed: true, workspaceId: "workspace_1", orgId: "org_1", role: "editor" }))
    historical.close()

    const upgraded = new RuntimeStore(root)
    assert.equal(upgraded.subagentOrigin("parent", "subagent_legacy"), undefined)
    upgraded.recordSubagentOrigin("parent", "subagent_legacy", { provenance: "loopback-direct" })
    upgraded.recordSubagentOrigin("parent", "subagent_legacy", {
      provenance: "relay-replayed",
      actor: { actorId: "https://idp.example|mallory", actorKind: "human" },
      authority: { managed: true, workspaceId: "workspace_1", orgId: "org_1", role: "owner" },
    })

    // Neither call took: the actor it already holds is not empty, and the row
    // stays unreadable rather than becoming someone else's or becoming local.
    const stored = db(upgraded)
      .prepare(`SELECT origin_provenance, origin_actor_id FROM session_subagent WHERE parent_session_id = 'parent' AND subagent_key = 'subagent_legacy'`)
      .get() as { origin_provenance: string | null; origin_actor_id: string | null }
    assert.deepEqual(stored, { origin_provenance: null, origin_actor_id: "https://idp.example|bob" })
    assert.equal(upgraded.subagentOrigin("parent", "subagent_legacy"), undefined)
    upgraded.close()

    const reopened = new RuntimeStore(root)
    assert.equal(reopened.subagentOrigin("parent", "subagent_legacy"), undefined)
    reopened.close()
  })

  void it("refuses a local origin that also names an actor instead of reading it as local", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "parent", directory: "/workspace", agentSessionId: "parent" })
    store.admit({
      parentSessionId: "parent",
      observation: { observationId: "create", subagentKey: "subagent_mixed", status: "pending" },
      allocateKey: () => "unused",
    })
    store.markPublished("parent", "create")
    // Only a migration could write this pair; answering it as local would run
    // a verified actor's wake unleased.
    db(store)
      .prepare(`UPDATE session_subagent SET origin_provenance = 'loopback-direct', origin_actor_id = ?
        WHERE parent_session_id = 'parent' AND subagent_key = 'subagent_mixed'`)
      .run("https://idp.example|bob")

    assert.equal(store.subagentOrigin("parent", "subagent_mixed"), undefined)
    store.close()
  })

  void it("keeps a local child's provenance across reopen, and tells it apart from a row that recorded none", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "parent", directory: "/workspace", agentSessionId: "parent" })
    for (const key of ["subagent_local", "subagent_legacy"]) {
      store.admit({
        parentSessionId: "parent",
        observation: { observationId: `create_${key}`, subagentKey: key, status: "pending" },
        allocateKey: () => "unused",
      })
      store.markPublished("parent", `create_${key}`)
    }
    store.recordSubagentOrigin("parent", "subagent_local", { provenance: "loopback-direct" })
    store.recordSubagentOrigin("parent", "subagent_local", {
      provenance: "relay-replayed",
      actor: { actorId: "https://idp.example|mallory", actorKind: "human" },
      authority: { managed: true, workspaceId: "workspace_1", orgId: "org_1", role: "owner" },
    })
    store.close()

    const reopened = new RuntimeStore(root)
    // Known-local stays known-local; a row nobody recorded stays unknown, and
    // the two are never the same answer.
    assert.deepEqual(reopened.subagentOrigin("parent", "subagent_local"), { provenance: "loopback-direct" })
    assert.equal(reopened.subagentOrigin("parent", "subagent_legacy"), undefined)
    reopened.close()
  })

  void it("keeps a queued prompt's provenance across reopen so a delayed local turn is still local", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "s1", directory: "/workspace", agentSessionId: "a1" })
    store.queuePrompt({ sessionId: "s1", messageId: "local", parts: [], delivery: "queue", provenance: "loopback-direct" })
    store.queuePrompt({ sessionId: "s1", messageId: "legacy", parts: [], delivery: "queue" })
    store.close()

    const reopened = new RuntimeStore(root)
    assert.deepEqual(
      reopened.listQueuedPrompts().map((row) => [row.messageId, row.provenance]),
      [["local", "loopback-direct"], ["legacy", undefined]],
    )
    reopened.close()
  })

  void it("routes an observation carrying an already-owned child session to the owning row (claude dual-channel split)", () => {
    // Repro of the live crash "UNIQUE constraint failed:
    // session_subagent.child_session_id": the claude harness reports one Task
    // through two channels — an `agent-tool` observation keyed by toolCallId
    // and a `background-task` observation keyed by stableCorrelationId — so
    // admission opens TWO rows for one subagent. The linking `task_started`
    // observation then arrived carrying the FIRST row's child session while
    // resolving (by stable key) to the SECOND row, and the child-column write
    // collided with the unique child index, killing the whole turn.
    const root = tmp()
    const store = new RuntimeStore(root)

    // Channel 1: Task tool block — toolCallId only, child session allocated.
    const spawn = store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "claude:agent-tool:w:tool-1",
        harnessExecutionId: "run",
        toolCallId: "tool-1",
        toolCallRole: "spawn",
        status: "pending",
        providerKind: "claude-agent",
        childSessionId: "child-a",
        transcript: { kind: "messages" },
      },
      allocateKey: () => "unused-a",
    })

    // Channel 2: background_tasks_changed — stable task id only, no child yet.
    const background = store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "claude:background-task:w:task-1",
        harnessExecutionId: "run",
        stableCorrelationId: "task-1",
        status: "running",
        providerKind: "claude-agent",
        transcript: { kind: "messages" },
      },
      allocateKey: () => "unused-b",
    })
    assert.notEqual(background.event.subagentKey, spawn.event.subagentKey)

    // The link: carries the stable key of row B and the child of row A. Child
    // identity is the strongest correlator — this must land on row A, never
    // write child-a into row B (which is what crashed with the UNIQUE error).
    const linked = store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "claude:task_started:w",
        harnessExecutionId: "run",
        stableCorrelationId: "task-1",
        toolCallId: "tool-1",
        toolCallRole: "spawn",
        status: "running",
        providerKind: "claude-agent",
        childSessionId: "child-a",
        transcript: { kind: "messages" },
      },
      allocateKey: () => "unused-c",
    })
    assert.equal(linked.event.subagentKey, spawn.event.subagentKey)

    const rows = store.listSubagents("parent")
    const owners = rows.filter((row) => row.childSessionId === "child-a")
    assert.equal(owners.length, 1)
    assert.equal(owners[0]?.subagentKey, spawn.event.subagentKey)
    store.close()

    // The poisoned durable state must also rehydrate (the live failure mode
    // was every later admission crashing after restart).
    const reopened = new RuntimeStore(root)
    assert.equal(reopened.listSubagents("parent").length, rows.length)
    reopened.close()
  })

  void it("gives an admitted delegation's child session the parent it belongs to", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "parent", directory: "/work", agentSessionId: "parent", createdAt: 1 })
    // A delegating harness owns this child, so the runtime's only row for it is
    // the placeholder a session-scoped read binds. Admission is where the
    // parent link enters this store, and `GET /session/:id` answers from here.
    store.bindSession({ sessionId: "child", directory: "/work", agentSessionId: "child", createdAt: 2 })

    store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "harness:task:tool-1",
        harnessExecutionId: "run",
        toolCallId: "tool-1",
        toolCallRole: "spawn",
        status: "running",
        providerKind: "harness-task",
        childSessionId: "child",
        transcript: { kind: "messages" },
      },
      allocateKey: () => "key-1",
    })

    assert.equal((store.getSession("child") as { parentID?: string } | null)?.parentID, "parent")
    assert.equal((store.getSession("child") as { directory?: string } | null)?.directory, "/work")
    store.close()

    // Journaled like every other session write, so a rehydrate keeps it.
    const reopened = new RuntimeStore(root)
    assert.equal((reopened.getSession("child") as { parentID?: string } | null)?.parentID, "parent")
    reopened.close()
  })

  void it("binds a child session admission names before this store has any row for it", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "parent", directory: "/work", agentSessionId: "parent", createdAt: 1 })

    store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "harness:task:tool-2",
        harnessExecutionId: "run",
        toolCallId: "tool-2",
        toolCallRole: "spawn",
        status: "running",
        providerKind: "harness-task",
        childSessionId: "unseen-child",
        transcript: { kind: "messages" },
      },
      allocateKey: () => "key-2",
    })

    assert.partialDeepStrictEqual(store.getSession("unseen-child"), {
      id: "unseen-child",
      parentID: "parent",
      directory: "/work",
    })
    store.close()
  })

  void it("serializes key and revision admission across concurrently open stores", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    const second = new RuntimeStore(root)
    const spawn = first.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "spawn",
        stableCorrelationId: "task-1",
        status: "running",
      },
      allocateKey: () => "first-key",
    })
    const completion = second.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "completion",
        stableCorrelationId: "task-1",
        status: "completed",
      },
      allocateKey: () => "second-key",
    })

    assert.equal(completion.event.subagentKey, spawn.event.subagentKey)
    assert.equal(completion.event.revision, 2)
    first.close()
    second.close()
  })

  void it("preserves terminal subagent status after a late active observation and reopen", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    const spawn = store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "spawn",
        status: "running",
      },
      allocateKey: () => "child-key",
    })
    store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "completed",
        subagentKey: spawn.event.subagentKey,
        status: "completed",
      },
      allocateKey: () => "unused",
    })
    store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "late-running",
        subagentKey: spawn.event.subagentKey,
        status: "running",
      },
      allocateKey: () => "unused",
    })
    store.close()

    const reopened = new RuntimeStore(root)

    assert.equal(reopened.listSubagents("parent")[0]?.revision, 3)
    assert.equal(reopened.listSubagents("parent")[0]?.status, "completed")
    reopened.close()
  })

  void it("interrupts active children on archive while preserving durable history", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "parent", directory: "/work", agentSessionId: "provider-parent", createdAt: 1 })
    store.bindSession({
      sessionId: "child-session",
      parentSessionId: "parent",
      directory: "/work",
      agentSessionId: "provider-child",
      createdAt: 2,
    })
    const admitted = store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "spawn",
        subagentKey: "child-key",
        mode: "background",
        status: "running",
        childSessionId: "child-session",
        transcript: { kind: "live", ref: "opaque-handle" },
      },
      allocateKey: () => "unused",
    })
    store.markPublished("parent", "spawn")

    store.updateSession("parent", { time: { archived: 50 } })

    const rows = store.listSubagents("parent")
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.subagentKey, "child-key")
    assert.equal(rows[0]?.revision, admitted.event.revision + 1)
    assert.equal(rows[0]?.status, "interrupted")
    assert.equal(rows[0]?.childSessionId, "child-session")
    assert.deepEqual(rows[0]?.transcript, { kind: "live", ref: "opaque-handle" })
    assert.equal((store.getSession("child-session") as { parentID?: string } | null)?.parentID, "parent")
    store.close()

    const reopened = new RuntimeStore(root)
    assert.equal((reopened.listSubagents("parent")[0] as { status?: string }).status, "interrupted")
    assert.ok(reopened.getSession("child-session"))
    reopened.close()
  })

  void it("reconciles disconnected foreground children and deletes child ownership atomically", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "parent", directory: "/work", agentSessionId: "provider-parent", createdAt: 1 })
    store.bindSession({
      sessionId: "child-session",
      parentSessionId: "parent",
      directory: "/work",
      agentSessionId: "provider-child",
      createdAt: 2,
    })
    store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "spawn",
        subagentKey: "child-key",
        mode: "foreground",
        status: "running",
        childSessionId: "child-session",
        toolCallId: "tool-1",
        toolCallRole: "spawn",
      },
      allocateKey: () => "unused",
    })
    store.markPublished("parent", "spawn")
    store.close()

    const reopened = new RuntimeStore(root)
    assert.equal((reopened.listSubagents("parent")[0] as { status?: string }).status, "interrupted")
    reopened.deleteSession("parent")

    assert.deepEqual(reopened.listSubagents("parent"), [])
    assert.equal(reopened.getSession("parent"), null)
    assert.equal(reopened.getSession("child-session"), null)
    const edgeCount = db(reopened)
      .prepare("SELECT COUNT(*) AS count FROM session_subagent_tool_call WHERE parent_session_id = ?")
      .get("parent") as { count: number }
    assert.equal(edgeCount.count, 0)
    reopened.close()
  })


  void it("journals before projecting so replay recovers when projection fails", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    const db = (
      store as unknown as {
        db: {
          exec(sql: string): unknown
          prepare(sql: string): {
            all(...params: unknown[]): unknown[]
          }
        }
      }
    ).db
    db.exec("DROP TABLE session")

    assert.throws(() => {
      store.bindSession({
        sessionId: "s1",
        directory: "/work",
        agentSessionId: "a1",
        createdAt: 1,
      })
    })

    const journal = db.prepare("SELECT type FROM runtime_journal WHERE session_id = ?").all("s1") as Array<{
      type: string
    }>
    assert.deepEqual(
      journal.map((row) => row.type),
      ["session.bind"],
    )
    store.close()

    const next = new RuntimeStore(root)
    assert.equal(next.getAgentSessionId("s1"), "a1")
    next.close()
  })

  void it("rolls back failed projection transactions and replays the journaled row later", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: todoUpdated("s1", [{ content: "Old", status: "pending", priority: "low" }]),
    })

    db(store).exec(`
      CREATE TRIGGER fail_todo_insert
      BEFORE INSERT ON todo
      WHEN NEW.content = 'New'
      BEGIN
        SELECT RAISE(FAIL, 'todo insert failed');
      END
    `)

    assert.throws(() => {
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: todoUpdated("s1", [{ content: "New", status: "completed", priority: "high" }]),
      })
    }, /todo insert failed/)
    db(store).exec("DROP TRIGGER fail_todo_insert")

    assert.deepEqual(store.getTodos("s1"), [{ content: "Old", status: "pending", priority: "low" }])
    store.close()

    const next = new RuntimeStore(root)
    assert.deepEqual(next.getTodos("s1"), [{ content: "New", status: "completed", priority: "high" }])
    next.close()
  })

  void it("returns committed append output after projection commits", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })

    const payload = todoUpdated("s1", [{ content: "Done", status: "completed", priority: "high" }])
    const output = store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload,
      source: {
        dir: "in",
        method: "test.append",
        requestId: "req-1",
      },
    })

    assert.equal(output.sessionId, "s1")
    assert.equal(output.agentSessionId, "a1")
    assert.equal(output.seq, 2)
    assert.equal(output.createdAt > 0, true)
    assert.deepEqual(output.payload, payload)
    assert.deepEqual(output.source, {
      dir: "in",
      method: "test.append",
      requestId: "req-1",
    })
    assert.deepEqual(store.getTodos("s1"), [{ content: "Done", status: "completed", priority: "high" }])
    store.close()
  })

  void it("returns committed turn-start output after projection commits", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })

    const output = store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "msg-user",
      assistantMessageId: "msg-user_r",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })

    assert.equal(output.sessionId, "s1")
    assert.equal(output.agentSessionId, "a1")
    assert.equal(output.seq, 2)
    assert.equal(output.createdAt > 0, true)
    assert.deepEqual(
      output.events.map((event) => event.type),
      ["session.status", "message.updated", "message.part.updated", "message.updated"],
    )
    const replay = store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "msg-user",
      assistantMessageId: "msg-user_r",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    assert.equal(replay.seq, output.seq)
    assert.equal(replay.createdAt, output.createdAt)
    assert.deepEqual(replay.events, [])
    assert.equal(journal(root, "s1").filter((row) => row.type === "turn.start").length, 1)
    assert.deepEqual(
      store.getMessages("s1").map((message) => message.info.id),
      ["msg-user", "msg-user_r"],
    )
    store.close()
  })

  void it("persists Goal continuations under their original user boundary through reopen", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "goal-session", directory: "/work", agentSessionId: "native-goal", createdAt: 1 })
    const common = { sessionId: "goal-session", agent: "build", model: { providerID: "openai", modelID: "codex" } }
    store.startTurn({ ...common, userMessageId: "goal-request", assistantMessageId: "first", parts: [{ type: "text", text: "Finish the requested work" }] })
    const user = store.getMessages("goal-session").find((message) => message.info.role === "user")
    store.startTurn({ ...common, parentMessageId: "goal-request", assistantMessageId: "continuation", parts: [] })
    assert.deepEqual(store.getMessages("goal-session").filter((message) => message.info.role === "user"), [user])
    assert.equal(store.getMessages("goal-session").find((message) => message.info.id === "continuation")?.info.parentID, "goal-request")
    assert.ok(store.getMessagePage("goal-session", { view: "latest-surface" }))
    store.close()
    const reopened = new RuntimeStore(root)
    assert.equal(reopened.getMessages("goal-session").find((message) => message.info.id === "continuation")?.info.parentID, "goal-request")
    assert.ok(reopened.getMessagePage("goal-session", { view: "latest-surface" }))
    reopened.close()
  })

  void it("pages projected messages backward with an opaque cursor and bounded hydration", () => {
    const store = new RuntimeStore(tmp())
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    for (let index = 1; index <= 6; index++) {
      const messageId = `m${index}`
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messageUpdated({
          id: messageId,
          sessionID: "s1",
          role: "user",
          time: { created: index },
        } as any),
      })
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messagePartUpdated({
          id: `${messageId}-text`,
          sessionID: "s1",
          messageID: messageId,
          type: "text",
          text: `message ${index}`,
        }),
      })
    }

    // A page must not parse parts for messages outside its bounded selection.
    db(store).prepare("UPDATE part SET data_json = ? WHERE id = ?").run("not-json", "m1-text")

    const first = store.getMessagePage("s1", { limit: 2 })
    assert.ok(first)
    assert.deepEqual(
      first.messages.map((message) => message.info.id),
      ["m5", "m6"],
    )
    assert.deepEqual(
      first.messages.map((message) => (message.parts[0] as { text?: string } | undefined)?.text),
      ["message 5", "message 6"],
    )
    assert.match(first.nextCursor ?? "", /^wrmp1:/)

    const second = store.getMessagePage("s1", { limit: 2, before: first.nextCursor })
    assert.ok(second)
    assert.deepEqual(
      second.messages.map((message) => message.info.id),
      ["m3", "m4"],
    )
    assert.ok(second.nextCursor)

    const indexes = db(store)
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('message', 'part')")
      .all() as Array<{ name: string }>
    assert(indexes.some((row) => row.name === "message_session_ord_idx"))
    assert(indexes.some((row) => row.name === "part_session_message_ord_idx"))
    store.close()
  })

  void it("returns the chronological latest turn and continues before its user boundary", () => {
    const store = new RuntimeStore(tmp())
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    const append = (info: Record<string, unknown>) =>
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messageUpdated({ sessionID: "s1", time: { created: Date.now() }, ...info } as any),
      })
    append({ id: "user-1", role: "user" })
    append({ id: "assistant-1", role: "assistant", parentID: "user-1" })
    append({ id: "user-2", role: "user" })
    append({ id: "assistant-2a", role: "assistant", parentID: "user-2" })
    append({ id: "assistant-2b", role: "assistant", parentID: "user-2" })

    const latest = store.getMessagePage("s1", { view: "latest-turn" })
    assert.ok(latest)
    assert.deepEqual(
      latest.messages.map((message) => message.info.id),
      ["user-2", "assistant-2a", "assistant-2b"],
    )
    assert.match(latest.nextCursor ?? "", /^wrmp1:/)

    const older = store.getMessagePage("s1", { limit: 10, before: latest.nextCursor })
    assert.ok(older)
    assert.deepEqual(
      older.messages.map((message) => message.info.id),
      ["user-1", "assistant-1"],
    )
    store.close()
  })

  void it("returns only the owning user and final message for the latest surface without losing intermediates", () => {
    const store = new RuntimeStore(tmp())
    const omittedDecodeMarker = "LATEST_SURFACE_OMITTED_PAYLOAD_MUST_NOT_BE_PARSED"
    const omittedPayload = `${omittedDecodeMarker}:${"x".repeat(256 * 1024)}`
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    const append = (info: Record<string, unknown>) =>
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messageUpdated({ sessionID: "s1", time: { created: Date.now() }, ...info } as any),
      })
    append({ id: "user-1", role: "user" })
    append({ id: "assistant-1", role: "assistant", parentID: "user-1" })
    append({
      id: "user-2",
      role: "user",
      summary: { body: "deferred summary", diffs: [{ patch: "large diff" }] },
      system: "deferred system prompt",
      tools: { read: true },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    })
    append({ id: "assistant-2a", role: "assistant", parentID: "user-2" })
    append({ id: "assistant-2b", role: "assistant", parentID: "user-2" })
    for (const part of [
      { id: "user-2-text", messageID: "user-2", type: "text", text: "complete prompt" },
      { id: "user-2-file", messageID: "user-2", type: "file", url: "data:large" },
      { id: "assistant-2b-reasoning", messageID: "assistant-2b", type: "reasoning", text: "large reasoning" },
      { id: "assistant-2b-text", messageID: "assistant-2b", type: "text", text: "complete final reply" },
      {
        id: "assistant-2b-tool",
        messageID: "assistant-2b",
        type: "tool",
        state: { status: "completed", output: omittedPayload },
      },
    ]) {
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messagePartUpdated({ sessionID: "s1", ...part } as any),
      })
    }

    const originalParse = JSON.parse
    JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      assert.equal(text.includes(omittedDecodeMarker), false, "latest-surface decoded an omitted JSON payload")
      return originalParse(text, reviver)
    }) as typeof JSON.parse
    let surface: ReturnType<RuntimeStore["getMessagePage"]>
    try {
      surface = store.getMessagePage("s1", { view: "latest-surface" })
    } finally {
      JSON.parse = originalParse
    }
    assert.ok(surface)
    assert.deepEqual(
      surface.messages.map((message) => message.info.id),
      ["user-2", "assistant-2b"],
    )
    assert.deepEqual(surface.messages[0]?.info, {
      id: "user-2",
      sessionID: "s1",
      role: "user",
      time: surface.messages[0]?.info.time,
      summary: { body: "deferred summary", diffs: [{ patch: "large diff" }] },
      system: "deferred system prompt",
      tools: { read: true },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    })
    assert.deepEqual(
      surface.messages.map((message) => message.parts),
      [
        [{ id: "user-2-text", sessionID: "s1", messageID: "user-2", type: "text", text: "complete prompt" }],
        [
          {
            id: "assistant-2b-text",
            sessionID: "s1",
            messageID: "assistant-2b",
            type: "text",
            text: "complete final reply",
          },
        ],
      ],
    )
    assert.match(surface.nextCursor ?? "", /^wrmp1:/)

    const complete = store.getMessagePage("s1", { view: "latest-turn" })
    assert.ok(complete)
    const completeFirst = complete.messages[0]
    assert.ok(completeFirst)
    assert.deepEqual(completeFirst.info.summary, {
      body: "deferred summary",
      diffs: [{ patch: "large diff" }],
    })
    assert.deepEqual(
      complete.messages.at(-1)?.parts.map((part: any) => part.type),
      ["reasoning", "text", "tool"],
    )

    const older = store.getMessagePage("s1", { limit: 10, before: surface.nextCursor })
    assert.ok(older)
    assert.deepEqual(
      older.messages.map((message) => message.info.id),
      ["user-1", "assistant-1", "user-2", "assistant-2a"],
    )
    store.close()
  })

  void it("latest-surface keeps envelopes and every text whole, drops the tools, and latest-turn stays complete", () => {
    const store = new RuntimeStore(tmp())
    const longUser = "u".repeat(96 * 1024)
    const longAnswer = "a".repeat(200 * 1024)
    const error = { name: "ProviderError", data: { body: "e".repeat(16 * 1024) } }
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    for (const info of [
      { id: "user-long", role: "user", summary: { title: "kept" } },
      { id: "assistant-long", role: "assistant", parentID: "user-long", error },
    ]) {
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messageUpdated({ sessionID: "s1", time: { created: Date.now(), completed: Date.now() }, ...info } as any),
      })
    }
    const parts = [
      { id: "user-text", messageID: "user-long", type: "text", text: longUser },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `assistant-narration-${index}`,
        messageID: "assistant-long",
        type: "text",
        text: `step ${index}`,
      })),
      { id: "assistant-tool", messageID: "assistant-long", type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: {}, output: "o".repeat(1024), title: "bash", metadata: {}, time: { start: 1, end: 2 } } },
      { id: "assistant-answer", messageID: "assistant-long", type: "text", text: longAnswer },
    ]
    for (const value of parts) {
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messagePartUpdated({ sessionID: "s1", ...value } as any),
      })
    }

    const surface = store.getMessagePage("s1", { view: "latest-surface" })
    assert.ok(surface)
    const surfaceUser = surface.messages[0]
    const surfaceAssistant = surface.messages[1]
    assert.ok(surfaceUser)
    assert.ok(surfaceAssistant)
    assert.equal((surfaceUser.parts[0] as any).text, longUser)
    assert.deepEqual((surfaceUser.info as any).summary, { title: "kept" })
    assert.deepEqual(surfaceAssistant.info.error, error)
    assert.deepEqual(
      surfaceAssistant.parts.map((part) => part.id),
      [...Array.from({ length: 20 }, (_, index) => `assistant-narration-${index}`), "assistant-answer"],
    )
    assert.equal((surfaceAssistant.parts.at(-1) as any).text, longAnswer)

    const complete = store.getMessagePage("s1", { view: "latest-turn" })
    assert.ok(complete)
    const completeAssistant = complete.messages[1]
    assert.ok(completeAssistant)
    assert.equal(completeAssistant.parts.length, 22)
    assert.equal(completeAssistant.parts[20]?.type, "tool")
    store.close()
  })

  void it("an attachment recorded as a synthetic text reads back as its file part, and stays out of the surface", () => {
    const store = new RuntimeStore(tmp())
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    const image = { id: "prt_image", type: "file", mime: "image/png", filename: "image.png", url: `data:image/png;base64,${"A".repeat(2048)}` }
    for (const info of [
      { id: "user-image", role: "user" },
      { id: "assistant-image", role: "assistant", parentID: "user-image" },
    ]) {
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messageUpdated({ sessionID: "s1", time: { created: Date.now(), completed: Date.now() }, ...info } as any),
      })
    }
    for (const part of [
      { id: "user-text", messageID: "user-image", type: "text", text: "" },
      { id: "prt_image", messageID: "user-image", type: "text", text: JSON.stringify(image), synthetic: true },
      { id: "assistant-answer", messageID: "assistant-image", type: "text", text: "Looks fine." },
    ]) {
      store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: messagePartUpdated({ sessionID: "s1", ...part } as any) })
    }

    const complete = store.getMessagePage("s1", { view: "latest-turn" })
    assert.ok(complete)
    assert.deepEqual(complete.messages[0]?.parts.map((part) => part.type), ["text", "file"])
    assert.deepEqual(complete.messages[0]?.parts[1], { ...image, sessionID: "s1", messageID: "user-image" })

    const surface = store.getMessagePage("s1", { view: "latest-surface" })
    assert.ok(surface)
    assert.deepEqual(surface.messages[0]?.parts.map((part) => part.id), ["user-text"])
    store.close()
  })

  void it("does not invent a surface cursor for an adjacent user and final assistant", () => {

    const store = new RuntimeStore(tmp())
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    for (const info of [
      { id: "user-adjacent", role: "user" },
      { id: "assistant-adjacent", role: "assistant", parentID: "user-adjacent" },
    ]) {
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messageUpdated({ sessionID: "s1", time: { created: Date.now() }, ...info } as any),
      })
    }

    const surface = store.getMessagePage("s1", { view: "latest-surface" })
    assert.ok(surface)
    assert.deepEqual(
      surface.messages.map((message) => message.info.id),
      ["user-adjacent", "assistant-adjacent"],
    )
    assert.equal(surface.nextCursor, undefined)
    store.close()
  })

  void it("rejects a latest surface whose assistant is not owned by its user boundary", () => {
    const store = new RuntimeStore(tmp())
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    for (const info of [
      { id: "owner", role: "user" },
      { id: "wrong-owner", role: "assistant", parentID: "different-user" },
    ]) {
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messageUpdated({ sessionID: "s1", time: { created: Date.now() }, ...info } as any),
      })
    }

    assert.throws(
      () => store.getMessagePage("s1", { view: "latest-surface" }),
      (error: unknown) => error instanceof AgentMessagePageError && error.status === 409,
    )
    store.close()
  })

  void it("returns a user-only live turn without inventing an older-history cursor", () => {
    const store = new RuntimeStore(tmp())
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messageUpdated({
        id: "user-live",
        sessionID: "s1",
        role: "user",
        time: { created: 1 },
      } as any),
    })

    const latest = store.getMessagePage("s1", { view: "latest-turn" })
    assert.ok(latest)
    assert.deepEqual(
      latest.messages.map((message) => message.info.id),
      ["user-live"],
    )
    assert.equal(latest.nextCursor, undefined)
    store.close()
  })

  void it("rejects invalid, cross-session, and missing-session message page cursors", () => {
    const store = new RuntimeStore(tmp())
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    store.bindSession({ sessionId: "s2", directory: "/work", agentSessionId: "a2", createdAt: 2 })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messageUpdated({
        id: "m1",
        sessionID: "s1",
        role: "user",
        time: { created: 1 },
      } as any),
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messageUpdated({
        id: "m2",
        sessionID: "s1",
        role: "user",
        time: { created: 2 },
      } as any),
    })
    store.appendEvent({
      sessionId: "s2",
      agentSessionId: "a2",
      payload: messageUpdated({
        id: "s2-m1",
        sessionID: "s2",
        role: "user",
        time: { created: 1 },
      } as any),
    })
    const result = store.getMessagePage("s1", { limit: 1 })
    assert.ok(result)
    const cursor = result.nextCursor
    assert.ok(cursor)

    for (const run of [
      () => store.getMessagePage("s1", { limit: 1, before: "not-a-cursor" }),
      () => store.getMessagePage("s2", { limit: 1, before: cursor }),
    ]) {
      assert.throws(
        run,
        (error: unknown) =>
          error instanceof AgentMessagePageError &&
          error.status === 400 &&
          error.message === "Invalid message page cursor",
      )
    }
    assert.throws(
      () => store.getMessagePage("missing", { limit: 1 }),
      (error: unknown) => error instanceof AgentMessagePageError && error.status === 404,
    )
    store.close()
  })

  void it("journals every public durable runtime mutation before projection state", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      title: "Demo",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: permissionAsked({
        id: "p1",
        sessionID: "s1",
        permission: "bash",
        patterns: ["/tmp"],
        metadata: {},
        always: ["/tmp"],
      }),
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: questionAsked({
        id: "q1",
        sessionID: "s1",
        questions: [
          {
            question: "Ship it?",
            header: "Ship it?",
            options: [{ label: "Yes", description: "Ship it" }],
            custom: false,
          },
        ],
      }),
    })

    store.stalePermission("p1")
    store.staleQuestion("q1")
    store.markRecovering("s1", "recovering")
    assert.equal(store.consumeRecoveryError("s1"), "recovering")
    store.createNotice("s1", { notice: "recovery_error", message: "created notice" })
    assert.equal(store.rebuildProjection("s1", "operator requested rebuild").rebuilt, true)
    store.updateSession("s1", { title: "Updated", time: { archived: 123 } })
    store.updateSessionConfig("s1", {
      harness: { id: "codex", access: "native" },
      model: { providerID: "openai", modelID: "gpt-5.4" },
    })
    store.deleteSession("s1")
    store.close()

    const rows = journal(root, "s1")
    assert.deepEqual(
      rows.map((row) => row.type),
      [
        "session.bind",
        "permission.asked",
        "question.asked",
        "permission.staled",
        "question.staled",
        "session.recovering",
        "notice.acknowledged",
        "notice.created",
        "projection.reset_requested",
        "session.update",
        "config.update",
        "session.delete",
      ],
    )
    assert.deepEqual(
      rows.map((row) => row.seq),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    )
    assert.equal(rows.find((row) => row.type === "notice.created")?.payload.message, "created notice")
    assert.equal(
      rows.find((row) => row.type === "projection.reset_requested")?.payload.reason,
      "operator requested rebuild",
    )

    const next = new RuntimeStore(root)
    assert.equal(next.getSession("s1"), null)
    next.close()
  })

  void it("closes idempotently and allows the store root to reopen", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })

    first.close()
    first.close()

    const next = new RuntimeStore(root)
    assert.equal(next.getAgentSessionId("s1"), "a1")
    next.close()
  })

  void it("reopens checkpointed projections without resetting or replaying durable history", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    db(first).exec(`
      CREATE TRIGGER reject_session_projection_reset
      BEFORE DELETE ON session
      BEGIN
        SELECT RAISE(ABORT, 'checkpointed projections must not be reset');
      END
    `)
    first.close()

    const next = new RuntimeStore(root)
    assert.equal(next.getAgentSessionId("s1"), "a1")
    next.close()
  })

  void it("exports JSONL debug output from the SQLite runtime journal", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })

    const rows = store
      .exportJournalJsonl("s1")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      rows.map((row) => row.control.type),
      ["session.bind"],
    )
    assert.equal(rows[0]?.sessionId, "s1")
    assert.equal(rows[0]?.agentSessionId, "a1")
  })

  void it("replays journaled messages and todos", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      title: "Demo",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messagePartDelta({
        sessionID: "s1",
        messageID: "m1",
        partID: "m1-text",
        field: "text",
        delta: "world",
      }),
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: todoUpdated("s1", [{ id: "native-task-42", content: "Ship", status: "pending", priority: "high" }]),
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: sessionIdle("s1"),
    })

    const next = new RuntimeStore(root)
    const msgs = next.getMessages("s1") as Array<{
      info: { role: string }
      parts: Array<{ type: string; text?: string }>
    }>

    assert.equal(msgs.length, 2)
    assert.equal(msgs[0]?.info.role, "user")
    assert.equal(msgs[0]?.parts[0]?.type, "text")
    assert.equal(msgs[0]?.parts[0]?.text, "hello")
    assert.equal(msgs[1]?.info.role, "assistant")
    assert.equal(msgs[1]?.parts[0]?.type, "text")
    assert.equal(msgs[1]?.parts[0]?.text, "world")
    assert.deepEqual(next.getTodos("s1"), [{ id: "native-task-42", content: "Ship", status: "pending", priority: "high" }])
  })

  void it("migrates task identity without discarding existing todo rows", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    first.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: todoUpdated("s1", [
      { content: "Existing", status: "pending", priority: "medium" },
    ]) })
    db(first).exec("ALTER TABLE todo DROP COLUMN task_id")
    first.close()
    const next = new RuntimeStore(root)
    assert.deepEqual(next.getTodos("s1"), [{ content: "Existing", status: "pending", priority: "medium" }])
    next.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: todoUpdated("s1", [
      { id: "provider-task-7", content: "Existing", status: "completed", priority: "medium" },
    ]) })
    next.close()
    const reopened = new RuntimeStore(root)
    assert.deepEqual(reopened.getTodos("s1"), [{ id: "provider-task-7", content: "Existing", status: "completed", priority: "medium" }])
    reopened.close()
  })

  void it("retains only the latest full snapshot for each message part", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "opencode", modelID: "big-pickle" },
      parts: [{ type: "text", text: "hello" }],
    })
    for (const text of ["first", "second", "latest"]) {
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messagePartUpdated({
          id: "streaming-part",
          sessionID: "s1",
          messageID: "m1",
          type: "text",
          text,
        }),
      })
    }

    const snapshots = db(store)
      .prepare(
        `
      SELECT payload_json
      FROM runtime_journal
      WHERE session_id = ?
        AND type = 'message.part.updated'
        AND part_id = ?
      ORDER BY seq ASC
    `,
      )
      .all("s1", "streaming-part") as Array<{ payload_json: string }>
    assert.equal(snapshots.length, 1)
    assert.equal(JSON.parse(snapshots[0].payload_json).properties.part.text, "latest")
    store.close()

    const reopened = new RuntimeStore(root)
    const messages = reopened.getMessages("s1") as Array<{ parts: Array<{ id: string; text?: string }> }>
    assert.equal(messages[1]?.parts.find((part) => part.id === "streaming-part")?.text, "latest")
    reopened.close()
  })

  void it("rolls back failed session deletes and successful deletes survive replay", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      title: "Demo",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: todoUpdated("s1", [{ content: "Ship", status: "pending", priority: "high" }]),
    })

    db(store).exec(`
      CREATE TRIGGER fail_message_delete
      BEFORE DELETE ON message
      BEGIN
        SELECT RAISE(FAIL, 'message delete failed');
      END
    `)

    assert.throws(() => store.deleteSession("s1"), /message delete failed/)
    db(store).exec("DROP TRIGGER fail_message_delete")

    assert.equal((store.getSession("s1") as any)?.title, "Demo")
    assert.equal(store.getMessages("s1").length, 2)
    assert.deepEqual(store.getTodos("s1"), [{ content: "Ship", status: "pending", priority: "high" }])

    store.deleteSession("s1")
    assert.equal(store.getSession("s1"), null)
    assert.deepEqual(store.getMessages("s1"), [])
    assert.deepEqual(store.getTodos("s1"), [])
    assert.equal(fs.existsSync(path.join(root, "sessions", "s1.jsonl")), false)
    store.close()

    const next = new RuntimeStore(root)
    assert.equal(next.getSession("s1"), null)
    assert.deepEqual(next.getMessages("s1"), [])
    assert.deepEqual(next.getTodos("s1"), [])
    next.close()
  })

  void it("rejects late event appends after session delete and does not resurrect on replay", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      title: "Demo",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.deleteSession("s1")

    assert.throws(
      () =>
        store.appendEvent({
          sessionId: "s1",
          agentSessionId: "a1",
          payload: sessionUpdated({
            id: "s1",
            directory: "/work",
            title: "Late",
            time: { created: 1, updated: 2 },
          } as never),
        }),
      /deleted/,
    )

    const next = new RuntimeStore(root)
    assert.equal(next.getSession("s1"), null)
    next.close()
  })

  void it("preserves agent_session_id through status updates", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "agent-abc",
      createdAt: 1,
    })

    // agent_session_id is present after bind
    assert.equal(store.getAgentSessionId("s1"), "agent-abc")

    // startTurn calls upsertSession without agentSessionId — must not clear it
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "agent-abc",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    assert.equal(store.getAgentSessionId("s1"), "agent-abc")

    // session.idle event also must not clear it
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "agent-abc",
      payload: sessionIdle("s1"),
    })
    assert.equal(store.getAgentSessionId("s1"), "agent-abc")

    // Replay also preserves it
    const next = new RuntimeStore(root)
    assert.equal(next.getAgentSessionId("s1"), "agent-abc")
  })

  void it("preserves an active turn status through session metadata updates", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      title: "New Session",
      agentSessionId: "agent-abc",
      createdAt: 1,
    })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "agent-abc",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "openai", modelID: "gpt-5" },
      parts: [{ type: "text", text: "hello" }],
    })

    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "agent-abc",
      payload: sessionUpdated({
        id: "s1",
        directory: "/work",
        title: "Generated title",
        time: { created: 1, updated: 2 },
      } as never),
    })

    assert.equal((store.getSession("s1") as { status?: string } | null)?.status, "busy")

    const replay = new RuntimeStore(root)
    assert.equal((replay.getSession("s1") as { status?: string } | null)?.status, "busy")
  })

  void it("marks pending interactives stale after interruption", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: permissionAsked({
        id: "p1",
        sessionID: "s1",
        permission: "bash",
        patterns: ["/tmp"],
        metadata: {},
        always: ["/tmp"],
      }),
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: questionAsked({
        id: "q1",
        sessionID: "s1",
        questions: [
          {
            question: "Ship it?",
            header: "Ship it?",
            options: [{ label: "Yes", description: "Ship it" }],
            custom: false,
          },
        ],
      }),
    })
    first.markDirectorySessionsInterrupted("/work", "ACP process restarted")

    const next = new RuntimeStore(root)
    assert.deepEqual(next.listPermissions("/work"), [])
    assert.equal((next.getSession("s1") as any)?.status, "recovering")
    assert.equal(next.consumeRecoveryError("s1"), "ACP process restarted")
    assert.equal(next.consumeRecoveryError("s1"), null)

    const afterAck = new RuntimeStore(root)
    assert.equal(afterAck.consumeRecoveryError("s1"), null)
  })

  void it("lists replayed pending questions from the durable projection", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: questionAsked({
        id: "q1",
        sessionID: "s1",
        questions: [
          {
            question: "Ship it?",
            header: "Ship it?",
            options: [{ label: "Yes", description: "Ship it" }],
            custom: false,
          },
        ],
      }),
    })
    first.close()

    const next = new RuntimeStore(root)
    assert.deepEqual(
      next.listQuestions("/work").map((row) => row.id),
      ["q1"],
    )
    next.close()
  })

  void it("marks only matching owner-key sessions stale after interruption", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      ownerKey: "process-a",
      createdAt: 1,
    })
    first.bindSession({
      sessionId: "s2",
      directory: "/work",
      agentSessionId: "a2",
      ownerKey: "process-b",
      createdAt: 2,
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: permissionAsked({
        id: "p1",
        sessionID: "s1",
        permission: "bash",
        patterns: ["/tmp/a"],
        metadata: {},
        always: ["/tmp/a"],
      }),
    })
    first.appendEvent({
      sessionId: "s2",
      agentSessionId: "a2",
      payload: permissionAsked({
        id: "p2",
        sessionID: "s2",
        permission: "bash",
        patterns: ["/tmp/b"],
        metadata: {},
        always: ["/tmp/b"],
      }),
    })
    first.markSessionsInterruptedByOwner("process-a", "ACP shared process exited")

    const next = new RuntimeStore(root)
    assert.equal(next.getSessionOwnerKey("s1"), "process-a")
    assert.deepEqual(next.listSessionsByOwnerKey("process-b"), ["s2"])
    assert.deepEqual(
      next.listPermissions("/work").map((row) => row.id),
      ["p2"],
    )
    assert.equal((next.getSession("s1") as { status?: string } | null)?.status, "recovering")
    assert.equal((next.getSession("s2") as { status?: string } | null)?.status, undefined)
  })

  void it("terminalizes running tool parts after interruption", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messagePartUpdated({
        id: "tool-1",
        sessionID: "s1",
        messageID: "m1",
        type: "tool",
        callID: "call-1",
        tool: "task",
        state: {
          status: "running",
          input: {},
          time: { start: 2 },
        },
      }),
    })

    first.markDirectorySessionsInterrupted("/work", "ACP process restarted; pending interactive state must be rerun")

    const current = first.getMessages("s1") as Array<{
      parts: Array<{ id: string; type: string; state?: { status?: string; error?: string } }>
    }>
    const toolPart = current[1]?.parts.find((part) => part.id === "tool-1")
    assert.equal(toolPart?.id, "tool-1")
    assert.equal(toolPart?.type, "tool")
    assert.equal(toolPart?.state?.status, "error")
    assert.equal(toolPart?.state?.error, "Tool execution interrupted by ACP restart")

    const next = new RuntimeStore(root)
    const replayed = next.getMessages("s1") as Array<{
      parts: Array<{ id: string; type: string; state?: { status?: string; error?: string } }>
    }>
    const replayedPart = replayed[1]?.parts.find((part) => part.id === "tool-1")
    assert.equal(replayedPart?.id, "tool-1")
    assert.equal(replayedPart?.type, "tool")
    assert.equal(replayedPart?.state?.status, "error")
    assert.equal(replayedPart?.state?.error, "Tool execution interrupted by ACP restart")
    assert.equal((next.getSession("s1") as any)?.status, "recovering")
  })

  void it("renders stale running tools in completed error messages as interrupted", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messagePartUpdated({
        id: "tool-1",
        sessionID: "s1",
        messageID: "m1",
        type: "tool",
        callID: "call-1",
        tool: "read",
        state: {
          status: "running",
          input: {},
          time: { start: 2 },
        },
      }),
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messageUpdated({
        id: "m1",
        sessionID: "s1",
        role: "assistant",
        parentID: "u1",
        time: { created: 1, completed: 3 },
        error: {
          name: "UnknownError",
          data: { message: "ACP prompt timed out after 300000ms of inactivity" },
        },
      } as any),
    })

    const current = store.getMessages("s1") as Array<{
      parts: Array<{ id: string; type: string; state?: { status?: string; error?: string } }>
    }>
    const toolPart = current[1]?.parts.find((part) => part.id === "tool-1")
    assert.equal(toolPart?.state?.status, "error")
    assert.equal(toolPart?.state?.error, "Tool execution interrupted")
  })

  void it("marks busy sessions recovering through explicit runtime recovery", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messagePartUpdated({
        id: "tool-1",
        sessionID: "s1",
        messageID: "m1",
        type: "tool",
        callID: "call-1",
        tool: "read",
        state: {
          status: "running",
          input: {},
          time: { start: 2 },
        },
      }),
    })

    const next = new RuntimeStore(root)
    assert.equal((next.getSession("s1") as any)?.status, "busy")
    next.recoverBusySessions()
    assert.equal((next.getSession("s1") as any)?.status, "recovering")
    assert.equal(
      (next.getSession("s1") as any)?.recovery_error,
      "ACP process restarted; pending interactive state must be rerun",
    )
    const current = next.getMessages("s1") as Array<{
      parts: Array<{ id: string; type: string; state?: { status?: string; error?: string } }>
    }>
    const toolPart = current[1]?.parts.find((part) => part.id === "tool-1")
    assert.equal(toolPart?.state?.status, "error")
    assert.equal(toolPart?.state?.error, "Tool execution interrupted by ACP restart")
  })

  void it("recoverBusySessions is a no-op when no sessions are busy", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    // No turn started, so the session is idle rather than busy.
    first.close()

    const next = new RuntimeStore(root)
    const before = (next.getSession("s1") as { status?: string } | null)?.status ?? null
    next.recoverBusySessions()
    const after = next.getSession("s1") as { status?: string; recovery_error?: string | null } | null
    // Idle sessions are left untouched: not flipped to "recovering", no marker.
    assert.equal(after?.status ?? null, before)
    assert.notEqual(after?.status, "recovering")
    assert.equal(after?.recovery_error ?? null, null)
  })

  void it("finishTurn clears a busy turn through replayable terminal events", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
      parts: [{ type: "text", text: "hello" }],
    })

    assert.equal((store.getSession("s1") as { status?: string } | null)?.status, "busy")
    finishHeldTurn(store, {
      sessionId: "s1",
      assistantMessageId: "m1",
      outcome: { status: "completed", completedAt: 123 },
    })
    assert.equal((store.getSession("s1") as { status?: string } | null)?.status, "idle")
    assert.equal(
      (store.getSession("s1") as { lastTurn?: { assistantMessageId?: string } } | null)?.lastTurn?.assistantMessageId,
      "m1",
    )

    const rows = journal(root, "s1")
    assert.equal(rows.at(-3)?.type, "message.completed")
    assert.equal(rows.at(-2)?.type, "session.idle")
    assert.equal(rows.at(-1)?.type, "turn.finish")

    const replayed = new RuntimeStore(root)
    assert.equal((replayed.getSession("s1") as { status?: string } | null)?.status, "idle")
    assert.equal(
      (replayed.getMessages("s1")[1]?.info.time as { completed?: number } | undefined)?.completed !== undefined,
      true,
    )
  })

  void it("persists the durable generation and rejects every stale producer write after takeover", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    const start = (assistantMessageId: string, fencingToken: number) => first.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: `${assistantMessageId}_user`,
      assistantMessageId,
      agent: "general",
      model: { providerID: "opencode", modelID: "test" },
      parts: [{ type: "text", text: assistantMessageId }],
      fencingToken,
    })

    start("m1", 4)
    first.appendEvent({ sessionId: "s1", payload: sessionIdle("s1"), fencingToken: 4 })
    start("m2", 5)
    assert.throws(
      () => first.appendEvent({ sessionId: "s1", payload: sessionIdle("s1"), fencingToken: 4 }),
      AgentRuntimeStaleTurnError,
    )
    assert.throws(
      () => finishHeldTurn(first, {
        sessionId: "s1",
        assistantMessageId: "m1",
        outcome: { status: "completed", completedAt: 10 },
        fencingToken: 4,
      }),
      AgentRuntimeStaleTurnError,
    )
    first.close()

    const reconstructed = new RuntimeStore(root)
    assert.throws(
      () => reconstructed.appendEvent({ sessionId: "s1", payload: sessionIdle("s1"), fencingToken: 4 }),
      AgentRuntimeStaleTurnError,
    )
    reconstructed.appendEvent({ sessionId: "s1", payload: sessionIdle("s1"), fencingToken: 5 })
    finishHeldTurn(reconstructed, {
      sessionId: "s1",
      assistantMessageId: "m2",
      outcome: { status: "completed", completedAt: 11 },
      fencingToken: 5,
    })
  })

  void it("commits exact usage before terminal lifecycle records", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "claude-sdk", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: sessionUsage({
        sessionID: "s1",
        messageID: "m1",
        contextSize: 200_000,
        contextUsed: 24_542,
        observation: {
          kind: "cumulative",
          tokens: {
            input: 4,
            output: 679,
            reasoning: null,
            cache: { read: 21_144, write: 2_715 },
          },
        },
      }),
    })
    finishHeldTurn(store, {
      sessionId: "s1",
      assistantMessageId: "m1",
      outcome: { status: "completed", completedAt: 123 },
    })

    const rows = journal(root, "s1")
    assert.deepEqual(
      rows.slice(-4).map((row) => row.type),
      ["session.usage", "message.completed", "session.idle", "turn.finish"],
    )
    assert.deepEqual((rows.at(-4)?.payload.properties as { observation?: unknown } | undefined)?.observation, {
      kind: "cumulative",
      tokens: {
        input: 4,
        output: 679,
        reasoning: null,
        cache: { read: 21_144, write: 2_715 },
      },
    })
  })

  void it("finishTurn does not duplicate terminal events already committed by an adapter", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "opencode", modelID: "big-pickle" },
      parts: [{ type: "text", text: "hello" }],
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messageCompleted("s1", "m1"),
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: sessionIdle("s1"),
    })

    finishHeldTurn(store, {
      sessionId: "s1",
      assistantMessageId: "m1",
      outcome: { status: "completed", completedAt: 123 },
    })

    const rows = journal(root, "s1")
    assert.equal(rows.filter((row) => row.type === "message.completed").length, 1)
    assert.equal(rows.filter((row) => row.type === "session.idle").length, 1)
    assert.equal(
      (store.getSession("s1") as { lastTurn?: { assistantMessageId?: string } } | null)?.lastTurn?.assistantMessageId,
      "m1",
    )
  })

  void it("finishTurn durably preserves a cancelled outcome", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "build",
      model: { providerID: "codex-app-server", modelID: "gpt-5.5" },
      parts: [{ type: "text", text: "hello" }],
    })

    finishHeldTurn(store, {
      sessionId: "s1",
      assistantMessageId: "m1",
      outcome: { status: "cancelled", completedAt: 123, reason: "abort" },
    })

    assert.deepEqual((store.getSession("s1") as { lastTurn?: unknown } | null)?.lastTurn, {
      status: "cancelled",
      completedAt: 123,
      reason: "abort",
      assistantMessageId: "m1",
    })
    finishHeldTurn(store, {
      sessionId: "s1",
      assistantMessageId: "m1",
      outcome: { status: "completed", completedAt: 124 },
    })
    assert.deepEqual((store.getSession("s1") as { lastTurn?: unknown } | null)?.lastTurn, {
      status: "cancelled",
      completedAt: 123,
      reason: "abort",
      assistantMessageId: "m1",
    })
    assert.equal(journal(root, "s1").filter((row) => row.type === "turn.finish").length, 1)

    const replayed = new RuntimeStore(root)
    assert.deepEqual((replayed.getSession("s1") as { lastTurn?: unknown } | null)?.lastTurn, {
      status: "cancelled",
      completedAt: 123,
      reason: "abort",
      assistantMessageId: "m1",
    })
  })

  void it("finishTurn records failed turns on the assistant message", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "build",
      model: { providerID: "codex-app-server", modelID: "gpt-5.5" },
      parts: [{ type: "text", text: "hello" }],
    })

    const finished = finishHeldTurn(store, {
      sessionId: "s1",
      assistantMessageId: "m1",
      outcome: { status: "failed", completedAt: 123, error: "The database connection is not open" },
    })

    assert.deepEqual(finished?.events.map((event) => event.type), ["message.updated", "session.error"])

    const assistant = store.getMessages("s1")[1]?.info as {
      error?: { data?: { message?: string; firstTurnErrorClass?: string } }
    }
    assert.equal(assistant.error?.data?.message, "The database connection is not open")
    assert.equal(assistant.error?.data?.firstTurnErrorClass, "unknown")
    assert.equal(
      (store.getSession("s1") as { lastTurn?: { assistantMessageId?: string } } | null)?.lastTurn?.assistantMessageId,
      "m1",
    )

    const rows = journal(root, "s1")
    assert.equal(rows.at(-3)?.type, "message.updated")
    assert.equal(rows.at(-2)?.type, "session.error")
    assert.equal(rows.at(-1)?.type, "turn.finish")

    const replayed = new RuntimeStore(root)
    const replayedAssistant = replayed.getMessages("s1")[1]?.info as {
      error?: { data?: { message?: string; firstTurnErrorClass?: string } }
    }
    assert.equal(replayedAssistant.error?.data?.message, "The database connection is not open")
    assert.equal(replayedAssistant.error?.data?.firstTurnErrorClass, "unknown")
  })

  void it("recoverBusySessions is idempotent once a session is recovering", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })

    const next = new RuntimeStore(root)
    const session = () => next.getSession("s1") as { status?: string; recovery_error?: string | null } | null
    assert.equal(session()?.status, "busy")
    next.recoverBusySessions()
    const firstError = session()?.recovery_error
    assert.equal(session()?.status, "recovering")
    assert.equal(firstError, "ACP process restarted; pending interactive state must be rerun")

    // A second recovery pass finds no busy sessions (the first pass flipped it to
    // "recovering"), so the marker is unchanged.
    next.recoverBusySessions()
    assert.equal(session()?.status, "recovering")
    assert.equal(session()?.recovery_error, firstError)
  })

  void it("returns normalized session objects from the store", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      title: "Demo",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.updateSession("s1", { time: { archived: 0 } })

    const sessions = store.listSessions("/work") as any[]
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]?.id, "s1")
    assert.equal(sessions[0]?.title, "Demo")
    assert.equal(sessions[0]?.directory, "/work")
    assert.equal(sessions[0]?.agent_session_id, "a1")
    assert.equal(sessions[0]?.time?.created, 1)
    assert.equal(typeof sessions[0]?.time?.updated, "number")
    assert.equal(sessions[0]?.time?.archived, 0)

    const session = store.getSession("s1") as any
    assert.equal(session?.id, "s1")
    assert.equal(session?.title, "Demo")
    assert.equal(session?.directory, "/work")
    assert.equal(session?.agent_session_id, "a1")
    assert.equal(session?.time?.created, 1)
    assert.equal(session?.time?.archived, 0)

    const next = new RuntimeStore(root)
    assert.equal((next.getSession("s1") as any)?.time?.archived, 0)
  })

  void it("persists permission selection across reopen and clears it on a harness change", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({ sessionId: "restricted", directory: "/work", agentSessionId: "a1" })
    first.updateSessionConfig("restricted", { harness: { id: "codex", access: "native" }, permissionCeiling: "ask", permissionMode: "read-only", permissionState: { allow: ["Bash(printf approved-write *)"] } })
    first.updateSessionConfig("restricted", { agent: "build" })
    const reopened = new RuntimeStore(root)
    assert.equal(reopened.getSessionConfig("restricted")?.permissionCeiling, "ask")
    assert.equal(reopened.getSessionConfig("restricted")?.permissionMode, "read-only")
    assert.deepEqual(reopened.getSessionConfig("restricted")?.permissionState, { allow: ["Bash(printf approved-write *)"] })
    reopened.updateSessionConfig("restricted", { harness: { id: "claude", access: "native" } })
    assert.equal(reopened.getSessionConfig("restricted")?.permissionCeiling, "ask")
    assert.equal(reopened.getSessionConfig("restricted")?.permissionMode, undefined)
    assert.equal(reopened.getSessionConfig("restricted")?.permissionState, undefined)
  })

  void it("persists startup questions without an executable session or cross-directory visibility", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    const binding = { sessionId: "startup", directory: "/work", workspaceId: "workspace", connectionId: "connection:agent", operationId: "operation" }
    store.sessionStarts.begin(binding)
    store.appendEvent({ sessionId: "startup", payload: questionAsked({ id: "startup-question", sessionID: "startup", questions: [{ header: "Setup", question: "Continue?", options: [] }] }) })
    assert.equal(store.getSession("startup"), null)
    assert.deepEqual(store.listSessions("/work"), [])
    assert.equal(store.listQuestions("/work")[0]?.id, "startup-question")
    assert.deepEqual(store.listQuestions("/other"), [])
    store.close()
    const reopened = new RuntimeStore(root)
    assert.deepEqual(reopened.sessionStarts.get("startup")?.binding, binding)
    assert.equal(reopened.listQuestions("/work")[0]?.id, "startup-question")
    assert.equal(reopened.getSession("startup"), null)
  })

  void it("preserves elicitation schema through reload without resurrecting process resolvers", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({ sessionId: "elicitation", directory: "/work", agentSessionId: "agent", createdAt: 1 })
    const questions = [{ header: "Agent", question: "Choose", options: [], elicitation: {
      mode: "form" as const, agentName: "Agent", message: "Choose", requestedSchema: { type: "object" as const,
        properties: { count: { type: "integer" as const, default: 2 } }, required: ["count"] },
    } }]
    first.appendEvent({ sessionId: "elicitation", payload: questionAsked({ id: "q1", sessionID: "elicitation", questions }) })
    first.close()
    const reopened = new RuntimeStore(root)
    assert.deepEqual(reopened.listQuestions("/work")[0]?.questions, questions)
    reopened.markSessionInterrupted("elicitation", "Agent process lost")
    assert.deepEqual(reopened.listQuestions("/work"), [])
  })

  void it("persists agent command updates, clears them, and isolates sessions", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    for (const sessionId of ["one", "two"]) first.bindSession({ sessionId, directory: "/work", agentSessionId: `agent-${sessionId}`, createdAt: 1 })
    const commands = [{ name: "review", description: "Review changes", input: { hint: "<path>" } }]
    first.appendEvent({ sessionId: "one", payload: { type: "session.commands", properties: { sessionID: "one", commands } } })
    assert.deepEqual(first.getSession("one")?.commands, commands)
    assert.equal(first.getSession("two")?.commands, undefined)
    first.close()
    const reopened = new RuntimeStore(root)
    assert.deepEqual(reopened.getSession("one")?.commands, commands)
    reopened.bindSession({ sessionId: "one", directory: "/work", agentSessionId: "agent-one-resumed", createdAt: 1 })
    assert.deepEqual(reopened.getSession("one")?.commands, commands)
    assert.deepEqual(reopened.listSessions("/work").find((session) => session.id === "one")?.commands, commands)
    reopened.appendEvent({ sessionId: "one", payload: { type: "session.commands", properties: { sessionID: "one", commands: [] } } })
    reopened.close()
    const cleared = new RuntimeStore(root)
    assert.deepEqual(cleared.getSession("one")?.commands, [])
    cleared.updateSessionConfig("one", { harness: { id: "example", access: "connection" } })
    cleared.appendEvent({ sessionId: "one", payload: { type: "session.commands", properties: { sessionID: "one", commands } } })
    cleared.updateSessionConfig("one", { harness: { id: "codex", access: "native" } })
    assert.equal(cleared.getSession("one")?.commands, undefined)
  })

  void it("persists session config across replay", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.updateSessionConfig("s1", {
      harness: {
        id: "openclaw",
        access: "connection",
      },
      model: {
        providerID: "acp:openclaw",
        modelID: "sonnet",
      },
      variant: "max",
      agent: "plan",
    })

    const expectedConfig = {
      harness: {
        id: "openclaw",
        access: "connection",
      },
      model: {
        providerID: "acp:openclaw",
        modelID: "sonnet",
      },
      variant: "max",
      agent: "plan",
    }
    assert.deepEqual(first.getSessionConfig("s1"), expectedConfig)

    const next = new RuntimeStore(root)
    assert.deepEqual(next.getSessionConfig("s1"), expectedConfig)
  })

  void it("retains create-time instructions across reopen and through a harness change", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    first.updateSessionConfig("s1", { harness: { id: "codex", access: "native" }, instructions: "Answer only in haiku." })
    assert.equal(first.getSessionConfig("s1")?.instructions, "Answer only in haiku.")

    const reopened = new RuntimeStore(root)
    assert.equal(reopened.getSessionConfig("s1")?.instructions, "Answer only in haiku.")
    reopened.updateSessionConfig("s1", { harness: { id: "claude", access: "native" } })
    assert.equal(reopened.getSessionConfig("s1")?.instructions, "Answer only in haiku.")
    reopened.updateSessionConfig("s1", { instructions: null })
    assert.equal(reopened.getSessionConfig("s1")?.instructions, undefined)
    assert.equal(new RuntimeStore(root).getSessionConfig("s1")?.instructions, undefined)
  })

  void it("retains the create-time model group across reopen and through a harness change", () => {
    const root = tmp()
    const group = {
      primary: { harness: { id: "claude", access: "native" }, model: { providerID: "anthropic", modelID: "opus" }, effort: "high" },
      review: { harness: { id: "codex", access: "native" }, model: { providerID: "openai", modelID: "gpt-5-codex" } },
    } as const
    const first = new RuntimeStore(root)
    first.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    first.updateSessionConfig("s1", { harness: { id: "codex", access: "native" }, group })
    assert.deepEqual(first.getSessionConfig("s1")?.group, group)

    const reopened = new RuntimeStore(root)
    assert.deepEqual(reopened.getSessionConfig("s1")?.group, group)
    reopened.updateSessionConfig("s1", { harness: { id: "claude", access: "native" } })
    assert.deepEqual(reopened.getSessionConfig("s1")?.group, group)
    reopened.updateSessionConfig("s1", { group: null })
    assert.equal(reopened.getSessionConfig("s1")?.group, undefined)
    assert.equal(new RuntimeStore(root).getSessionConfig("s1")?.group, undefined)
  })

  void it("writes the group of a config applied before the session row exists", () => {
    const root = tmp()
    const group = {
      planning: { harness: { id: "claude", access: "native" }, model: { providerID: "anthropic", modelID: "opus" } },
    } as const
    const first = new RuntimeStore(root)
    first.updateSessionConfig("s1", { harness: { id: "claude", access: "native" }, group }, { directory: "/work" })
    assert.deepEqual(new RuntimeStore(root).getSessionConfig("s1")?.group, group)
  })

  void it("reads back no group when the stored row is not a valid group", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    store.updateSessionConfig("s1", {
      harness: { id: "codex", access: "native" },
      group: { primary: { harness: { id: "codex", access: "native" }, model: { providerID: "openai", modelID: "gpt-5-codex" } } },
    })
    ;(store as unknown as { db: { prepare(sql: string): { run(...params: unknown[]): unknown } } })
      .db.prepare("UPDATE session SET group_json = ? WHERE id = ?").run('{"archivist":{}}', "s1")
    assert.equal(new RuntimeStore(root).getSessionConfig("s1")?.group, undefined)
  })

  void it("persists and clears a pending cross-harness handoff", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    first.updateSessionConfig("s1", {
      harness: { id: "claude", access: "native" },
      handoff: {
        from: { id: "pi", access: "native" },
        pending: true,
        transcript: '<session-handoff from="pi">\n\nremember Tommy\n\n</session-handoff>',
      },
    })

    const replayed = new RuntimeStore(root)
    assert.deepEqual(replayed.getSessionConfig("s1")?.handoff, {
      from: { id: "pi", access: "native" },
      pending: true,
      transcript: '<session-handoff from="pi">\n\nremember Tommy\n\n</session-handoff>',
    })

    replayed.updateSessionConfig("s1", { handoff: null })
    assert.equal(replayed.getSessionConfig("s1")?.handoff, undefined)
    assert.equal(new RuntimeStore(root).getSessionConfig("s1")?.handoff, undefined)
  })

})

void describe("RuntimeStore session projection cost", () => {
  void it("resolves lastTurn through the terminal-row partial index instead of walking the journal", () => {
    const root = tmp()
    const store = new RuntimeStoreImpl(root)
    const db = (store as unknown as { db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } } }).db
    // The same statement `lastTurn` runs. If the predicate drifts from the
    // index predicate the planner silently falls back to the primary key and
    // every session read scans that session's whole journal again.
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT seq, type, created_at, payload_json
      FROM runtime_journal
      WHERE session_id = ?
        AND (
          (kind = 'control' AND type = 'turn.finish')
          OR (kind = 'event' AND type IN ('message.completed', 'session.error'))
        )
      ORDER BY seq DESC
      LIMIT 1
    `).all("s1") as Array<{ detail: string }>
    assert.ok(
      plan.some((row) => row.detail.includes("runtime_journal_turn_outcome_idx")),
      `lastTurn does not use runtime_journal_turn_outcome_idx: ${plan.map((row) => row.detail).join(" | ")}`,
    )
    store.close()
  })
})

void describe("canonical execution binding", () => {
  void it("persists the complete binding and never derives it from provider inventory", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      directory: "/work/a",
      connectionId: "native:pi",
      upstreamSessionId: "thread-1",
      agentSessionId: "thread-1",
    })
    assert.deepEqual(store.getExecutionBinding("session-1"), {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      directory: "/work/a",
      connectionId: "native:pi",
      upstreamSessionId: "thread-1",
    })
    assert.equal((store.getSession("session-1") as { workspaceId?: string })?.workspaceId, "workspace-1")
    assert.equal((store.listSessions("/work/a")[0] as { workspaceId?: string })?.workspaceId, "workspace-1")
    const reopened = new RuntimeStore(root)
    assert.deepEqual(reopened.getExecutionBinding("session-1"), store.getExecutionBinding("session-1"))
    assert.equal(reopened.getExecutionBinding("provider-only"), null)
  })
})

void describe("provisional user parts", () => {
  /**
   * Three layers each record the user's prompt, each minting its own id:
   *   `${messageId}-part-N`       — this store's `inputParts` (via startTurn)
   *   `NNNNNN_${messageId}-input` — the opencode adapter's `promptParts`
   *   `prt_…`                     — the engine's own persisted part
   * Captured live: ONE send produced all three, so the transcript rendered the
   * prompt three times. The provider request always carried one part, so this
   * was transcript fidelity, never model input.
   */
  const engineCanonical = (messageId: string, text: string) =>
    messagePartUpdated({
      id: "prt_fbf520445001MRpnaorKB7bmPL",
      sessionID: "s1",
      messageID: messageId,
      type: "text",
      text,
    })

  function seeded(root: string) {
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    // startTurn writes this store's own provisional part: `u1-part-0`.
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "test-provider", modelID: "test-model" },
      parts: [{ type: "text", text: "UNIQUE-PROMPT-XYZ" }],
    })
    return store
  }

  const userParts = (store: RuntimeStore) =>
    (
      (store.getMessages("s1") as Array<{ info: { id: string }; parts: Array<{ id: string }> }>).find(
        (message) => message.info.id === "u1",
      )?.parts ?? []
    ).map((part) => part.id)

  void it("keeps provisional parts while NO canonical part exists — nothing is dropped without a replacement", () => {
    // The durability case these writers exist for: the engine never responds.
    const store = seeded(tmp())

    const parts = userParts(store)
    assert.ok(parts.length > 0, "a turn whose engine never answered must still show the user's prompt")
    assert.deepEqual(parts, ["u1-part-0"])
    store.close()
  })

  void it("keeps a multi-part prompt whole while the engine has persisted only some of it", () => {
    // The engine mints its own ids (`prt_…`), so there is NO id correspondence
    // between a canonical part and the provisional it replaces. Retiring every
    // provisional the moment ONE canonical part landed therefore erased the
    // second half of a two-part prompt outright — the attachment case. A
    // replacement must be in hand for each provisional before any is dropped,
    // and with no id to match on, count is the only honest proxy.
    const store = new RuntimeStore(tmp())
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "test-provider", modelID: "test-model" },
      parts: [
        { type: "text", text: "PROMPT" },
        { type: "text", text: "ATTACHED" },
      ],
    })
    const canonical = (id: string, text: string) =>
      messagePartUpdated({ id, sessionID: "s1", messageID: "u1", type: "text", text })

    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: canonical("prt_first", "PROMPT") })
    assert.deepEqual(
      userParts(store).sort(),
      ["prt_first", "u1-part-0", "u1-part-1"],
      "one canonical part cannot replace two provisionals — the prompt must stay whole",
    )

    // Once the engine has persisted the whole prompt, the provisionals go.
    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: canonical("prt_second", "ATTACHED") })
    assert.deepEqual(userParts(store).sort(), ["prt_first", "prt_second"])
    store.close()
  })

  void it("a canonical part on ONE user message leaves another's provisionals alone", () => {
    // The mutation this exists to catch: a predicate matching id SHAPE alone
    // (any `*-part-N`) rather than THIS message's id would retire
    // a second turn's provisionals the moment the first turn's engine part
    // landed. Needs two user messages, each holding provisionals, to discriminate.
    const store = seeded(tmp())
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u2",
      assistantMessageId: "m2",
      agent: "general",
      model: { providerID: "test-provider", modelID: "test-model" },
      parts: [{ type: "text", text: "SECOND" }],
    })
    // u1's engine part lands; u2's turn is still in flight.
    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: engineCanonical("u1", "FIRST") })

    const u2 = (
      (store.getMessages("s1") as Array<{ info: { id: string }; parts: Array<{ id: string }> }>).find(
        (message) => message.info.id === "u2",
      )?.parts ?? []
    ).map((part) => part.id)
    assert.deepEqual(u2, ["u2-part-0"], "u2's provisional must survive u1's canonical part")
    store.close()
  })

  void it("does not retire another message's provisional parts", () => {
    const store = seeded(tmp())
    // A canonical part on the ASSISTANT message must not touch the user's.
    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: engineCanonical("m1", "OK") })

    // The user's provisional must survive: a predicate that matched on id shape
    // alone rather than on this message's id would retire it.
    assert.deepEqual(userParts(store), ["u1-part-0"])
    store.close()
  })
})


void it("persists Goal state across reopen and clears it with the session", () => {
  const root = tmp()
  const store = new RuntimeStore(root)
  store.bindSession({ sessionId: "goal-session", directory: "/work", agentSessionId: "pi-native" })
  const goal = { sessionId: "goal-session", objective: "Verify the workspace", status: "active" as const, iteration: 0, createdAt: 1, updatedAt: 1 }
  store.setGoal("goal-session", goal)
  assert.deepEqual(store.getGoal("goal-session"), goal)
  assert.ok(journal(root, "goal-session").some((row) => row.type === "goal.update"))
  const reopened = new RuntimeStore(root)
  assert.deepEqual(reopened.getGoal("goal-session"), goal)
  reopened.setGoal("goal-session", { ...goal, status: "paused", updatedAt: 2 })
  assert.equal(store.getGoal("goal-session")?.status, "paused")
  reopened.setGoal("goal-session", null)
  assert.equal(new RuntimeStore(root).getGoal("goal-session"), null)
  reopened.setGoal("goal-session", goal)
  reopened.deleteSession("goal-session")
  assert.equal(store.getGoal("goal-session"), null)
})

void describe("session ordering timestamps", () => {
  void it("recovery does not restamp the session the way a turn does", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1_000 })
    store.startTurn({
      sessionId: "s1",
      assistantMessageId: "m1",
      agent: "claude",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
      parts: [{ type: "text", text: "hi" }],
    })

    // A turn and a recovery both stamp `Date.now()`, so within one test run they are
    // the same millisecond and indistinguishable. Pin the turn's stamp to a value the
    // clock cannot produce, so a restamp is visible.
    const db = (store as unknown as { db: { prepare(sql: string): { run(...p: unknown[]): unknown } } }).db
    db.prepare("UPDATE session SET updated_at = ? WHERE id = ?").run(111, "s1")

    // The three recovery paths: the runtime's own bookkeeping, never the reader
    // speaking to the session, so the sidebar must not reorder behind them.
    store.markRecovering("s1", "recovering")
    store.createNotice("s1", { notice: "recovery_error", message: "created notice" })
    store.markDirectorySessionsInterrupted("/work", "ACP process restarted")

    const after = store.getSession("s1") as
      | { status?: string; time?: { created?: number; updated?: number } }
      | null
    assert.equal(after?.status, "recovering")
    assert.equal(after?.time?.updated, 111)
    assert.equal(after?.time?.created, 1_000)
  })

  void it("only a human turn records lastHumanTurn; an agent turn moves updated alone", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    const turn = (sessionId: string, actorKind?: "human" | "agent") =>
      store.startTurn({
        sessionId,
        assistantMessageId: `m-${sessionId}-${actorKind ?? "none"}`,
        agent: "claude",
        model: { providerID: "anthropic", modelID: "claude-opus-5" },
        parts: [{ type: "text", text: "hi" }],
        ...(actorKind ? { actorId: "actor-1", actorKind } : {}),
      })
    const read = (id: string) =>
      store.getSession(id) as { time?: { updated?: number; lastHumanTurn?: number } } | null

    store.bindSession({ sessionId: "human", directory: "/work", agentSessionId: "ah", createdAt: 1 })
    store.bindSession({ sessionId: "agent", directory: "/work", agentSessionId: "aa", createdAt: 1 })
    turn("human", "human")
    turn("agent", "agent")

    assert.ok(typeof read("human")?.time?.lastHumanTurn === "number")
    // A wake or subagent driving a session must not make it look freshly spoken to.
    assert.equal(read("agent")?.time?.lastHumanTurn, undefined)
    assert.ok(typeof read("agent")?.time?.updated === "number")
  })

  void it("an agent turn after a human one leaves the human stamp where it was", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    store.startTurn({
      sessionId: "s1",
      assistantMessageId: "m1",
      agent: "claude",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
      parts: [{ type: "text", text: "hi" }],
      actorId: "actor-1",
      actorKind: "human",
    })
    const db = (store as unknown as { db: { prepare(sql: string): { run(...p: unknown[]): unknown } } }).db
    db.prepare("UPDATE session SET last_human_turn_at = ? WHERE id = ?").run(222, "s1")

    store.startTurn({
      sessionId: "s1",
      assistantMessageId: "m2",
      agent: "claude",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
      parts: [{ type: "text", text: "wake" }],
      actorId: "wake-1",
      actorKind: "agent",
    })

    const after = store.getSession("s1") as { time?: { lastHumanTurn?: number } } | null
    assert.equal(after?.time?.lastHumanTurn, 222)
  })

  void it("the directory listing carries lastHumanTurn, which is what the session list orders on", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "spoken", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    store.bindSession({ sessionId: "quiet", directory: "/work", agentSessionId: "a2", createdAt: 2 })
    store.startTurn({
      sessionId: "spoken",
      assistantMessageId: "m1",
      agent: "claude",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
      parts: [{ type: "text", text: "hi" }],
      actorId: "actor-1",
      actorKind: "human",
    })
    store.startTurn({
      sessionId: "quiet",
      assistantMessageId: "m2",
      agent: "claude",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
      parts: [{ type: "text", text: "wake" }],
      actorId: "wake-1",
      actorKind: "agent",
    })

    const rows = store.listSessions("/work") as Array<{ id: string; time?: { lastHumanTurn?: number } }>
    const by = new Map(rows.map((row) => [row.id, row.time?.lastHumanTurn]))
    assert.ok(typeof by.get("spoken") === "number")
    assert.equal(by.get("quiet"), undefined)
  })
})

void describe("streamed delta settlement", () => {
  const db = (store: RuntimeStore) => (store as unknown as { db: { prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown } } }).db
  const text = (store: RuntimeStore, sessionId: string) =>
    store.getMessages(sessionId).flatMap((message) => message.parts).map((part) => (part as { text?: string }).text).join("|")
  const delta = (store: RuntimeStore, chunk: string) =>
    store.appendEvent({
      sessionId: "s1",
      payload: { type: "message.part.delta", properties: { sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: chunk } },
    } as never)
  const bind = (store: RuntimeStore) => {
    store.bindSession({ sessionId: "s1", directory: "/w", agentSessionId: "a1" })
    store.appendEvent({ sessionId: "s1", payload: { type: "message.updated", properties: { info: { id: "m1", sessionID: "s1", role: "assistant" } } } } as never)
  }

  void it("journals every delta at once but writes the part and its checkpoint only when settled", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    bind(store)
    for (const chunk of ["one ", "two ", "three"]) delta(store, chunk)
    const rows = db(store).prepare("SELECT seq, type FROM runtime_journal WHERE session_id = ? ORDER BY seq").all("s1") as Array<{ seq: number; type: string }>
    assert.equal(rows.filter((row) => row.type === "message.part.delta").length, 3)
    assert.deepEqual(db(store).prepare("SELECT count(*) AS n FROM part WHERE id = ?").get("p1"), { n: 0 }, "no part row before settlement")
    const checkpoint = db(store).prepare("SELECT last_seq FROM journal_checkpoint WHERE session_id = ?").get("s1") as { last_seq: number }
    assert.ok(checkpoint.last_seq < rows[rows.length - 1]?.seq, "checkpoint lags the unsettled deltas")

    assert.equal(text(store, "s1"), "one two three")
    const settled = db(store).prepare("SELECT last_seq FROM journal_checkpoint WHERE session_id = ?").get("s1") as { last_seq: number }
    assert.equal(settled.last_seq, rows[rows.length - 1]?.seq)
    store.close()
  })

  void it("a snapshot or any other event for the session lands after the deltas before it", () => {
    const store = new RuntimeStore(tmp())
    bind(store)
    delta(store, "draft ")
    store.appendEvent({
      sessionId: "s1",
      payload: { type: "message.part.updated", properties: { part: { id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "final" } } },
    } as never)
    delta(store, " plus")
    assert.equal(text(store, "s1"), "final plus")
    store.close()
  })

  void it("deltas the process died on before settling are replayed from the journal on reopen", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    bind(store)
    for (const chunk of ["never ", "settled"]) delta(store, chunk)
    // Drop the handle without settling, the way a crash would.
    const raw = store as unknown as { db: { close(): void }; closed: boolean; pendingDeltas: Map<string, unknown> }
    raw.pendingDeltas.clear()
    raw.db.close()
    raw.closed = true

    const reopened = new RuntimeStore(root)
    assert.equal(text(reopened, "s1"), "never settled")
    reopened.close()
  })
})

void it("later events cannot checkpoint past a failed approval, and repair replays it before continuing", () => {
  const root = tmp()
  const store = new RuntimeStore(root)
  store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
  store.bindSession({ sessionId: "s2", directory: "/other", agentSessionId: "a2", createdAt: 1 })
  const permission = { id: "blocked", sessionID: "s1", permission: "command", patterns: [], always: [], metadata: {} }
  db(store).exec("ALTER TABLE pending_permission DROP COLUMN options_json")
  assert.throws(() => store.appendEvent({ sessionId: "s1", payload: permissionAsked(permission) }), /options_json/)
  const checkpoint = () => db(store).prepare("SELECT last_seq FROM journal_checkpoint WHERE session_id = ?").get("s1")
  const before = checkpoint()
  assert.throws(() => store.appendEvent({ sessionId: "s1", payload: sessionIdle("s1") }), /options_json/)
  assert.throws(() => store.appendEvent({ sessionId: "s1", payload: messagePartDelta({ sessionID: "s1", messageID: "m", partID: "p", field: "text", delta: "later" }) }), /options_json/)
  assert.deepEqual(checkpoint(), before)
  // A failed session does not prevent an unrelated session from progressing.
  store.appendEvent({ sessionId: "s2", payload: sessionIdle("s2") })
  db(store).exec("ALTER TABLE pending_permission ADD COLUMN options_json TEXT")
  store.appendEvent({ sessionId: "s1", payload: sessionIdle("s1") })
  assert.deepEqual(store.listPermissions("/work"), [permission])
  store.close()
  const reopened = new RuntimeStore(root)
  assert.deepEqual(reopened.listPermissions("/work"), [permission])
})

void it("migrates existing permission storage and replays an unprojected approval", () => {
  const root = tmp()
  const first = new RuntimeStore(root)
  first.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
  const existing = { id: "existing", sessionID: "s1", permission: "command", patterns: ["pwd"], always: [], metadata: {} }
  first.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: permissionAsked(existing) })
  db(first).exec("ALTER TABLE pending_permission DROP COLUMN options_json")
  const pending = { ...existing, id: "unprojected", options: [{ id: "accept", label: "Allow once" }] }
  // The request is journaled before projection fails against the old schema.
  assert.throws(() => first.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: permissionAsked(pending) }), /options_json/)
  first.close()

  const next = new RuntimeStore(root)
  assert.deepEqual(next.listPermissions("/work"), [existing, pending])
  assert.deepEqual(next.listPermissions("/other"), [])
  next.close()
  const reopened = new RuntimeStore(root)
  assert.deepEqual(reopened.listPermissions("/work"), [existing, pending])
})

void it("persists provider permission options across reload, preserving empty versus absent", () => {
  const root = tmp()
  const first = new RuntimeStore(root)
  first.bindSession({ sessionId: "options-session", directory: "/work", agentSessionId: "options-agent", createdAt: 1 })
  const choices = [{ id: '{"persist":"session"}', label: "Accept for session", description: "Supplied scope" }]
  const permissions = [
    { id: "dynamic", options: choices },
    { id: "empty", options: [] },
    { id: "native" },
  ].map((item) => ({ ...item, sessionID: "options-session", permission: "mcp", patterns: [], always: [], metadata: {} }))
  for (const permission of permissions) {
    first.appendEvent({ sessionId: "options-session", agentSessionId: "options-agent", payload: permissionAsked(permission) })
  }
  assert.deepEqual(first.listPermissions("/work"), permissions)
  first.close()
  const reopened = new RuntimeStore(root)
  assert.deepEqual(reopened.listPermissions("/work"), permissions)
  assert.deepEqual(reopened.listPermissions("/other"), [])
})

void it("preserves canonical title precedence across binding, replay and legacy projection migration", () => {
  const root = tmp()
  const store = new RuntimeStore(root)
  store.bindSession({ sessionId: "titled", directory: "/work", title: "New Session", agentSessionId: "agent-title" })
  const update = (title: string, titleSource?: "prompt" | "harness" | "user") => store.appendEvent({
    sessionId: "titled", payload: sessionUpdated({ id: "titled", directory: "/work", title, ...(titleSource ? { titleSource } : {}), time: { created: 1, updated: 20 } }),
  })
  update("Prompt placeholder", "prompt")
  update("Agent title", "harness")
  update("Late unranked title")
  assert.equal(store.getSession("titled")?.title, "Agent title")
  assert.equal(store.getSession("titled")?.titleSource, "harness")
  store.bindSession({ sessionId: "titled", directory: "/work", title: "Agent title", agentSessionId: "agent-resumed" })
  assert.equal(store.getSession("titled")?.titleSource, "harness")
  store.updateSession("titled", { title: "My chosen title" })
  update("Late generated title", "harness")
  assert.equal(store.getSession("titled")?.title, "My chosen title")
  assert.equal(store.getSession("titled")?.titleSource, "user")
  assert.equal(store.listSessions("/work")[0]?.titleSource, "user")
  const timestamp = store.getSession("titled")?.time.updated
  // Simulate the old projection: source was absent and a stale event had
  // overwritten the user title. Rebuild only from the authoritative journal.
  db(store).exec("ALTER TABLE session DROP COLUMN title_source")
  db(store).prepare("UPDATE session SET title = ? WHERE id = ?").run("Late generated title", "titled")
  const reopened = new RuntimeStore(root)
  assert.equal(reopened.getSession("titled")?.title, "My chosen title")
  assert.equal(reopened.getSession("titled")?.titleSource, "user")
  assert.equal(reopened.getSession("titled")?.time.updated, timestamp)
  reopened.bindSession({ sessionId: "chosen", directory: "/work", title: "Chosen at creation", agentSessionId: "agent-chosen" })
  assert.equal(reopened.getSession("chosen")?.titleSource, "user")
})


const requireDriver = createRequire(import.meta.url)

/**
 * A second connection to the same store file, outside any RuntimeStore. Two
 * RuntimeStore handles both migrate, so a test about what a concurrent
 * connection does to a migration needs one that does not.
 */
function rawDatabase(root: string) {
  const driver = requireDriver("better-sqlite3")
  const Database = (driver as { default?: unknown }).default ?? driver
  return new (Database as new (file: string) => {
    exec(sql: string): unknown
    prepare(sql: string): { get(...params: unknown[]): unknown }
    close(): void
  })(path.join(root, "state.db"))
}

function turnFixture(store: RuntimeStore, sessionId = "s1") {
  store.bindSession({ sessionId, directory: "/work", agentSessionId: "a1", createdAt: 1 })
  const leaseId = store.acquireTurnLease(sessionId)
  assert.ok(leaseId)
  store.startTurn({
    sessionId,
    agentSessionId: "a1",
    userMessageId: "u1",
    assistantMessageId: "m1",
    agent: "build",
    model: { providerID: "anthropic", modelID: "opus" },
    parts: [{ type: "text", text: "go" }],
  })
  return leaseId
}

function journalTypes(store: RuntimeStore, sessionId = "s1") {
  return (db(store).prepare("SELECT type FROM runtime_journal WHERE session_id = ? ORDER BY seq").all(sessionId) as Array<{ type: string }>)
    .map((row) => row.type)
}

void it("finishTurn refuses a writer whose durable turn lease was replaced", () => {
  const store = new RuntimeStore(tmp())
  const leaseId = turnFixture(store)
  store.releaseTurnLease("s1", leaseId)
  const replacement = store.acquireTurnLease("s1")
  assert.notEqual(replacement, leaseId)

  assert.throws(
    () => store.finishTurn({ sessionId: "s1", assistantMessageId: "m1", outcome: { status: "completed", completedAt: 5 }, leaseId }),
    AgentRuntimeStaleTurnError,
  )
  assert.equal(journalTypes(store).includes("turn.finish"), false)
  assert.equal(store.getSession("s1")?.status, "busy")

  store.finishTurn({ sessionId: "s1", assistantMessageId: "m1", outcome: { status: "completed", completedAt: 5 }, leaseId: replacement! })
  assert.equal(journalTypes(store).includes("turn.finish"), true)
  assert.equal(store.getSession("s1")?.status, "idle")
  store.close()
})

void it("finishTurn refuses a writer whose lease was released and never reacquired", () => {
  const store = new RuntimeStore(tmp())
  const leaseId = turnFixture(store)
  store.releaseTurnLease("s1", leaseId)
  assert.equal(store.readTurnAuthority("s1"), undefined)
  assert.throws(
    () => store.finishTurn({ sessionId: "s1", outcome: { status: "completed", completedAt: 5 }, leaseId }),
    AgentRuntimeStaleTurnError,
  )
  assert.equal(journalTypes(store).includes("turn.finish"), false)
  store.close()
})

void it("a terminal write that fails leaves no half-finished turn, and the retry after repair completes it", () => {
  const root = tmp()
  const store = new RuntimeStore(root)
  const leaseId = turnFixture(store)
  db(store).exec(`
    CREATE TRIGGER fail_terminal_status
    BEFORE UPDATE ON session
    WHEN NEW.status = 'idle'
    BEGIN
      SELECT RAISE(FAIL, 'terminal status write failed');
    END
  `)

  assert.throws(
    () => store.finishTurn({ sessionId: "s1", assistantMessageId: "m1", outcome: { status: "completed", completedAt: 5 }, leaseId }),
    /terminal status write failed/,
  )
  const attempted = journalTypes(store)
  assert.equal(attempted.includes("turn.finish"), false)
  assert.equal(attempted.includes("message.completed"), false)
  assert.equal(attempted.includes("session.idle"), false)
  assert.equal(store.getSession("s1")?.status, "busy")
  store.close()

  // The crash boundary: nothing of the failed finalization survives the reopen.
  const reopened = new RuntimeStore(root)
  assert.equal(reopened.getSession("s1")?.status, "busy")
  assert.equal(journalTypes(reopened).includes("turn.finish"), false)

  // Repair the storage fault; the same turn finalizes, once.
  db(reopened).exec("DROP TRIGGER fail_terminal_status")
  reopened.finishTurn({ sessionId: "s1", assistantMessageId: "m1", outcome: { status: "completed", completedAt: 5 }, leaseId })
  assert.equal(reopened.getSession("s1")?.status, "idle")
  assert.deepEqual(
    journalTypes(reopened).filter((type) => type !== "session.bind" && type !== "turn.start"),
    ["message.completed", "session.idle", "turn.finish"],
  )
  reopened.close()
})

void it("a journal append that fails leaves the session unchanged and reopens without it", () => {
  const root = tmp()
  const store = new RuntimeStore(root)
  turnFixture(store)
  db(store).exec(`
    CREATE TRIGGER fail_journal_append
    BEFORE INSERT ON runtime_journal
    WHEN NEW.type = 'session.idle'
    BEGIN
      SELECT RAISE(FAIL, 'journal append failed');
    END
  `)
  assert.throws(() => store.appendEvent({ sessionId: "s1", payload: sessionIdle("s1") }), /journal append failed/)
  assert.equal(journalTypes(store).includes("session.idle"), false)
  store.close()

  const reopened = new RuntimeStore(root)
  assert.equal(reopened.getSession("s1")?.status, "busy")
  assert.equal(journalTypes(reopened).includes("session.idle"), false)
  reopened.close()
})

void it("a lease release that fails reaches its caller and leaves the lease held", () => {
  const store = new RuntimeStore(tmp())
  const leaseId = turnFixture(store)
  db(store).exec(`
    CREATE TRIGGER fail_lease_release
    BEFORE DELETE ON session_turn_lease
    BEGIN
      SELECT RAISE(FAIL, 'lease release failed');
    END
  `)
  assert.throws(() => store.releaseTurnLease("s1", leaseId), /lease release failed/)
  assert.equal(store.readTurnAuthority("s1")?.leaseId, leaseId)
  db(store).exec("DROP TRIGGER fail_lease_release")
  store.releaseTurnLease("s1", leaseId)
  assert.equal(store.readTurnAuthority("s1"), undefined)
  store.close()
})

void it("a journal row that no longer parses stops that session's replay and gates its later writes", () => {
  const root = tmp()
  const first = new RuntimeStore(root)
  first.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
  first.bindSession({ sessionId: "s2", directory: "/other", agentSessionId: "a2", createdAt: 1 })
  first.appendEvent({ sessionId: "s1", payload: todoUpdated("s1", [{ content: "before", status: "pending", priority: "low" }]) })
  first.appendEvent({ sessionId: "s1", payload: todoUpdated("s1", [{ content: "after", status: "completed", priority: "high" }]) })
  first.appendEvent({ sessionId: "s2", payload: todoUpdated("s2", [{ content: "unrelated", status: "pending", priority: "low" }]) })
  // A projection that never caught up with the journal, plus one journal row
  // that has since become unreadable at that same session.
  db(first).prepare("DELETE FROM journal_checkpoint WHERE session_id = ?").run("s1")
  db(first).prepare("DELETE FROM todo WHERE session_id = ?").run("s1")
  db(first).prepare("UPDATE runtime_journal SET payload_json = ? WHERE session_id = ? AND seq = ?").run("{not json", "s1", 2)
  first.close()

  const store = new RuntimeStore(root)
  assert.deepEqual(store.replayJournal("s1"), {
    position: 1,
    blocked: { seq: 2, reason: "journal row event/todo.updated did not parse" },
  })
  // The perfectly good row after the gap must not be projected over it.
  assert.deepEqual(store.getTodos("s1"), [])
  assert.throws(
    () => store.appendEvent({ sessionId: "s1", payload: sessionIdle("s1") }),
    (error: unknown) => error instanceof Error && error.name === "RuntimeProjectionBlockedError" && /seq 2/.test(error.message),
  )
  assert.deepEqual(db(store).prepare("SELECT last_seq FROM journal_checkpoint WHERE session_id = ?").get("s1"), { last_seq: 1 })
  // An unrelated session in the same store keeps working.
  assert.deepEqual(store.getTodos("s2"), [{ content: "unrelated", status: "pending", priority: "low" }])
  store.appendEvent({ sessionId: "s2", payload: sessionIdle("s2") })
  assert.equal(store.getSession("s2")?.status, "idle")
  store.close()
})

void it("an explicit rebuild repairs one session's projection and applies every row exactly once", () => {
  const root = tmp()
  const first = new RuntimeStore(root)
  first.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
  first.bindSession({ sessionId: "s2", directory: "/other", agentSessionId: "a2", createdAt: 1 })
  first.appendEvent({ sessionId: "s1", payload: todoUpdated("s1", [{ content: "first", status: "pending", priority: "low" }]) })
  first.appendEvent({ sessionId: "s1", payload: todoUpdated("s1", [{ content: "second", status: "completed", priority: "high" }]) })
  first.appendEvent({ sessionId: "s2", payload: todoUpdated("s2", [{ content: "other", status: "pending", priority: "low" }]) })
  const readable = db(first).prepare("SELECT payload_json FROM runtime_journal WHERE session_id = ? AND seq = ?").get("s1", 2) as { payload_json: string }
  db(first).prepare("DELETE FROM journal_checkpoint WHERE session_id = ?").run("s1")
  db(first).prepare("DELETE FROM todo WHERE session_id = ?").run("s1")
  db(first).prepare("UPDATE runtime_journal SET payload_json = ? WHERE session_id = ? AND seq = ?").run("{not json", "s1", 2)
  first.close()

  const store = new RuntimeStore(root)
  assert.equal(store.replayJournal("s1").blocked?.seq, 2)
  // A rebuild repairs a projection, never the journal: the same row is still
  // unreadable, so the session is still refused.
  assert.deepEqual(store.rebuildProjection("s1"), {
    rebuilt: false,
    blocked: { seq: 2, reason: "journal row event/todo.updated did not parse" },
  })

  db(store).prepare("UPDATE runtime_journal SET payload_json = ? WHERE session_id = ? AND seq = ?").run(readable.payload_json, "s1", 2)
  // Position 4 is the request row the refused rebuild above journaled:
  // a rebuild replays everything the journal holds, its own requests included.
  assert.deepEqual(store.rebuildProjection("s1", "journal repaired"), { rebuilt: true, position: 4 })
  assert.deepEqual(store.getTodos("s1"), [{ content: "second", status: "completed", priority: "high" }])
  // The rebuild replayed the journal; it did not append a second copy of it.
  assert.equal(journalTypes(store).filter((type) => type === "todo.updated").length, 2)
  assert.equal(journalTypes(store).filter((type) => type === "projection.reset_requested").length, 2)
  assert.deepEqual(store.getTodos("s2"), [{ content: "other", status: "pending", priority: "low" }])

  store.appendEvent({ sessionId: "s1", payload: sessionIdle("s1") })
  assert.equal(store.getSession("s1")?.status, "idle")
  store.close()

  const reopened = new RuntimeStore(root)
  assert.deepEqual(reopened.getTodos("s1"), [{ content: "second", status: "completed", priority: "high" }])
  assert.equal(reopened.getSession("s1")?.status, "idle")
  reopened.close()
})

function recoveryFact<V extends string>(value: V, observedAt = 10) {
  return { value, source: "test", observedAt, generation: "lease-1" }
}

function recoveryOperation(overrides: { operationId?: string; requestId?: string } = {}) {
  return {
    operationId: overrides.operationId ?? "op-1",
    requestId: overrides.requestId ?? "req-1",
    target: { scope: "turn" as const, workspaceId: "w1", sessionId: "s1", turnId: "u1", ownerGeneration: "lease-1" },
    action: "cancel_turn" as const,
    scopeRevision: "rev-1",
    attempt: 1,
    state: "accepted" as const,
    phase: "ack" as const,
    phaseDeadlineAt: 20,
    facts: {
      execution: recoveryFact("running" as const),
      cleanup: recoveryFact("owned" as const),
      persistence: recoveryFact("pending" as const),
    },
    cleanupErrors: [],
    nextActions: [],
    receipt: "durable" as const,
    createdAt: 10,
    updatedAt: 10,
  }
}

void it("two store handles on one root cannot both create one caller's request", () => {
  const root = tmp()
  const first = new RuntimeStore(root)
  const second = new RuntimeStore(root)

  assert.deepEqual(first.recordRecoveryOperation(recoveryOperation(), { callerId: "caller-a" }), { created: true })
  const again = second.recordRecoveryOperation(recoveryOperation({ operationId: "op-2" }), { callerId: "caller-a" })
  assert.equal(again.created, false)
  assert.equal(!again.created ? again.existing.operationId : undefined, "op-1")
  assert.equal(second.readRecoveryOperation("op-2", { callerId: "caller-a" }), undefined)
  // A different caller reusing the same request id owns its own operation.
  assert.deepEqual(second.recordRecoveryOperation(recoveryOperation({ operationId: "op-3" }), { callerId: "caller-b" }), { created: true })

  assert.equal(second.readRecoveryOperation("op-1", { callerId: "caller-a" })?.requestId, "req-1")
  assert.deepEqual(first.listRecoveryOperations({ sessionId: "s1" }).map((op) => op.operationId).sort(), ["op-1", "op-3"])
  assert.deepEqual(first.listRecoveryOperations({ sessionId: "other" }), [])

  second.updateRecoveryOperation({ ...recoveryOperation(), state: "running", updatedAt: 40 })
  assert.equal(first.readRecoveryOperation("op-1", { callerId: "caller-a" })?.state, "running")
  assert.throws(() => first.updateRecoveryOperation(recoveryOperation({ operationId: "never-recorded" })), /is not recorded in this store/)
  first.close()
  second.close()
})

void it("settled recovery operations age out, and one still holding cleanup never does", () => {
  const store = new RuntimeStore(tmp())
  const stale = Date.now() - 10 * 60 * 1000
  const settled = {
    ...recoveryOperation({ operationId: "settled", requestId: "req-settled" }),
    state: "succeeded" as const,
    updatedAt: stale,
    facts: {
      execution: recoveryFact("terminal" as const, stale),
      cleanup: recoveryFact("verified_clear" as const, stale),
      persistence: recoveryFact("committed" as const, stale),
    },
  }
  const unresolved = {
    ...recoveryOperation({ operationId: "unresolved", requestId: "req-unresolved" }),
    state: "failed" as const,
    updatedAt: stale,
    facts: {
      execution: recoveryFact("unknown" as const, stale),
      cleanup: recoveryFact("owned" as const, stale),
      persistence: recoveryFact("committed" as const, stale),
    },
  }
  store.recordRecoveryOperation(settled, { callerId: "caller-a" })
  store.recordRecoveryOperation(unresolved, { callerId: "caller-a" })
  store.recordRecoveryOperation(recoveryOperation({ operationId: "live", requestId: "req-live" }), { callerId: "caller-a" })

  // The settled one aged out; the one still holding cleanup did not, in the
  // listing as well as in the table — the list is what an owner looks at.
  assert.deepEqual(store.listRecoveryOperations({}).map((op) => op.operationId), ["unresolved", "live"])
  assert.equal(store.readRecoveryOperation("settled", { callerId: "caller-a" }), undefined)
  assert.equal(store.readRecoveryOperation("unresolved", { callerId: "caller-a" })?.state, "failed")
  store.close()
})

void it("the recovery migration snapshots an existing store before it writes the new schema", () => {
  const root = tmp()
  const first = new RuntimeStore(root)
  first.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
  db(first).exec("DROP TABLE recovery_operation")
  first.close()

  const migrated = new RuntimeStore(root)
  assert.equal(migrated.readRecoveryOperation("none", { callerId: "caller-a" }), undefined)
  assert.equal(migrated.getAgentSessionId("s1"), "a1")
  migrated.close()

  const backups = fs.readdirSync(root).filter((name) => name.endsWith(".bak"))
  assert.equal(backups.length, 1)
  assert.ok(fs.statSync(path.join(root, backups[0])).size > 0)
  // An already-migrated store takes no further snapshots.
  new RuntimeStore(root).close()
  assert.equal(fs.readdirSync(root).filter((name) => name.endsWith(".bak")).length, 1)
})

void it("the recovery migration refuses to run when the store cannot be quiesced", () => {
  const root = tmp()
  const first = new RuntimeStore(root)
  first.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
  db(first).exec("DROP TABLE recovery_operation")
  first.close()

  // A second connection reading the database is exactly the case a file copy
  // would silently misreport as a consistent backup.
  const holder = rawDatabase(root)
  holder.exec("BEGIN IMMEDIATE")
  try {
    assert.throws(
      () => new RuntimeStore(root),
      (error: unknown) =>
        error instanceof Error
        && error.name === "RuntimeStoreMigrationBlockedError"
        && /Stop every process/.test(error.message),
    )
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".bak")), false)
    assert.equal(holder.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recovery_operation'").get(), undefined)
  } finally {
    holder.exec("ROLLBACK")
    holder.close()
  }

  const repaired = new RuntimeStore(root)
  assert.equal(repaired.readRecoveryOperation("none", { callerId: "caller-a" }), undefined)
  repaired.close()
  assert.equal(fs.readdirSync(root).filter((name) => name.endsWith(".bak")).length, 1)
})

void it("a turn the replacement superseded is still reported against its own id", () => {
  const store = new RuntimeStore(tmp())
  turnFixture(store)
  store.startTurn({
    sessionId: "s1",
    agentSessionId: "a1",
    userMessageId: "u2",
    assistantMessageId: "m2",
    agent: "build",
    model: { providerID: "anthropic", modelID: "opus" },
    parts: [{ type: "text", text: "again" }],
  })
  // Nothing finished the first turn and no outcome names it, so the store says
  // so rather than inferring an end from the newer turn.
  assert.deepEqual(store.turnEvidence("s1", "u1"), { started: true, finished: false })
  assert.deepEqual(store.turnEvidence("s1", "u2"), { started: true, finished: false })
  store.close()
})

void it("an update replaces the stored operation without creating a second receipt", () => {
  const store = new RuntimeStore(tmp())
  store.recordRecoveryOperation(recoveryOperation(), { callerId: "caller-a" })
  store.updateRecoveryOperation({ ...recoveryOperation(), state: "running", updatedAt: 40 })

  assert.deepEqual(store.listRecoveryOperations({ sessionId: "s1" }).map((op) => op.operationId), ["op-1"])
  assert.equal(store.readRecoveryOperation("op-1", { callerId: "caller-a" })?.state, "running")
  // The same request id still joins the one receipt rather than reopening it.
  const again = store.recordRecoveryOperation(recoveryOperation({ operationId: "op-2" }), { callerId: "caller-a" })
  assert.equal(!again.created ? again.existing.state : undefined, "running")
  store.close()
})

void it("turnEvidence answers for either of a turn's two message ids", () => {
  const store = new RuntimeStore(tmp())
  const leaseId = turnFixture(store)
  assert.deepEqual(store.turnEvidence("s1", "u1"), { started: true, finished: false })
  assert.deepEqual(store.turnEvidence("s1", "m1"), { started: true, finished: false })
  assert.deepEqual(store.turnEvidence("s1", "never"), { started: false, finished: false })

  store.finishTurn({ sessionId: "s1", assistantMessageId: "m1", outcome: { status: "completed", completedAt: 5 }, leaseId })
  assert.deepEqual(store.turnEvidence("s1", "u1"), {
    started: true,
    finished: true,
    outcome: { status: "completed", completedAt: 5, assistantMessageId: "m1" },
  })
  store.close()
})

void it("turnCoverage calls a finished turn complete against the id it was asked for", () => {
  const store = new RuntimeStore(tmp())
  const leaseId = turnFixture(store)
  store.finishTurn({ sessionId: "s1", assistantMessageId: "m1", outcome: { status: "completed", completedAt: 5 }, leaseId })

  const byUser = store.turnCoverage("s1", "u1")
  const byAssistant = store.turnCoverage("s1", "m1")
  assert.equal(byUser.coverage, "complete")
  assert.equal(byUser.reason, undefined)
  assert.equal(byUser.turnId, "u1")
  assert.deepEqual(byUser.terminal, { status: "completed", completedAt: 5, assistantMessageId: "m1" })
  assert.deepEqual(byUser.messages.map((message) => message.info.id), ["u1", "m1"])
  assert.equal(byUser.committedSequence, store.replayJournal("s1").position)

  assert.equal(byAssistant.turnId, "m1")
  assert.equal(byAssistant.coverage, "complete")
  assert.deepEqual(byAssistant.messages.map((message) => message.info.id), byUser.messages.map((message) => message.info.id))
  store.close()
})

void it("turnCoverage refuses a turn that belongs to another session rather than calling it unavailable", () => {
  const store = new RuntimeStore(tmp())
  turnFixture(store)
  store.bindSession({ sessionId: "s2", directory: "/work", agentSessionId: "a2", createdAt: 1 })

  // `unavailable` tells a caller the turn can never be covered, which would
  // discharge the obligation s1 still owes for it.
  assert.throws(
    () => store.turnCoverage("s2", "u1"),
    (error: unknown) => error instanceof AgentMessagePageError && error.status === 404,
  )

  // A turn no session journalled really is unanswerable.
  const unknown = store.turnCoverage("s2", "u_never")
  assert.equal(unknown.coverage, "unavailable")
  assert.match(unknown.reason ?? "", /no turn u_never/)
  store.close()
})

void it("turnCoverage reports a running turn partial and names no terminal for it", () => {
  const store = new RuntimeStore(tmp())
  turnFixture(store)

  const running = store.turnCoverage("s1", "u1")
  assert.equal(running.coverage, "partial")
  assert.match(running.reason ?? "", /no end for turn u1/)
  assert.equal("terminal" in running, false)
  assert.deepEqual(running.messages.map((message) => message.info.id), ["u1", "m1"])
  store.close()
})

void it("turnCoverage refuses to account for a turn the journal never started", () => {
  const store = new RuntimeStore(tmp())
  turnFixture(store)

  const unknown = store.turnCoverage("s1", "never-started")
  assert.equal(unknown.coverage, "unavailable")
  assert.equal(unknown.turnId, "never-started")
  assert.match(unknown.reason ?? "", /records no turn never-started/)
  assert.deepEqual(unknown.messages, [])
  store.close()
})

void it("turnCoverage calls a turn partial while a message inside it belongs to another", () => {
  const store = new RuntimeStore(tmp())
  const leaseId = turnFixture(store)
  store.finishTurn({ sessionId: "s1", assistantMessageId: "m1", outcome: { status: "completed", completedAt: 5 }, leaseId })
  store.appendEvent({
    sessionId: "s1",
    agentSessionId: "a1",
    payload: messageUpdated({
      id: "stray",
      sessionID: "s1",
      role: "assistant",
      parentID: "another-user",
      time: { created: 9 },
    } as any),
  })

  const strayed = store.turnCoverage("s1", "u1")
  assert.equal(strayed.coverage, "partial")
  assert.match(strayed.reason ?? "", /not contiguous/)
  // The turn finished, so the journal still names its outcome: a projection
  // defect does not unmake a recorded end.
  assert.deepEqual(strayed.terminal, { status: "completed", completedAt: 5, assistantMessageId: "m1" })
  store.close()
})

void it("turnCoverage refuses a finished turn whose projection is blocked behind the journal", () => {
  const root = tmp()
  const first = new RuntimeStore(root)
  const leaseId = turnFixture(first)
  first.finishTurn({ sessionId: "s1", assistantMessageId: "m1", outcome: { status: "completed", completedAt: 5 }, leaseId })
  first.appendEvent({ sessionId: "s1", payload: todoUpdated("s1", [{ content: "last", status: "pending", priority: "low" }]) })
  const head = first.getSessionMaxSeq("s1")
  db(first).prepare("DELETE FROM journal_checkpoint WHERE session_id = ?").run("s1")
  db(first).prepare("UPDATE runtime_journal SET payload_json = ? WHERE session_id = ? AND seq = ?").run("{not json", "s1", head)
  first.close()

  const store = new RuntimeStore(root)
  const blocked = store.turnCoverage("s1", "u1")
  assert.equal(blocked.coverage, "unavailable")
  assert.match(blocked.reason ?? "", new RegExp(`blocked at seq ${head}`))
  assert.deepEqual(blocked.messages, [])
  assert.equal(blocked.committedSequence, head - 1)
  store.close()
})

void it("turnCoverage refuses a session whose transcript this store does not project", () => {
  const store = new RuntimeStore(tmp())
  turnFixture(store)
  db(store).prepare("DELETE FROM message WHERE session_id = ?").run("s1")

  const unprojected = store.turnCoverage("s1", "u1")
  assert.equal(unprojected.coverage, "unavailable")
  assert.match(unprojected.reason ?? "", /no projected transcript/)
  store.close()
})

void it("turnCoverage refuses a session it does not hold at all", () => {
  const store = new RuntimeStore(tmp())
  assert.throws(
    () => store.turnCoverage("missing", "u1"),
    (error: unknown) => error instanceof AgentMessagePageError && error.status === 404,
  )
  store.close()
})

void it("a receipt is readable by the caller that created it and by one that coalesced onto it, and by nobody else", () => {
  const root = tmp()
  const store = new RuntimeStore(root)
  store.recordRecoveryOperation(recoveryOperation(), { callerId: "caller-a" })
  store.addRecoveryOperationCaller("op-1", { callerId: "caller-b" })
  // An id this store does not hold records nobody.
  store.addRecoveryOperationCaller("never-recorded", { callerId: "caller-c" })

  assert.equal(store.readRecoveryOperation("op-1", { callerId: "caller-a" })?.requestId, "req-1")
  assert.equal(store.readRecoveryOperation("op-1", { callerId: "caller-b" })?.requestId, "req-1")
  assert.equal(store.readRecoveryOperation("op-1", { callerId: "caller-c" }), undefined)
  // Listing is scoped to the session, not the reader; only the receipt is.
  assert.deepEqual(store.listRecoveryOperations({ sessionId: "s1" }).map((op) => op.operationId), ["op-1"])
  store.close()

  const reopened = new RuntimeStore(root)
  assert.equal(reopened.readRecoveryOperation("op-1", { callerId: "caller-b" })?.requestId, "req-1")
  assert.equal(reopened.readRecoveryOperation("op-1", { callerId: "caller-c" }), undefined)
  reopened.close()
})

void it("a session whose projection is behind cannot advance its checkpoint through pending deltas", () => {
  const root = tmp()
  const store = new RuntimeStore(root)
  store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
  store.bindSession({ sessionId: "s2", directory: "/other", agentSessionId: "a2", createdAt: 1 })
  const delta = (sessionId: string, text: string) => store.appendEvent({
    sessionId,
    payload: messagePartDelta({ sessionID: sessionId, messageID: "m", partID: `p-${sessionId}`, field: "text", delta: text }),
  })
  delta("s1", "held ")
  delta("s2", "other")
  const checkpoint = (sessionId: string) =>
    db(store).prepare("SELECT last_seq FROM journal_checkpoint WHERE session_id = ?").get(sessionId)
  const before = checkpoint("s1")

  // The session falls behind its journal while its deltas are still pending.
  db(store).prepare("DELETE FROM journal_checkpoint WHERE session_id = ?").run("s1")
  db(store).prepare("UPDATE runtime_journal SET payload_json = ? WHERE session_id = ? AND seq = ?").run("{not json", "s1", 1)
  assert.equal(store.replayJournal("s1").blocked?.seq, 1)

  store.flush()

  assert.equal(checkpoint("s1"), undefined, "the blocked session's checkpoint did not advance")
  assert.notDeepEqual(checkpoint("s2"), undefined)
  assert.notDeepEqual(before, undefined)
  // The other session's deltas settled in the same sweep.
  assert.equal(
    (db(store).prepare("SELECT count(*) AS n FROM part WHERE id = ?").get("p-s2") as { n: number }).n,
    1,
  )
  store.close()
})

void it("a writer carrying no lease is refused, whether or not the session granted one", () => {
  const store = new RuntimeStore(tmp())
  // A lease-less writer against a session that holds one.
  turnFixture(store)
  assert.throws(
    () => store.finishTurn({
      sessionId: "s1",
      assistantMessageId: "m1",
      outcome: { status: "completed", completedAt: 5 },
      leaseId: undefined as unknown as string,
    }),
    AgentRuntimeStaleTurnError,
  )

  // And against one that holds none: two absent leases must not compare equal.
  store.bindSession({ sessionId: "s2", directory: "/other", agentSessionId: "a2", createdAt: 1 })
  store.startTurn({
    sessionId: "s2",
    agentSessionId: "a2",
    userMessageId: "u2",
    assistantMessageId: "m2",
    agent: "build",
    model: { providerID: "anthropic", modelID: "opus" },
    parts: [{ type: "text", text: "go" }],
  })
  assert.equal(store.readTurnAuthority("s2"), undefined)
  assert.throws(
    () => store.finishTurn({
      sessionId: "s2",
      assistantMessageId: "m2",
      outcome: { status: "completed", completedAt: 5 },
      leaseId: undefined as unknown as string,
    }),
    AgentRuntimeStaleTurnError,
  )
  assert.equal(journalTypes(store, "s2").includes("turn.finish"), false)
  assert.equal(store.getSession("s2")?.status, "busy")
  store.close()
})
