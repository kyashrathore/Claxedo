import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ProcessRoutes } from "@claxedo/workspace-runtime/routes"
import { createClaxedoMcpClient } from "../client/index"
import { CLAXEDO_MCP_PATH, createClaxedoMcpRoutes, fullUserCredential, inProcessFetch } from "../server"
import { formatProcess, launchText, parseLaunchResult, parseListResponse, registerProcessTools } from "./processes"

/**
 * The workspace runtime's own process routes, over a real temporary workspace:
 * the manager, its config file and its pty are the production ones, so a start
 * here spawns a real process and a stop really stops it.
 */
const saved: Record<string, string | undefined> = {}
let directory = ""
let dataDir = ""
let runtime: Hono

beforeAll(() => {
  for (const key of ["WORKSPACE_RUNTIME_DIRECTORY", "CLAXEDO_DATA_DIR"]) saved[key] = process.env[key]
  directory = mkdtempSync(path.join(tmpdir(), "claxedo-mcp-process-"))
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-mcp-process-data-"))
  process.env.WORKSPACE_RUNTIME_DIRECTORY = directory
  process.env.CLAXEDO_DATA_DIR = dataDir
  runtime = new Hono().route("/api/wr/process", ProcessRoutes())
})

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of [directory, dataDir]) rmSync(dir, { recursive: true, force: true })
})

