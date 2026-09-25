import { AcpServer } from "@agentclientprotocol/sdk/experimental/server"
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node"
import { createServer } from "node:http"
import { reservePort, releasePort } from "../ports"
import { ScriptedAgent } from "./agent"

export type ScriptedAcpHttp = { url: string; close(): Promise<void> }

export async function startScriptedAcpHttp(scriptDir: string, options: {
  restoreMode?: "load" | "resume"; startupQuestion?: boolean; groups?: readonly string[]
} = {}): Promise<ScriptedAcpHttp> {
  const port = await reservePort()
  const acp = new AcpServer({ createLegacyAgent: (connection) =>
    new ScriptedAgent(connection, scriptDir, {}, true, options.restoreMode, options.startupQuestion, options.groups) })
  const handler = createNodeHttpHandler(acp)
  const server = createServer((request, response) => {
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname === "/acp") handler(request, response)
    else { response.writeHead(404); response.end("Not Found") }
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, "127.0.0.1", resolve)
    })
    return { url: `http://127.0.0.1:${port}/acp`, async close() {
      await acp.close()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      releasePort(port)
    } }
  } catch (error) {
    await acp.close()
    releasePort(port)
    throw error
  }
}
