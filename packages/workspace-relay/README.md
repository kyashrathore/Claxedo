# `@claxedo/workspace-relay`

The Claxedo workspace relay — the single canonical tunnel process between
cloud-hosted browsers and workspace-runtime hosts, whether the host is a cloud
VM or a user laptop. One package, one process, one config surface — there is no
separate `dev-relay` codepath.

Runtime requirement: the packaged `workspace-relay` bin and the default server
bootstrap run on **Bun** (they use `Bun.*` APIs via the Bun adapter). Node is
not supported for the standalone process today; the Cloudflare Worker adapter
is the other supported runtime.

Production v1 is deliberately single-instance for user-hosted traffic. The
relay keeps host presence and host-tunnel sockets in process-local maps, and a
`hostId` has exactly one active tunnel at a time. Deploy one active relay
process per user-hosted relay fleet; horizontal scaling needs a future routing
owner for sticky host tunnels, split-brain prevention, and failover. A relay
process, VM, or region failure drops existing user-hosted HTTP, WebSocket, SSE,
and PTY sessions until workspace runtimes reconnect.

## Quickstart

```sh
bun add @claxedo/workspace-relay jose
```

The smallest runnable relay: mint an EdDSA key pair to stand in for the
control plane's signing key, point `resolveTarget` at a cloud-VM-style
workspace host, boot the Bun adapter, then mint a Runtime Access Token the
way `claxedo-control-plane` would and use it to reach the target through the
relay.

```ts
// relay.ts
import { generateKeyPair } from "jose"
import { createWorkspaceRelayBun, mintRuntimeAccessToken } from "@claxedo/workspace-relay"

const runtimeAccessKey = await generateKeyPair("EdDSA", { extractable: true })
const relayHostKey = await generateKeyPair("EdDSA", { extractable: true })

// Stand-in workspace host: whatever the relay forwards accepted traffic to.
const host = Bun.serve({
  port: 0,
  fetch: (request) => new Response(`host saw ${new URL(request.url).pathname}`),
})

const handler = createWorkspaceRelayBun({
  runtimeAccessKey: runtimeAccessKey.publicKey,
  relayHostSigningKey: relayHostKey.privateKey,
  relayHostAlgorithm: "EdDSA",
  resolveTarget: (claims) => ({
    workspaceId: claims.workspace_id,
    hostId: claims.host_id,
    baseUrl: String(host.url).replace(/\/$/, ""),
    access: "cloud",
    backing: "cloud-vm",
  }),
})

const relay = Bun.serve({
  port: 7777,
  fetch: handler.fetch,
  websocket: handler.websocket,
})

const token = await mintRuntimeAccessToken(
  {
    principalKind: "user",
    actorId: "user_1",
    actorKind: "human",
    orgId: "org_1",
    workspaceId: "ws_1",
    hostId: "host_1",
    role: "editor",
  },
  runtimeAccessKey.privateKey,
  "EdDSA",
)

console.log(`relay listening on ${relay.url}`)
console.log(`curl -H "Authorization: Bearer ${token}" ${relay.url}workspaces/ws_1/hello`)
```

```sh
bun run relay.ts
```

Run the printed `curl` command in another terminal — the relay verifies the
Runtime Access Token, calls `resolveTarget`, mints a Relay Host Token, and
forwards the request; you'll see `host saw /hello` come back. This mirrors
what [`src/main.ts`](src/main.ts) assembles for production, minus the
env-driven resolver client, JWKS, and graceful drain — see
[docs/architecture.md](docs/architecture.md) for how those pieces fit
together, and the Configuration table below for the env vars that replace
the hardcoded values above in a real deployment.

## Deployment Security

The relay is a public edge service for workspace traffic, but it is not the
identity provider or policy database. It verifies short-lived runtime access
tokens, calls the configured target resolver/revocation callback, and forwards
accepted traffic to the selected host with a freshly minted relay-host token.

| Token | Default TTL | Issuer | Audience | Purpose |
| --- | ---: | --- | --- | --- |
| Runtime Access Token (RAT) | 30 minutes | `claxedo-control-plane` | `workspace-relay` | User/browser authorization to reach one workspace and host through the relay. |
| Host Tunnel Token (HTT) | 5 minutes | `claxedo-control-plane` | `workspace-relay-host-tunnel` | Workspace runtime authorization to register a user-hosted tunnel. |
| Relay Host Token (RHT) | 60 seconds | `workspace-relay` | `workspace-host-service` | Per-request relay-to-host authorization minted after RAT validation. |

Runtime access tokens and host tunnel tokens bind issuer, audience, subject,
workspace id, host id, expiry, issue time, and JTI. Runtime access tokens also
bind role. Relay-host tokens additionally bind the deployment pair:
`cloud/cloud-vm` or `user-hosted/local-worktree`.

