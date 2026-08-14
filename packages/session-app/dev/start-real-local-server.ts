/**
 * Boots the REAL desktop-local server composition (control plane + embedded
 * engine + embedded workspace runtime) on loopback for session-app
 * verification — the same `startLocalServer` the Electron server child runs,
 * unsigned and unauthed, pointed at a scratch data dir.
 *
 *   CLAXEDO_DATA_DIR=$(mktemp -d) bun dev/start-real-local-server.ts [port]
 */

// Relative on purpose: session-app carries no dependency on the server —
// this dev script reaches the sibling package's source the way a dev tool may.
import { startLocalServer } from "../../claxedo-local-server/src/app/start-local-server"

const port = Number(process.argv[2] ?? 4480)
const embed = new URL("../../opencode/dist/node/node.js", import.meta.url).pathname

const server = startLocalServer({
  port,
  opencodePassword: null,
  opencodeEmbedPath: embed,
})

void server.ready.then(() => {
  console.log(`real local server listening on http://127.0.0.1:${server.port} (data: ${process.env.CLAXEDO_DATA_DIR})`)
})
