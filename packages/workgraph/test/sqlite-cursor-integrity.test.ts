import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { createSqliteWorkGraphService } from "../src/adapters/sqlite/store"
import type { WorkGraphContext } from "../src/contracts"

const databases: BetterSqlite3.Database[] = []

afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe("SQLite tenant-bound stable cursors", () => {
  it("binds Change cursors to organization, owner, and Stream filter", async () => {
    const database = createDatabase()
    const workgraph = createSqliteWorkGraphService({ database }).service
    const created = await workgraph.execute(owner("organization_a"), {
      operationId: "operation_stream" as never,
      command: { version: 1, type: "create_stream", title: "Cursor Stream" },
    })
    if (!created.ok) throw new Error("Expected Stream creation")
    const streamId = String((created.value as { streamId: string }).streamId) as never
    const all = await workgraph.query(owner("organization_a"), "changes", "list", {})
    const stream = await workgraph.query(owner("organization_a"), "changes", "listStream", { streamId })

    await expect(workgraph.query(owner("organization_b"), "changes", "list", { after: all[0]!.cursor }))
      .rejects.toMatchObject({ name: "ChangeCursorError", reason: "owner_mismatch" })
    await expect(workgraph.query(owner("organization_a"), "changes", "list", { after: stream[0]!.cursor }))
      .rejects.toMatchObject({ name: "ChangeCursorError", reason: "filter_mismatch" })
    await expect(workgraph.query(owner("organization_a"), "changes", "list", { after: "broken" as never }))
      .rejects.toMatchObject({ name: "ChangeCursorError", reason: "invalid" })
  })

  it("pages Work Sources by immutable keyset across inserts before and after the cursor", async () => {
    const database = createDatabase()
    let now = 1_000
    const workgraph = createSqliteWorkGraphService({ database, clock: { now: () => now } }).service
    await workgraph.execute(owner("organization_a"), {
      operationId: "operation_source_a" as never,
      command: { version: 1, type: "create_work_source", title: "A", content: "A" },
    })
    now = 3_000
    await workgraph.execute(owner("organization_a"), {
      operationId: "operation_source_b" as never,
      command: { version: 1, type: "create_work_source", title: "B", content: "B" },
    })
    const first = await workgraph.query(owner("organization_a"), "sources", "list", { limit: 1 })
    expect(first.sources.map((source) => source.title)).toEqual(["A"])

    now = 2_000
    await workgraph.execute(owner("organization_a"), {
      operationId: "operation_source_between" as never,
      command: { version: 1, type: "create_work_source", title: "Between pages", content: "Between" },
    })
    now = 999
    const inserted = await workgraph.execute(owner("organization_a"), {
      operationId: "operation_source_before" as never,
      command: { version: 1, type: "create_work_source", title: "Before cursor", content: "Before" },
    })
    if (!inserted.ok) throw new Error("Expected Work Source creation")
    database.prepare("UPDATE wg_v2_work_sources SET created_at = 999 WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
      .run("organization_a", "same_user", (inserted.value as { workSourceId: string }).workSourceId)

    const second = await workgraph.query(owner("organization_a"), "sources", "list", { after: first.nextCursor!, limit: 1 })
    expect(second.sources.map((source) => source.title)).toEqual(["Between pages"])
    const third = await workgraph.query(owner("organization_a"), "sources", "list", { after: second.nextCursor!, limit: 1 })
    expect(third.sources.map((source) => source.title)).toEqual(["B"])
    await expect(workgraph.query(owner("organization_b"), "sources", "list", { after: first.nextCursor!, limit: 1 }))
      .rejects.toMatchObject({ name: "WorkSourcePageCursorError", reason: "owner_mismatch" })
    await expect(workgraph.query(owner("organization_a"), "sources", "list", { after: "broken" as never, limit: 1 }))
      .rejects.toMatchObject({ name: "WorkSourcePageCursorError", reason: "invalid" })
  })

})

function createDatabase() {
  const database = new BetterSqlite3(":memory:")
  databases.push(database)
  return database
}

function owner(organizationId: string): WorkGraphContext {
  return {
    organizationId: organizationId as never,
    ownerUserId: "same_user" as never,
    actor: { type: "user", id: "same_user" as never },
    requestId: `request_${organizationId}` as never,
    access: { mode: "owner" },
  }
}
