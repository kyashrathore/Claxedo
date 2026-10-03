import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client"
import { startScriptedAcpWebSocketProcess } from "./websocket-process"

test("the owned ACP WebSocket server hosts isolated sessions and closes every connection", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scripted-acp-ws-process-"))
  const server = await startScriptedAcpWebSocketProcess({ bunPath: process.execPath, scriptDir: dir })
  const clients: ClientSideConnection[] = []
  try {
    for (let index = 0; index < 2; index++) {
      const client = new ClientSideConnection(() => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      }), createWebSocketStream(server.url))
      clients.push(client)
      await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    }
    const sessions = await Promise.all(clients.map((client) => client.newSession({ cwd: dir, mcpServers: [] })))
    expect(sessions[0].sessionId).not.toBe(sessions[1].sessionId)
    await Promise.all(clients.map((client, index) => client.prompt({ sessionId: sessions[index].sessionId, prompt: [{ type: "text", text: "fixture lifecycle" }] })))
    await server.close()
    await Promise.all(clients.map((client) => client.closed))
    await expect(fetch(server.url.replace("ws:", "http:"))).rejects.toThrow()
    await server.close()
  } finally {
    await server.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a failed ACP WebSocket server startup is reported and retired", async () => {
  await expect(startScriptedAcpWebSocketProcess({ bunPath: process.execPath, scriptDir: "" })).rejects.toThrow("exited before ready")
})

test("an unavailable ACP server executable reports its spawn error", async () => {
  await expect(startScriptedAcpWebSocketProcess({ bunPath: "/nonexistent-claxedo-scripted-acp-bun", scriptDir: "unused" })).rejects.toMatchObject({ code: "ENOENT" })
})
