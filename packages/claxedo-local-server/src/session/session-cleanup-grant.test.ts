import { beforeEach, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  owned: true,
  signed: true,
  local: [] as string[],
  account: [] as string[],
  excluded: undefined as (() => Promise<readonly string[]>) | undefined,
}))
vi.mock("@claxedo/server-core/workspace/store/index", () => ({ listWorkspaces: async () => [{ id: "local", kind: "local" }, { id: "hosted", kind: "local", org_id: "org" }] }))
vi.mock("@claxedo/host-serving/serving", () => ({ hostServingPublisherCredential: () => state.signed ? { hostId: "machine", token: "secret", workspaceIds: ["hosted"] } : undefined }))
vi.mock("../deployments/local/host-session-authority", () => ({ localHostSessionRowsUrl: () => state.signed ? "https://cp.test/rows" : undefined }))
vi.mock("./cleanup-grant", () => ({ localSessionCleanupGrant: (input: { excludeWorkspaces(): Promise<readonly string[]> }) => {
  state.excluded = () => input.excludeWorkspaces()
  return { allowed: () => state.owned, fetch: async (path: string, init?: RequestInit) => {
    state.local.push(path)
    if (init?.method === "POST") return Response.json({ results: [{ sessionId: "l", workspaceId: "local", status: "deleted", deletedSessionIds: ["l"] }] })
    return Response.json({ candidates: [{ sessionId: "l", workspaceId: "local" }], incompleteSources: [] })
  } }
} }))
vi.mock("./host-cleanup-grant", () => ({ hostSessionCleanupGrant: () => ({ allowed: () => state.signed, fetch: async (path: string, init?: RequestInit) => {
  state.account.push(path)
  if (init?.method === "POST") return Response.json({ results: [{ sessionId: "h", workspaceId: "hosted", status: "failed", code: "session_cleanup_changed", message: "Reader changed" }] })
  return Response.json({ candidates: [{ sessionId: "h", workspaceId: "hosted" }], incompleteSources: [] })
} }) }))
const { sessionCleanupGrant } = await import("./session-cleanup-grant")
const grant = () => sessionCleanupGrant({ workspaceId: "hosted", sessionId: "caller", ownerDriven: () => state.owned, fetch: async () => new Response() })
beforeEach(() => { state.owned = true; state.signed = true; state.local = []; state.account = [] })

test("local then account pages retain filters and exclude hosted mirrors from local reader state", async () => {
  const client = grant()
  const first = await client.fetch("/api/claxedo/session-cleanup?seen=seen&settled=settled")
  const page = await first.json()
  expect(page.candidates[0].workspaceId).toBe("local")
  expect(await state.excluded!()).toEqual(["hosted"])
  const second = await client.fetch(`/api/claxedo/session-cleanup?seen=seen&settled=settled&cursor=${page.nextCursor}`)
  expect((await second.json()).candidates[0].workspaceId).toBe("hosted")
  expect(state.account[0]).toContain("seen=seen&settled=settled")
  expect(state.account[0]).not.toContain("cursor=")
})

test("filter switches cannot reuse a combined source cursor", async () => {
  const client = grant()
  const page = await (await client.fetch("/api/claxedo/session-cleanup?seen=seen")).json()
  expect((await client.fetch(`/api/claxedo/session-cleanup?seen=unseen&cursor=${page.nextCursor}`)).status).toBe(400)
  expect(state.account).toEqual([])
})

test("deletion routes each exact target through its reader authority and preserves result order", async () => {
  const client = grant()
  const response = await client.fetch("/api/claxedo/session-cleanup/delete", { method: "POST", body: JSON.stringify({ targets: [{ sessionId: "h", workspaceId: "hosted" }, { sessionId: "l", workspaceId: "local" }], cascade: true }) })
  expect((await response.json()).results).toEqual([
    expect.objectContaining({ sessionId: "h", status: "failed", code: "session_cleanup_changed" }),
    expect.objectContaining({ sessionId: "l", status: "deleted" }),
  ])
  expect(state.local).toHaveLength(1)
  expect(state.account).toHaveLength(1)
})

test("owner withdrawal revokes the whole grant before any source is called", async () => {
  const client = grant()
  state.owned = false
  expect(client.allowed()).toBe(false)
  expect((await client.fetch("/api/claxedo/session-cleanup")).status).toBe(403)
  expect(state.local).toEqual([])
  expect(state.account).toEqual([])
})

test("a canonical signed desktop grant adds an account source with no served workspaces", async () => {
  state.signed = false
  const paths: string[] = []
  const client = sessionCleanupGrant({ workspaceId: "local", sessionId: "caller", ownerDriven: () => true, fetch: async () => new Response(), account: {
    allowed: () => true, fetch: async (path) => { paths.push(path); return Response.json({ candidates: [], incompleteSources: [] }) },
  } })
  const page = await (await client.fetch("/api/claxedo/session-cleanup?seen=unseen")).json()
  expect(page.nextCursor).toBeTypeOf("string")
  const account = await (await client.fetch(`/api/claxedo/session-cleanup?seen=unseen&cursor=${page.nextCursor}`)).json()
  expect(account.incompleteSources).toEqual([])
  expect(paths).toEqual(["/api/claxedo/session-cleanup?seen=unseen"])
})

test("withdrawn account consent reports that source as incomplete while retaining available local selection", async () => {
  const client = sessionCleanupGrant({ workspaceId: "local", sessionId: "caller", ownerDriven: () => true, fetch: async () => new Response(), account: {
    allowed: () => true, fetch: async () => new Response(null, { status: 403 }),
  } })
  const first = await (await client.fetch("/api/claxedo/session-cleanup")).json()
  expect(first.candidates).toEqual([{ sessionId: "l", workspaceId: "local" }])
  const second = await client.fetch(`/api/claxedo/session-cleanup?cursor=${first.nextCursor}`)
  expect(second.status).toBe(200)
  expect(await second.json()).toEqual({ candidates: [], incompleteSources: [{ reason: "Account cleanup authority was refused (403)" }] })
})
