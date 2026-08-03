import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WorkspaceExecutionPort } from "@claxedo/workgraph"
import { createLocalEmbeddedWorkGraph } from "./composition/server-workgraph"
import type { WorkgraphChangedEvent } from "../../platform/runtime/lib/bus"
import { createWorkGraphChangeDoorbell, createWorkGraphChangeTipWatcher } from "./change-doorbell"

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  databases.splice(0).forEach((database) => database.close())
  directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }))
  vi.useRealTimers()
})

describe("WorkGraph change doorbell coalescing", () => {
  it("emits exactly one nudge per mutation, after the coalesce window", () => {
    vi.useFakeTimers()
    const published: WorkgraphChangedEvent[] = []
    const doorbell = createWorkGraphChangeDoorbell({
      publish: (event) => published.push(event),
      coalesceMs: 100,
      now: () => 1_000,
    })

    doorbell.nudge("owner_a")
    expect(published).toEqual([])

    vi.advanceTimersByTime(99)
    expect(published).toEqual([])

    vi.advanceTimersByTime(1)
    expect(published).toEqual([{ type: "workgraph.changed", ownerUserId: "owner_a", ts: 1_000 }])

    vi.advanceTimersByTime(10_000)
    expect(published).toHaveLength(1)
  })

  it("collapses a burst of rapid mutations into a single nudge", () => {
    vi.useFakeTimers()
    const published: WorkgraphChangedEvent[] = []
    const doorbell = createWorkGraphChangeDoorbell({ publish: (event) => published.push(event), coalesceMs: 100 })

    for (let index = 0; index < 50; index += 1) {
      doorbell.nudge("owner_a")
      vi.advanceTimersByTime(1)
    }
    expect(published).toEqual([])

    vi.advanceTimersByTime(100)
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ type: "workgraph.changed", ownerUserId: "owner_a" })
  })

  it("publishes the latest cursor and stream metadata from a coalesced burst", () => {
    vi.useFakeTimers()
    const published: WorkgraphChangedEvent[] = []
    const doorbell = createWorkGraphChangeDoorbell({
      publish: (event) => published.push(event),
      coalesceMs: 100,
      now: () => 1_000,
    })

    doorbell.nudge("owner_a", { cursor: "wgc2:first", streamId: "stream-first" })
    doorbell.nudge("owner_a", { cursor: "wgc2:latest", streamId: "stream-latest" })
    vi.advanceTimersByTime(100)

    expect(published).toEqual([{
      type: "workgraph.changed",
      ownerUserId: "owner_a",
      cursor: "wgc2:latest",
      streamId: "stream-latest",
      ts: 1_000,
    }])
  })

  it("does not reset the window under continuous churn, so a nudge always lands", () => {
    vi.useFakeTimers()
    const published: WorkgraphChangedEvent[] = []
    const doorbell = createWorkGraphChangeDoorbell({ publish: (event) => published.push(event), coalesceMs: 100 })

    // A resetting debounce would starve the client here — exactly when it is most
    // out of date. The trailing window must still fire.
    for (let index = 0; index < 10; index += 1) {
      doorbell.nudge("owner_a")
      vi.advanceTimersByTime(50)
    }
    expect(published.length).toBeGreaterThanOrEqual(4)
  })

  it("coalesces per owner and starts a fresh window after each emit", () => {
    vi.useFakeTimers()
    const published: WorkgraphChangedEvent[] = []
    const doorbell = createWorkGraphChangeDoorbell({ publish: (event) => published.push(event), coalesceMs: 100 })

    doorbell.nudge("owner_a")
    doorbell.nudge("owner_b")
    vi.advanceTimersByTime(100)
    expect(published.map((event) => event.ownerUserId).sort()).toEqual(["owner_a", "owner_b"])

    doorbell.nudge("owner_a")
    vi.advanceTimersByTime(100)
    expect(published).toHaveLength(3)
    expect(published.at(-1)).toMatchObject({ ownerUserId: "owner_a" })
  })

  it("drops pending nudges once disposed", () => {
    vi.useFakeTimers()
    const published: WorkgraphChangedEvent[] = []
    const doorbell = createWorkGraphChangeDoorbell({ publish: (event) => published.push(event), coalesceMs: 100 })

    doorbell.nudge("owner_a")
    doorbell.dispose()
    vi.advanceTimersByTime(1_000)
    expect(published).toEqual([])
  })

  it("keeps publishing after a subscriber throws", () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    let calls = 0
    const doorbell = createWorkGraphChangeDoorbell({
      publish: () => {
        calls += 1
        throw new Error("bus exploded")
      },
      coalesceMs: 100,
    })

    doorbell.nudge("owner_a")
    expect(() => vi.advanceTimersByTime(100)).not.toThrow()
    doorbell.nudge("owner_a")
    vi.advanceTimersByTime(100)
    expect(calls).toBe(2)
    error.mockRestore()
  })
})