### Revocation And Active Checks

`isRuntimeAccessTokenActive` is the revocation/target freshness hook. Production
deployments should implement it by calling the control plane or an equivalent
authority on every new HTTP request and WebSocket upgrade. A false result
rejects before forwarding to the host.

Long-lived relayed sockets are authorized at establishment time. Already-open
SSE, PTY, and WebSocket streams may live until normal close, reconnect, relay
drain, host disconnect, or process restart. If immediate stream revocation is a
requirement, the control plane must also close the session/runtime channel.

### Host Tunnel Serving-Generation Fence

A Host Tunnel Token minted by a connect-enrolled host carries `enrollment_id`
and `generation`. A relay built by `src/main.ts` or `src/worker.ts` — that is,
any relay with a resolver — asks
`GET <CLAXEDO_RELAY_RESOLVER_URL>/host-generation?enrollmentId=` on every
admission and re-checks established tunnels every 30 s (both adapters). The
verdicts, in order:

| Control plane answer | Admission | Established tunnel |
| --- | --- | --- |
| Same generation, not revoked | admitted | kept |
| Higher generation | `403 host_generation_superseded` | closed `1008` |
| Lower generation | `403 host_generation_unknown` | closed `1008` |
| Enrollment revoked or paused | `403 host_enrollment_revoked` | closed `1008` |
| `404 relay_resolver_enrollment_not_found` | `403 host_enrollment_unknown` | closed `1008` |
| Any other status, a bare 404 (route missing), malformed body, or the 5 s deadline | `503 host_generation_lookup_unavailable` (retry) | survives two consecutive failures, closed `1012` on the third |

A token without a generation is admitted without asking the control plane. It
never displaces a socket that carries a generation: for one host+workspace
identity (Bun) or one room (Cloudflare), an incumbent with a generation yields
only to an equal or higher generation, and an incumbent without one yields to
any later socket. Every refusal is audited as `host_tunnel.denied` with the
code as `reason` (Bun; the Cloudflare room has no audit hook).

A `host.registration.update` frame is re-admitted the same way, with the
socket's own claims as the first incumbent: an update whose token carries no
generation, or a lower one than the socket holds, is refused (closed `1008
Host tunnel registration update superseded`); one that passes is then checked
against the control plane exactly as a connect is and closed with the table's
established-tunnel code on refusal (`1012` for an unavailable lookup, without
the outage grace). An accepted update replaces the socket's claims and
identities, and a socket that became fenced starts the 30 s re-check (or arms
the hibernation alarm).

A relay composed directly from `createWorkspaceRelayBun` /
`createWorkspaceRelayDurableObjectRoom` without `resolveHostGeneration` — the
desktop and self-hosted composition — admits tokens without a generation
newest-wins and refuses any token that carries one with
`403 host_generation_unverifiable` (an update: closed `1008`). A generation is
a fence the relay cannot verify without the resolver, and the refusal is not
retryable because the resolver is a property of the composition.

### Forwarding Boundary

The relay strips client-supplied `x-forwarded-for`, `x-forwarded-host`,
`x-forwarded-proto`, `x-real-ip`, `x-claxedo-internal-*`, and `x-supervisor-*`
headers. It replaces `Authorization` with an RHT, sets `x-workspace-id`, and
adds `x-forwarded-by: workspace-relay`.

For user-hosted targets, `Cookie` is stripped before forwarding. User-hosted
workspace processes may run near a developer's local browser cookie jar, so
browser cookies must not be passed through to the local host service. Cloud VM
targets may receive cookies when the caller intentionally sends them.

### CORS

The relay owns CORS responses for browser-facing workspace requests. Do not
forward upstream CORS headers as the source of truth. Add allowed product
origins in the relay/server CORS configuration and keep wildcard origins out of
credentialed deployments.

### Metrics

`GET /metrics` is privileged operational data. In production, set
`CLAXEDO_RELAY_METRICS_TOKEN` and scrape with `Authorization: Bearer <token>`.
When no metrics token is configured, the endpoint only allows callers that the
adapter identifies as loopback; if no remote-address resolver exists, it fails
closed.

### User-Hosted Topology

Production v1 supports one active relay instance for user-hosted traffic, or a
load balancer with strict stickiness that keeps each `hostId` on the relay
process that owns its tunnel socket. Non-sticky horizontal scaling needs an
external directory and tunnel routing owner before it is safe to advertise as
durable.

## Why one package, no parallel impl

In the fa9cabf9 design pass the working assumption was clarified:

> "I think this creates a parallel implementation problem — why is there
> no devmode in the prod relay?"

