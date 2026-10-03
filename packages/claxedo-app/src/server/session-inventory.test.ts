/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId } from "./ids"
import type { SessionContext } from "./session-context"
import { readSessionInventory } from "./session-inventory"

type InventoryReply = { items: unknown[]; totalKnown: number }
type InventoryResponse = InventoryReply | Error | ((query: Readonly<Record<string, unknown>>) => InventoryReply)
type Options = { loopback?: boolean; account?: boolean; local?: InventoryResponse; hosted?: InventoryResponse; sharedFailure?: Error }

function item(id: string, workspaceId: string, createdAt: number) {
  return {
    sessionId: id, sessionRef: `${workspaceId}/${id}`, workspaceId, directory: `/projects/${workspaceId}`,
    title: id, createdAt, updatedAt: createdAt, projectName: "Project", placement: { kind: "local" },
    attention: { generation: 1, sequence: 1, activitySequence: 1, activityAt: createdAt, working: false, awaitingInput: false },
    reader: { generation: 1, revision: 0, seenThrough: 0 }, status: { kind: "idle", awaitingInput: false },
  }
}

function reply(id: string, workspaceId: string, createdAt: number, needs: number): InventoryReply {
  return { items: [item(id, workspaceId, createdAt)], totalKnown: needs }
}

function context(options: Options = {}) {
  const paths: string[] = []
  const accountCalls: Array<{ operation: string; input?: Readonly<Record<string, unknown>> }> = []
  const read = (response: InventoryResponse | undefined, query: Readonly<Record<string, unknown>>) => {
    if (response instanceof Error) throw response
    if (typeof response === "function") return response(query)
    return response ?? { items: [], totalKnown: 0 }
  }
  const value = {
    transport: { loopback: options.loopback !== false, json: async (path: string) => { paths.push(path); return read(options.local, Object.fromEntries(new URL(path, "http://localhost").searchParams)) } },
    workspaces: {
      load: async () => undefined,
      shared: { load: async () => { if (options.sharedFailure) throw options.sharedFailure } },
      accountWorkspaceIds: () => options.account ? ["ws_account"] : [],
      address: { placementFor: (_directory: string, workspaceId: string) => ({ projectId: projectId(`prj_${workspaceId}`), placementId: placementId(`plc_${workspaceId}`) }) },
      learn: async () => undefined,
    },
    status: { listed: (_ref: unknown, status: unknown) => status },
    ...(options.account ? { account: { run: async (operation: string, input?: Readonly<Record<string, unknown>>) => { accountCalls.push({ operation, input }); return read(options.hosted, input ?? {}) } } } : {}),
  } as unknown as SessionContext
  return { value, paths, accountCalls }
}

test("unsigned desktop inventory reads its local authority and full active count", async () => {
  const state = context({ local: reply("local", "ws_local", 10, 73) })
  const page = await readSessionInventory(state.value, { settled: "active", limit: 25 })
  expect(state.paths).toEqual(["/api/claxedo/session-list?settled=active&limit=25&sort=human_turn_desc&scope=all"])
  expect(state.accountCalls).toEqual([])
  expect(page.rows.map((row) => row.ref.sessionId)).toEqual([sessionId("local")])
  expect(page.totalKnown).toBe(73)
  expect(page.rows[0]).toMatchObject({ projectName: "Project", placement: { kind: "local" }, reader: { revision: 0 } })
})

test("signed desktop excludes hosted mirror workspaces from local rows and sums disjoint counts", async () => {
  const state = context({ account: true, local: reply("local", "ws_local", 10, 73), hosted: reply("hosted", "ws_account", 20, 129) })
  const page = await readSessionInventory(state.value, { ownership: "all", settled: "active", limit: 25 })
  expect(new URL(state.paths[0], "http://localhost").searchParams.get("excludeWorkspaces")).toBe("ws_account")
  expect(state.accountCalls).toEqual([{ operation: "session.inventory", input: { ownership: "all", settled: "active", limit: 25, sort: "human_turn_desc", after: undefined } }])
  expect(page.rows.map((row) => row.ref.sessionId)).toEqual([sessionId("hosted"), sessionId("local")])
  expect(page.totalKnown).toBe(202)
  expect(page.degraded).toBe(false)
})

test("web inventory reads the control authority without a local source", async () => {
  const active = item("hosted", "ws_account", 10)
  const state = context({ loopback: false, local: { items: [active], totalKnown: 16 } })
  const page = await readSessionInventory(state.value, { settled: "active", limit: 25 })
  expect(state.paths).toEqual(["/api/control/session-list?settled=active&limit=25&sort=human_turn_desc&scope=all"])
  expect(page.totalKnown).toBe(16)
  expect(page.degraded).toBe(false)
})

test("a failed hosted inventory keeps local rows and makes the incomplete result visible", async () => {
  const state = context({ account: true, local: reply("local", "ws_local", 10, 7), hosted: new Error("hosted unavailable") })
  const page = await readSessionInventory(state.value, { settled: "active", limit: 25 })
  expect(page.rows.map((row) => row.ref.sessionId)).toEqual([sessionId("local")])
  expect(page.totalKnown).toBe(7)
  expect(page.degraded).toBe(true)
})

test("a failed shared workspace read does not suppress local inventory", async () => {
  const state = context({ account: true, local: reply("local", "ws_local", 10, 7), sharedFailure: new Error("share inventory unavailable") })
  const page = await readSessionInventory(state.value, { settled: "active", limit: 25 })
  expect(page.rows.map((row) => row.ref.sessionId)).toEqual([sessionId("local")])
  expect(page.degraded).toBe(true)
  expect(state.accountCalls).toEqual([])
})

test("a failed local inventory keeps hosted rows with hosted counts", async () => {
  const state = context({ account: true, local: new Error("daemon unavailable"), hosted: reply("hosted", "ws_account", 10, 29) })
  const page = await readSessionInventory(state.value, { settled: "active", limit: 25 })
  expect(page.rows.map((row) => row.ref.sessionId)).toEqual([sessionId("hosted")])
  expect(page.totalKnown).toBe(29)
  expect(page.degraded).toBe(true)
})

test("when every source fails the inventory fails instead of showing an empty ready list", async () => {
  const state = context({ loopback: false, account: true, hosted: new Error("control plane unavailable") })
  await expect(readSessionInventory(state.value, { settled: "active", limit: 25 })).rejects.toThrow("control plane unavailable")
})

test("missing totals reject a source instead of reporting counts from the visible page", async () => {
  const state = context({ local: { items: [item("local", "ws_local", 1)], totalKnown: Number.NaN } })
  await expect(readSessionInventory(state.value, { settled: "active", limit: 25 })).rejects.toThrow()
})
