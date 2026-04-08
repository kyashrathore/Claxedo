import { startServer } from "./server"
import { workspaceDir, workspaceId } from "./target"

const port = parseInt(process.env.CLAXEDO_WR_PORT ?? "3002", 10)
const id = workspaceId()
const directory = workspaceDir()
startServer(port)

console.log(`[workspace-runtime] listening on http://127.0.0.1:${port} workspaceId=${id} directory=${directory}`)
