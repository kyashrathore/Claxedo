import { importJWK } from "jose"
import { createWorkspaceRelayBun, createWorkspaceRelayDirectory } from "@claxedo/workspace-relay"
import { getLease } from "./adapters/sandbox/stores/lease.sql"
import { resolveWorkspace } from "./workspace/store/index.ts"
import { sandboxLeaseUrl } from "./adapters/sandbox/stores/sqlite-supervisor-state.ts"

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
