# `@claxedo/workspace-relay`

The Claxedo workspace relay: the tunnel between browsers and workspace-runtime
hosts, whether the host is a cloud VM or a user laptop.

It deploys as a Cloudflare Worker. `src/worker.ts` is a stateless gateway that
routes each workspace to its own Durable Object room (`src/cloudflare.ts`), so
the room that owns a workspace's host tunnel also serves every request for that
workspace. `scripts/deploy-cloudflare.ts` deploys it.

## Deployment Security

The relay is a public edge service for workspace traffic, but it is not the
identity provider or policy database. It verifies short-lived runtime access
tokens, calls the configured target resolver/revocation callback, and forwards
accepted traffic to the selected host with a freshly minted relay-host token.

| Token | Default TTL | Issuer | Audience | Purpose |
| --- | ---: | --- | --- | --- |
| Runtime Access Token (RAT) | 30 minutes | `claxedo-control-plane` | `workspace-relay` | User/browser authorization to reach one workspace and host through the relay. |
| Host Tunnel Token (HTT) | 5 minutes | `claxedo-control-plane` | `workspace-relay-host-tunnel` | Workspace runtime authorization to register a host tunnel. |
| Relay Host Token (RHT) | 60 seconds | `workspace-relay` | `workspace-host-service` | Per-request relay-to-host authorization minted after RAT validation. |

Runtime access tokens and host tunnel tokens bind issuer, audience, subject,
workspace id, host id, expiry, issue time, and JTI. Runtime access tokens also
bind role. Relay-host tokens additionally bind the placement: `cloud-vm` or
`local-worktree`.

A cloud runtime access token carries `routing_id`, a UUID owned by the lease
store's address transition. It changes when the address or resource changes and
on a new acquisition, including after lease deletion. The resolver requires the
signed identity to match the current ready lease; otherwise it returns 401
`runtime_access_token_invalid`. The app renews through connection POST once.

Target lookups only coalesce while in flight, keyed by workspace, host and routing
identity. Completed answers are never retained. Each subsequent lookup checks
current authority, even when a newer identity has already been served. A request
already resolving or forwarding when the lease changes can finish with its
previous snapshot; established streams are not disconnected by this fence. The
runtime receives a relay-host token, so it does not independently fence the
original routing identity. This costs a control-plane lookup per request rather
than allowing a stale positive-cache window. The relay does not retry upstream failures.

### Revocation And Active Checks

`isRuntimeAccessTokenActive` is the revocation/target freshness hook. A deployed
relay implements it by calling the control plane or an equivalent
authority on every new HTTP request and WebSocket upgrade. A false result
rejects before forwarding to the host.

Long-lived relayed sockets are authorized at establishment time. Already-open
SSE, PTY, and WebSocket streams may live until normal close, reconnect, relay
drain, host disconnect, or process restart. If immediate stream revocation is a
requirement, the control plane must also close the session/runtime channel.

### Host Tunnel Serving-Generation Fence

Every Host Tunnel Token carries `enrollment_id` and `generation`. A relay
requires a host-generation resolver and asks
`GET <CLAXEDO_RELAY_RESOLVER_URL>/host-generation?enrollmentId=` on every
admission and re-checks established tunnels every 30 s. The
verdicts, in order:

| Control plane answer | Admission | Established tunnel |
| --- | --- | --- |
| Same generation, not revoked | admitted | kept |
| Higher generation | `403 host_generation_superseded` | closed `1008` |
| Lower generation | `403 host_generation_unknown` | closed `1008` |
| Enrollment revoked or paused | `403 host_enrollment_revoked` | closed `1008` |
| `404 relay_resolver_enrollment_not_found` | `403 host_enrollment_unknown` | closed `1008` |
| Any other status, a bare 404 (route missing), malformed body, or the 5 s deadline | `503 host_generation_lookup_unavailable` (retry) | survives two consecutive failures, closed `1012` on the third |

A token missing either fence claim is refused. An incumbent in a workspace
room yields only to an equal or higher generation.

A `host.registration.update` frame must carry a complete, verified token. A
missing fence closes the socket with `1008 Host tunnel registration update
denied`; a lower generation closes it with `1008 Host tunnel registration
update superseded`. The relay then checks the control plane and closes with
the table's established-tunnel code on refusal, without outage grace for an
update. An accepted update replaces the socket's claims and identities and
keeps the periodic check or hibernation alarm active.

A relay composed without `resolveHostGeneration` refuses host tunnels with
`403 host_generation_unverifiable`. This refusal is not retryable because the
resolver belongs to the composition.

### Forwarding Boundary

The relay strips client-supplied `x-forwarded-for`, `x-forwarded-host`,
`x-forwarded-proto`, `x-real-ip`, `x-claxedo-internal-*`, and `x-supervisor-*`
headers. It replaces `Authorization` with an RHT, sets `x-workspace-id`, and
adds `x-forwarded-by: workspace-relay`.

For `local-worktree` targets, `Cookie` is stripped before forwarding. A host
tunnel ends on a machine someone uses, whose browser cookie jar the host
service may share, so browser cookies must not be passed through to it. Cloud
VM targets may receive cookies when the caller intentionally sends them.

