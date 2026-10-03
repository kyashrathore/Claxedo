import { afterEach, expect, test } from "vitest"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { createClaxedoMcpClient } from "../client/index"
import { createClaxedoMcpRoutes, CLAXEDO_MCP_PATH, mcpAuditRecord } from "../server"
import type { SessionCleanupGrant } from "../client/contract"
import { registerSessionCleanupTools, readCleanupSelection } from "./session-cleanup"

const servers: ReturnType<typeof serve>[] = []
const clients: Client[] = []
const mounts: { dispose(): void }[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  for (const mount of mounts.splice(0)) mount.dispose()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

const candidate = (sessionId = "selected") => ({
  sessionId, workspaceId: "ws", generation: 1, activitySequence: 4, readerRevision: 2,
  descendants: [{ sessionId: "child", generation: 1, activitySequence: 2 }],
  title: "Done", createdAt: 100, activityAt: 200, seen: true, settled: true,
})

async function connect(grant?: SessionCleanupGrant, confirmed = false) {
  const audits: Record<string, unknown>[] = []
  const prompts: string[] = []
  const mount = createClaxedoMcpRoutes({
    mount: "loopback",
    verifyRuntimeCredential: (token) => token === "runtime-token" ? { runtimeId: "rt", workspaceId: "ws", sessionId: "caller", expiresAt: Number.MAX_SAFE_INTEGER } : undefined,
    enabledToolGroups: () => ["session-cleanup"],
    createClient: () => createClaxedoMcpClient({
      deployment: "loopback", local: { workspace: { workspaceId: "ws" }, fetch: async () => new Response(null, { status: 404 }) },
      ...(grant ? { sessionCleanup: grant } : {}),
    }),
    registerTools: [{ id: "session-cleanup", reach: "account", register: registerSessionCleanupTools }],
    audit: (event) => { audits.push(mcpAuditRecord(event)) },
  })
  mounts.push(mount)
  const app = new Hono().route(CLAXEDO_MCP_PATH, mount.routes)
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 })
  servers.push(server)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No fixture server port")
  const client = new Client({ name: "fixture-host", version: "1" }, { capabilities: confirmed ? { elicitation: { form: {} } } : {} })
  if (confirmed) client.setRequestHandler(ElicitRequestSchema, async (request) => {
    prompts.push(request.params.message)
    return { action: "accept", content: {} }
  })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}${CLAXEDO_MCP_PATH}`), { requestInit: { headers: { authorization: "Bearer runtime-token" } } }))
  clients.push(client)
  return { client, audits, prompts }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args })
  const content = response.content as { type: string; text: string }[]
  return { body: JSON.parse(content[0].text), isError: response.isError }
}

test("a bare runtime has no cleanup tools and cannot call them by name", async () => {
  const { client, audits } = await connect()
  expect((await client.listTools()).tools).toEqual([])
  await expect(client.callTool({ name: "sessions_delete", arguments: { targets: [candidate()], cascade: true } })).rejects.toThrow()
  expect(audits).toEqual([])
})

test("selection reads every page, keeps timezone filters, and reports offline sources", async () => {
  const paths: string[] = []
  const { client } = await connect({ allowed: () => true, fetch: async (path) => {
    paths.push(path)
    const query = new URL(path, "http://fixture").searchParams
    return Response.json(query.has("cursor")
      ? { candidates: [candidate("older")], incompleteSources: [{ workspaceId: "offline", reason: "machine offline" }] }
      : { candidates: [candidate()], incompleteSources: [], nextCursor: "page-2" })
  } })
  const result = await call(client, "sessions_cleanup_list", { seen: "seen", settled: "settled", dateField: "settled", from: "2026-10-01T00:00:00+05:30", until: "2026-10-03T00:00:00Z" })
  expect(result.body.candidates.map((row: { sessionId: string }) => row.sessionId)).toEqual(["selected", "older"])
  expect(result.body).toMatchObject({ complete: false, incompleteSources: [{ workspaceId: "offline", reason: "machine offline" }] })
  expect(paths).toHaveLength(2)
  for (const path of paths) expect(new URL(path, "http://fixture").searchParams.get("from")).toBe("2026-10-01T00:00:00+05:30")
})

test("destructive cleanup requires confirmation and audits exact guarded targets", async () => {
  const bodies: unknown[] = []
  const grant = { allowed: () => true, fetch: async (_path: string, init?: RequestInit) => {
    bodies.push(await new Response(init?.body).json())
    return Response.json({ results: [{ sessionId: "selected", workspaceId: "ws", status: "deleted", deletedSessionIds: ["selected", "child"] }] })
  } }
  const refused = await connect(grant)
  const denial = await refused.client.callTool({ name: "sessions_delete", arguments: { targets: [candidate()], cascade: true } })
  expect(denial.isError).toBe(true)
  expect(bodies).toEqual([])
  const confirmed = await connect(grant, true)
  const exact = { ...candidate() }
  const { title: _title, createdAt: _createdAt, activityAt: _activityAt, seen: _seen, settled: _settled, ...target } = exact
  const result = await call(confirmed.client, "sessions_delete", { targets: [target], cascade: true })
  expect(bodies).toEqual([{ targets: [target], cascade: true }])
  expect(result.body).toMatchObject({ deletion: "logical", journalRetained: true, results: [{ status: "deleted", deletedSessionIds: ["selected", "child"] }] })
  expect(confirmed.prompts[0]).toContain("ws/selected")
  expect(confirmed.audits).toEqual([expect.objectContaining({ tool: "sessions_delete", callerSessionId: "caller", targets: [{ sessionId: "selected", workspaceId: "ws" }] })])
})

test("a revoked grant is denied at call time and disappears from the list", async () => {
  let allowed = true
  let requests = 0
  const { client } = await connect({ allowed: () => allowed, fetch: async () => { requests++; return Response.json({ candidates: [], incompleteSources: [] }) } })
  expect((await client.listTools()).tools).toHaveLength(2)
  allowed = false
  const result = await client.callTool({ name: "sessions_cleanup_list", arguments: {} })
  expect(result.isError).toBe(true)
  expect(requests).toBe(0)
  expect((await client.listTools()).tools).toEqual([])
})

test("a dropped source after page one preserves candidates and reports incompleteness", async () => {
  let calls = 0
  const selected = await readCleanupSelection(async () => {
    if (++calls > 1) throw new Error("connection lost")
    return Response.json({ candidates: [candidate()], incompleteSources: [], nextCursor: "next" })
  }, new URLSearchParams())
  expect(selected.candidates).toHaveLength(1)
  expect(selected).toMatchObject({ complete: false, incompleteSources: [{ reason: "connection lost" }] })
})

test("a deletion request without a receipt reports uncertainty for every selected target", async () => {
  const { client } = await connect({ allowed: () => true, fetch: async () => { throw new Error("connection lost after send") } }, true)
  const { title: _title, createdAt: _createdAt, activityAt: _activityAt, seen: _seen, settled: _settled, ...target } = candidate()
  const result = await call(client, "sessions_delete", { targets: [target], cascade: true })
  expect(result.body.results).toEqual([expect.objectContaining({ sessionId: "selected", status: "unknown", code: "outcome_unknown" })])
})

test("an invalid later page preserves verified candidates and reports incomplete selection", async () => {
  let calls = 0
  const selected = await readCleanupSelection(async () => ++calls === 1
    ? Response.json({ candidates: [candidate()], incompleteSources: [], nextCursor: "next" })
    : new Response("<html>proxy unavailable</html>", { headers: { "content-type": "text/html" } }), new URLSearchParams())
  expect(selected.candidates).toHaveLength(1)
  expect(selected.complete).toBe(false)
  expect(selected.incompleteSources).toHaveLength(1)
})

test("bulk deletion keeps confirmed first-batch receipts when the later receipt is invalid", async () => {
  const requests: number[] = []
  const targets = Array.from({ length: 201 }, (_, i) => ({
    sessionId: `selected-${i}`, workspaceId: "ws", generation: 1, activitySequence: 4, readerRevision: 2, descendants: [],
  }))
  const { client } = await connect({ allowed: () => true, fetch: async (_path, init) => {
    const body = await new Response(init?.body).json() as { targets: typeof targets }
    requests.push(body.targets.length)
    return requests.length === 1
      ? Response.json({ results: body.targets.map((row) => ({ sessionId: row.sessionId, workspaceId: row.workspaceId, status: "deleted", deletedSessionIds: [row.sessionId] })) })
      : Response.json({ results: [] })
  } }, true)
  const result = await call(client, "sessions_delete", { targets, cascade: false })
  expect(requests).toEqual([200, 1])
  expect(result.body.results).toHaveLength(201)
  expect(result.body.results.slice(0, 200).every((row: { status: string }) => row.status === "deleted")).toBe(true)
  expect(result.body.results[200]).toMatchObject({ sessionId: "selected-200", status: "unknown", code: "outcome_unknown" })
})
