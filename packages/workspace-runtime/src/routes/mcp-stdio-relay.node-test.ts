import assert from "node:assert/strict"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterEach, test } from "node:test"
import WebSocket from "ws"
import type { PluginProjection } from "@claxedo/harness/contract"
import { serveExecutionEnv, type ExecutionEnvClaims } from "../test-support/execution-env-server"

const STDIO_SERVER = `const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  if (message.method === "initialize") return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "pid:" + process.pid, version: "1" } });
  if (message.method === "tools/list") return reply({ tools: [{ name: "guide", description: "Read the guide", inputSchema: { type: "object", properties: {} } }] });
});
`

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function relay() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "wr-mcp-relay-node-")))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const script = path.join(directory, "stdio-mcp.cjs")
  await writeFile(script, STDIO_SERVER)
  const stdio = { kind: "stdio" as const, command: process.execPath, args: [script] }
  const projection: PluginProjection = {
    generation: "g1", pluginRoots: [], notApplied: [],
    mcpServers: [{ ...stdio, name: "tools", origin: "plugin" }, { ...stdio, name: "configured", origin: "configured" }],
  }
  const server = await serveExecutionEnv({ directory, projection })
  cleanups.push(server.close)
  const url = (name: string) => `${server.origin.replace("http", "ws")}/api/wr/execution-env/mcp/${name}`
  return { server, url }
}

function open(url: string, headers: Record<string, string>) {
  const socket = new WebSocket(url, { headers })
  return new Promise<{ socket: WebSocket } | { status: number }>((resolve, reject) => {
    socket.once("open", () => resolve({ socket }))
    socket.once("unexpected-response", (_request, response) => resolve({ status: response.statusCode ?? 0 }))
    socket.once("error", reject)
  })
}

function rpc(socket: WebSocket, id: number, method: string, params: unknown = {}) {
  return new Promise<{ result: Record<string, any> }>((resolve) => {
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : "{}")
      if (message.id !== id) return
      socket.off("message", onMessage)
      resolve(message)
    }
    socket.on("message", onMessage)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
}

function processAlive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

void test("bridges JSON-RPC to the named plugin stdio server and retires it when the socket closes", async () => {
  const { server, url } = await relay()
  const opened = await open(url("tools"), await server.headers({ sessionId: "ses_1" }))
  assert.ok("socket" in opened)
  const initialized = await rpc(opened.socket, 1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "do", version: "1" } })
  const pid = Number(String(initialized.result.serverInfo.name).slice("pid:".length))
  assert.equal(processAlive(pid), true)
  assert.deepEqual((await rpc(opened.socket, 2, "tools/list")).result.tools.map((tool: { name: string }) => tool.name), ["guide"])
  opened.socket.close()
  const deadline = Date.now() + 10_000
  while (processAlive(pid) && Date.now() < deadline) await sleep(25)
  assert.equal(processAlive(pid), false, `MCP server ${pid} outlived its socket`)
})

void test("an unknown name, a non-plugin server and a viewer are refused before any process starts", async () => {
  const { server, url } = await relay()
  const editor = await server.headers({ sessionId: "ses_1" })
  const viewer: ExecutionEnvClaims = { sessionId: "ses_1", role: "viewer" }
  assert.deepEqual(await open(url("missing"), editor), { status: 404 })
  assert.deepEqual(await open(url("configured"), editor), { status: 404 })
  assert.deepEqual(await open(url("tools"), await server.headers(viewer)), { status: 403 })
})
