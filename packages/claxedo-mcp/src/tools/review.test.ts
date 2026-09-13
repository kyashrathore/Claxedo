import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest"
import { NO_HARNESS_EFFORT } from "@claxedo/agent-runtime-contract"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { DiffRoutes, createSessionRoutes } from "@claxedo/workspace-runtime/routes"
import { createClaxedoMcpClient } from "../client/index"
import { CLAXEDO_MCP_PATH, createClaxedoMcpRoutes, fullUserCredential, inProcessFetch } from "../server"
import { registerReviewTools } from "./review"

type FixtureSession = { id: string; title: string; directory: string }

const saved: Record<string, string | undefined> = {}
let repository = ""
const sessions: FixtureSession[] = []

function git(args: string[]) {
  execFileSync("git", args, { cwd: repository, stdio: "pipe" })
}

beforeAll(() => {
  saved.WORKSPACE_RUNTIME_DIRECTORY = process.env.WORKSPACE_RUNTIME_DIRECTORY
  repository = mkdtempSync(path.join(tmpdir(), "claxedo-mcp-review-"))
  process.env.WORKSPACE_RUNTIME_DIRECTORY = repository
  git(["init", "-b", "main"])
  git(["config", "user.email", "fixture@example.com"])
  git(["config", "user.name", "Fixture"])
  writeFileSync(path.join(repository, "tracked.txt"), "one\ntwo\nthree\n")
  git(["add", "."])
  git(["commit", "-m", "initial"])
  sessions.push({ id: "ses_root", title: "Fix login", directory: repository })
})

afterAll(() => {
  if (saved.WORKSPACE_RUNTIME_DIRECTORY === undefined) delete process.env.WORKSPACE_RUNTIME_DIRECTORY
  else process.env.WORKSPACE_RUNTIME_DIRECTORY = saved.WORKSPACE_RUNTIME_DIRECTORY
  rmSync(repository, { recursive: true, force: true })
})

/** The runtime's own session and diff routes over the real repository above. */
function runtimeApp() {
  const routes = createSessionRoutes({
    resolveDirectory: () => repository,
    resolveExecutionBinding: (_c, directory, sessionId) => ({
      workspaceId: "ws_local",
      directory: directory ?? repository,
      sessionId,
      connectionId: "conn",
      upstreamSessionId: sessionId,
    }),
    listSessions: async () => sessions.map((row) => ({ ...row })),
    getSession: (_c, _directory, sessionId) => sessions.find((row) => row.id === sessionId) ?? null,
    sessionBus: { publish: () => {}, subscribe: () => () => {} },
    publishGlobal: () => {},
    resolveAdapter: () => ({
      getSession: async (binding) => sessions.find((row) => row.id === binding.sessionId) ?? null,
      createSession: async () => ({ id: "ses_new" }),
      updateSession: async () => null,
      getSessionConfig: async () => ({ harness: { id: "claude", access: "native" as const }, agent: "build", variant: null }),
      updateSessionConfig: async () => ({ harness: { id: "claude", access: "native" as const }, agent: "build", variant: null }),
      deleteSession: async () => {},
      readHarnessCapabilities: () => ({
        harness: "claude",
        abort: true,
        reconnect: false,
        replay: true,
        permissions: true,
        questions: true,
        todos: false,
        commands: false,
        fork: false,
        revert: false,
        unrevert: false,
        configOptions: false,
        subagents: false,
        goals: false,
        effortLevels: NO_HARNESS_EFFORT,
      }),
      executeTurn: () => (async function* () {})(),
      getMessages: async () => [],
      dispose: () => {},
      abort: async () => ({ ok: true as const, status: "cancelled" as const }),
    }),
  })
  return new Hono().route("/api/wr/diff", DiffRoutes()).route("/", routes)
}

const servers: Array<ReturnType<typeof serve>> = []
const clients: Client[] = []
const mounts: Array<{ dispose(): void }> = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  for (const mount of mounts.splice(0)) mount.dispose()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function listen() {
  const app = runtimeApp()
  const routes = createClaxedoMcpRoutes({
    mount: "node",
    verifyRuntimeCredential: (token) =>
      token === "rt-token" ? { runtimeId: "rt_1", workspaceId: "ws_local", expiresAt: Number.MAX_SAFE_INTEGER } : undefined,
    resolveUserCredential: async (request) =>
      request.headers.get("authorization") === "Bearer cli-jwt" ? fullUserCredential({ actorId: "actor_1", clientId: "cli" }) : undefined,
    createClient: () =>
      createClaxedoMcpClient({
        deployment: "node",
        local: { fetch: inProcessFetch((request) => app.fetch(request)), workspace: { workspaceId: "ws_local", directory: repository } },
      }),
    registerTools: [registerReviewTools],
    audit: () => undefined,
  })
  mounts.push(routes)
  const mounted = new Hono().route(CLAXEDO_MCP_PATH, routes.routes)
  const server = serve({ fetch: mounted.fetch, port: 0, hostname: "127.0.0.1" })
  servers.push(server)
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return { url: `http://127.0.0.1:${address.port}${CLAXEDO_MCP_PATH}` }
}

async function connect(url: string, token: string) {
  const client = new Client({ name: "fixture-host", version: "0.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  clients.push(client)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  const [block] = result.content as Array<{ type: string; text: string }>
  return { text: block?.text ?? "", isError: result.isError === true }
}

describe("session_changes", () => {
  test("says a session has changed nothing while its working tree is clean", async () => {
    const { url } = await listen()
    const client = await connect(url, "cli-jwt")
    expect(await call(client, "session_changes", { session: "ses_root" })).toEqual({
      text: `ses_root "Fix login" has no uncommitted changes in ${repository}.`,
      isError: false,
    })
  })

  test("counts the lines the session's own working directory gained and lost", async () => {
    writeFileSync(path.join(repository, "tracked.txt"), "one\ntwo\nthree\nfour\n")
    writeFileSync(path.join(repository, "added.txt"), "new\nfile\n")
    git(["add", "added.txt"])
    const { url } = await listen()
    const client = await connect(url, "cli-jwt")

    const summary = await call(client, "session_changes", { session: "ses_root" })
    expect(summary.isError).toBe(false)
    const [headline, ...rows] = summary.text.split("\n")
    expect(headline).toBe(`ses_root "Fix login" in ${repository} — 2 files, +3 -0 (uncommitted)`)
    expect(rows.toSorted()).toEqual(["  A added.txt +2 -0", "  M tracked.txt +1 -0"])
  })

  test("reads the mode it is asked for", async () => {
    const { url } = await listen()
    const client = await connect(url, "cli-jwt")
    const staged = await call(client, "session_changes", { session: "ses_root", mode: "staged" })
    expect(staged.text.split("\n")).toEqual([
      `ses_root "Fix login" in ${repository} — 1 file, +2 -0 (staged)`,
      "  A added.txt +2 -0",
    ])
  })

  test("never answers a session that does not exist", async () => {
    const { url } = await listen()
    const client = await connect(url, "cli-jwt")
    expect(await call(client, "session_changes", { session: "ses_absent" })).toMatchObject({ isError: true })
  })

  test("is not offered to a session's own credential", async () => {
    const { url } = await listen()
    const client = await connect(url, "rt-token")
    expect((await client.listTools()).tools).toEqual([])
    // The group registered nothing for this credential, so the server carries
    // no tools/call handler at all and the SDK refuses the method outright.
    await expect(client.callTool({ name: "session_changes", arguments: { session: "ses_root" } })).rejects.toThrow(/Method not found/)
  })
})
