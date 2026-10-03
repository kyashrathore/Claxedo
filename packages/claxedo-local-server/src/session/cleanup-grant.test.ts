import { afterEach, describe, expect, test, vi } from "vitest"
const admit = vi.hoisted(() => vi.fn())
vi.mock("./cleanup-reader", () => ({ admitLocalSessionCleanup: admit }))
import { localSessionCleanupGrant } from "./cleanup-grant"

afterEach(() => admit.mockClear())

describe("local cleanup batch owner-driven grant", () => {
  test("withdrawal during the first delete prevents admission and dispatch of later targets", async () => {
    let owned = true
    const dispatched: string[] = []
    const grant = localSessionCleanupGrant({ ownerDriven: () => owned, fetch: async (request) => {
      const id = new URL(request.url).pathname.split("/")[2]
      dispatched.push(id)
      owned = false
      return Response.json({ ok: true, deletedSessionIds: [id] })
    } })
    const targets = ["first", "second"].map((sessionId) => ({ sessionId, workspaceId: "local", generation: 1, activitySequence: 5, readerRevision: 0, descendants: [] }))
    const response = await grant.fetch("/api/claxedo/session-cleanup/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targets, cascade: false }) })
    expect(await response.json()).toMatchObject({ results: [
      { sessionId: "first", status: "deleted", deletedSessionIds: ["first"] },
      { sessionId: "second", status: "failed", code: "cleanup_capability_revoked" },
    ] })
    expect(admit).toHaveBeenCalledTimes(1)
    expect(dispatched).toEqual(["first"])
  })
})