async function addConfig(config: Record<string, unknown>) {
  const response = await runtime.request(`http://127.0.0.1/api/wr/process?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ autoStart: false, restartPolicy: "never", maxRestarts: 0, args: [], ...config }),
  })
  if (response.status !== 201) throw new Error(`the runtime refused the config: ${await response.text()}`)
}

async function removeConfig(id: string) {
  await runtime.request(`http://127.0.0.1/api/wr/process/${id}?directory=${encodeURIComponent(directory)}`, { method: "DELETE" })
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
  const elsewhere: string[] = []
  const routes = createClaxedoMcpRoutes({
    mount: "node",
    verifyRuntimeCredential: (token) =>
      token === "rt-token" ? { runtimeId: "rt_1", workspaceId: "ws_local", expiresAt: Number.MAX_SAFE_INTEGER } : undefined,
    resolveUserCredential: async (request) =>
      request.headers.get("authorization") === "Bearer cli-jwt" ? fullUserCredential({ actorId: "actor_1", clientId: "cli" }) : undefined,
    createClient: () =>
      createClaxedoMcpClient({
        deployment: "node",
        local: { fetch: inProcessFetch((request) => runtime.fetch(request)), workspace: { workspaceId: "ws_local", directory } },
        controlPlane: {
          fetch: async (requestPath) => {
            const connection = /^\/api\/workspace\/([^/]+)\/connection$/.exec(new URL(requestPath, "http://control.local").pathname)
            if (!connection) return Response.json({ error: { code: "not_found", message: requestPath } }, { status: 404 })
            return Response.json({
              workspaceId: decodeURIComponent(connection[1]),
              relayUrl: "https://relay.example",
              runtimeAccessToken: "rat",
              tokenExpiresAt: Date.now() + 900_000,
            })
          },
        },
        fetch: async (input) => {
          elsewhere.push(input)
          return Response.json({ configs: [], processes: [] })
        },
      }),
    registerTools: [{ id: "processes", register: registerProcessTools }],
    audit: () => undefined,
  })
  mounts.push(routes)
  const app = new Hono().route(CLAXEDO_MCP_PATH, routes.routes)
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
  servers.push(server)
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return { url: `http://127.0.0.1:${address.port}${CLAXEDO_MCP_PATH}`, elsewhere }
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

describe("the process tools over the runtime's own process routes", () => {
  test("says a workspace has no processes and then lists the one it is given", async () => {
    const { url } = await listen()
    const client = await connect(url, "cli-jwt")
    expect(await call(client, "processes")).toEqual({ text: "No processes are configured in this workspace.", isError: false })

    await addConfig({ id: "proc_listed", name: "watcher", command: "/usr/bin/true", args: ["--once"] })
    const listed = await call(client, "processes")
    expect(listed.text).toBe(
      [
        "watcher (proc_listed): idle",
        "  command: /usr/bin/true --once",
        "  restart: never, autoStart: false",
      ].join("\n"),
    )
    await removeConfig("proc_listed")
  })

  test("reports a start the runtime refused as a result the model can read", async () => {
    const { url } = await listen()
    const client = await connect(url, "cli-jwt")
    expect(await call(client, "process_start", { process: "proc_missing" })).toEqual({
      text: "Process proc_missing could not start: Process config not found",
      isError: true,
    })
  })

  test("starts a real process, reads its output and reports the stop the workspace performed", async () => {
    await addConfig({ id: "proc_greeter", name: "greeter", command: "/bin/echo", args: ["ready"] })
    const { url } = await listen()
    const client = await connect(url, "cli-jwt")

    const started = await call(client, "process_start", { process: "proc_greeter" })
    expect(started.isError).toBe(false)
    expect(started.text).toMatch(/^Process proc_greeter started\. Status: (running|starting)/)
    expect((await call(client, "processes")).text).toContain("greeter (proc_greeter): running")

    const logs = await call(client, "process_logs", { process: "proc_greeter", lines: 20 })
    expect(logs.isError).toBe(false)

    expect(JSON.parse((await call(client, "process_stop", { process: "proc_greeter" })).text)).toEqual({
      process: "proc_greeter",
      stopped: true,
    })
    await removeConfig("proc_greeter")
  }, 30_000)

  test("refuses to start a process on another machine from inside a session", async () => {
    const { url, elsewhere } = await listen()
    const client = await connect(url, "rt-token")
    const refused = await call(client, "process_start", { process: "proc_greeter", workspace: "ws_other" })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain("ws_other")
    expect(elsewhere).toEqual([])

    // The same target reads, because security review S2 leaves reads open.
    expect((await call(client, "processes", { workspace: "ws_other" })).isError).toBe(false)
    expect(elsewhere).toEqual(["https://relay.example/workspaces/ws_other/api/wr/process?workspace=ws_other"])
  })
})

describe("reading the manager's answers", () => {
  test("reads a well-formed list", () => {
    expect(parseListResponse({
      configs: [{ id: "proc_1", name: "dev", command: "npm", args: ["run", "dev"], autoStart: true, restartPolicy: "always", maxRestarts: 3 }],
      processes: [{ configId: "proc_1", status: "running", restartCount: 2, assignedPort: 3000, namedUrl: "http://dev.localhost" }],
    })).toEqual({
      configs: [{
        id: "proc_1",
        name: "dev",
        command: "npm",
        args: ["run", "dev"],
        cwd: undefined,
        env: undefined,
        autoStart: true,
        restartPolicy: "always",
        maxRestarts: 3,
        color: undefined,
        dependsOn: undefined,
        port: undefined,
      }],
      processes: [{
        configId: "proc_1",
        ptyId: undefined,
        status: "running",
        restartCount: 2,
        exitCode: undefined,
        startedAt: undefined,
        exitedAt: undefined,
        assignedPort: 3000,
        namedUrl: "http://dev.localhost",
      }],
    })
  })

  test("drops rows that can be neither displayed nor acted on", () => {
    const listed = parseListResponse({
      configs: [{ id: "proc_1" }, { name: "nameless" }, { id: "proc_2", name: "ok", command: "x" }],
      processes: [{ status: "running" }, { configId: "proc_2", status: "running", restartCount: 0 }],
    })
    expect(listed.configs.map((config) => config.id)).toEqual(["proc_2"])
    expect(listed.processes.map((managed) => managed.configId)).toEqual(["proc_2"])
  })

  test("substitutes the declared defaults for unusable values", () => {
    const listed = parseListResponse({
      configs: [{ id: "proc_1", name: "dev", restartPolicy: "sometimes", maxRestarts: "many" }],
      processes: [{ configId: "proc_1", status: "levitating", restartCount: null }],
    })
    expect(listed.configs[0]).toMatchObject({ restartPolicy: "never", maxRestarts: 0, command: "" })
    expect(listed.processes[0]).toMatchObject({ status: "idle", restartCount: 0 })
  })

  test("reads a body that is not an object as an empty list", () => {
    expect(parseListResponse("nope")).toEqual({ configs: [], processes: [] })
  })

  test("reads every launch kind and reports an unreadable one instead of throwing on it", () => {
    expect(parseLaunchResult({ kind: "started", process: { configId: "p", status: "running", restartCount: 0 } })).toMatchObject({ kind: "started" })
    expect(parseLaunchResult({ kind: "not_found", error: "gone" })).toEqual({ kind: "not_found", error: "gone" })
    expect(parseLaunchResult({ kind: "started" })).toEqual({ kind: "failed", error: 'Launch reported "started" without a process' })
    expect(parseLaunchResult({ kind: "port_conflict", conflict: { processName: "vite" } })).toEqual({
      kind: "failed",
      error: "Port conflict reported without a port",
    })
    expect(parseLaunchResult({ kind: "levitated" })).toEqual({ kind: "failed", error: 'Unrecognized launch response kind "levitated"' })
  })

  test("names the process holding a port or a route", () => {
    expect(launchText("proc_1", parseLaunchResult({ kind: "port_conflict", conflict: { port: 3000, pid: 42, processName: "vite" } }))).toEqual({
      text: "Process proc_1 could not start: preferred port 3000 is in use (vite).",
      isError: true,
    })
    expect(launchText("proc_1", parseLaunchResult({ kind: "route_conflict", conflict: { hostname: "app.localhost", pid: 42 } }))).toEqual({
      text: "Process proc_1 could not start: route app.localhost is in use.",
      isError: true,
    })
  })

  test("renders a running process with its assigned port and url", () => {
    const config = parseListResponse({
      configs: [{ id: "proc_1", name: "dev", command: "npm", args: ["run", "dev"], port: { name: "PORT", inject: "env" } }],
    }).configs[0]
    expect(formatProcess(config, { configId: "proc_1", status: "running", restartCount: 1, assignedPort: 3001, namedUrl: "http://dev.localhost" })).toBe(
      [
        "dev (proc_1): running (restarts: 1) [port: PORT=3001]",
        "  command: npm run dev",
        "  restart: never, autoStart: false",
        "  url: http://dev.localhost",
      ].join("\n"),
    )
  })
})
