/**
 * Runs the desktop-local Claxedo server under NODE, from its built dist.
 *
 * This matters, and is not just a convenience: the vendored fork's embedded
 * engine imports `node:sqlite`, which Bun 1.3.14 does not provide, so starting
 * this server under Bun fails with
 * "No such built-in module: node:sqlite" and every OpenCode route 502s.
 * The shipped desktop product runs this server under Node, so Node is the
 * faithful baseline.
 *
 * (The public V2 SDK is better behaved here: it carries a `bun` condition that
 * resolves to bun:sqlite, so it runs under both.)
 *
 *   node run-local-server-node.mjs
 */
import { startLocalServer } from "@claxedo/local-server/self-hosted-execution"

const port = Number(process.env.CLAXEDO_PORT ?? 2593)
const server = startLocalServer({ port, opencodePassword: process.env.OPENCODE_PASSWORD ?? "local-dev-probe" })
await server.ready
console.log(`LOCAL_SERVER_READY http://127.0.0.1:${port}`)
