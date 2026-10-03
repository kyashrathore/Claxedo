import { beforeEach, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({ token: "host-secret-1", served: true, owned: true, workspaceIds: ["ws"] }))
vi.mock("@claxedo/host-serving/serving", () => ({ hostServingPublisherCredential: () => state.served ? { hostId: "machine", token: state.token, workspaceIds: state.workspaceIds } : undefined }))
vi.mock("../deployments/local/host-session-authority", () => ({ localHostSessionRowsUrl: () => "https://cp.test/api/claxedo/host/session-rows" }))
const { hostSessionCleanupGrant } = await import("./host-cleanup-grant")
beforeEach(() => { state.token = "host-secret-1"; state.served = true; state.owned = true; state.workspaceIds = ["ws"] })

function fixture() {
  const calls: { url: string; authorization: string | null; body: unknown }[] = []
  const send = async (input: URL, init?: RequestInit) => {
    const request = new Request(input, init)
    calls.push({ url: request.url, authorization: request.headers.get("authorization"), body: init?.body ? await new Response(init.body).json() : undefined })
    if (request.url.endsWith("/grant")) return Response.json({ token: `cleanup-grant-${calls.length}`, expiresAt: Date.now() + 60_000 })
    return Response.json({ candidates: [], incompleteSources: [] })
  }
  const grant = hostSessionCleanupGrant({ workspaceId: "ws", sessionId: "caller", ownerDriven: () => state.owned, send })
  return { calls, grant }
}

test("host identity only mints a dedicated cleanup bearer and never reaches runtime tools", async () => {
  const { calls, grant } = fixture()
  expect(grant.allowed()).toBe(true)
  await grant.fetch("/api/claxedo/session-cleanup?seen=seen")
  await grant.fetch("/api/claxedo/session-cleanup?settled=settled")
  expect(calls).toHaveLength(3)
  expect(calls[0]).toEqual({ url: "https://cp.test/api/claxedo/session-cleanup/grant", authorization: "Bearer host-secret-1", body: { scope: "session", hostId: "machine", workspaceId: "ws", sessionId: "caller" } })
  expect(calls[1]?.authorization).toBe("Bearer cleanup-grant-1")
  expect(calls[2]?.authorization).toBe("Bearer cleanup-grant-1")
  await expect(grant.fetch("https://outside.test/api/claxedo/session-cleanup")).rejects.toThrow("cannot reach")
  expect(calls).toHaveLength(3)
})

test("owner withdrawal and enrollment stop block requests before credentials are transmitted", async () => {
  const { grant, calls } = fixture()
  state.owned = false
  expect(grant.allowed()).toBe(false)
  expect((await grant.fetch("/api/claxedo/session-cleanup")).status).toBe(503)
  state.owned = true
  state.served = false
  expect((await grant.fetch("/api/claxedo/session-cleanup")).status).toBe(503)
  expect(calls).toEqual([])
})

test("a changed host credential requires fresh canonical issuer approval", async () => {
  const { grant, calls } = fixture()
  await grant.fetch("/api/claxedo/session-cleanup")
  state.token = "host-secret-2"
  await grant.fetch("/api/claxedo/session-cleanup")
  expect(calls.filter((row) => row.url.endsWith("/grant")).map((row) => row.authorization)).toEqual(["Bearer host-secret-1", "Bearer host-secret-2"])
})

test("an unserved local folder requests explicit machine-owner consent instead of borrowing a served origin", async () => {
  state.workspaceIds = ["another-project"]
  const { grant, calls } = fixture()
  expect(grant.allowed()).toBe(true)
  await grant.fetch("/api/claxedo/session-cleanup")
  expect(calls[0]?.body).toEqual({ scope: "machine", hostId: "machine" })
  expect(calls[1]?.authorization).toBe("Bearer cleanup-grant-1")
  state.workspaceIds = ["ws"]
  await grant.fetch("/api/claxedo/session-cleanup")
  expect(calls[2]?.body).toEqual({ scope: "session", hostId: "machine", workspaceId: "ws", sessionId: "caller" })
})
