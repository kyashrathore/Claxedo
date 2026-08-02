// H2 experiment worker — opener sharding for the Cloudflare-relay
// re-evaluation's hypothesis H2. NOT a production entry; the stock worker
// (src/worker.ts) is untouched.
//
// Mechanism under test: Cloudflare Workers cap each invocation at 6 outbound
// connections simultaneously waiting for response headers, and a cross-provider
// WebSocket handshake IS such a connection. A single relay DO isolate therefore
// admits at most ~6 concurrent upstream WS opens; at c200 the queue of
// ~750ms handshakes serializes into a ~25s tail (the June failure). H2 asks:
// does fanning the opens across N separate DO isolates multiply the window to
// ~N×6 and restore holder setup?
//
// DESIGN DEVIATION (decision-grade, documented per the plan): the literal plan
// described "opener DOs that open the socket and hand the established WebSocket
// back to the room." That is architecturally impossible on Cloudflare — a
// WebSocket cannot be transferred between Durable Object isolates; sockets are
// not serializable and there is no cross-DO socket-passing primitive. The
// nearest viable design, which this implements, is to SHARD WHOLE BRIDGES: the
// gateway routes each cloud WS client connection to one of OPENER_COUNT DO
// instances, and that instance runs the entire admitCloudClient bridge (client
// pair + its own outbound upstream open) for its shard. Because each shard is a
// distinct isolate with its own 6-in-flight-handshake budget, N shards give
// ~N×6 concurrent handshake capacity — the same admission multiplication the
// "opener pool" intended, achieved by placing the bridge (not just the open) on
// the shard. Whether that actually clears the 429/timeout signature is exactly
// what Row 5 measures; if provider-side rate limiting of shared CF egress IPs
// dominates, sharding won't help and the June decision is re-confirmed.
//
// SCOPE: cloud targets only (Daytona / CF sandbox). User-hosted routing needs
// host-tunnel/client shard affinity that this experiment intentionally does not
// implement — every /workspaces/ WS upgrade is round-robined, so a user-hosted
// client could land on a shard without its host tunnel. The re-eval matrix only
// exercises cloud targets, so this is a non-issue for the experiment and is
// called out rather than silently relied upon.

import {
  createWorkspaceRelayDurableObjectGateway,
  setWorkspaceRelayAllowedOrigins,
  setWorkspaceRelayAppOrigins,
  type WorkspaceRelayDurableObjectNamespace,
} from "./cloudflare"
import stockWorker, { WorkspaceRelayRoom, type WorkspaceRelayWorkerEnv } from "./worker"

// The DO class is identical to the stock room — only the NAMING fans out. Re-
// export so wrangler-h2.toml can bind class_name = "WorkspaceRelayRoom".
export { WorkspaceRelayRoom }

export type WorkspaceRelayH2WorkerEnv = WorkspaceRelayWorkerEnv & {
  // Number of opener shards per workspace. Higher = more concurrent upstream
  // handshake budget (~OPENER_COUNT×6). Default 8; Row 5 sweeps 8 then 32.
  OPENER_COUNT?: string
}

function clean(input: unknown) {
  const value = typeof input === "string" ? input.trim() : undefined
  return value ? value : undefined
}

function openerCount(env: WorkspaceRelayH2WorkerEnv): number {
  const parsed = Number(clean(env.OPENER_COUNT))
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 8
}

// Shard selection must be STATELESS: under a concurrent burst CF spreads the
// requests across many isolates, each with its own module state, so a
// module-global round-robin cursor collapses toward shard 0 (every fresh
// isolate starts at 0). A uniform random pick distributes evenly regardless of
// how many isolates handle the burst — which is the whole point of the fan-out.
function pickShard(count: number): number {
  return count > 1 ? Math.floor(Math.random() * count) : 0
}

function websocketRequest(request: Request) {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket"
}

// Wrap the real DO namespace so idFromName fans a base room name across
// `#opener<shard>` suffixes. Each suffix is a distinct DO instance/isolate with
// its own outbound-handshake budget.
function shardedNamespace(
  real: WorkspaceRelayDurableObjectNamespace,
  shardOf: () => number,
): WorkspaceRelayDurableObjectNamespace {
  return {
    idFromName: (name: string) => real.idFromName(`${name}#opener${shardOf()}`),
    get: (id, options) => real.get(id, options),
  }
}

export default {
  fetch(request: Request, env: WorkspaceRelayH2WorkerEnv) {
    setWorkspaceRelayAppOrigins(clean(env.CLAXEDO_APP_ORIGINS))
    setWorkspaceRelayAllowedOrigins(clean(env.CLAXEDO_RELAY_ALLOWED_ORIGINS))

    const url = new URL(request.url)
    // JWKS, health, HTTP forwards, and host tunnels are handled by the stock
    // worker on canonical `workspace:<id>` DOs — behavior there is byte-for-byte
    // the stock relay. Only cloud WS upgrades on /workspaces/ fan out across
    // shard DOs. Cloud WS bridges are self-contained, so no state is shared
    // between the canonical DO and the shard DOs.
    const shardCloudWs = url.pathname.startsWith("/workspaces/") && websocketRequest(request)
    const namespace = env.WORKSPACE_RELAY_ROOM
    if (!shardCloudWs || !namespace) return stockWorker.fetch(request, env)
    const count = openerCount(env)
    const gateway = createWorkspaceRelayDurableObjectGateway({
      namespace: shardedNamespace(namespace, () => pickShard(count)),
    })
    return gateway.fetch(request, env)
  },
}
