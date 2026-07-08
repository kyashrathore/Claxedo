# Relay And Deployment

`@claxedo/workspace-runtime` can run locally, inside a private VM, behind a
trusted relay/supervisor auth boundary, or attached to
`@claxedo/workspace-relay`.

## Runtime Shapes

| Shape | Supported setup |
| --- | --- |
| Local unauthenticated runtime | `startServer(port, { exposure: loopbackWorkspaceRuntimeExposure() })` on loopback. |
| Private cloud VM runtime | `startServer(port, { exposure: privateNetworkWorkspaceRuntimeExposure(...), target })` behind private ingress such as a VM firewall or security group. |
| Config-authenticated local runtime | `startServer(port, { exposure: loopbackWorkspaceRuntimeExposure(), configToken })`; the token is accepted for direct health/config discovery through relay-host auth, but direct config mutation still requires runtime management auth. This does not authenticate every runtime route. |
| Relay-attached runtime | `startServer(port, await workspaceRelayRuntimeOptionsFromEnv(process.env, port))`; tunnel and auth options come from env. |

## Local Runtime

```ts
import { loopbackWorkspaceRuntimeExposure, startServer } from "@claxedo/workspace-runtime"

startServer(4096, {
  exposure: loopbackWorkspaceRuntimeExposure(),
})
```

## Private VM Runtime

```ts
import { privateNetworkWorkspaceRuntimeExposure, startServer } from "@claxedo/workspace-runtime"

startServer(4096, {
  exposure: privateNetworkWorkspaceRuntimeExposure({
    name: "private-vm-ingress",
    guard: (input) => input.request.headers.get("x-private-ingress") === process.env.PRIVATE_INGRESS_TOKEN,
    runtimeAuth: (input) => input.request.headers.get("authorization") === `Bearer ${process.env.WORKSPACE_RUNTIME_PRIVATE_TOKEN}`,
  }),
  target: {
    workspaceId: "ws_private_vm",
    directory: "/workspace/repo",
  },
})
```

This creates a runtime pinned to one workspace target. Network access control is
provided by the surrounding private network.

## Config-Authenticated Local Runtime

```ts
import { loopbackWorkspaceRuntimeExposure, startServer } from "@claxedo/workspace-runtime"

startServer(4096, {
  exposure: loopbackWorkspaceRuntimeExposure(),
  configToken: process.env.WORKSPACE_RUNTIME_CONFIG_TOKEN,
})
```

When `configToken` is set, the token is used as a trusted direct token for
relay-host middleware and direct health/config discovery. It is not a standalone
permission to mutate runtime config. `POST /api/wr/config` accepts runtime
management auth through `x-workspace-runtime-management-token`.

## Relay-Attached Runtime

```ts
import { startServer } from "@claxedo/workspace-runtime"
import { workspaceRelayRuntimeOptionsFromEnv } from "@claxedo/workspace-runtime/relay"

const port = Number(process.env.WORKSPACE_RUNTIME_PORT ?? 3002)

startServer(port, await workspaceRelayRuntimeOptionsFromEnv(process.env, port))
```

Local development needs none of these — a loopback runtime boots with zero
environment variables. These knobs exist for the relay-attached production
shape. Supported environment variables include:

| Env var | Purpose |
| --- | --- |
| `WORKSPACE_RUNTIME_WORKSPACE_ID` | Workspace id for the runtime. |
| `WORKSPACE_RUNTIME_HOST_ID` | Host id. Defaults to workspace id when omitted. |
| `WORKSPACE_RUNTIME_RELAY_URL` | Relay base URL. Enables host tunnel options. |
| `WORKSPACE_RUNTIME_RELAY_WORKSPACE_IDS` | Comma-separated workspace ids registered by this host. |
| `WORKSPACE_RUNTIME_RELAY_TUNNEL_TOKEN` | Bearer token used for the host tunnel Authorization header. |
| `WORKSPACE_RUNTIME_LOCAL_BASE_URL` | Local runtime URL forwarded by the tunnel. Defaults to `http://127.0.0.1:<port>`. |
| `WORKSPACE_RUNTIME_CONFIG_TOKEN` | Trusted direct token for relay-host middleware and the `GET /api/wr/health` check. Not standalone config mutation auth. |
| `WORKSPACE_RUNTIME_TRUSTED_DIRECT_TOKEN` | Whole-host direct token accepted by relay-host auth without an RHT. Use only for trusted supervisor/control-plane traffic. Also acts as the config token when `WORKSPACE_RUNTIME_CONFIG_TOKEN` is unset. |
| `WORKSPACE_RUNTIME_RELAY_JWKS_URL` | JWKS URL for relay-host auth verification. |
| `WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM` | PEM public key for relay-host auth verification. |