So this package is the relay. Local-dev configuration is selected by
environment variables, not by a sibling `dev-relay.ts` module. If a
future cycle re-introduces a separate `dev-relay.*` file in
`packages/claxedo-server/`, that should be flagged as a regression.

## Public surface

Re-exported from [`src/index.ts`](src/index.ts):

| Concern | Module | Notable exports |
| --- | --- | --- |
| Token issuance / verification | [`src/auth.ts`](src/auth.ts) | `mintRuntimeAccessToken`, `verifyRuntimeAccessToken`, `mintRelayHostToken`, `verifyRelayHostToken`, `mintHostTunnelToken`, `verifyHostTunnelToken`, types `RelayRole`, `RelayAccess`, `RelayBacking`, `RelayJwtAlgorithm`, `RuntimeAccessTokenClaims`, `RelayKey`, `RelayKeyResolver`, error class `WorkspaceRelayAuthError` |
| Hono HTTP surface | [`src/server.ts`](src/server.ts) | `createWorkspaceRelay`, `authorizeWorkspaceRelayRequest`, types `WorkspaceRelayOptions`, `WorkspaceRelayTarget`, `RuntimeAccessTokenActiveResult`, `WorkspaceRelayAuditEvent`, `WorkspaceRelayMetricsSources`, `RelayHostPublicKey` |
| Active-host directory | [`src/directory.ts`](src/directory.ts) | `createWorkspaceRelayDirectory`, `disposeWorkspaceRelayDirectory`, types `WorkspaceRelayDirectory`, `HostTunnelPresence` |
| Bun-specific server bootstrap | [`src/bun.ts`](src/bun.ts) | `createWorkspaceRelayBun`, type `WorkspaceRelayBunOptions`, `WorkspaceRelayBunDrainController`, metrics `getFragmentationStats`, `getSlowConsumerStats` |

Wire types live in the sibling package
[`@claxedo/workspace-relay-protocol`](../workspace-relay-protocol/)
(`TUNNEL_PROTOCOL_VERSION`, `TunnelMessage`, `isTunnelMessage`,
`makeTunnelPong`). Keep that split — it lets non-Node consumers
implement the tunnel protocol without pulling Hono and Jose.

## Configuration

All knobs are environment variables. The relay refuses to boot in
production if `CLAXEDO_RELAY_RESOLVER_TOKEN` is missing — the
production fail-closed gate at `src/main.ts`.

| Env var | Purpose |
| --- | --- |
| `CLAXEDO_RELAY_BIND_HOST`, `CLAXEDO_RELAY_BIND_PORT` | Listening socket. Loopback by default. |
| `CLAXEDO_RELAY_PUBLIC_URL` | Externally-resolvable URL the relay advertises in tokens. |
| `CLAXEDO_RELAY_RESOLVER_URL` | Control-plane resolver base (`https://<control-plane>/internal/relay`). The relay derives `/target`, `/revocation`, and `/host-generation` from it. Required by the Bun process; the Worker also accepts `CLAXEDO_CENTRAL_URL` and appends `/internal/relay`. |
| `CLAXEDO_RELAY_RESOLVER_TOKEN` | Bearer token the relay sends to the resolver. **Required in production.** |
| `CLAXEDO_RELAY_HOST_GENERATION_URL` | Optional absolute URL of the host-generation lookup. Unset (the normal case) derives `<CLAXEDO_RELAY_RESOLVER_URL>/host-generation`; set it only when the lookup lives at a different origin than the rest of the resolver. There is no way to turn the fence off on a resolver-backed relay. |
| `CLAXEDO_RELAY_HOST_GENERATION_CACHE_TTL_MS` | Cache TTL for host-generation answers. Defaults to 10000. A superseded tunnel closes within the re-check interval (30 s) plus this TTL. |
| `CLAXEDO_RELAY_TARGET_CACHE_TTL_MS`, `CLAXEDO_RELAY_REVOCATION_CACHE_TTL_MS` | Cache TTLs for `/target` (default 30000 on Bun, 5000 on the Worker) and `/revocation` (default 10000) answers. |
| `CLAXEDO_RELAY_JWKS_URL` | Optional remote JWKS the relay uses to verify runtime-access tokens. |
| `CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM` | Inline public key (alternative to JWKS). |
| `CLAXEDO_RELAY_HOST_VERIFY_PEM` | Public PEM the relay uses to verify host-tunnel tokens. |
| `CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM` | Private PEM the relay uses to mint relay-host tokens. |
| `CLAXEDO_RELAY_METRICS_TOKEN` | Optional bearer token for `/metrics`. Without it, `/metrics` requires a trusted loopback remote-address resolver. |
| `CLAXEDO_RELAY_DRAIN_TIMEOUT_MS` | Graceful shutdown wait before force-closing sockets. Defaults to 30000. |
| `CLAXEDO_RELAY_ALLOWED_ORIGINS` | Comma-separated browser-origin allowlist for CORS. **Replaces** the built-in default list (Claxedo/OpenCode app origins plus `http://localhost:*` dev hosts) — self-hosted deployments set their own origins here. Grammar: exact origin, `https://*.example.com`, `http://localhost:*`. Works on both the Bun process and the Cloudflare Worker. |
| `NODE_ENV` | `production` / `development` / `test`. Switches the production fail-closed gate. |

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

