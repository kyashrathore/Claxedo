import { afterEach, describe, expect, test } from "vitest"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createClaxedoMcpClient } from "../client/index"
import type { ClaxedoFetch } from "../client/contract"
import { CLAXEDO_MCP_PATH, createClaxedoMcpRoutes, fullUserCredential } from "../server"
import { registerDocumentTools } from "./documents"

type DocumentRow = Record<string, unknown>

const PLAN: DocumentRow = {
  id: "doc_plan",
  project_id: "proj_1",
  display_name: "Plan",
  origin_kind: "managed",
  placement_kind: "local",
  status: "draft",
  archived_at: null,
  markdown: "the secret body",
  content: "also secret",
}

type Service = { rows: readonly DocumentRow[]; mounted: boolean; calls: Array<{ method: string; path: string; body?: unknown }> }

/** The documents service as `documents/routes/index.ts` answers: a bare array to list, ids and a path to agent-open. */
function documentsService(input: Partial<Service> = {}): Service & { fetch: ClaxedoFetch } {
  const state: Service = { rows: [PLAN], mounted: true, calls: [], ...input }
  const fetchLike: ClaxedoFetch = async (requestPath, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    state.calls.push({ method: init?.method ?? "GET", path: requestPath, ...(body ? { body } : {}) })
    if (!state.mounted) return new Response("Not Found", { status: 404 })
    const url = new URL(requestPath, "http://node.local")
    if (url.pathname === "/documents") {
      const archived = url.searchParams.get("archived")
      return Response.json(state.rows.filter((row) => archived === "all" || !row.archived_at))
    }
    const open = /^\/documents\/([^/]+)\/agent-open$/.exec(url.pathname)
    if (open) {
      const row = state.rows.find((candidate) => candidate.id === decodeURIComponent(open[1]))
      if (!row) return Response.json({ error: { code: "document_not_found", message: "no such document" } }, { status: 404 })
      return Response.json({
        document_id: row.id,
        display_name: row.display_name,
        path: `/data/documents/proj_1/${String(row.id)}/plan.md`,
      })
    }
    return Response.json({ error: { code: "not_found", message: url.pathname } }, { status: 404 })
  }
  return { ...state, get calls() { return state.calls }, fetch: fetchLike }
}

const servers: Array<ReturnType<typeof serve>> = []
const clients: Client[] = []
const mounts: Array<{ dispose(): void }> = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  for (const mount of mounts.splice(0)) mount.dispose()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function listen(service?: ReturnType<typeof documentsService>) {
  const routes = createClaxedoMcpRoutes({
    mount: "node",
    verifyRuntimeCredential: (token) =>
      token === "rt-token" ? { runtimeId: "rt_1", workspaceId: "ws_local", sessionId: "ses_caller", expiresAt: Number.MAX_SAFE_INTEGER } : undefined,
    resolveUserCredential: async (request) => {
      if (request.headers.get("authorization") === "Bearer read-token") {
        return { kind: "user", actorId: "actor_1", clientId: "reader", readOnly: true, scopes: new Set(["read"]) }
      }
      return request.headers.get("authorization") === "Bearer cli-jwt" ? fullUserCredential({ actorId: "actor_1", clientId: "cli" }) : undefined
    },
    createClient: () =>
      createClaxedoMcpClient({
        deployment: "node",
        local: {
          fetch: async () => new Response(null, { status: 204 }),
          workspace: { workspaceId: "ws_local", directory: "/w" },
        },
        ...(service ? { documents: { fetch: service.fetch } } : {}),
      }),
    registerTools: [registerDocumentTools],
    audit: () => undefined,
  })
  mounts.push(routes)
  const app = new Hono().route(CLAXEDO_MCP_PATH, routes.routes)
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
  servers.push(server)
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return { url: `http://127.0.0.1:${address.port}${CLAXEDO_MCP_PATH}` }
}