Additional tuning knobs (tunnel ping cadence, a full Authorization-header
override for the tunnel token, drain timeout, PTY backpressure watermarks)
exist with sensible defaults — see the package source if you need them.

`workspaceRelayRuntimeOptionsFromEnv` returns:

- `relayHostAuth`
- `hostTunnel`
- `configToken`
- `managementAuth` / `managementTarget` (when the
  `WORKSPACE_RUNTIME_MANAGEMENT_*` env vars are set)

## Production Relay Shape

Workspace Relay production v1 is a single-instance deployment for user-hosted
traffic. The relay stores host presence and active host-tunnel sockets in
process memory, so one `hostId` has exactly one active inbound host tunnel in
one relay process. A new tunnel for the same `hostId` replaces the previous
tunnel; stale close events from the old socket do not mark the replacement
offline.

Do not run multiple active relay instances for the same user-hosted fleet unless
a separate multi-instance routing milestone has added sticky host routing,
split-brain prevention, and failover ownership. Private cloud-VM targets can be
forwarded directly by the relay, but user-hosted tunnels are process-local.

Operational tradeoff: the relay process, VM, or region is a single point of
failure for user-hosted traffic. Restart, deploy, or crash events drop active
host tunnels and long-lived HTTP/WebSocket/SSE/PTY sessions until the
workspace-runtime host reconnects. During planned drain, the relay reports
`/health` as unhealthy, rejects new workspace requests and tunnel registrations
with `503 relay_draining`, closes active host tunnels so hosts reconnect
promptly, waits for pending work up to the drain timeout, then exits. Future
multi-instance relay support is out of scope for this v1 production shape.

## Auth And Metrics

Runtime access tokens are validated on every new HTTP request and WebSocket
upgrade. Custom `TokenVerifier` implementations are allowed, but their output is
still decoded into relay-domain claims, bound to the requested workspace id and
host id, checked for revocation, and role-checked by allowlist. Missing,
unknown, or malformed roles deny.

Established long-lived relayed sockets are not reauthorized mid-stream in v1.
Revocation applies to new requests and new connections; existing
WebSocket/SSE/PTY sessions may continue until they close, reconnect, drain, or
hit a future max-lifetime/recheck feature.

`/metrics` is ops-only. In production, configure `CLAXEDO_RELAY_METRICS_TOKEN`
or run through the Bun adapter's trusted remote-address resolver so the endpoint
is limited to loopback. Without either signal, metrics fail closed.

## Protocol Package

`@claxedo/workspace-relay-protocol` contains the tunnel message types and token
verifier helpers. It does not depend on Hono or the relay server package.

It exists as a separate package because both sides of the tunnel need the same
wire contract:

- `@claxedo/workspace-relay` uses it to validate and emit tunnel messages.
- `@claxedo/workspace-runtime` uses it in the host tunnel client that connects a
  workspace host back to the relay.
- `claxedo-server` and `workspace-runtime` use the same `TokenVerifier`
  interface for pluggable auth seams.

Keeping this contract package separate means a runtime host, browser-adjacent
client, or custom relay implementation can depend on the protocol without
depending on the relay server's Hono/Jose/Bun-specific implementation.

The package exports:

- `TUNNEL_PROTOCOL_VERSION`
- `TunnelMessage` and specific tunnel frame types
- `isTunnelMessage`
- `makeTunnelPong`
- `TokenVerifier`
- `TokenVerifierError`
- `createHttpTokenVerifier`
- `createStaticTokenVerifier`

```ts
import { createStaticTokenVerifier } from "@claxedo/workspace-relay-protocol"

const verifier = createStaticTokenVerifier({
  tokens: {
    "tok-1": {
      subject: "u1",
      scopes: ["workspace:write"],
      claims: {},
    },
  },
})
```

`createHttpTokenVerifier` is a reference verifier implementation. Its endpoint
is the cryptographic authority and must run over HTTPS, enforce issuer,
audience, expiry, key selection, and replay policy, then return the claims that
each consuming boundary validates into its own domain type.

## Grounding

Implemented in:

- `packages/workspace-runtime/src/workspace-relay-env.ts`
- `packages/workspace-runtime/src/workspace-relay-host-tunnel.ts`
- `packages/workspace-runtime/src/workspace-host-service-auth.ts`
- `packages/workspace-relay-protocol/src/index.ts`
- `packages/workspace-relay-protocol/src/token-verifier.ts`
- `packages/workspace-relay/src/server.ts`