describe("WorkGraph doorbell publish points", () => {
  it("nudges once, post-commit, for a committed command", async () => {
    const published: WorkgraphChangedEvent[] = []
    const embedded = await composeWorkGraph(published)

    const result = await embedded.service.execute(context(), {
      operationId: "operation_doorbell_1" as never,
      command: { version: 1, type: "create_stream", title: "Doorbell Stream" },
    } as never)
    expect(result.ok).toBe(true)

    // The change row is already readable when `execute` resolves: that is what
    // makes resolution the post-commit publish point.
    expect(changeTip(embedded.database)).toBe(1)

    await settle()
    expect(published).toEqual([expect.objectContaining({
      type: "workgraph.changed",
      ownerUserId: "local",
      cursor: result.ok ? result.cursor : undefined,
    })])
  })

  it("collapses rapid committed commands into one nudge", async () => {
    const published: WorkgraphChangedEvent[] = []
    const embedded = await composeWorkGraph(published)

    for (let index = 0; index < 5; index += 1) {
      await embedded.service.execute(context(), {
        operationId: `operation_burst_${index}` as never,
        command: { version: 1, type: "create_stream", title: `Stream ${index}` },
      } as never)
    }
    expect(changeTip(embedded.database)).toBe(5)

    await settle()
    expect(published).toHaveLength(1)
  })

  it("does not nudge for a rejected command", async () => {
    const published: WorkgraphChangedEvent[] = []
    const embedded = await composeWorkGraph(published)

    const result = await embedded.service.execute(context(), {
      operationId: "operation_invalid" as never,
      command: { version: 1, type: "update_stream", streamId: "stream_missing", title: "Nope", expectedVersion: 1 },
    } as never)
    expect(result.ok).toBe(false)

    await settle()
    expect(published).toEqual([])
  })

  // ATTENTION PARITY (plan §6). Acknowledgements write only to
  // `wg_v2_attention_acknowledgements`, appending no change row — proven below —
  // so without their own nudge a mark-all-read from a second client would never
  // reach the first.
  it("nudges on an attention-only transition that appends no change row", async () => {
    const published: WorkgraphChangedEvent[] = []
    const embedded = await composeWorkGraph(published)
    const tipBefore = changeTip(embedded.database)

    await embedded.attentionAcknowledgements.markAllRead(context())

    expect(changeTip(embedded.database)).toBe(tipBefore)
    await settle()
    expect(published).toEqual([expect.objectContaining({ type: "workgraph.changed", ownerUserId: "local" })])
  })

  it("nudges when attention is cleared", async () => {
    const published: WorkgraphChangedEvent[] = []
    const embedded = await composeWorkGraph(published)

    await embedded.attentionAcknowledgements.clear(context())

    await settle()
    expect(published).toEqual([expect.objectContaining({ type: "workgraph.changed", ownerUserId: "local" })])
  })

  // Regression (Wave 4 measured 10 mutations -> 20 nudges, exactly 2x live): the
  // command path nudges post-commit, then the reconciler tick sees the tip its
  // OWN command advanced and rings again ~1s later — too far apart for the 100ms
  // coalesce to fold. With the client cursor deleted (plan §3) the client cannot
  // tell the second nudge is redundant and pays a full duplicate reload, exactly
  // during agent churn.
  it("does not ring a second time for a change the command path already announced", async () => {
    const published: WorkgraphChangedEvent[] = []
    const embedded = await composeWorkGraph(published)

    // The reconciler is ALREADY ticking before the command lands — that is the
    // live sequence, and it matters: the watcher seeds its baseline silently on
    // first observation, so without this seed there is nothing to compare against
    // and the duplicate cannot appear at all.
    embedded.observeChanges(context())
    await settle()
    expect(published).toEqual([])

    const created = await embedded.service.execute(context(), {
      operationId: "operation_doorbell_adopt" as never,
      command: { version: 1, type: "create_stream", title: "Adopt Stream" },
    } as never)
    expect(created.ok).toBe(true)
    await settle()
    expect(published).toHaveLength(1)

    // The next tick lands well after the command's coalesce window closed, so no
    // debounce can fold a second nudge into the first.
    embedded.observeChanges(context())
    await settle()

    // Still one: the command's own row must not be re-announced.
    expect(published).toHaveLength(1)
  })

  it("nudges from the tip watcher when a non-command writer advances the log", async () => {
    const published: WorkgraphChangedEvent[] = []
    const embedded = await composeWorkGraph(published)

    // Seed the baseline the way the reconciler tick does.
    embedded.observeChanges(context())
    await settle()
    expect(published).toEqual([])

    // Stand in for any writer outside `service.execute` (run settlement,
    // source planning, activity, intake) by appending a change row.
    appendForeignChange(embedded.database)

    embedded.observeChanges(context())
    await settle()
    expect(published).toEqual([expect.objectContaining({ type: "workgraph.changed", ownerUserId: "local" })])
  })

  it("stays silent on tip observations when nothing changed", async () => {
    const published: WorkgraphChangedEvent[] = []
    const embedded = await composeWorkGraph(published)

    for (let index = 0; index < 5; index += 1) embedded.observeChanges(context())

    await settle()
    expect(published).toEqual([])
  })

  // Regression: the baseline map was keyed by ownerUserId alone while the tip it
  // stored was org-scoped, so one owner in two organizations shared a baseline.
  // With the orgs at different tips the baseline ping-pongs, and every tick one
  // observation reads as an advance — nudging forever with nothing changed. That
  // breaks the zero-idle-cost property this watcher exists to preserve.
  it("stays silent for an idle owner who exists in two organizations", async () => {
    const published: WorkgraphChangedEvent[] = []
    const embedded = await composeWorkGraph(published)
    const watcher = createWorkGraphChangeTipWatcher({
      database: embedded.database,
      doorbell: createWorkGraphChangeDoorbell({
        publish: (event) => published.push(event),
        coalesceMs: 0,
      }),
    })

    // Different tips per org is the trigger: a shared baseline oscillates
    // between 2 and 1, so each observation sees the other org's value.
    appendForeignChangeFor(embedded.database, "alpha", "shared")
    appendForeignChangeFor(embedded.database, "alpha", "shared")
    appendForeignChangeFor(embedded.database, "beta", "shared")

    // Five reconciler ticks. The reconciler observes every owner each tick, so
    // alpha and beta interleave — that interleaving is what exposes the
    // collision. Nothing is written after this point.
    for (let tick = 0; tick < 5; tick += 1) {
      watcher.observe({ organizationId: "alpha", ownerUserId: "shared" })
      watcher.observe({ organizationId: "beta", ownerUserId: "shared" })
      await settle()
    }

    // Nothing changed, so nothing may be published. Under the bug this emits a
    // nudge on almost every tick.
    expect(published).toEqual([])

    // And a real change still nudges — the fix must not silence the watcher.
    appendForeignChangeFor(embedded.database, "beta", "shared")
    watcher.observe({ organizationId: "beta", ownerUserId: "shared" })
    await settle()
    expect(published).toEqual([expect.objectContaining({ type: "workgraph.changed", ownerUserId: "shared" })])
  })
})

