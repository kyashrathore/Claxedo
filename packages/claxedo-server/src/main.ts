import { startServer } from "./server"

const port = parseInt(process.env.CLAXEDO_SERVER_PORT ?? "3001", 10)
const opencodeUrl = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096"
startServer(port, opencodeUrl)

console.log(`[claxedo-server] listening on http://127.0.0.1:${port}`)