async function connect(url: string, token: string, session?: string) {
  const client = new Client({ name: "fixture-host", version: "0.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(session ? `${url}?session=${session}` : url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  clients.push(client)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  const [block] = result.content as Array<{ type: string; text: string }>
  return { text: block?.text ?? "", isError: result.isError === true }
}

const json = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await call(client, name, args)
  if (result.isError) throw new Error(result.text)
  return JSON.parse(result.text) as Record<string, unknown>
}

describe("documents_list", () => {
  test("returns index metadata and never a document's body", async () => {
    const service = documentsService()
    const { url } = await listen(service)
    const client = await connect(url, "cli-jwt")
    const listed = await json(client, "documents_list", { project: "proj_1" })
    expect(listed.documents).toEqual([
      {
        id: "doc_plan",
        project_id: "proj_1",
        display_name: "Plan",
        origin_kind: "managed",
        placement_kind: "local",
        status: "draft",
        archived_at: null,
      },
    ])
    expect(JSON.stringify(listed)).not.toContain("secret")
    expect(service.calls).toEqual([{ method: "GET", path: "/documents?archived=active&project_id=proj_1" }])
  })

  test("reads this workspace's own directory when neither a project nor a directory is named", async () => {
    const service = documentsService()
    const { url } = await listen(service)
    const client = await connect(url, "cli-jwt")
    await json(client, "documents_list")
    expect(service.calls[0].path).toBe("/documents?archived=active&directory=%2Fw")
  })

  test("refuses a scope that names both a project and a directory", async () => {
    const service = documentsService()
    const { url } = await listen(service)
    const client = await connect(url, "cli-jwt")
    expect(await call(client, "documents_list", { project: "proj_1", directory: "/w" })).toEqual({
      text: "Name a project or a directory, not both.",
      isError: true,
    })
    expect(service.calls).toEqual([])
  })
})

describe("documents_open", () => {
  test("read-only access cannot grant a document path to a session", async () => {
    const service = documentsService()
    const { url } = await listen(service)
    const client = await connect(url, "read-token")
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["documents_list"])
    const result = await client.callTool({ name: "documents_open", arguments: { document: "doc_plan", project: "proj_1", session: "ses_1" } })
    expect(result.isError).toBe(true)
    expect(service.calls).toEqual([])
  })

  test("resolves a reference, an id and a display name to the service's canonical path", async () => {
    const service = documentsService()
    const { url } = await listen(service)
    const client = await connect(url, "cli-jwt")
    for (const reference of ["claxedo://document/doc_plan", "doc_plan", "plan"]) {
      expect(await json(client, "documents_open", { document: reference, project: "proj_1", session: "ses_1" })).toEqual({
        document: "doc_plan",
        name: "Plan",
        path: "/data/documents/proj_1/doc_plan/plan.md",
        session: "ses_1",
      })
    }
    expect(service.calls.filter((row) => row.method === "POST")).toEqual([
      { method: "POST", path: "/documents/doc_plan/agent-open", body: { session_id: "ses_1" } },
      { method: "POST", path: "/documents/doc_plan/agent-open", body: { session_id: "ses_1" } },
      { method: "POST", path: "/documents/doc_plan/agent-open", body: { session_id: "ses_1" } },
    ])
  })

  test("prefers an exact id over another document whose name collides with it", async () => {
    const service = documentsService({
      rows: [
        { id: "doc_plan", project_id: "proj_1", display_name: "Something else" },
        { id: "doc_other", project_id: "proj_1", display_name: "doc_plan" },
      ],
    })
    const { url } = await listen(service)
    const client = await connect(url, "cli-jwt")
    expect(await json(client, "documents_open", { document: "doc_plan", project: "proj_1", session: "ses_1" })).toMatchObject({
      document: "doc_plan",
    })
  })

  test("refuses an archived, missing, ambiguous or unnamed document", async () => {
    const service = documentsService({
      rows: [
        { id: "doc_gone", project_id: "proj_1", display_name: "Gone", archived_at: 1 },
        { id: "doc_a", project_id: "proj_1", display_name: "Twin" },
        { id: "doc_b", project_id: "proj_1", display_name: "twin" },
      ],
    })
    const { url } = await listen(service)
    const client = await connect(url, "cli-jwt")
    const scope = { project: "proj_1", session: "ses_1" }
    expect((await call(client, "documents_open", { ...scope, document: "doc_gone" })).text).toBe("Document 'doc_gone' is archived.")
    expect((await call(client, "documents_open", { ...scope, document: "absent" })).text).toBe("No document 'absent' is in this project.")
    expect((await call(client, "documents_open", { ...scope, document: "twin" })).text).toBe(
      "More than one document is named 'twin'; open it by id.",
    )
    expect((await call(client, "documents_open", { project: "proj_1", document: "doc_a" })).text).toBe(
      "Opening a document grants a path to one session; name the session it is for.",
    )
  })

  test("grants to the calling session itself, whatever session the model names", async () => {
    const service = documentsService()
    const { url } = await listen(service)
    const client = await connect(url, "rt-token", "ses_caller")
    expect(await json(client, "documents_open", { document: "doc_plan", directory: "/w", session: "ses_someone_else" })).toMatchObject({
      session: "ses_caller",
    })
    expect(service.calls.find((row) => row.method === "POST")?.body).toEqual({ session_id: "ses_caller" })
  })
})

describe("a deployment that does not serve documents", () => {
  test("says so instead of failing", async () => {
    const unmounted = documentsService({ mounted: false })
    const withService = await listen(unmounted)
    const client = await connect(withService.url, "cli-jwt")
    const message = "This Claxedo deployment does not serve the documents service."
    expect(await call(client, "documents_list", { project: "proj_1" })).toEqual({ text: message, isError: true })
    expect(await call(client, "documents_open", { document: "doc_plan", project: "proj_1", session: "ses_1" })).toEqual({
      text: message,
      isError: true,
    })

    const noControlPlane = await listen()
    const local = await connect(noControlPlane.url, "cli-jwt")
    expect(await call(local, "documents_list", { project: "proj_1" })).toEqual({ text: message, isError: true })
  })
})
