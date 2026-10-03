/// <reference types="bun" />
import { expect, test } from "bun:test"
import { sessionId, type SessionInventoryPage } from "@/server"
import { createSessionInventory } from "./inventory"
import { createInventoryReads } from "./inventory-reads"
import { inventoryRows } from "./inventory-rows"
import { deferred, inventoryPage, inventoryRow, inventoryServer, inventoryTestState } from "./inventory.test-support"

test("inventory invalidation discards a held snapshot and serializes one latest refetch", async () => {
  const state = inventoryTestState()
  const oldPage = deferred<SessionInventoryPage>()
  const latestPage = deferred<SessionInventoryPage>()
  const latestStarted = deferred<void>()
  let calls = 0
  let concurrent = 0
  let maximum = 0
  const server = inventoryServer(async () => {
    maximum = Math.max(maximum, ++concurrent)
    const pending = ++calls === 1 ? oldPage : latestPage
    if (calls === 2) latestStarted.resolve()
    const page = await pending.promise
    concurrent -= 1
    return page
  })
  const reads = createInventoryReads(server, state.list, state.windows)
  const initial = reads.read("active")
  expect(reads.read("active")).toBe(initial)
  expect(reads.read("active")).toBe(initial)
  oldPage.resolve(inventoryPage([inventoryRow("stale")]))
  await latestStarted.promise
  expect(state.list.state().entries.size).toBe(0)
  latestPage.resolve(inventoryPage([inventoryRow("current")]))
  await initial
  expect(calls).toBe(2)
  expect(maximum).toBe(1)
  expect(state.windows.active.state().count).toBe(109)
  expect([...state.list.state().entries.keys()]).toEqual([sessionId("current")])
})

test("a late active page preserves live work and the same row position", async () => {
  const state = inventoryTestState()
  const row = inventoryRow("moving")
  state.list.send({ type: "inventoryRead", rows: [row], statuses: new Map(), sentAt: 1, ids: new Set([row.ref.sessionId]) })
  const held = deferred<SessionInventoryPage>()
  const reads = createInventoryReads(inventoryServer(() => held.promise), state.list, state.windows)
  const read = reads.read("active")
  state.list.send({ type: "attentionChanged", ref: row.ref, attention: { ...row.attention!, sequence: 2, activitySequence: 2, activityAt: 2, working: true }, delivery: "live" })
  held.resolve(inventoryPage([row]))
  await read
  expect(inventoryRows(state.list.state().entries, state.windows.active.state())).toEqual([row.ref])
  expect(state.list.state().entries.get(row.ref.sessionId)).toMatchObject({ row: { attention: { working: true, sequence: 2 } } })
  expect(state.list.state().entries.size).toBe(1)
})

test("reloading preserves the fifty-row prefix the user has already expanded", async () => {
  const state = inventoryTestState()
  const rows = Array.from({ length: 50 }, (_, index) => inventoryRow(`session_${index}`, 100 - index))
  const requests: Array<string | undefined> = []
  const reads = createInventoryReads(inventoryServer(async (input) => {
    requests.push(input.after)
    return input.after ? inventoryPage(rows.slice(25)) : inventoryPage(rows.slice(0, 25), "second")
  }), state.list, state.windows)
  await reads.read("active")
  await reads.read("active", true)
  await reads.read("active")
  expect(requests).toEqual([undefined, "second", undefined, "second"])
  expect(state.windows.active.state().refs).toEqual(rows.map((row) => row.ref))
  expect(state.windows.active.state().count).toBe(109)
  expect(state.list.state().entries.size).toBe(50)
})

test("Shared queries restrict ownership before paging and keep only identities in windows", async () => {
  const state = inventoryTestState()
  const row = inventoryRow("shared")
  const inputs: unknown[] = []
  const reads = createInventoryReads(inventoryServer(async (input) => {
    inputs.push(input)
    return inventoryPage([row])
  }), state.list, state.windows)
  await reads.read("shared")
  expect(inputs).toEqual([{ settled: "active", ownership: "shared", limit: 25, after: undefined }])
  expect(state.windows.shared.state().count).toBe(109)
  expect(state.windows.shared.state().refs).toEqual([row.ref])
  expect("rows" in state.windows.shared.state()).toBe(false)
  state.list.send({ type: "sessionUpserted", row: { ...row, title: "Latest title", updatedAt: 2 } })
  expect(state.list.state().entries.get(row.ref.sessionId)).toMatchObject({ row: { title: "Latest title" } })
})


test("Activity loads only active inventory without group or settled queries", async () => {
  const state = inventoryTestState()
  const inputs: unknown[] = []
  const reads = createInventoryReads(inventoryServer(async (input) => {
    inputs.push(input)
    return inventoryPage([])
  }), state.list, state.windows)
  await reads.read("active")
  expect(inputs).toEqual([{ settled: "active", limit: 25, after: undefined }])
  expect(Object.keys(state.windows)).toEqual(["active", "shared"])
})

test("changing the Activity filter fences the held page and requests the latest canonical filter once", async () => {
  const state = inventoryTestState()
  const old = deferred<SessionInventoryPage>()
  const calls: Array<string | undefined> = []
  const work = { ...inventoryRow("working"), attention: { ...inventoryRow("working").attention!, working: true } }
  const server = inventoryServer(async (input) => {
    calls.push(input.activity)
    if (calls.length === 1) return old.promise
    return inventoryPage(input.activity === "working" ? [work] : [inventoryRow("needs-you")])
  })
  const inventory = createSessionInventory(server, state.list)
  const loading = inventory.load()
  const changing = inventory.cycleFilter()
  old.resolve(inventoryPage([inventoryRow("old-all")]))
  await Promise.all([loading, changing])
  expect(calls).toEqual([undefined, "working"])
  expect(inventory.rows().map((ref) => ref.sessionId)).toEqual([sessionId("working")])
  expect(state.list.state().entries.has(sessionId("old-all"))).toBe(false)
  await inventory.cycleFilter()
  expect(inventory.rows().map((ref) => ref.sessionId)).toEqual([sessionId("needs-you")])
  expect(calls).toEqual([undefined, "working", "needs-you"])
  await inventory.resetFilter()
  expect(inventory.filter()).toBe("all")
  expect(calls).toEqual([undefined, "working", "needs-you", undefined])
  await inventory.resetFilter()
  expect(calls).toHaveLength(4)
})
