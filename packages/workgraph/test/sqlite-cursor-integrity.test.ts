import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { createSqliteNotificationStore } from "../src/adapters/sqlite/notification-store"
import { createSqliteWorkGraphService } from "../src/adapters/sqlite/store"
import { createNotificationService } from "../src/application/notification-service"
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

  it("pages Notifications by owner- and state-bound keyset without duplicate shifts", async () => {
    const database = createDatabase()
    const workgraph = createSqliteWorkGraphService({ database }).service
    const created = await workgraph.execute(owner("organization_a"), {
      operationId: "operation_notification_stream" as never,
      command: { version: 1, type: "create_stream", title: "Notifications" },
    })
    if (!created.ok) throw new Error("Expected Stream creation")
    const streamId = String((created.value as { streamId: string }).streamId)
    insertNotification(database, streamId, "notification_300", 300)
    insertNotification(database, streamId, "notification_200", 200)
    const notifications = createNotificationService(createSqliteNotificationStore(database))

    const first = await notifications.list(owner("organization_a"), { state: "unread", limit: 1 })
    expect(first.notifications.map((notification) => notification.id)).toEqual(["notification_300"])
    insertNotification(database, streamId, "notification_400", 400)
    insertNotification(database, streamId, "notification_250", 250)
    const second = await notifications.list(owner("organization_a"), { state: "unread", after: first.nextCursor!, limit: 1 })
    expect(second.notifications.map((notification) => notification.id)).toEqual(["notification_250"])
    const third = await notifications.list(owner("organization_a"), { state: "unread", after: second.nextCursor!, limit: 1 })
    expect(third.notifications.map((notification) => notification.id)).toEqual(["notification_200"])

    await expect(notifications.list(owner("organization_b"), { state: "unread", after: first.nextCursor!, limit: 1 }))
      .rejects.toMatchObject({ name: "NotificationPageCursorError", reason: "owner_mismatch" })
    await expect(notifications.list(owner("organization_a"), { state: "read", after: first.nextCursor!, limit: 1 }))
      .rejects.toMatchObject({ name: "NotificationPageCursorError", reason: "filter_mismatch" })
    await expect(notifications.list(owner("organization_a"), { after: "broken" as never, limit: 1 }))
      .rejects.toMatchObject({ name: "NotificationPageCursorError", reason: "invalid" })
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

function insertNotification(database: BetterSqlite3.Database, streamId: string, notificationId: string, createdAt: number) {
  const recapId = `recap_${notificationId}`
  database.prepare(`
    INSERT INTO wg_v2_recaps
      (organization_id, owner_user_id, id, stream_id, activity_start_sequence, activity_end_sequence, quiet_since, summary,
       actionable_references_json, generation_profile_json, provenance_json, generation_result_json, created_at)
    VALUES ('organization_a', 'same_user', ?, ?, 1, ?, ?, 'Actionable', '[]', '{}', ?, ?, ?)
  `).run(
    recapId,
    streamId,
    createdAt,
    createdAt,
    JSON.stringify({ actor: { type: "system", id: "recap_test" } }),
    JSON.stringify({ state: "succeeded", method: "agent_session", sessionId: `session_${notificationId}` }),
    createdAt,
  )
  database.prepare(`
    INSERT INTO wg_v2_notifications
      (organization_id, owner_user_id, id, notification_kind, state, stream_id, recap_id, created_at, updated_at)
    VALUES ('organization_a', 'same_user', ?, 'actionable_recap', 'unread', ?, ?, ?, ?)
  `).run(notificationId, streamId, recapId, createdAt, createdAt)
}
