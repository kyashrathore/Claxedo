import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, test } from "vitest"
import {
  createAttentionAcknowledgementService,
  createSqliteAttentionAcknowledgementStore,
  createSqliteWorkGraphService,
} from "../src"
import type { WorkGraphContext } from "../src/contracts"

const databases: BetterSqlite3.Database[] = []

afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe("SQLite Attention acknowledgements", () => {
  test("survive service reconstruction, stay owner-scoped, and reveal changed items again", async () => {
    const database = new BetterSqlite3(":memory:")
    databases.push(database)
    let now = 300
    const clock = { now: () => now }
    const service = createSqliteWorkGraphService({ database, clock }).service
    const acknowledgements = createAttentionAcknowledgementService(createSqliteAttentionAcknowledgementStore(database, clock))
    await seedAttention(database, service, owner("owner_a"), "item_a", 100)
    await seedAttention(database, service, owner("owner_b"), "item_b", 100)

    const initial = await service.query(owner("owner_a"), "attention", "list", { limit: 10 })
    expect(initial).toMatchObject({ items: [{ id: "item_a" }], total: 1 })
    expect(initial.items[0]).not.toHaveProperty("readAt")
    await acknowledgements.markAllRead(owner("owner_a"))
    await expect(service.query(owner("owner_a"), "attention", "list", { limit: 10 })).resolves.toMatchObject({
      items: [{ id: "item_a", readAt: 300 }],
      total: 1,
    })
    const otherOwner = await service.query(owner("owner_b"), "attention", "list", { limit: 10 })
    expect(otherOwner).toMatchObject({ items: [{ id: "item_b" }], total: 1 })
    expect(otherOwner.items[0]).not.toHaveProperty("readAt")

    now = 400
    await acknowledgements.clear(owner("owner_a"))
    const restarted = createSqliteWorkGraphService({ database, clock }).service
    await expect(restarted.query(owner("owner_a"), "attention", "list", { limit: 10 })).resolves.toMatchObject({ items: [], total: 0 })

    database.prepare("UPDATE wg_v2_work_items SET updated_at = 500 WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
      .run("organization", "owner_a", "item_a")
    const changed = await restarted.query(owner("owner_a"), "attention", "list", { limit: 10 })
    expect(changed).toMatchObject({ items: [{ id: "item_a" }], total: 1 })
    expect(changed.items[0]).not.toHaveProperty("readAt")

    now = 600
    await expect(acknowledgements.markAllRead(owner("owner_a"))).resolves.toEqual({
      ownerUserId: "owner_a",
      readAt: 600,
      clearedAt: 400,
    })
    await expect(restarted.query(owner("owner_a"), "attention", "list", { limit: 10 })).resolves.toMatchObject({
      items: [{ id: "item_a", readAt: 600 }],
      total: 1,
    })
  })
})

async function seedAttention(
  database: BetterSqlite3.Database,
  service: ReturnType<typeof createSqliteWorkGraphService>["service"],
  context: WorkGraphContext,
  id: string,
  updatedAt: number,
) {
  const stream = await service.execute(context, {
    operationId: `create_stream_${id}` as never,
    command: { version: 1, type: "create_stream", title: "Attention" },
  })
  if (!stream.ok || !stream.value || typeof stream.value !== "object" || !("streamId" in stream.value)) throw new Error("Stream was not created")
  const item = await service.execute(context, {
    operationId: `create_item_${id}` as never,
    command: {
      version: 1,
      type: "create_work_item",
      streamId: stream.value.streamId as never,
      title: "Review",
      completionContract: {
        version: 1,
        mode: "all",
        requirements: [{ id: "owner" as never, kind: "owner_confirmation", description: "Review" }],
      },
    },
  })
  if (!item.ok || !item.value || typeof item.value !== "object" || !("workItemId" in item.value)) throw new Error("Task was not created")
  database.prepare("UPDATE wg_v2_work_items SET id = ?, lifecycle = 'review_needed', updated_at = ? WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
    .run(id, updatedAt, context.organizationId, context.ownerUserId, item.value.workItemId)
}

function owner(ownerUserId: string): WorkGraphContext {
  return {
    organizationId: "organization" as never,
    ownerUserId: ownerUserId as never,
    actor: { type: "user", id: ownerUserId as never },
    requestId: `request_${ownerUserId}` as never,
    access: { mode: "owner" },
  }
}
