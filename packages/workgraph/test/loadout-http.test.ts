import { describe, expect, test } from "vitest"
import Database from "better-sqlite3"
import { createApp, initializeDb } from "../src/app"
import { handleToolCall } from "../src/mcp/tools"
import { getWorkGraph, resetWorkGraph } from "../src/model/registry"
import { openSqliteEventStore } from "../src/substrate/event-store-sqlite"
import { openSqlitePlannerStore } from "../src/sdk/planner"

function put(body: unknown) {
  return {
    method: "PUT" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

describe("Loadout HTTP and MCP surface", () => {
  test("applies narrow slots, gates broad slots, resolves through scope chain, and exposes MCP read", async () => {
    resetWorkGraph()
    const db = new Database(":memory:")
    initializeDb(db)
    const app = createApp(db)

    const narrow = await app.request("/loadout", put({
      scope_type: "work_item",
      scope_id: "missing_item",
      kind: "triage_mode",
      payload: { name: "light", overrides: null },
    }))
    expect(narrow.status).toBe(200)
    expect(await narrow.json()).toEqual(expect.objectContaining({
      scopeType: "work_item",
      scopeId: "missing_item",
      kind: "triage_mode",
    }))

    const broad = await app.request("/loadout", put({
      scope_type: "repo",
      scope_id: "github:acme/app",
      kind: "triage_mode",
      payload: { name: "deep", overrides: null },
    }))
    expect(broad.status).toBe(202)
    const broadBody = await broad.json()
    expect(broadBody).toEqual(expect.objectContaining({ outcome: "decision" }))
    expect(Object.values(getWorkGraph().getState().loadoutSlots).some((slot) => slot.scopeType === "repo")).toBe(false)

    getWorkGraph().acceptDecision(broadBody.decision.id)
    const item = getWorkGraph().create({
      title: "Repo task",
      repoRef: "github:acme/app",
    })

    const resolved = await app.request(`/loadout?scopeType=work_item&scopeId=${item.id}&kind=triage_mode`)
    expect(resolved.status).toBe(200)
    expect(await resolved.json()).toEqual(expect.objectContaining({
      source: "slot",
      scopeType: "repo",
      scopeId: "github:acme/app",
      name: "deep",
    }))

    const eventStore = openSqliteEventStore(db)
    const mcp = await handleToolCall({
      plannerStore: openSqlitePlannerStore(db),
      eventStore,
      runId: "run_1",
    }, "read_loadout", {
      subject: { type: "work_item", id: item.id },
      kind: "triage_mode",
    }, "captain")
    expect(mcp).toEqual(expect.objectContaining({
      source: "slot",
      name: "deep",
    }))
    resetWorkGraph()
  })
})
