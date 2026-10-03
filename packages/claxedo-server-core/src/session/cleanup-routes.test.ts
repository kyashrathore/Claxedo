import { expect, test } from "vitest"
import { SessionCleanupRoutes } from "./cleanup-routes"
import { buildSessionListResponse } from "./navigation-list"
import type { SessionCleanupTarget } from "@claxedo/agent-runtime-contract"
import { WorkspaceRuntimeClientError, WorkspaceRuntimeClientTransportError } from "@claxedo/workspace-runtime/client"

const facts = { sequence: 5, generation: 1, activitySequence: 5, activityAt: Date.parse("2026-10-02T00:00:00Z"), working: false, awaitingInput: false, outcome: { sequence: 5, completedAt: 200, status: "completed" as const } }
const reader = { generation: 1, revision: 2, seenThrough: 5, seenAt: 200, settledThrough: 5, settledAt: Date.parse("2026-10-02T00:00:00Z") }
const target: SessionCleanupTarget = { sessionId: "root", workspaceId: "ws", generation: 1, activitySequence: 5, readerRevision: 2, descendants: [{ sessionId: "child", generation: 1, activitySequence: 3 }] }

function fixture(input: { readerRevision?: number; unavailable?: boolean } = {}) {
  const writes: SessionCleanupTarget[] = []
  const app = SessionCleanupRoutes({ authenticate: async () => ({
    list: async (query) => ({ ...buildSessionListResponse({ query, sessions: [{ sessionID: "root", workspaceID: "ws", createdAt: 100, updatedAt: 200, attention: facts, reader, title: "Root" }] }), incompleteSources: [{ workspaceId: "offline", reason: "machine offline" }] }),
    prepare: async () => input.unavailable ? { unavailable: "runtime offline" } : { descendants: target.descendants },
    admit: async (selected) => { if (selected.readerRevision !== (input.readerRevision ?? 2)) throw Object.assign(new Error("Reader state changed"), { code: "session_cleanup_changed" }) },
    delete: async (selected) => { writes.push(selected); return { deletedSessionIds: [selected.sessionId, ...selected.descendants.map((row) => row.sessionId)] } },
  }) })
  return { app, writes }
}

async function remove(app: ReturnType<typeof SessionCleanupRoutes>, targets: readonly SessionCleanupTarget[], cascade = true) {
  return app.request("http://fixture/api/claxedo/session-cleanup/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targets, cascade }) })
}

test("selection filters dates and reader state before paging and reports unavailable sources", async () => {
  const { app } = fixture()
  const query = "seen=seen&settled=settled&dateField=settled&from=2026-10-02T00%3A00%3A00Z&until=2026-10-03T00%3A00%3A00Z"
  const response = await app.request(`http://fixture/api/claxedo/session-cleanup?${query}`)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ candidates: [{ ...target, seen: true, settled: true }], incompleteSources: [{ workspaceId: "offline" }] })
  const upperExclusive = await app.request("http://fixture/api/claxedo/session-cleanup?settled=all&dateField=activity&until=2026-10-02T00%3A00%3A00Z")
  expect((await upperExclusive.json()).candidates).toEqual([])
})

test("invalid and timezone-free date bounds return 400", async () => {
  const { app } = fixture()
  expect((await app.request("http://fixture/api/claxedo/session-cleanup?from=2026-10-01")).status).toBe(400)
  expect((await app.request("http://fixture/api/claxedo/session-cleanup?from=2026-10-03T00:00:00Z&until=2026-10-01T00:00:00Z")).status).toBe(400)
})

test("offline preparation produces explicit incomplete selection", async () => {
  const { app } = fixture({ unavailable: true })
  const response = await app.request("http://fixture/api/claxedo/session-cleanup?settled=all")
  expect(await response.json()).toMatchObject({ candidates: [], incompleteSources: [{ workspaceId: "offline" }, { sessionId: "root", reason: "runtime offline" }] })
})

test("a changed reader conflicts before any deletion and exact unchanged target succeeds", async () => {
  const { app, writes } = fixture({ readerRevision: 3 })
  const response = await remove(app, [target, { ...target, sessionId: "other", readerRevision: 3 }])
  expect(await response.json()).toMatchObject({ deletion: "logical", journalRetained: true, results: [{ sessionId: "root", status: "failed", code: "session_cleanup_changed" }, { sessionId: "other", status: "deleted", deletedSessionIds: ["other", "child"] }] })
  expect(writes.map((selected) => selected.sessionId)).toEqual(["other"])
})

test("unapproved cascades, duplicate roots and malformed selections make no writes", async () => {
  const { app, writes } = fixture()
  const refused = await remove(app, [target], false)
  expect(await refused.json()).toMatchObject({ results: [{ status: "failed", code: "cascade_required" }] })
  expect((await remove(app, [target, target])).status).toBe(400)
  expect((await app.request("http://fixture/api/claxedo/session-cleanup/delete", { method: "POST", headers: { "content-type": "application/json" }, body: "{broken" })).status).toBe(400)
  expect(writes).toEqual([])
})

test("authority refusal is returned without disclosing candidates or invoking deletion", async () => {
  const app = SessionCleanupRoutes({ authenticate: async () => Response.json({ error: "denied" }, { status: 403 }) })
  expect((await app.request("http://fixture/api/claxedo/session-cleanup")).status).toBe(403)
  expect((await remove(app, [target])).status).toBe(403)
})

test("runtime partial receipts retain deleted children and lost receipts stay unknown", async () => {
  const app = SessionCleanupRoutes({ authenticate: async () => ({
    list: async () => ({ view: { scope: "all", sort: "human_turn_desc", limit: 10 }, items: [] }),
    prepare: async () => ({ descendants: [] }),
    admit: async () => {},
    delete: async (selected) => {
      if (selected.sessionId === "root") throw new WorkspaceRuntimeClientError("session.delete", 500, "session_delete_failed", { error: { details: { deletedSessionIds: ["child"] } } }, "Root provider close failed")
      if (selected.sessionId === "proxy") throw new WorkspaceRuntimeClientError("session.delete", 504, "gateway_timeout", {}, "Relay timed out after dispatch")
      throw new WorkspaceRuntimeClientTransportError("session.delete", new Error("connection lost"))
    },
  }) })
  const response = await remove(app, [target, { ...target, sessionId: "unknown" }, { ...target, sessionId: "proxy" }])
  expect(await response.json()).toMatchObject({ results: [
    { sessionId: "root", status: "failed", deletedSessionIds: ["child"] },
    { sessionId: "unknown", status: "unknown", code: "outcome_unknown" },
    { sessionId: "proxy", status: "unknown", code: "outcome_unknown" },
  ] })
})