### CORS

The relay owns CORS responses for browser-facing workspace requests. Do not
forward upstream CORS headers as the source of truth. Configure browser origins
with `CLAXEDO_RELAY_ALLOWED_ORIGINS` or `CLAXEDO_APP_ORIGINS` (see
Configuration) and keep wildcard origins out of credentialed deployments.

### Host-Tunnel Topology

A Durable Object room is scoped to one workspace, so a host tunnel registering
through the Worker presents exactly one `workspaceId` per connection.

## Public surface

Re-exported from [`src/index.ts`](src/index.ts):

| Concern | Module | Notable exports |
| --- | --- | --- |
| Token issuance / verification | [`src/auth.ts`](src/auth.ts) | `mintRuntimeAccessToken`, `verifyRuntimeAccessToken`, `mintRelayHostToken`, `verifyRelayHostToken`, `mintHostTunnelToken`, `verifyHostTunnelToken`, types `RelayRole`, `RelayBacking`, `RelayJwtAlgorithm`, `RuntimeAccessTokenClaims`, `RelayKey`, `RelayKeyResolver`, error class `WorkspaceRelayAuthError` |
| Request authorization and forwarding | [`src/server.ts`](src/server.ts) | `authorizeWorkspaceRelayRequest`, `workspaceRelayForwardRequestInit`, `workspaceRelayTargetUrl`, the cached resolver clients, types `WorkspaceRelayOptions`, `WorkspaceRelayTarget`, `RuntimeAccessTokenActiveResult`, `WorkspaceRelayAuditEvent` |
| CORS policy | [`src/cors-origins.ts`](src/cors-origins.ts) | `DEFAULT_RELAY_APP_ORIGINS`, `RELAY_ALLOWED_REQUEST_HEADERS`, `createOriginMatcher`, `parseAllowedOrigins` |
| Active-host directory | [`src/directory.ts`](src/directory.ts) | `createWorkspaceRelayDirectory`, types `WorkspaceRelayDirectory`, `HostTunnelPresence` |
| Cloudflare Worker gateway and room | [`src/cloudflare.ts`](src/cloudflare.ts) | `createWorkspaceRelayDurableObjectGateway`, `createWorkspaceRelayDurableObjectRoom` |

Wire types live in the sibling package
[`@claxedo/workspace-relay-protocol`](../workspace-relay-protocol/)
(`TUNNEL_PROTOCOL_VERSION`, `TunnelMessage`, `isTunnelMessage`,
`makeTunnelPong`). Keep that split — it lets non-Node consumers
implement the tunnel protocol without pulling Jose.

## Configuration

All knobs are environment variables: Worker vars and secrets in
`wrangler.toml` and `scripts/deploy-cloudflare.ts`.

| Env var | Purpose |
| --- | --- |
| `CLAXEDO_RELAY_RESOLVER_URL` | Control-plane resolver base (`https://<control-plane>/internal/relay`). The relay derives `/target`, `/revocation`, and `/host-generation` from it. The Worker also accepts `CLAXEDO_CENTRAL_URL` and appends `/internal/relay`. |
| `CLAXEDO_RELAY_RESOLVER_TOKEN` | Bearer token the relay sends to the resolver. The Worker refuses to start without it. |
| `CLAXEDO_RELAY_HOST_GENERATION_URL` | Optional absolute URL of the host-generation lookup. Unset (the normal case) derives `<CLAXEDO_RELAY_RESOLVER_URL>/host-generation`; set it only when the lookup lives at a different origin than the rest of the resolver. There is no way to turn the fence off on a resolver-backed relay. |
| `CLAXEDO_RELAY_HOST_GENERATION_CACHE_TTL_MS` | Cache TTL for host-generation answers. Defaults to 10000. A superseded tunnel closes within the re-check interval (30 s) plus this TTL. |
| `CLAXEDO_RELAY_REVOCATION_CACHE_TTL_MS` | Cache TTL for `/revocation` answers (default 10000 ms). Target answers are not retained. |
| `CLAXEDO_CONTROL_PLANE_JWKS_URL` | Remote JWKS the relay uses to verify runtime-access and host-tunnel tokens. |
| `CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM` | Inline public key (alternative to JWKS). |
| `CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM` | Private PEM the relay uses to mint relay-host tokens. The Worker publishes its public half at `/.well-known/jwks.json`. |
| `CLAXEDO_RELAY_ALLOWED_ORIGINS` | Comma-separated browser-origin allowlist for CORS. **Replaces** the built-in default list (Claxedo/OpenCode app origins plus `http://localhost:*` dev hosts). Grammar: exact origin, `https://*.example.com`, `http://localhost:*`.  |

Cloudflare Worker tracing knobs (Durable Object deployment):

