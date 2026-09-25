import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client"
import { readAcpRequests } from "./requests"
import { startScriptedAcpWebSocket } from "./websocket"

const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of close.splice(0)) await stop() })

test("websocket scripted ACP agent speaks the product's JSON-RPC transport and records session requests", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scripted-acp-ws-"))
  close.push(() => fs.rm(dir, { recursive: true, force: true }))
  const server = await startScriptedAcpWebSocket(dir)
  close.push(() => server.close())
  const stream = createWebSocketStream(server.url)
  close.push(() => stream.writable.close())
  const updates: unknown[] = []
  const client = new ClientSideConnection(() => ({
    sessionUpdate: (update) => { updates.push(update); return Promise.resolve() },
    requestPermission: () => Promise.resolve({ outcome: { outcome: "cancelled" } }),
  }), stream)
  const initialized = await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  expect(initialized.agentCapabilities?.sessionCapabilities?.fork).toEqual({})
  const session = await client.newSession({ cwd: dir, mcpServers: [] })
  const result = await client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] })
  expect(result.stopReason).toBe("end_turn")
  expect(updates).toContainEqual(expect.objectContaining({ sessionId: session.sessionId, update: expect.objectContaining({ sessionUpdate: "agent_message_chunk" }) }))
  const fork = await client.unstable_forkSession({ sessionId: session.sessionId, cwd: dir, mcpServers: [] })
  expect(fork.sessionId).not.toBe(session.sessionId)
  await client.resumeSession({ sessionId: session.sessionId, cwd: dir, mcpServers: [] })
  expect((await readAcpRequests(dir)).map((request) => request.method)).toEqual(expect.arrayContaining(["session/new", "session/prompt", "session/fork", "session/resume"]))
})
