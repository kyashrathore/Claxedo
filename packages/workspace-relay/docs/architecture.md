# Architecture

`src/worker.ts` reads Worker bindings and creates the relay gateway. The gateway
routes each request to a workspace Durable Object using
`workspaceRelayDurableObjectRoomName(workspaceId)`.

`src/cloudflare.ts` owns the room's tunnel sockets, pending HTTP responses,
WebSocket channels, hibernation attachments and alarms. It calls the
`src/server.ts` authorization and forwarding functions, which operate on
standard `Request` and `Response` objects. Token codecs live in `src/auth.ts`;
`src/directory.ts` tracks active host presence.

A room belongs to one workspace. A host tunnel presents exactly one workspace
per connection; the gateway refuses a multi-workspace upgrade with
`host_tunnel_single_workspace_required`. `src/worker-h2.ts` evaluates HTTP/2
behavior on the same room implementation.

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
   `backing: "cloud-vm" | "local-worktree"`).
4. The relay mints a fresh RHT (`mintRelayHostToken`) bound to that
   placement, strips the incoming `Authorization`/forwarding headers
   (see README § Forwarding Boundary), and forwards to the target with the
   RHT as the new `Authorization` header.
5. The workspace host service verifies the RHT (`verifyRelayHostToken`)
   against the relay's published public key before trusting the request.

For **`local-worktree`** targets, step 4 does not `fetch()` a `baseUrl` directly —
it forwards over an already-registered host tunnel (below). A workspace
runtime registers that tunnel by presenting an HTT to
`/host-tunnels/{hostId}?workspaceId=...` (exactly one `workspaceId` query parameter). The
relay verifies the HTT (`verifyHostTunnelToken`, checking `hostId` and
`workspaceIds` match the claims) before upgrading the socket.

RAT and HTT claims bind issuer, audience, subject, workspace id, host id,
expiry, issue time, and JTI; RATs also bind `role` (`RelayRole`, one of
`viewer | editor | admin | owner`) which
`roleAllowsRelayRequest` enforces per method/path. RHTs additionally bind the
placement (`RelayBacking`). All three are short-lived by
design: a RAT or HTT authorizes only the request/connection that presents it,
not the lifetime of any socket it opens — see "Established sockets outlive
their token" below.

## Tunnel lifecycle

The room verifies the Host Tunnel Token and serving generation before accepting
a WebSocket. A replacement socket closes the incumbent and fails its pending
HTTP responses and child WebSocket channels. Close handling checks socket
identity before removing presence, so a delayed incumbent close cannot remove
the replacement.

Hibernation serializes socket attachments. The room rebuilds presence from
those attachments and uses an alarm to re-check serving generations. A revoked
or superseded enrollment closes the tunnel.

`WorkspaceRelayDurableObjectDrainController.setDraining(true)` closes active
tunnels and clients with code `1012`. New workspace requests are refused;
`waitForDrain(timeoutMs)` waits for pending responses to finish within the
supplied deadline.

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
consults before forwarding tunnelled traffic — "is `hostId` currently
tunneled in, and does it claim `workspaceId`?"

```ts
type WorkspaceRelayDirectory = {
  registerHostTunnel(input: { hostId: string; workspaceIds: string[] }): HostTunnelPresence
  recordPong(hostId: string): HostTunnelPresence | undefined
  disconnectHost(hostId: string): void
  activeHost(input: { hostId: string; workspaceId: string }): HostTunnelPresence | undefined
}
```

The shipped implementation is an in-memory `Map` with:

- a TTL per presence entry (`ttlMs`, default 45 s) refreshed by
  `recordPong` on every tunnel heartbeat pong; an expired entry is evicted
  when a lookup reaches it;
- `activeHost` returning a presence only if the host is unexpired **and**
  its `workspaceIds` includes the requested workspace — this is the
  workspace-membership check that keeps one host tunnel from serving
  traffic for a workspace it never registered.

The room owns both presence and the live tunnel socket. Cloudflare's routing
sends every request for the workspace to that one room, including requests
arriving through different gateway isolates.

Cloud-VM (`backing: "cloud-vm"`) targets do not go through the directory or a
host tunnel at all — the relay reaches them directly via `fetch()`/upstream
WebSocket against `target.baseUrl`, so socket ownership does not apply to
them.

## Where this sits relative to `claxedo-server`

The relay has no `/w/{workspaceId}/*` gateway prefix of its own and reads
neither the workspace authority nor the identity provider. See
[README § Routing](../README.md#routing) and
[README § Seam: `internal-relay` vs `workspace-relay`](../README.md#seam-internal-relay-vs-workspace-relay)
for the browser request path and the control-plane resolver boundary.
