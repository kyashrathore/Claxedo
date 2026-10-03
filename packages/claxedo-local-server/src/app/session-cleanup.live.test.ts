import { afterAll, beforeAll, expect, test } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { SessionCleanupCandidate } from "@claxedo/agent-runtime-contract"
import { createServer, type Server } from "node:http"
import { setLocalHostEndpoints } from "../deployments/local/host-session-authority"
import { callTool, startLiveFirstPartyMcp, toolText, type LiveMcpFixture } from "./test-support/first-party-mcp-live"

let live: LiveMcpFixture
const clients: Client[] = []
let authority: Server
const accountRequests: (string | undefined)[] = []
beforeAll(async () => {
  authority = createServer((request, response) => {
    if (request.url?.startsWith("/api/claxedo/session-cleanup")) {
      accountRequests.push(request.headers.authorization)
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ candidates: [], incompleteSources: [] }))
      return
    }
    let raw = ""
    request.on("data", (chunk) => { raw += chunk })
    request.on("end", () => {
      const body = JSON.parse(raw || "{}")
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(body.action === "turn_acquire"
        ? { allowed: true, turnId: body.turnId, leaseId: "member-turn", fencingToken: 1, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }
        : { allowed: true, lease: "member-read", expiresAt: Date.now() + 60_000 }))
    })
  })
  await new Promise<void>((resolve) => authority.listen(0, "127.0.0.1", resolve))
  const address = authority.address()
  if (!address || typeof address === "string") throw new Error("No authority fixture port")
  setLocalHostEndpoints({ ownerActorId: "owner", sessionAuthorityUrl: `http://127.0.0.1:${address.port}/authorize` })
  live = await startLiveFirstPartyMcp({ runtimeProxyOptions: { resolveRelayActor: async (request) => request.headers.get("authorization") === "Bearer bob" ? {
    actorId: "bob", actorPublicId: "bob-public", actorName: "Bob", actorKind: "human", orgId: "org", role: "editor",
  } : undefined } })
}, 60_000)
afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await live?.stop()
  setLocalHostEndpoints(undefined)
  await new Promise<void>((resolve) => authority.close(() => resolve()))
})

async function enableCleanup() {
  const origin = `http://127.0.0.1:${live.port}`
  const catalog = await (await live.call(`${origin}/api/claxedo/plugins`)).json() as { revision: number }
  const enabled = await live.call(`${origin}/api/claxedo/plugins/activation`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pluginInstanceId: "claxedo:session-cleanup", harnessIds: ["opencode"], choice: true, expectedRevision: catalog.revision }),
  })
  expect(enabled.status, await enabled.clone().text()).toBe(200)
}

async function confirmed(sessionId: string) {
  const entry = live.entryFor(sessionId)
  const client = new Client({ name: "cleanup-fixture", version: "1" }, { capabilities: { elicitation: { form: {} } } })
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: {} }))
  await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }))
  clients.push(client)
  return client
}

function target(candidate: SessionCleanupCandidate) {
  const { sessionId, workspaceId, generation, activitySequence, readerRevision, descendants } = candidate
  return { sessionId, workspaceId, generation, activitySequence, readerRevision, descendants }
}

async function selection(client: Client) {
  const result = await callTool(client, "sessions_cleanup_list", { workspace: live.workspace.id, seen: "seen", settled: "settled" })
  expect(result.isError, toolText(result)).not.toBe(true)
  return JSON.parse(toolText(result)) as { candidates: SessionCleanupCandidate[]; complete: boolean }
}