To swap the relay's auth backend in a self-hosted deployment:

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
for tests and self-hosted single-tenant setups.

`createHttpTokenVerifier` is a reference implementation. Its HTTPS endpoint is
the crypto authority and must enforce issuer, audience, expiry, key selection,
and replay policy before returning claims. Treat the endpoint as trusted
operator configuration, not as tenant/user input.

Long-lived relayed sockets are authorized at establishment. Revocation is
checked for new HTTP requests and WebSocket upgrades; already-established
WebSocket/SSE/PTY streams may live until their normal close, reconnect, relay
drain, or process restart.

## Tunnel Lifecycle

Host-tunnel reconnects replace the old socket deterministically. Replacement
cleans the old socket's pending HTTP responses, child WebSocket channels,
heartbeat timer, and buffered work before installing the new socket. Stale close
events identity-check the current owner before deleting presence, so an old
socket cannot mark a replacement offline.

Relay drain sets `/health` unhealthy, rejects new workspace requests and tunnel
registrations with `503 relay_draining`, closes active host tunnels so runtimes
reconnect promptly, waits for pending work up to the configured timeout, then
stops the server. Truly uncaught exceptions and unhandled rejections are fatal:
the relay marks itself draining, stops accepting work, disposes timers, and
exits for supervisor restart.

## External Directory Design

The current `WorkspaceRelayDirectory` is an in-memory implementation of the
directory contract:

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

A Redis, Durable Object, or equivalent implementation should keep the same
semantics:

- one active owner for a `hostId`;
- TTL extension on heartbeat pong;
- immediate removal on disconnect;
- workspace membership checks before user-hosted forwarding;
- split-brain prevention when a replacement tunnel connects;
- observability for active host count and stale owner cleanup.

The missing piece for true multi-instance user-hosted relay is not just durable
presence storage. HTTP/WebSocket/SSE/PTY traffic must also route to the process
or durable object that owns the live tunnel socket for that `hostId`.

## Routing

The relay has **no** `/w/{workspaceId}/*` URL prefix of its own. The
gateway pattern lives in `claxedo-server`:

- The user's browser calls `/api/claxedo/...`.
- `claxedo-server` mounts `workspaceRuntimeProxy` middleware
  (`packages/claxedo-server/src/workspace/runtime-dispatch/internals.ts:205`) on its top-level Hono
  app at `packages/claxedo-server/src/deployments/local/server.ts:93`.
- The proxy resolves the active workspace target via
  `internal-relay.ts` (control-plane auth — see "Seam: internal-relay
  vs workspace-relay" below), strips its own prefix, and forwards
  to the relay's tunnel endpoint.

If you are adding a new HTTP-level workspace surface, attach it to
`claxedo-server`'s gateway, not to `workspace-relay`. The relay is
intentionally narrow — it only handles tunnel traffic and the auth
checks that gate it.

## Seam: `internal-relay` vs `workspace-relay`

| | `claxedo-server/src/deployments/shared-routes/internal-relay.ts` | `@claxedo/workspace-relay` |
| --- | --- | --- |
| Layer | Control-plane auth | Tunnel transport |
| Trust | Authenticates the relay process itself (loopback or bearer) | Authenticates the user's runtime-access token |
| Routes | `GET /internal/relay/target`, `GET /internal/relay/revocation` | WS upgrade + tunnel framing |
| Owners | `claxedo-server` (depends on the workspace authority, the identity provider, audit log) | `workspace-relay` (no authority or identity-provider dependency) |
| Lives in | `packages/claxedo-server/` (server-side only) | `packages/workspace-relay/` (own process) |

This split is deliberate: the relay never reads the workspace authority or the
identity provider directly. It calls back to `claxedo-server` over HTTP for resolver
decisions. The decision data crosses the seam as
`RuntimeAccessTokenActiveResult` (defined in `server.ts`).

## Development

```sh
bun --cwd packages/workspace-relay dev   # hot-reload main.ts
bun --cwd packages/workspace-relay test  # run all *.test.ts
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
