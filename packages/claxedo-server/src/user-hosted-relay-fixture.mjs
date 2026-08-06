import { importJWK } from "jose"
import { createWorkspaceRelayBun, createWorkspaceRelayDirectory } from "@claxedo/workspace-relay"
import { getLease } from "./sandbox/stores/lease.sql"
import { resolveWorkspace } from "./workspace/store/index.ts"
import { sandboxLeaseUrl } from "./sandbox/stores/sqlite-supervisor-state.ts"

// 2026-08-06 plan Phase 3 (docs/plans/2026-08-06-001-test-full-matrix-real-
// e2e-plan.md) note: this file has NO control-plane `createServer(...)` to
// swap. It is a real `@claxedo/workspace-relay` instance (`createWorkspace
// RelayBun` below) — a separate real process the OWNING fixture
// (`signed-browser-relay-fixture.mjs`) spawns as a child via `bun` — and its
// only auth surface is the relay's own EdDSA runtime-access/host-tunnel token
// verification, which was already real before this phase (`runtimeAccessKey`/
// `relayHostSigningKey` below are imported EdDSA JWKs, not stubs). The
// hand-rolled control plane Phase 3 replaces — the fake bearer-token verifier
// and the canned `services.authority` object — lived entirely in
// `signed-browser-relay-fixture.mjs`, which now composes the REAL
// `createSqliteWorkspaceAuthority()` (`authority/adapters/sqlite/workspace-
// authority.ts`) behind `customVerifierAuthAdapter` (`platform/auth/auth.ts:
// 179`) backed by a real local JWKS issuer (`e2e-local-jwks-issuer.mjs`).
//
// Documented here too, verbatim, per the plan's requirement that both
// fixtures carry this note: a local JWKS issuer is a SUPPORTED SELF-HOST
// MODE, not a stub — same middleware, real crypto — but Clerk-specific
// behaviour (token shape, JWKS rotation, session claims) is covered only by
// the nightly credentialed lane.

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
    if (!baseUrl) return
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

const relayHandler = createWorkspaceRelayBun({
  runtimeAccessKey,
  relayHostSigningKey,
  relayHostAlgorithm: "EdDSA",
  directory: createWorkspaceRelayDirectory({ ttlMs: 10 * 60_000 }),
  resolveTarget,
  audit: (event) => {
    if (event.result === "deny") console.error(`[workspace-relay-fixture] ${JSON.stringify(event)}`)
  },
}, {
  hostTunnelPingIntervalMs: 1_000,
})
const relay = Bun.serve({
  port: 0,
  fetch: relayHandler.fetch,
  websocket: relayHandler.websocket,
})

console.log(JSON.stringify({
  url: String(relay.url).replace(/\/$/, ""),
  workspaceId,
  hostId,
}))

process.on("SIGTERM", () => {
  relay.stop(true)
  process.exit(0)
})

process.on("SIGINT", () => {
  relay.stop(true)
  process.exit(0)
})