| Env var | Purpose |
| --- | --- |
| `CLAXEDO_RELAY_TRACE_SAMPLE_RATE` | 0–1 sampling rate for request traces. Only sampled requests emit `Server-Timing` phase headers and structured trace logs; unsampled responses carry just the `x-claxedo-trace-id` correlation header. Defaults to 0 (off). |
| `CLAXEDO_RELAY_TRACE_FORCE_SECRET` | Optional operator secret. When set, a request with `x-claxedo-relay-trace: <secret>` forces sampling for that request (targeted debugging). Unset (default) means the force header is ignored — clients can never force tracing or timing emission. |
| `CLAXEDO_APP_ORIGINS` | Cloudflare-only, **additive** origin entries layered on top of the base allowlist (kept for existing deploys; prefer `CLAXEDO_RELAY_ALLOWED_ORIGINS` for full control). |

Token verification is pluggable today via the
`RelayKey | RelayKeyResolver` pair on `verifyRuntimeAccessToken` and
friends, **and** via the unified
[`TokenVerifier`](../workspace-relay-protocol/src/token-verifier.ts)
interface in `@claxedo/workspace-relay-protocol`. A custom verifier is only the
crypto/introspection authority; the relay still validates its output into
`RuntimeAccessTokenClaims`, binds the URL workspace id to the claims, applies
revocation, and allowlists roles. Missing, unknown, or malformed roles deny.

To swap the relay's auth backend:

```ts
import { createStaticTokenVerifier } from "@claxedo/workspace-relay-protocol"

const verifier = createStaticTokenVerifier({
  tokens: {
    "tok-tenant-1": { subject: "u1", scopes: ["workspace:write"], claims: {} },
  },
})
// Pass `verifier` as `WorkspaceRelayOptions.tokenVerifier`.
```

The `TokenVerifier` interface intentionally contains only `verify(token)`.
JWKS fetching, audience binding, and replay caches belong to the
implementation. Two reference implementations ship in the protocol
package: `createHttpTokenVerifier` for remote verifiers
(token introspection, custom OIDC), and `createStaticTokenVerifier`
for tests and single-tenant setups.

`createHttpTokenVerifier` is a reference implementation. Its HTTPS endpoint is
the crypto authority and must enforce issuer, audience, expiry, key selection,
and replay policy before returning claims. Treat the endpoint as trusted
operator configuration, not as tenant/user input.

Long-lived relayed sockets are authorized at establishment. Revocation is
checked for new HTTP requests and WebSocket upgrades; already-established
WebSocket/SSE/PTY streams may live until their normal close, reconnect, relay
drain, or room restart.

## Tunnel Lifecycle

Host-tunnel reconnects replace the old socket deterministically. Replacement
cleans the old socket's pending HTTP responses, child WebSocket channels,
heartbeat timer, and buffered work before installing the new socket. Stale close
events identity-check the current owner before deleting presence, so an old
socket cannot mark a replacement offline.

## External Directory Design

The current `WorkspaceRelayDirectory` is an in-memory implementation of the
directory contract:

```ts
type WorkspaceRelayDirectory = {
  registerHostTunnel(input: { hostId: string; workspaceIds: string[] }): HostTunnelPresence
  recordPong(hostId: string): HostTunnelPresence | undefined
  disconnectHost(hostId: string): void
  activeHost(input: { hostId: string; workspaceId: string }): HostTunnelPresence | undefined
}
```

The Durable Object room keeps presence with its live socket. Hibernation
restores presence from socket attachments. Cloudflare routes every request for
one workspace to that room, which owns its tunnel.

## Routing

Browsers call `/workspaces/:workspaceId/*` on the relay with a Runtime Access
Token. `src/worker.ts` selects the workspace room; `src/cloudflare.ts` authorizes
the request and forwards it to the resolved cloud target or machine tunnel.

## Seam: `internal-relay` vs `workspace-relay`

| | `claxedo-server/src/deployments/shared-routes/internal-relay.ts` | `@claxedo/workspace-relay` |
| --- | --- | --- |
| Layer | Control-plane auth | Tunnel transport |
| Trust | Authenticates the relay process itself (loopback or bearer) | Authenticates the user's runtime-access token |
| Routes | `GET /internal/relay/target`, `GET /internal/relay/revocation` | WS upgrade + tunnel framing |
| Owners | `claxedo-server` (depends on the workspace authority, the identity provider, audit log) | `workspace-relay` (no authority or identity-provider dependency) |
| Lives in | `packages/claxedo-server/` (server-side only) | `packages/workspace-relay/` (Worker and Durable Object) |

This split is deliberate: the relay never reads the workspace authority or the
identity provider directly. It calls back to `claxedo-server` over HTTP for resolver
decisions. The decision data crosses the seam as
`RuntimeAccessTokenActiveResult` (defined in `server.ts`).

## Development

```sh
bun --cwd packages/workspace-relay test        # unit suites, including the workerd ones
bun --cwd packages/workspace-relay typecheck
```

The TS error baseline for this package is **0** — keep it that way.

## Boundary rule

Consumers outside this package import `@claxedo/workspace-relay` only —
not `@claxedo/workspace-relay/src/...`. Direct deep-source imports
break the package boundary. The check is

```sh
grep -rn "workspace-relay/src/" packages/claxedo-{server,app}/src
```

— required to return zero hits.
