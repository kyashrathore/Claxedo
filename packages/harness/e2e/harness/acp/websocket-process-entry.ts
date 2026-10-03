import { startScriptedAcpWebSocket } from "./websocket"

const scriptDir = process.argv[2]
if (!scriptDir) throw new Error("The scripted ACP WebSocket server needs a script directory")
const server = await startScriptedAcpWebSocket(scriptDir)
process.stdout.write(`${JSON.stringify({ url: server.url })}\n`)

const close = async () => {
  await server.close()
  process.exit(0)
}
process.once("SIGTERM", close)
process.once("SIGINT", close)
