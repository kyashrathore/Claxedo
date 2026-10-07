import assert from "node:assert/strict"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, test } from "node:test"
import WebSocket from "ws"
import type { PluginProjection } from "@claxedo/harness/contract"
import { pidRunning, serveExecutionEnv, waitForPidExit, type ExecutionEnvClaims } from "../test-support/execution-env-server"

const STDIO_SERVER = `const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  if (message.method === "initialize") return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "pid:" + process.pid, version: "1" } });
  if (message.method === "debug/env") return reply({ env: process.env });
  if (message.method === "tools/list") return reply({ tools: [{ name: "guide", description: "Read the guide", inputSchema: { type: "object", properties: {} } }] });
});
`

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function relay(input: { env?: NodeJS.ProcessEnv; mcpHeartbeatMs?: number } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "wr-mcp-relay-node-")))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const script = path.join(directory, "stdio-mcp.cjs")
  await writeFile(script, STDIO_SERVER)
  const stdio = { kind: "stdio" as const, command: process.execPath, args: [script], env: { SERVER_VAR: "from-projection" } }
  const projection: PluginProjection = {
    generation: "g1", pluginRoots: [], notApplied: [],
    mcpServers: [{ ...stdio, name: "tools", origin: "plugin" }, { ...stdio, name: "configured", origin: "configured" }],
  }
  const server = await serveExecutionEnv({ directory, projection, ...input })
  cleanups.push(server.close)
  const url = (name: string) => `${server.origin.replace("http", "ws")}/api/wr/execution-env/mcp/${name}`
  return { server, url }
}

function openRelaySocket(url: string, headers: Record<string, string>, options: { autoPong?: boolean } = {}) {
  const socket = new WebSocket(url, { headers, ...options })
  return new Promise<{ socket: WebSocket } | { status: number }>((resolve, reject) => {
    socket.once("open", () => resolve({ socket }))
    socket.once("unexpected-response", (_request, response) => resolve({ status: response.statusCode ?? 0 }))
    socket.once("error", reject)
  })
}

function rpc(socket: WebSocket, id: number, method: string, params: unknown = {}) {
  return new Promise<{ result: Record<string, any> }>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : "{}")
      if (message.id !== id) return
      socket.off("message", onMessage)
      socket.off("close", onClose)
      resolve(message)
    }
    const onClose = (code: number, reason: Buffer) => {
      socket.off("message", onMessage)
      reject(new Error(`socket closed (${code} ${reason.toString()}) before ${method} #${id} was answered`))
    }
    socket.on("message", onMessage)
    socket.once("close", onClose)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
}

void test("bridges JSON-RPC to the named plugin stdio server and retires it when the socket closes", async () => {
  const { server, url } = await relay()
  const opened = await openRelaySocket(url("tools"), await server.headers({ sessionId: "ses_1" }))
  assert.ok("socket" in opened)
  const initialized = await rpc(opened.socket, 1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "do", version: "1" } })
  const pid = Number(String(initialized.result.serverInfo.name).slice("pid:".length))
  assert.equal(pidRunning(pid), true)
  assert.deepEqual((await rpc(opened.socket, 2, "tools/list")).result.tools.map((tool: { name: string }) => tool.name), ["guide"])
  opened.socket.close()
  assert.equal(await waitForPidExit(pid, 10_000), true, `MCP server ${pid} outlived its socket`)
})

void test("an unknown name, a non-plugin server, a viewer and a share holder are refused before any process starts", async () => {
  const { server, url } = await relay()
  const editor = await server.headers({ sessionId: "ses_1" })
  const viewer: ExecutionEnvClaims = { sessionId: "ses_1", role: "viewer" }
  assert.deepEqual(await openRelaySocket(url("missing"), editor), { status: 404 })
  assert.deepEqual(await openRelaySocket(url("configured"), editor), { status: 404 })
  assert.deepEqual(await openRelaySocket(url("tools"), await server.headers(viewer)), { status: 403 })
  assert.deepEqual(await openRelaySocket(url("tools"), await server.headers({ sessionId: "ses_1", share: true })), { status: 403 })
})

async function openedServer(url: string, headers: Record<string, string>, options: { autoPong?: boolean; onPing?: (socket: WebSocket) => void } = {}) {
  const { onPing, ...socketOptions } = options
  const opened = await openRelaySocket(url, headers, socketOptions)
  assert.ok("socket" in opened)
  if (onPing) opened.socket.on("ping", () => onPing(opened.socket))
  const initialized = await rpc(opened.socket, 1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "do", version: "1" } })
  return { socket: opened.socket, pid: Number(String(initialized.result.serverInfo.name).slice("pid:".length)) }
}

void test("a plugin stdio server gets the minimal inherited env plus its own, never the runtime's", async () => {
  // The inherited set names the platform's own home variable.
  const home = process.platform === "win32" ? "USERPROFILE" : "HOME"
  const { server, url } = await relay({ env: { PATH: process.env.PATH, [home]: "/home/test", RUNTIME_ONLY: "leak", CLAXEDO_RELAY_PRIVATE_KEY: "secret" } })
  const { socket } = await openedServer(url("tools"), await server.headers({ sessionId: "ses_1" }))
  const { env } = (await rpc(socket, 2, "debug/env")).result
  socket.close()
  assert.equal(env.SERVER_VAR, "from-projection")
  assert.equal(env[home], "/home/test")
  assert.equal(env.RUNTIME_ONLY, undefined)
  assert.equal(env.CLAXEDO_RELAY_PRIVATE_KEY, undefined)
})

void test("a socket that stops answering pings is closed and its server retired", async () => {
  const { server, url } = await relay({ mcpHeartbeatMs: 50 })
  // Answer pings by hand until the server is up: spawning it takes longer than
  // two heartbeats on Windows, and a socket terminated before `initialize` is
  // answered proves nothing about a server that went silent.
  let answering = true
  const { pid } = await openedServer(url("tools"), await server.headers({ sessionId: "ses_1" }), {
    autoPong: false,
    onPing: (socket) => { if (answering) socket.pong() },
  })
  assert.equal(pidRunning(pid), true)
  answering = false
  assert.equal(await waitForPidExit(pid, 10_000), true, `MCP server ${pid} outlived a silent socket`)
})

void test("stopping the runtime retires a server whose socket is still open", async () => {
  const { server, url } = await relay()
  const { pid } = await openedServer(url("tools"), await server.headers({ sessionId: "ses_1" }))
  await server.close()
  assert.equal(await waitForPidExit(pid, 10_000), true, `MCP server ${pid} outlived the runtime`)
})
