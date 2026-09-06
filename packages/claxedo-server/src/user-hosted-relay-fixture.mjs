import { importJWK } from "jose"
import { createWorkspaceRelayBun, WORKSPACE_RELAY_IDLE_TIMEOUT_SECONDS } from "@claxedo/workspace-relay/bun"
import { createWorkspaceRelayDirectory } from "@claxedo/workspace-relay"
import { getLease } from "./sandbox/stores/lease.sql"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { sandboxLeaseUrl } from "./sandbox/stores/sqlite-supervisor-state.ts"

// A real `@claxedo/workspace-relay` instance, spawned by
// `signed-browser-relay-fixture.mjs` as a child `bun` process. Its only auth
// surface is the relay's own EdDSA runtime-access/host-tunnel token
// verification; `runtimeAccessKey`/`relayHostSigningKey` below are real
// imported JWKs, not stubs. The control plane it fronts lives in the owning
// fixture.

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const workspaceId = required("CLAXEDO_RELAY_FIXTURE_WORKSPACE_ID")
const hostId = required("CLAXEDO_RELAY_FIXTURE_HOST_ID")
const runtimeAccessKey = await importJWK(
  JSON.parse(required("CLAXEDO_RELAY_FIXTURE_RUNTIME_PUBLIC_KEY_JWK")),
  "EdDSA",
)
const relayHostSigningKey = await importJWK(
  JSON.parse(required("CLAXEDO_RELAY_FIXTURE_HOST_PRIVATE_KEY_JWK")),
  "EdDSA",
)
async function resolveTarget(claims) {
  const ws = await resolveWorkspace({ workspaceId: claims.workspace_id }).catch(() => undefined)
  const lease = (() => {
    try {
      return getLease(claims.workspace_id)
    } catch {
      return undefined
    }
  })()
  if (ws?.kind === "cloud") {
    const baseUrl = sandboxLeaseUrl(lease)
    if (!baseUrl) return undefined
    return {
      workspaceId: claims.workspace_id,
      hostId: claims.host_id,
      baseUrl,
      access: "cloud",
      backing: "cloud-vm",
    }
  }
  return {
    workspaceId: claims.workspace_id,
    hostId: claims.host_id,
    baseUrl: "http://127.0.0.1:9",
    access: "user-hosted",
    backing: "local-worktree",
  }
}

// The browser-origin allowlist the relay enforces, in the same comma-separated
// pattern grammar `CLAXEDO_RELAY_ALLOWED_ORIGINS` carries in a real deployment
// (`workspace-relay/src/cors-origins.ts`). Absent, the relay keeps its built-in
// default list; a driver that serves the app from a front-door origin names
// that origin here, the way a self-hosted deployment names its own.
const allowedOrigins = (process.env.CLAXEDO_RELAY_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)

const relayHandler = createWorkspaceRelayBun({
  runtimeAccessKey,
  relayHostSigningKey,
  relayHostAlgorithm: "EdDSA",
  directory: createWorkspaceRelayDirectory({ ttlMs: 10 * 60_000 }),
  resolveTarget,
  ...(allowedOrigins.length ? { allowedOrigins } : {}),
  audit: (event) => {
    if (event.result === "deny") console.error(`[workspace-relay-fixture] ${JSON.stringify(event)}`)
  },
}, {
  hostTunnelPingIntervalMs: 1_000,
})
const relay = Bun.serve({
  port: 0,
  // Workspace runtime SSE heartbeats are intentionally 30s apart. The shared
  // bounded timeout exceeds that interval without disabling idle protection.
  idleTimeout: WORKSPACE_RELAY_IDLE_TIMEOUT_SECONDS,
  fetch: (request, server) => relayHandler.fetch(request, server),
  websocket: relayHandler.websocket,
})

console.log(JSON.stringify({
  url: String(relay.url).replace(/\/$/, ""),
  workspaceId,
  hostId,
}))

// `stop(true)` severs live connections and RESOLVES once the server is fully
// closed, so each shutdown path awaits it before exiting: calling `exit` on the
// same tick tears the process down mid-close and the fixture's parent sees a
// connection reset rather than a clean shutdown.
async function shutdown() {
  await relay.stop(true)
  process.exit(0)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

// The signed-browser fixture owns this relay through stdin. Parent death
// closes the pipe even when the parent cannot run a signal handler.
process.stdin.resume()
process.stdin.once("end", shutdown)
