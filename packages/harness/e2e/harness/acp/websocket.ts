import { AgentSideConnection, type Stream } from "@agentclientprotocol/sdk"
import { reservePort, releasePort } from "../ports"
import { ScriptedAgent } from "./agent"
import { recordAcpRequest } from "./requests"

type SocketState = { input: ReadableStreamDefaultController<StreamMessage>; headers: Record<string, string> }
type StreamMessage = Stream["readable"] extends ReadableStream<infer Message> ? Message : never

export type ScriptedAcpWebSocket = { url: string; close(): Promise<void> }

export async function startScriptedAcpWebSocket(scriptDir: string, options: { restoreMode?: "load" | "resume"; dropMethod?: string; source?: string } = {}): Promise<ScriptedAcpWebSocket> {
  const port = await reservePort()
  const sockets = new Set<Bun.ServerWebSocket<SocketState>>()
  try {
    const server = Bun.serve<SocketState>({
      hostname: "127.0.0.1",
      port,
      fetch(request, server) {
        const headers = Object.fromEntries(request.headers)
        if (server.upgrade(request, { data: { input: undefined as unknown as SocketState["input"], headers } })) return undefined
        return new Response("ACP websocket required", { status: 426 })
      },
      websocket: {
        open(socket) {
          sockets.add(socket)
          const readable = new ReadableStream<StreamMessage>({
            start(controller) { socket.data.input = controller },
          })
          const writable = new WritableStream<StreamMessage>({
            write(message) { socket.send(JSON.stringify(message)) },
          })
          new AgentSideConnection((connection) => new ScriptedAgent(connection, scriptDir, socket.data.headers, false, options.restoreMode), { readable, writable })
        },
        async message(socket, message) {
          const value = JSON.parse(typeof message === "string" ? message : Buffer.from(message).toString("utf8")) as StreamMessage
          if (value && typeof value === "object" && "method" in value && "id" in value) {
            await recordAcpRequest(scriptDir, value.method, "params" in value ? value.params : {}, socket.data.headers, options.source)
            if (value.method === options.dropMethod) { socket.close(); return }
          }
          socket.data.input.enqueue(value)
        },
        close(socket) {
          sockets.delete(socket)
          socket.data.input.close()
        },
      },
    })
    return {
      url: `ws://127.0.0.1:${server.port}/acp`,
      async close() {
        for (const socket of sockets) socket.terminate()
        // Bun can leave stop() pending after the listening socket closes while ACP stream readers still exist.
        void server.stop(true)
        releasePort(port)
      },
    }
  } catch (error) {
    releasePort(port)
    throw error
  }
}
