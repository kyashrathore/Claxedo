import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { ensureWorkspace } from "@claxedo/server-core/workspace/store/index"
import { ensureEmbeddedWorkspaceRuntime, shutdownEmbeddedWorkspaceRuntimes } from "../../deployments/local/embedded-workspace-runtime"
import { createLocalControlPlaneServices } from "../local-services"
import { startLocalServer, type LocalServer } from "../start-local-server"

/**
 * The composition the loopback MCP actually ships in, stood up for a test: the
 * real local server, a real workspace row, the embedded workspace runtime that
 * serves it, and the first-party entry that runtime injects into every session
 * it launches.
 *
 * Shared by the two live suites rather than duplicated, because a boot costs a
 * migration run and an embedded runtime and both suites need the same one.
 */

export type LiveMcpFixture = Awaited<ReturnType<typeof startLiveFirstPartyMcp>>

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

export async function startLiveFirstPartyMcp() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-first-party-mcp-data-"))
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "claxedo-first-party-mcp-ws-"))
  const previousDataDir = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
  const git = (args: readonly string[]) => execFileSync("git", [...args], { cwd: workspaceRoot, stdio: "pipe" })
  // The workspace store refuses a local directory that is not a git repository,
  // and the runtime proxy dispatches only to a workspace the store resolved.
  git(["init", "-b", "main"])
  git(["config", "user.email", "fixture@example.com"])
  git(["config", "user.name", "Fixture"])

  const port = await freePort()
  const server: LocalServer = startLocalServer({
    port,
    services: createLocalControlPlaneServices(),
    corsOrigin: (origin: string) => origin,
  })
  await server.ready

  const workspace = await ensureWorkspace({ directory: workspaceRoot })
  if (!workspace) throw new Error("the workspace store stored no row for the fixture directory")
  const runtime = await ensureEmbeddedWorkspaceRuntime(workspace)
  const clients: Client[] = []

  const runtimeRequest = (pathAndQuery: string, init?: RequestInit) => {
    const url = new URL(pathAndQuery, "http://embedded.local")
    if (!url.searchParams.has("directory")) url.searchParams.set("directory", workspace.directory)
    const headers = new Headers(init?.headers)
    headers.set("x-workspace-id", workspace.id)
    return runtime.app.fetch(new Request(url, { ...init, headers }))
  }

  const createSession = async (title: string) => {
    const response = await runtimeRequest(`/session?nativeHarness=opencode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    })
    if (response.status !== 201) throw new Error(`the runtime refused the fixture session: ${response.status} ${await response.text()}`)
    const id = ((await response.json()) as { id?: string }).id
    if (!id) throw new Error("the runtime created a session without an id")
    return id
  }

  /** What the rail reads: the flat local inventory the desktop lists as its root sessions. */
  const rootInventory = async () => {
    const url = new URL("/api/claxedo/session", `http://127.0.0.1:${port}`)
    url.searchParams.set("roots", "true")
    url.searchParams.set("directory", workspace.directory)
    const response = await fetch(url, { headers: { Accept: "application/json" } })
    if (!response.ok) throw new Error(`the local inventory answered ${response.status}`)
    return ((await response.json()) as { sessions?: Array<{ sessionID: string }> }).sessions ?? []
  }

  /** What the rail paginates: the navigation rows the sidebar renders per section. */
  const navigationRows = async () => {
    const url = new URL("/api/claxedo/session-list", `http://127.0.0.1:${port}`)
    url.searchParams.set("scope", "workspace")
    url.searchParams.set("directory", workspace.directory)
    url.searchParams.set("limit", "50")
    const response = await fetch(url, { headers: { Accept: "application/json" } })
    if (!response.ok) throw new Error(`the navigation list answered ${response.status}`)
    return ((await response.json()) as { items?: Array<{ sessionId: string }> }).items ?? []
  }

  const entryFor = (sessionId: string) => {
    const entry = runtime.host.firstPartyMcpServer(sessionId)
    if (!entry) throw new Error("the embedded runtime injects no first-party MCP entry")
    return entry
  }

  const connect = async (sessionId: string) => {
    const entry = entryFor(sessionId)
    const client = new Client({ name: "first-party-live", version: "0" })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }))
    return client
  }

  return {
    port,
    workspace,
    server,
    runtime,
    runtimeRequest,
    rootInventory,
    navigationRows,
    createSession,
    entryFor,
    connect,
    async stop() {
      await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
      await shutdownEmbeddedWorkspaceRuntimes()
      await server.stop()
      ClaxedoDB.close()
      closeAuthorityDatabases()
      if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
      else process.env.CLAXEDO_DATA_DIR = previousDataDir
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(workspaceRoot, { recursive: true, force: true })
    },
  }
}

export function toolText(result: CallToolResult): string {
  const [block] = result.content
  if (!block || block.type !== "text") throw new Error("the tool answered with no text block")
  return block.text
}

/** The tool's text block parsed; every caller names the shape it expects. */
export function toolJson(result: CallToolResult): unknown {
  return JSON.parse(toolText(result))
}

export const callTool = (client: Client, name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>

export async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read()
    if (ready(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}
