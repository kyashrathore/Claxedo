import { importJWK } from "jose"
import { createWorkspaceRelayBun, WORKSPACE_RELAY_IDLE_TIMEOUT_SECONDS } from "@claxedo/workspace-relay/bun"
import { createWorkspaceRelayDirectory, deriveRelayHostKid } from "@claxedo/workspace-relay"
import { getLease } from "./sandbox/stores/lease.sql"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { sandboxLeaseUrl } from "./sandbox/stores/sqlite-supervisor-state.ts"
import { createResolverClient, resolverClientCacheOptionsFromEnv } from "../../workspace-relay/src/main.ts"

// A real `@claxedo/workspace-relay` instance, spawned by
// `signed-browser-relay-fixture.mjs` as a child `bun` process. Its only auth
// surface is the relay's own EdDSA runtime-access/host-tunnel token
// verification; `runtimeAccessKey`/`relayHostSigningKey` below are real
// imported JWKs, not stubs. The control plane it fronts lives in the owning
// fixture.
//
// Two modes. `embedded` (the default) is the desktop shape: the owning fixture
// runs the host in-process, and this relay answers target lookups itself with
// a permissive resolver and no token-revocation check. `connect` is the
// production shape for a `claxedo connect` host: target, revocation and
// host-generation are all asked of the control plane's `/internal/relay/*`
// routes through `createResolverClient`, exactly as `main.ts` wires them, so
// admission, the periodic client check and the host-generation fence are the
// real ones.

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function optionalInteger(name) {
  const value = Number(process.env[name]?.trim())
  return Number.isInteger(value) && value > 0 ? value : undefined
}

const mode = process.env.CLAXEDO_RELAY_FIXTURE_MODE === "connect" ? "connect" : "embedded"
const workspaceId = mode === "connect" ? process.env.CLAXEDO_RELAY_FIXTURE_WORKSPACE_ID?.trim() : required("CLAXEDO_RELAY_FIXTURE_WORKSPACE_ID")
const hostId = mode === "connect" ? process.env.CLAXEDO_RELAY_FIXTURE_HOST_ID?.trim() : required("CLAXEDO_RELAY_FIXTURE_HOST_ID")
const runtimeAccessKey = await importJWK(
  JSON.parse(required("CLAXEDO_RELAY_FIXTURE_RUNTIME_PUBLIC_KEY_JWK")),
  "EdDSA",
)
const relayHostPrivateJwk = JSON.parse(required("CLAXEDO_RELAY_FIXTURE_HOST_PRIVATE_KEY_JWK"))
const relayHostSigningKey = await importJWK(relayHostPrivateJwk, "EdDSA")
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

const directory = createWorkspaceRelayDirectory({ ttlMs: 10 * 60_000 })

/**
 * Every audit event the relay emits, kept for the owning spec: tunnel
 * connect/disconnect and every refusal with its code, timestamped so a bound
 * ("closed within the next check + cache TTL") can be measured, not assumed.
 */
const auditEvents = []
function recordAudit(event) {
  auditEvents.push({ at: Date.now(), ...event })
  if (event.result === "deny") console.error(`[workspace-relay-fixture] ${JSON.stringify(event)}`)
}

async function connectModeOptions() {
  const { d: _d, ...publicJwk } = relayHostPrivateJwk
  const relayHostPublicKey = await importJWK(publicJwk, "EdDSA")
  const kid = await deriveRelayHostKid(relayHostPublicKey)
  const resolver = createResolverClient(
    required("CLAXEDO_RELAY_RESOLVER_URL"),
    process.env.CLAXEDO_RELAY_RESOLVER_TOKEN?.trim(),
    resolverClientCacheOptionsFromEnv(process.env),
  )
  if (!resolver.hostGeneration) throw new Error("connect mode needs CLAXEDO_RELAY_HOST_GENERATION_URL")
  return {
    relayHostPublicKeys: [{ publicKey: relayHostPublicKey, kid }],
    relayHostMintKid: kid,
    resolveTarget: (claims) => resolver.target(claims.workspace_id, claims.host_id),
    isRuntimeAccessTokenActive: (claims) =>
      resolver.revocation({ jti: claims.jti, workspaceId: claims.workspace_id, hostId: claims.host_id }),
    resolveHostGeneration: resolver.hostGeneration,
  }
}

const relayHandler = createWorkspaceRelayBun({
  runtimeAccessKey,
  relayHostSigningKey,
  relayHostAlgorithm: "EdDSA",
  directory,
  ...(mode === "connect" ? await connectModeOptions() : { resolveTarget }),
  ...(allowedOrigins.length ? { allowedOrigins } : {}),
  audit: recordAudit,
}, {
  hostTunnelPingIntervalMs: 1_000,
  // Production has no env for these two intervals (30s each); the fixture takes
  // them so a spec can keep its total under budget while still asserting
  // against the value it configured.
  ...(optionalInteger("CLAXEDO_E2E_RELAY_CLIENT_CHECK_INTERVAL_MS")
    ? { runtimeAccessTokenActiveCheckIntervalMs: optionalInteger("CLAXEDO_E2E_RELAY_CLIENT_CHECK_INTERVAL_MS") }
    : {}),
  ...(optionalInteger("CLAXEDO_E2E_RELAY_HOST_GENERATION_CHECK_INTERVAL_MS")
    ? { hostGenerationCheckIntervalMs: optionalInteger("CLAXEDO_E2E_RELAY_HOST_GENERATION_CHECK_INTERVAL_MS") }
    : {}),
})

/**
 * Fixture-only observation routes on the relay's own origin, answered before
 * the relay sees the request: the audit log and the directory's view of a
 * host tunnel. Nothing here changes relay state.
 */
function fixtureRoute(request) {
  const url = new URL(request.url)
  if (!url.pathname.startsWith("/__fixture/")) return undefined
  if (url.pathname === "/__fixture/audit") {
    const since = Number(url.searchParams.get("since") ?? 0)
    return Response.json({ events: auditEvents.filter((event) => event.at >= since) })
  }
  if (url.pathname === "/__fixture/host") {
    const presence = directory.activeHost({
      hostId: url.searchParams.get("hostId") ?? "",
      workspaceId: url.searchParams.get("workspaceId") ?? "",
    })
    return Response.json({ active: presence !== undefined, presence: presence ?? null })
  }
  return Response.json({ error: { code: "fixture_route_unknown" } }, { status: 404 })
}

const relay = Bun.serve({
  port: 0,
  // Workspace runtime SSE heartbeats are intentionally 30s apart. The shared
  // bounded timeout exceeds that interval without disabling idle protection.
  idleTimeout: WORKSPACE_RELAY_IDLE_TIMEOUT_SECONDS,
  fetch: (request, server) => fixtureRoute(request) ?? relayHandler.fetch(request, server),
  websocket: relayHandler.websocket,
})

console.log(JSON.stringify({
  url: String(relay.url).replace(/\/$/, ""),
  mode,
  ...(workspaceId ? { workspaceId } : {}),
  ...(hostId ? { hostId } : {}),
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
