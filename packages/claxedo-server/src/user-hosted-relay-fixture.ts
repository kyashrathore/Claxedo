import { importJWK, type JWK } from "jose"
import { createWorkspaceRelayBun, createWorkspaceRelayDirectory } from "@claxedo/workspace-relay"

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const workspaceId = required("CLAXEDO_RELAY_FIXTURE_WORKSPACE_ID")
const hostId = required("CLAXEDO_RELAY_FIXTURE_HOST_ID")
const runtimeAccessKey = await importJWK(JSON.parse(required("CLAXEDO_RELAY_FIXTURE_RUNTIME_PUBLIC_KEY_JWK")) as JWK, "EdDSA")
const relayHostSigningKey = await importJWK(JSON.parse(required("CLAXEDO_RELAY_FIXTURE_HOST_PRIVATE_KEY_JWK")) as JWK, "EdDSA")
const directory = createWorkspaceRelayDirectory({ ttlMs: 10 * 60_000 })
const relayHandler = createWorkspaceRelayBun({
  runtimeAccessKey,
  relayHostSigningKey,
  relayHostAlgorithm: "EdDSA",
  directory,
  resolveTarget: (claims) => ({
    workspaceId: claims.workspace_id,
    hostId: claims.host_id,
    baseUrl: "http://127.0.0.1:9",
    access: "user-hosted",
    backing: "local-worktree",
  }),
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
