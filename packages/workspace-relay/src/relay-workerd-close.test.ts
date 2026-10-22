import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { Miniflare } from "miniflare"
import { mintHostTunnelToken } from "./auth"
import { bootWorkerd, reapWorkerd } from "./workerd-fixture/boot"
import { relayCompatibilityDate } from "./workerd-fixture/compatibility"

/**
 * A host tunnel's close handshake against the bundled relay on real workerd at
 * the deployed compatibility date.
 *
 * A hibernated socket the peer closes stays CLOSING until the relay closes it
 * too, whatever `web_socket_auto_reply_to_close` does for other sockets; a
 * peer left waiting for the reply holds its process open (Node's `ws` for
 * 30 s), which is what `claxedo connect` spent after every SIGTERM.
 *
 * Bun's `ws` shim cannot drive miniflare's WebSocket client, so the host end
 * is opened and closed from inside workerd by a probe Worker.
 */

const PEER_SCRIPT = `
export default {
  async fetch(request, env) {
    const answer = await env.RELAY.fetch("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: { upgrade: "websocket", authorization: request.headers.get("authorization") },
    })
    const socket = answer.webSocket
    if (!socket) return new Response("no upgrade: " + answer.status + " " + await answer.text(), { status: 500 })
    socket.accept()
    const startedAt = Date.now()
    const closed = new Promise((resolve) => socket.addEventListener("close", (event) => resolve({ code: event.code, ms: Date.now() - startedAt })))
    socket.close(1000, "host stopping")
    const unanswered = new Promise((resolve) => setTimeout(() => resolve({ unanswered: true, ms: Date.now() - startedAt }), 3000))
    return Response.json(await Promise.race([closed, unanswered]))
  },
}
`

let workDir: string
let mf: Miniflare
let hostTunnelToken: string

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "relay-close-"))
  const outfile = join(workDir, "relay.mjs")
  execFileSync(process.execPath, [
    fileURLToPath(import.meta.resolve("esbuild/bin/esbuild")),
    fileURLToPath(new URL("./worker.ts", import.meta.url)),
    "--bundle",
    "--format=esm",
    "--platform=neutral",
    "--target=es2022",
    "--conditions=development,workerd,worker,browser",
    "--main-fields=module,main",
    `--outfile=${outfile}`,
  ], { stdio: "pipe" })
  const runtimeAccess = await generateKeyPair("EdDSA", { extractable: true })
  const relayHost = await generateKeyPair("EdDSA", { extractable: true })
  hostTunnelToken = await mintHostTunnelToken({
    enrollmentId: "enr_1",
    generation: 0,
    subject: "host_1",
    hostId: "host_1",
    workspaceIds: ["ws_1"],
  }, runtimeAccess.privateKey, "EdDSA")
  mf = await bootWorkerd({
    workers: [
      {
        name: "peer",
        modules: true,
        script: PEER_SCRIPT,
        compatibilityDate: relayCompatibilityDate(),
        serviceBindings: { RELAY: "relay" },
      },
      {
        name: "relay",
        modules: true,
        script: await readFile(outfile, "utf8"),
        compatibilityDate: relayCompatibilityDate(),
        durableObjects: { WORKSPACE_RELAY_ROOM: { className: "WorkspaceRelayRoom", useSQLite: true } },
        bindings: {
          CLAXEDO_RELAY_RESOLVER_URL: "https://control-plane.test/internal/relay",
          CLAXEDO_RELAY_RESOLVER_TOKEN: "resolver-token",
          CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(runtimeAccess.publicKey),
          CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: await exportPKCS8(relayHost.privateKey),
        },
        outboundService: (request: Request) => {
          const url = new URL(request.url)
          if (url.pathname === "/internal/relay/host-generation") {
            return Response.json({ enrollmentId: url.searchParams.get("enrollmentId"), generation: 0, revoked: false })
          }
          if (url.pathname === "/internal/relay/revocation") return Response.json({ active: true })
          return new Response("not found", { status: 404 })
        },
      },
    ],
  })
}, 120_000)

afterAll(async () => {
  reapWorkerd()
  await rm(workDir, { recursive: true, force: true })
})

describe("relay host tunnel close on workerd", () => {
  test("a host tunnel the host closes is closed back at once", async () => {
    const response = await mf.dispatchFetch("http://peer.test/", { headers: { authorization: `Bearer ${hostTunnelToken}` } })
    const outcome = await response.json() as { code?: number; ms: number; unanswered?: boolean }

    expect(response.status).toBe(200)
    expect(outcome.unanswered, `no close reply within ${outcome.ms} ms`).toBeUndefined()
    expect(outcome.code).toBe(1000)
    expect(outcome.ms).toBeLessThan(1000)
  }, 60_000)
})
