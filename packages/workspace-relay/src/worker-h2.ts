// Experimental worker: shards each workspace's cloud WS bridges across
// OPENER_COUNT Durable Object isolates. Not a production entry; the stock
// worker (src/worker.ts) is untouched.
//
// Cloudflare Workers cap each invocation at 6 outbound connections waiting on
// response headers, and a cross-provider WebSocket handshake is one. A single
// relay DO therefore admits ~6 concurrent upstream opens, and at c200 the
// ~750ms handshakes serialize into a ~25s tail. A WebSocket cannot be handed
// between DO isolates, so the whole admitCloudClient bridge (client pair plus
// its own upstream open) runs on the shard the gateway routes the client to;
// N shards give ~N×6 handshake capacity. If provider-side rate limiting of
// shared CF egress IPs dominates, sharding will not help.
//
// Scope: cloud targets only (Daytona / CF sandbox). Every /workspaces/ WS
// upgrade is round-robined, so a tunnelled client could land on a shard
// without its host tunnel; host-tunnel routing would need shard affinity.

import { trimToUndefined } from "@claxedo/helpers/string"
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
  // handshake budget (~OPENER_COUNT×6). Default 8.
  OPENER_COUNT?: string
}

function openerCount(env: WorkspaceRelayH2WorkerEnv): number {
  const parsed = Number(trimToUndefined(env.OPENER_COUNT))
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
    setWorkspaceRelayAppOrigins(trimToUndefined(env.CLAXEDO_APP_ORIGINS))
    setWorkspaceRelayAllowedOrigins(trimToUndefined(env.CLAXEDO_RELAY_ALLOWED_ORIGINS))

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