async function settle(sessionId: string) {
  const info = await (await live.runtimeRequest(`/session/${sessionId}`)).json() as { attention: { generation: number; activitySequence: number } }
  const response = await live.call(`http://127.0.0.1:${live.port}/api/claxedo/session/${sessionId}/reader?workspaceId=${encodeURIComponent(live.workspace.id)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "settle", generation: info.attention.generation, activitySequence: info.attention.activitySequence, revision: 0 }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
}

test("the opt-in in-session cleanup uses persisted reader filters and exact canonical cascade deletion", async () => {
  const caller = await live.createSession("cleanup caller")
  expect((await (await live.connect(caller)).listTools()).tools.map((row) => row.name)).not.toContain("sessions_delete")
  await enableCleanup()
  const root = await live.createSession("settled cleanup root")
  const childResponse = await live.runtimeRequest("/session?nativeHarness=opencode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "cleanup child", parentID: root }) })
  expect(childResponse.status).toBe(201)
  const child = (await childResponse.json() as { id: string }).id
  await settle(root)
  const client = await confirmed(caller)
  const listed = await selection(client)
  expect(listed.complete).toBe(true)
  const selected = listed.candidates.find((row) => row.sessionId === root)!
  expect(selected).toMatchObject({ settled: true, seen: true, descendants: [expect.objectContaining({ sessionId: child })] })
  const refused = JSON.parse(toolText(await callTool(client, "sessions_delete", { targets: [target(selected)], cascade: false })))
  expect(refused.results).toEqual([expect.objectContaining({ status: "failed", code: "cascade_required" })])
  expect((await live.runtimeRequest(`/session/${root}`)).status).toBe(200)
  const removed = JSON.parse(toolText(await callTool(client, "sessions_delete", { targets: [target(selected)], cascade: true })))
  expect(removed).toMatchObject({ deletion: "logical", journalRetained: true, results: [{ status: "deleted", deletedSessionIds: [child, root] }] })
  expect((await live.runtimeRequest(`/session/${root}`)).status).toBe(404)
  expect((await live.runtimeRequest(`/session/${child}`)).status).toBe(404)
  expect((await live.rootInventory()).map((row) => row.sessionID)).not.toContain(root)
}, 30_000)

test("a shared recipient's recorded turn revokes previously issued cleanup authority", async () => {
  await enableCleanup()
  const shared = await live.createSession("recipient-driven session")
  const childResponse = await live.runtimeRequest("/session?nativeHarness=opencode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "shared descendant", parentID: shared }) })
  expect(childResponse.status).toBe(201)
  const descendant = await confirmed((await childResponse.json() as { id: string }).id)
  const previous = await confirmed(shared)
  expect((await previous.listTools()).tools.map((row) => row.name)).toContain("sessions_delete")
  expect((await descendant.listTools()).tools.map((row) => row.name)).toContain("sessions_delete")
  const sent = await fetch(`http://127.0.0.1:${live.port}/workspaces/${live.workspace.id}/session/${shared}/message`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer bob", "x-forwarded-by": "workspace-relay" },
    body: JSON.stringify({ messageID: "msg_bob_cleanup", parts: [{ type: "text", text: "start my work" }] }),
  })
  expect(sent.status, await sent.clone().text()).toBeLessThan(300)
  const denied = await callTool(previous, "sessions_cleanup_list", { workspace: live.workspace.id })
  expect(denied.isError).toBe(true)
  expect((await previous.listTools()).tools.map((row) => row.name)).not.toContain("sessions_delete")
  expect((await callTool(descendant, "sessions_cleanup_list", {})).isError).toBe(true)
  expect((await descendant.listTools()).tools.map((row) => row.name)).not.toContain("sessions_delete")
}, 30_000)

test("returning a selected settled session to active conflicts before deletion", async () => {
  await enableCleanup()
  const caller = await live.createSession("second cleanup caller")
  const root = await live.createSession("returned cleanup candidate")
  await settle(root)
  const client = await confirmed(caller)
  const selected = (await selection(client)).candidates.find((row) => row.sessionId === root)!
  const returned = await live.call(`http://127.0.0.1:${live.port}/api/claxedo/session/${root}/reader?workspaceId=${encodeURIComponent(live.workspace.id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "return", generation: selected.generation, revision: selected.readerRevision }) })
  expect(returned.status).toBe(200)
  const removed = JSON.parse(toolText(await callTool(client, "sessions_delete", { targets: [target(selected)], cascade: false })))
  expect(removed.results).toEqual([expect.objectContaining({ status: "failed", code: "session_cleanup_changed" })])
  expect((await live.runtimeRequest(`/session/${root}`)).status).toBe(200)
}, 30_000)

test("a signed desktop account grant reaches the account inventory with no serving connection", async () => {
  await enableCleanup()
  const address = authority.address()
  if (!address || typeof address === "string") throw new Error("No account fixture port")
  const path = `http://127.0.0.1:${live.port}/api/claxedo/daemon/session-cleanup`
  const capability = { token: "fixture-dedicated-desktop-cleanup", expiresAt: Date.now() + 60_000, actorId: "owner", orgId: "org", origin: `http://127.0.0.1:${address.port}` }
  const installed = await live.call(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability }) })
  expect(installed.status, await installed.clone().text()).toBe(200)
  expect(await installed.json()).toEqual({ ok: true, authenticated: true })
  const caller = await live.createSession("signed local-folder cleanup")
  const client = await confirmed(caller)
  const selected = await callTool(client, "sessions_cleanup_list", { seen: "seen", settled: "settled" })
  expect(selected.isError, toolText(selected)).not.toBe(true)
  expect(JSON.parse(toolText(selected)).complete).toBe(true)
  expect(accountRequests).toEqual(["Bearer fixture-dedicated-desktop-cleanup"])
  const cleared = await live.call(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability: null }) })
  expect(cleared.status).toBe(200)
  await callTool(client, "sessions_cleanup_list", {})
  expect(accountRequests).toHaveLength(1)
  const unavailable = await live.call(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability: null, unavailable: "Account-wide Session cleanup consent is required" }) })
  expect(unavailable.status).toBe(200)
  const incomplete = JSON.parse(toolText(await callTool(client, "sessions_cleanup_list", {})))
  expect(incomplete.complete).toBe(false)
  expect(incomplete.incompleteSources).toHaveLength(1)
  expect(incomplete.incompleteSources[0].reason).toContain("Account-wide Session cleanup consent is required")
  expect(accountRequests).toHaveLength(1)
}, 30_000)
