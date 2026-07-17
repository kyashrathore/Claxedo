// Dial-in agent for the CF re-evaluation. This is the sandbox-side half of the
// dial-in cloud path: it runs INSIDE the Daytona sandbox, opens ONE outbound
// multiplexed tunnel INTO the relay, and forwards each relay-opened channel to
// the sandbox's own local echo server (http://localhost:3939). The relay holds
// every browser client inbound and routes it through this single tunnel — so
// the DO makes ZERO outbound WS connections and never hits the per-DO
// 6-outbound-handshake window that dial-out fights.
//
// The whole tunnel protocol (ws.open / ws.frame / ws.close + http framing,
// reconnect, ping watchdog) is already implemented in
// packages/workspace-runtime/src/workspace-relay-host-tunnel.ts — this agent is
// just a thin CLI wrapper that wires its options to bench values. It is bundled
// to a single node-compatible .cjs (bench/setup-dialin.ts) because Daytona
// sandbox images ship node, not bun. Node 22 provides global WebSocket + fetch,
// which the tunnel client uses directly (production wires it the same way, no
// custom WebSocket ctor — see claxedo-server/src/user-hosted-tunnel.ts).
//
// Config via env (injected by setup-dialin.ts):
//   RELAY_URL     wss://…relay base (host-tunnels path is appended internally)
//   HOST_ID       the provisioned host id (must match the HTT + the RAT's host)
//   WORKSPACE_ID  the workspace this tunnel serves (must match the HTT + room)
//   HTT           the Host Tunnel Token (Bearer) authorizing registration
//   LOCAL_URL     local echo base to forward channels to (default http://localhost:3939)

import { startWorkspaceRelayHostTunnel } from "../../workspace-runtime/src/workspace-relay-host-tunnel"

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    console.error(`[dialin-agent] missing required env ${name}`)
    process.exit(2)
  }
  return value
}

const relayUrl = required("RELAY_URL")
const hostId = required("HOST_ID")
const workspaceId = required("WORKSPACE_ID")
const htt = required("HTT")
const localBaseUrl = process.env.LOCAL_URL?.trim() || "http://localhost:3939"

console.error(
  `[dialin-agent] starting relay=${relayUrl} host=${hostId} workspace=${workspaceId} local=${localBaseUrl}`,
)

const tunnel = startWorkspaceRelayHostTunnel({
  relayUrl,
  hostId,
  workspaceIds: [workspaceId],
  localBaseUrl,
  // Forward EVERY relay-routed channel/request to the local echo server. Unlike
  // the production claxedo-server tunnel (which route-filters to keep central
  // routes loopback-only), the bench target is a single echo app, so any path
  // maps straight through to it.
  resolveLocalUrl: ({ path }) => new URL(path.replace(/^\/+/, ""), `${localBaseUrl.replace(/\/+$/, "")}/`),
  // The HTT authorizes the socket at establishment; the socket lives until close
  // (relay socket-lifetime auth rule). A generously-TTL'd bench HTT covers the
  // whole run; reconnects re-present the same token. Production swaps this for a
  // client-credentials refresh — out of scope for the bench.
  tokenProvider: () => Promise.resolve(htt),
  onEvent: (event) => {
    // One JSON line per event so setup-dialin.ts can grep the log for `open`.
    console.error(`[dialin-agent] ${JSON.stringify(event)}`)
  },
  pingIntervalMs: 15_000,
  reconnectIntervalMs: 1_000,
})

const shutdown = () => {
  tunnel.close()
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
