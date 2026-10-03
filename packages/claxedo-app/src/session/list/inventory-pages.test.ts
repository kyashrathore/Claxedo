/// <reference types="bun" />
import { expect, test } from "bun:test"
import { readInventoryPages } from "./inventory-pages"
import { inventoryPage, inventoryRow, inventoryServer } from "./inventory.test-support"

test("inventory pagination reports a repeated cursor instead of hanging the sidebar", async () => {
  let calls = 0
  const server = inventoryServer(async () => {
    calls += 1
    return inventoryPage([inventoryRow("same")], "repeated")
  })
  await expect(readInventoryPages(server, { settled: "active", limit: 25 }, 50)).rejects.toThrow("repeated cursor")
  expect(calls).toBe(2)
})

test("inventory refill retains rows, statuses and a failure indication from any loaded page", async () => {
  const first = inventoryRow("first")
  const second = inventoryRow("second")
  const server = inventoryServer(async (input) => {
    const page = inventoryPage(input.after ? [second] : [first], input.after ? undefined : "second")
    return { ...page, degraded: !input.after, statuses: new Map([[input.after ? second.ref.sessionId : first.ref.sessionId, { status: { kind: "idle" }, waitingOnUser: false, backgroundWork: { agents: 0, shells: 0, other: 0 } }]]) }
  })
  const page = await readInventoryPages(server, { settled: "active", limit: 25 }, 2)
  expect(page.rows).toEqual([first, second])
  expect([...page.statuses.keys()]).toEqual([first.ref.sessionId, second.ref.sessionId])
  expect(page.degraded).toBe(true)
  expect(page.totalKnown).toBe(109)
  expect(page.nextAfter).toBeUndefined()
})
