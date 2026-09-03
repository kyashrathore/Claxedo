# Architecture

This is the internals doc for `@claxedo/workspace-relay`: how the two runtime
adapters share one server core, how the three tokens (RAT/HTT/RHT) chain
together, how a host tunnel connects/replaces/drains, and what the presence
directory does and does not guarantee. For the public API surface and
configuration knobs, see the [README](../README.md).

## One server core, two adapters

`src/server.ts` is the transport-agnostic core: request authorization
(`authorizeWorkspaceRelayRequest`), target resolution, header
stripping/forwarding (`workspaceRelayForwardHeaders`,
`workspaceRelayForwardRequestInit`), CORS, `/metrics`, and the
`/.well-known/jwks.json` publication of Relay Host public keys. It knows
nothing about `Bun.serve` or Cloudflare Workers — it operates on standard
`Request`/`Response` and a `WorkspaceRelayOptions` bag (auth keys, drain
hook, telemetry, routing).

Two adapters wrap that core with a WebSocket runtime:

- **`src/bun.ts`** (`createWorkspaceRelayBun`) — the packaged
  `workspace-relay` bin and default server bootstrap. Uses `Bun.serve`'s
  `fetch`/`websocket` handler pair and `Bun.ServerWebSocket`. One process
  holds every host tunnel and pending-response map in local `Map`s (see
  "Single-instance limitation" below). A host tunnel here registers with a
  set of `workspaceId`s in one WebSocket connection — one host can serve
  several workspaces over a single tunnel socket.
- **`src/cloudflare.ts`** + **`src/worker.ts`** (`createWorkspaceRelayDurableObjectGateway`,
  `createWorkspaceRelayDurableObjectRoom`) — a stateless Worker gateway that
  routes each request to a per-workspace Durable Object "room" via
  `namespace.idFromName(workspaceRelayDurableObjectRoomName(workspaceId))`,
  where the room name is `` `workspace:${workspaceId}` ``. The room itself
  reuses `authorizeWorkspaceRelayRequest` and the other `server.ts` exports —
  it is the same authorization and forwarding logic as the Bun adapter,
  just driven by Durable Object `WebSocketPair`s and (optionally) hibernation
  instead of `Bun.serve`. Because a DO room is scoped to one workspace, a
  host tunnel registering through this adapter must present exactly one
  `workspaceId` per connection — the gateway rejects a host-tunnel upgrade
  that lists more than one (`host_tunnel_single_workspace_required`).
  `src/worker-h2.ts` is a variant entry point used to evaluate HTTP/2-specific
  behavior on the same Durable Object core.

