import { expect, test } from "vitest"
import { createSqliteLeaseStore } from "./sqlite"

test("SQLite persists address identity through resume and never reuses it after release", async () => {
  const store = createSqliteLeaseStore()
  const workspaceId = crypto.randomUUID()
  const acquire = { driver: "test", homeRegion: "us-east", staleAfterMs: 30_000 }
  const target = { sandboxId: "sandbox", hostId: "host", url: "https://old.test", labels: {} }
  await store.acquire(workspaceId, acquire)
  const first = await store.recordTarget(workspaceId, 1, target)
  const resumed = await store.recordTarget(workspaceId, 1, { ...target, url: "https://new.test" })
  expect(resumed?.routingId).toEqual(expect.any(String))
  expect(resumed?.routingId).not.toBe(first?.routingId)
  expect((await createSqliteLeaseStore().get(workspaceId))?.routingId).toBe(resumed?.routingId)
  expect((await store.recordTarget(workspaceId, 1, { ...target, url: "https://new.test" }))?.routingId).toBe(resumed?.routingId)
  await store.release(workspaceId)
  await store.acquire(workspaceId, acquire)
  const replaced = await store.recordTarget(workspaceId, 1, target)
  expect(replaced?.routingId).not.toBe(first?.routingId)
  expect(replaced?.routingId).not.toBe(resumed?.routingId)
  await store.release(workspaceId)
})
