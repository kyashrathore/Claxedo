import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { ensureEmbeddedWorkspaceRuntime, shutdownEmbeddedWorkspaceRuntimes } from "../deployments/local/embedded-workspace-runtime"
import { createLocalControlPlaneServices } from "./local-services"
import { startLocalServer, type LocalServer } from "./start-local-server"

/**
 * The loopback mount over the whole composition it actually ships in: the real
 * local server, a session on the embedded `opencode` harness, the entry that
 * session's runtime injects, and an MCP client speaking streamable HTTP to it.
 *
 * `local-app.behaviour.test.ts` reaches the same route through `app.request()`
 * with a stubbed credential, which cannot tell whether the runtime the server
 * composed mints a bearer the server it is mounted in accepts — the two halves
 * are wired in different files and were only ever tested one at a time.
 */

let dataDir: string
let workspaceDir: string
let previous: string | undefined
let server: LocalServer | undefined
const clients: Client[] = []

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        probe.close()
        reject(new Error("could not allocate a port"))
        return
      }
      probe.close(() => resolve(address.port))
    })
    probe.on("error", reject)
  })
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-first-party-mcp-data-"))
  workspaceDir = mkdtempSync(path.join(tmpdir(), "claxedo-first-party-mcp-ws-"))
  previous = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  await shutdownEmbeddedWorkspaceRuntimes()
  await server?.stop()
  server = undefined
  ClaxedoDB.close()
  closeAuthorityDatabases()
  if (previous === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workspaceDir, { recursive: true, force: true })
})

async function bootWithSession() {
  const port = await freePort()
  server = startLocalServer({
    port,
    services: createLocalControlPlaneServices(),
    isCredentialPath: (candidate: string) => candidate.startsWith("/api/claxedo/credentials"),
    corsOrigin: (origin: string) => origin,
  })
  await server.ready

  const now = Date.now()
  const workspace = { id: "ws_first_party_live", directory: workspaceDir, kind: "local" as const, created_at: now, updated_at: now }
  const runtime = await ensureEmbeddedWorkspaceRuntime(workspace)
  const created = await runtime.app.fetch(new Request(
    `http://embedded.local/session?directory=${encodeURIComponent(workspaceDir)}&nativeHarness=opencode`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-workspace-id": workspace.id },
      body: JSON.stringify({ title: "first-party mcp" }),
    },
  ))
  expect(created.status).toBe(201)
  const sessionId = ((await created.json()) as { id?: string }).id
  if (!sessionId) throw new Error("the runtime created a session without an id")

  const entry = runtime.host.firstPartyMcpServer(sessionId)
  if (!entry) throw new Error("the embedded runtime injects no first-party MCP entry")
  return { entry, sessionId, port }
}

async function connect(entry: { url: string; headers: Record<string, string> }) {
  const client = new Client({ name: "first-party-live", version: "0" })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }))
  return client
}

describe("the first-party MCP a local session is launched with", () => {
  test("names the session in the URL the runtime injects, and serves the runtime audience over it", async () => {
    const { entry, sessionId, port } = await bootWithSession()

    expect(entry.name).toBe("claxedo")
    expect(entry.url).toBe(`http://127.0.0.1:${port}/api/claxedo/mcp?session=${sessionId}`)

    const client = await connect(entry)
    expect(client.getServerVersion()).toMatchObject({ name: "claxedo" })

    // The runtime audience, in full: a model inside a session drives sessions,
    // subagents, processes and documents, answers only its own children's
    // questions, and never approves a permission, rejects a question, deletes
    // a session or touches workspace compute.
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "create_subagent",
      "documents_list",
      "documents_open",
      "process_logs",
      "process_start",
      "process_stop",
      "processes",
      "question_reply",
      "session_abort",
      "session_create",
      "session_get",
      "session_send",
      "session_transcript",
      "sessions_list",
      "subagent_cancel",
      "subagent_capabilities",
      "subagent_list",
      "subagent_status",
    ])
  })

  test("refuses the same URL without the injected bearer", async () => {
    const { entry } = await bootWithSession()

    const refused = await fetch(entry.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "no-bearer", version: "0" } },
      }),
    })
    expect(refused.status).toBe(401)
    expect(refused.headers.get("www-authenticate")).toBe('Bearer realm="claxedo-mcp"')
  })
})