Both adapters import their token verification, target/revocation resolvers,
and directory contract from the same `src/auth.ts`, `src/directory.ts`, and
`src/server.ts` modules — there is no parallel auth or forwarding
implementation per runtime. `src/main.ts` is the Bun bin's env-driven
composition root (see [README § Configuration](../README.md#configuration));
`src/worker.ts` plays the equivalent role for the Cloudflare deployment,
reading `WorkspaceRelayWorkerEnv` bindings instead of `process.env`.

## Token flow: RAT → HTT → RHT

Three short-lived JWTs gate traffic, each scoped to a narrower purpose and a
shorter TTL than the one before it:

| Token | Minted by | Verified by | Default TTL | Audience |
| --- | --- | --- | ---: | --- |
| Runtime Access Token (RAT) | `claxedo-control-plane` (`mintRuntimeAccessToken`) | relay (`authorizeWorkspaceRelayRequest`) | 30 min | `workspace-relay` |
| Host Tunnel Token (HTT) | `claxedo-control-plane` (`mintHostTunnelToken`) | relay (`authorizeHostTunnel` → `verifyHostTunnelToken`) | 5 min | `workspace-relay-host-tunnel` |
| Relay Host Token (RHT) | relay itself (`mintRelayHostToken`) | the workspace host service | 60 s | `workspace-host-service` |

Flow for one browser request:

1. The browser presents a RAT for `/workspaces/{workspaceId}/...` — as
   `Authorization: Bearer <token>` for plain HTTP, or as a
   `sec-websocket-protocol: claxedo-rat.<token>` entry for WebSocket
   upgrades (browsers cannot set arbitrary headers on a WS handshake, so the
   subprotocol list is the token channel; `authorizeWorkspaceRelayRequest`
   accepts either form — see `src/server.ts`'s protocol-token fallback).
2. The relay verifies the RAT against `runtimeAccessKey` (or a pluggable
   `tokenVerifier`), binds the URL's `workspaceId` to the token's claims,
   and calls `isRuntimeAccessTokenActive` for revocation/freshness.
3. `resolveTarget(claims)` returns a `WorkspaceRelayTarget` (`baseUrl`,
   `access: "cloud" | "user-hosted"`, `backing: "cloud-vm" | "local-worktree"`).
4. The relay mints a fresh RHT (`mintRelayHostToken`) bound to that
   deployment pair, strips the incoming `Authorization`/forwarding headers
   (see README § Forwarding Boundary), and forwards to the target with the
   RHT as the new `Authorization` header.
5. The workspace host service verifies the RHT (`verifyRelayHostToken`)
   against the relay's published public key before trusting the request.

For **user-hosted** targets, step 4 does not `fetch()` a `baseUrl` directly —
it forwards over an already-registered host tunnel (below). A workspace
runtime registers that tunnel by presenting an HTT to
`/host-tunnels/{hostId}?workspaceId=...` (one or more `workspaceId` query
params on the Bun adapter; exactly one on the Durable Object adapter). The
relay verifies the HTT (`verifyHostTunnelToken`, checking `hostId` and
`workspaceIds` match the claims) before upgrading the socket.

RAT and HTT claims bind issuer, audience, subject, workspace id, host id,
expiry, issue time, and JTI; RATs also bind `role` (`RelayRole`, one of
`viewer | editor | admin | owner`) which
`roleAllowsRelayRequest` enforces per method/path. RHTs additionally bind the
deployment pair (`RelayAccess`/`RelayBacking`). All three are short-lived by
design: a RAT or HTT authorizes only the request/connection that presents it,
not the lifetime of any socket it opens — see "Established sockets outlive
their token" below.

## Tunnel connect / replace / drain state machine

A host tunnel is a long-lived WebSocket from a workspace runtime to the relay
at `/host-tunnels/{hostId}`, multiplexing HTTP requests, WebSocket channels,
and heartbeats for one `hostId`. States (Bun adapter; the Durable Object room
implements the same transitions inside one DO instance):

```
              authorizeHostTunnel() fails
                        │
   (no tunnel) ─────────┼───────────────────────────► 403 / socket refused
        │               │
        │ HTT valid, reconnect-rate under cap
        ▼
   CONNECTING ──────────────────────────► CONNECTED
        │  server.upgrade()                  │  (open handler)
        │                                     │  - registers in `hostTunnels` map
        │                                     │  - directory.registerHostTunnel()
        │                                     │  - starts ping heartbeat (15s default)
        │                                     │  - schedules a debounced
        │                                     │    host_tunnel.connected audit event
        │                                     │
        │            new socket for same hostId opens
        │                        │
        │                        ▼
        │              REPLACING OLD SOCKET
        │              - old socket's pending HTTP responses fail with
        │                503 user_hosted_app_offline
        │              - old socket's child WS channels close (1011)
        │              - old socket's heartbeat timer cleared
        │              - old socket closed (1012 "replaced by a newer
        │                connection") WITHOUT touching directory presence
        │                (disconnectDirectory: false — the new socket owns it)
        │                        │
        │                        ▼
        │                   CONNECTED (new socket)
        │
        ▼
   missed pongs > cap (default 2)          explicit close/error
        │                                          │
        ▼                                          ▼
   heartbeat timeout close (1001)          DISCONNECTED
        │                                          │
        └──────────────────────┬───────────────────┘
                                ▼
                   cleanupHostTunnelSocket(disconnectDirectory: true)
                   - fails all pending HTTP responses
                   - closes all child WS channels
                   - identity-checks: only deletes `hostTunnels[hostId]`
                     if the closing socket is still the map's current owner
                     (so a stale old-socket close can't clobber a
                     newer replacement's presence)
                   - directory.disconnectHost(hostId)
                   - schedules debounced host_tunnel.disconnected audit
```

Two properties make reconnects and flapping safe:

- **Replacement is deterministic and ordered.** `open()` on the new socket
  runs the full old-socket cleanup (fail pending, close channels, clear
  heartbeat) synchronously before installing the new socket in the
  `hostTunnels` map, so no request can be handed to a socket that is being
  torn down.
- **Stale-close identity check.** `cleanupHostTunnelSocket`'s directory
  disconnect only fires `if (hostTunnels.get(hostId) === ws)` — an old
  socket's delayed `close` event (arriving after a replacement already
  connected) cannot delete the replacement's presence entry or emit a
  spurious disconnect audit.
- **Audit debounce.** `host_tunnel.connected`/`disconnected` events are
  coalesced per `hostId` over a configurable window (`hostTunnelStateDebounceMs`,
  default 250 ms) so a flapping reconnect within the window nets zero audit
  events instead of a connect/disconnect/connect burst.

Host tunnel reconnects are also rate-limited: at most
`HOST_TUNNEL_REGISTRATION_RECONNECT_CAP` (5) registrations per `hostId`
within `HOST_TUNNEL_REGISTRATION_RECONNECT_WINDOW_MS` (60 s), returning
`429 too_many_host_tunnel_reconnects` past that.

### Relay drain

`WorkspaceRelayBunDrainController.setDraining(true)` (wired to `SIGTERM`/
`SIGINT` via `installShutdownDrainHandler` in `main.ts`, and to uncaught
exceptions/rejections via `installFatalProcessHandlers`) drives an orderly
shutdown:

1. `/health` starts returning `503 { draining: true }`.
2. New HTTP requests to `/workspaces/*` and new host-tunnel WebSocket
   upgrades fast-path to `503 relay_draining` before any auth work.
3. Every currently-open host tunnel and relay client socket is closed with
   `1012` so runtimes and browsers reconnect promptly (to another instance,
   in a multi-instance deploy).
4. The operator polls `waitForDrain(drainTimeoutMs)` (default 30 s, overridable
   via `CLAXEDO_RELAY_DRAIN_TIMEOUT_MS`), which watches `pendingCount()` — the
   sum of in-flight tunnel HTTP responses across every connected host tunnel —
   until it reaches zero or the timeout elapses.
5. `stopServer()` force-closes anything left (`server.stop(true)`), the
   directory's sweep timer is disposed, and the process exits.

### Established sockets outlive their token

RAT/HTT/RHT validation happens at connection **establishment** only. A
already-open SSE stream, PTY channel, or WebSocket survives past its
authorizing token's TTL by design — revocation is re-checked on the next new
HTTP request or WS upgrade, not on bytes flowing over a socket that's already
open. If a deployment needs a revoked session's *existing* streams cut
immediately, the control plane must separately close that session/runtime
channel; the relay's `isRuntimeAccessTokenActive` hook only gates new
connections.

## Directory / presence contract

`WorkspaceRelayDirectory` (`src/directory.ts`) is the presence map the relay
consults before forwarding user-hosted traffic — "is `hostId` currently
tunneled in, and does it claim `workspaceId`?"

```ts
type WorkspaceRelayDirectory = {
  registerHostTunnel(input: { hostId: string; workspaceIds: string[] }): HostTunnelPresence
  recordPong(hostId: string): HostTunnelPresence | undefined
  disconnectHost(hostId: string): void
  activeHost(input: { hostId: string; workspaceId: string }): HostTunnelPresence | undefined
  sweep(): void
  dispose(): void
  size(): number
}
```

The shipped implementation is an in-memory `Map` with:

- a TTL per presence entry (`ttlMs`, default 45 s) refreshed by
  `recordPong` on every tunnel heartbeat pong;
- a background sweep (`sweepIntervalMs`, default 30 s; `0` disables the
  timer for tests, which then call `sweep()` manually) that evicts entries
  whose `expiresAt` has passed;
- `activeHost` returning a presence only if the host is unexpired **and**
  its `workspaceIds` includes the requested workspace — this is the
  workspace-membership check that keeps one host tunnel from serving
  traffic for a workspace it never registered.

The Bun adapter pairs this with its `hostTunnels: Map<hostId, WebSocket>` —
the directory says a `hostId` *should* be reachable; the local map is the
only thing that actually holds the live socket. That pairing is exactly the
single-instance limitation:

### Single-instance limitation

Presence data (the directory) and the live tunnel socket (the `hostTunnels`
map) are both process-local in the Bun adapter. A second relay process has
no way to reach a tunnel socket held by the first, even if it could see that
`hostId` in a shared directory. So:

- **Today**: one active Bun relay process (or a load balancer with strict
  per-`hostId` stickiness) owns every host tunnel it accepts. A process, VM,
  or region failure drops in-flight user-hosted HTTP/WS/SSE/PTY sessions
  until the workspace runtime reconnects (to whichever instance is up).
- **A durable directory (Redis, a dedicated coordination DO) is necessary
  but not sufficient** for multi-instance user-hosted relay. It would need
  to preserve the same semantics — one active owner per `hostId`, TTL
  extension on pong, immediate removal on disconnect, workspace-membership
  checks, split-brain prevention on a replacement tunnel — but the harder
  problem is routing: HTTP/WebSocket/SSE/PTY traffic for a `hostId` must
  reach the specific process or Durable Object instance that holds that
  tunnel's live socket, not just any instance that can read presence state.
- **The Cloudflare Durable Object adapter sidesteps this differently**, not
  by solving multi-instance for the Bun process: each workspace gets exactly
  one DO room (Cloudflare's own single-writer-per-DO-id guarantee), so
  "which instance holds the socket" is answered by DO routing rather than by
  an application-level directory. That is why a DO host tunnel is
  restricted to one `workspaceId` per connection — the DO's identity *is*
  the workspace, so a tunnel serving several workspaces would need to exist
  in several rooms simultaneously with no shared state between them.

Cloud-VM (`access: "cloud"`) targets do not go through the directory or a
host tunnel at all — the relay reaches them directly via `fetch()`/upstream
WebSocket against `target.baseUrl`, so they are unaffected by this
limitation.

## Where this sits relative to `claxedo-server`

The relay has no `/w/{workspaceId}/*` gateway prefix of its own and reads
neither the workspace authority nor the identity provider. See
[README § Routing](../README.md#routing) and
[README § Seam: `internal-relay` vs `workspace-relay`](../README.md#seam-internal-relay-vs-workspace-relay)
for how `claxedo-server`'s `workspaceRuntimeProxy` middleware and
`internal-relay.ts` compose with this package.