async function composeWorkGraph(published: WorkgraphChangedEvent[]) {
  const embedded = await createLocalEmbeddedWorkGraph({
    database: trackedDatabase(databaseFile()),
    execution: terminalExecution(),
    publishChanged: (event) => published.push(event),
    changeCoalesceMs: 5,
  })
  return embedded
}

function context() {
  return {
    organizationId: "local" as never,
    ownerUserId: "local" as never,
    actor: { type: "user" as const, id: "local" as never },
    requestId: `request_${crypto.randomUUID()}` as never,
    access: { mode: "owner" as const },
  }
}

/** Wait past the 5ms coalesce window used by these compositions. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 30))
}

function changeTip(database: Database.Database) {
  const row = database
    .prepare("SELECT MAX(cursor) AS tip FROM wg_v2_changes WHERE organization_id = ? AND owner_user_id = ?")
    .get("local", "local") as { tip: number | null }
  return Number(row.tip ?? 0)
}

function appendForeignChangeFor(database: Database.Database, organizationId: string, ownerUserId: string) {
  const row = database
    .prepare("SELECT MAX(cursor) AS tip FROM wg_v2_changes WHERE organization_id = ? AND owner_user_id = ?")
    .get(organizationId, ownerUserId) as { tip: number | null }
  const operationId = `operation_foreign_${crypto.randomUUID()}`
  database
    .prepare(
      `INSERT INTO wg_v2_operation_results
         (organization_id, owner_user_id, id, command_type, request_hash, result_status, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(organizationId, ownerUserId, operationId, "complete_run", "hash", 1, "{}", String(Date.now()))
  database
    .prepare(
      `INSERT INTO wg_v2_changes
         (organization_id, owner_user_id, cursor, id, stream_id, operation_id, resource_type, resource_id, change_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      organizationId,
      ownerUserId,
      Number(row.tip ?? 0) + 1,
      `change_${crypto.randomUUID()}`,
      null,
      operationId,
      "run",
      "run_1",
      "run_completed",
      "{}",
      String(Date.now()),
    )
}

function appendForeignChange(database: Database.Database) {
  const operationId = `operation_foreign_${crypto.randomUUID()}`
  database
    .prepare(
      `INSERT INTO wg_v2_operation_results
         (organization_id, owner_user_id, id, command_type, request_hash, result_status, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("local", "local", operationId, "complete_run", "hash", 1, "{}", String(Date.now()))
  database
    .prepare(
      `INSERT INTO wg_v2_changes
         (organization_id, owner_user_id, cursor, id, stream_id, operation_id, resource_type, resource_id, change_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "local",
      "local",
      changeTip(database) + 1,
      `change_${crypto.randomUUID()}`,
      null,
      operationId,
      "run",
      "run_1",
      "run_completed",
      "{}",
      String(Date.now()),
    )
}

function trackedDatabase(file: string) {
  const database = new Database(file)
  databases.push(database)
  return database
}

function databaseFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-doorbell-"))
  directories.push(directory)
  return path.join(directory, "workgraph.sqlite")
}

function terminalExecution(): WorkspaceExecutionPort {
  return {
    provisionOrAdopt: async (_context, input) => ({
      id: "envelope_1" as never,
      streamId: input.streamId,
      environment: input.environment,
      repository: input.repository,
      workspaceId: "/tmp/worktree",
    }),
    launch: async (_context, input) => ({ sessionId: "session_1" as never, envelopeId: input.envelopeId, projectId: "/tmp/workgraph" }),
    cancel: async () => undefined,
    result: async () => ({ state: "succeeded", summary: "Done", artifacts: ["commit:abc"] }),
    cleanup: async () => undefined,
  }
}
