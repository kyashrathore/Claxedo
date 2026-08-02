# `@claxedo/workspace-relay-protocol`

Shared wire types and token-verifier contracts for Claxedo workspace relay
traffic. This package intentionally has no Hono, Bun, or server dependency so
workspace hosts and non-Node clients can validate tunnel frames without pulling
in the relay implementation.

## Install

```sh
npm install @claxedo/workspace-relay-protocol
```

## Quickstart

```ts
import { createStaticTokenVerifier, isTunnelMessage, validateTunnelMessage } from "@claxedo/workspace-relay-protocol"

// Validate an inbound tunnel frame before acting on it.
const result = validateTunnelMessage(JSON.parse(rawFrame))
if (!result.ok) {
  throw new Error(`invalid tunnel frame: ${result.reason}`)
}
// result.message is a narrowed TunnelMessage here.

// Or use the boolean type guard when you just need a filter.
const frames = incoming.filter(isTunnelMessage)

// A fixed token table for tests and single-tenant self-hosted deployments.
const verifier = createStaticTokenVerifier({
  tokens: {
    "test-token": {
      subject: "workspace-abc",
      scopes: ["relay:connect"],
      claims: {
        iss: "claxedo-test",
        aud: "workspace-relay",
        sub: "workspace-abc",
        workspace_id: "workspace-abc",
        host_id: "host-1",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        jti: "jti-1",
      },
    },
  },
})
const claims = await verifier.verify("test-token")
```

## Public Surface

| Export | Stability | Purpose |
| --- | --- | --- |
| `TUNNEL_PROTOCOL_VERSION` | Stable | Current tunnel protocol version. |
| `TunnelMessage` and message subtypes | Stable | Discriminated union for HTTP, WebSocket, heartbeat, host-registration, flow-control, and error frames. |
| `TunnelHostRegistrationUpdate` / `"host.registration.update"` | Stable | Frame a host sends to update the set of workspace IDs it serves and its auth token. |
| `validateTunnelMessage`, `isTunnelMessage` | Stable | Runtime validation for protocol, message type, and per-message payload shape. |
| `TunnelMessageValidation` | Stable | Result type returned by `validateTunnelMessage` — `{ ok: true, message }` or a typed failure (`protocol_mismatch` / `invalid`). |
| `makeTunnelPing`, `makeTunnelPong` | Stable | Helpers for heartbeat requests and replies. |
| `TokenVerifier` and claim types | Stable | Narrow verifier interface shared by relay/runtime boundaries. |
| `RelayHostVerifierClaims` (incl. `role`) | Stable | Claims shape for host-side verification: org, `role` (`viewer` \| `editor` \| `admin` \| `owner`), and cloud/user-hosted backing discriminant. |
| `createClerkTokenVerifier` | Public beta | Verifies Clerk session tokens with issuer, audience, JWKS, and algorithm constraints. |
| `createHttpTokenVerifier` | Public beta | Calls an operator-controlled verifier endpoint over HTTP. |
| `createStaticTokenVerifier` | Test/single-tenant only | Fixed token table for tests and isolated self-hosted deployments. |

## Tunnel Validation

`validateTunnelMessage(input)` rejects:

- non-objects;
- protocol mismatches;
- unknown message types;
- missing required fields for the selected message type;
- malformed header maps;
- invalid base64 fields;
- invalid HTTP status or WebSocket close-code fields.

The validator allows extra object fields for forward-compatible metadata, but
consumers should ignore fields they do not understand.

## Token Verifiers

`TokenVerifier` is deliberately small:

```ts
export type TokenVerifier<TClaims extends Record<string, unknown> = Record<string, unknown>> = {
  verify(token: string): Promise<TokenClaims<TClaims>>
}
```

Verifier implementations own issuer checks, audience checks, key selection,
expiry, replay policy, and any revocation/introspection calls. Relay and
runtime packages validate the returned claims again at their own boundaries.

### HTTP Verifier Endpoint

`createHttpTokenVerifier({ endpoint })` posts `{ token }` to the configured
endpoint and expects `{ subject, scopes?, claims }` back. The endpoint is a
trusted operator configuration value. Do not derive it from a request, tenant
record, query string, workspace config, or other user-controlled input.

The endpoint should normally be an HTTPS URL on infrastructure you control. It
must enforce issuer, audience, expiry, key selection, and replay/revocation
policy before returning claims. Treat a compromised verifier endpoint as
equivalent to a compromised token issuer.

### Static Verifier

`createStaticTokenVerifier` is for tests, local demos, and isolated
single-tenant deployments where tokens are provisioned out of band. It is not a
multi-tenant production verifier because it has no issuer rotation, expiry
enforcement, replay cache, or revocation source unless the caller adds those
outside the static table.

## Compatibility Policy

The current wire version is `1`. Patch and minor releases may add optional
fields to existing message objects. They must not change the meaning or type of
existing fields within the same protocol version.

Breaking message changes require a new `TUNNEL_PROTOCOL_VERSION`. Relays and
hosts should reject unsupported protocol versions with a protocol-mismatch
error instead of trying to coerce frames across versions.
