# @claxedo/egress-broker

A streaming HTTP broker for credentials a harness must be able to SPEND but
never READ. The authority owns raw values; runtimes receive a signed,
binding-scoped placeholder and a `/bindings/<id>` base URL. A binding names the
user, organization, workspace, lease generation, runtime identity, credential,
revision, destination policy, and header injection policy.

```ts
import { createEgressBroker, verifyRuntimeToken } from "@claxedo/egress-broker"

const egressBroker = createEgressBroker({
  authority,
  verifyToken: (token) => verifyRuntimeToken(token, signingKey),
})
```

`authority` is supplied by the server that holds the credential values. This
package owns request policy, header injection and runtime-token verification,
and nothing else. Two compositions mount it:

- The desktop: `@claxedo/local-server`'s `credentials/broker.ts` holds every
  binding it minted in memory and signs placeholders with its own HS256 key
  (`mintRuntimeToken` / `verifyRuntimeToken`). Pass the handler to
  `createLocalApp` / `startLocalServer`; `loopbackBrokerRoutes` is the one
  gate they mount it behind, and `isBrokerPath` is the matching CORS
  carve-out. `listenLoopbackBroker` from `@claxedo/egress-broker/node` owns a
  Node listener bound to `127.0.0.1` instead; close it during shutdown.
- The hosted control plane: `@claxedo/server`'s
  `credentials/hosted-egress-broker/` mounts the handler at `/bindings/*` on
  the API Worker for cloud sandboxes whose driver has no provider edge (Boat,
  Modal, Docker). Its placeholders are sandbox passes signed with the plane's
  runtime key, and its authority holds nothing between requests: `resolve`
  receives the verified claims beside the binding id and reads the account
  they name from the organization's store. Drivers with a native edge
  (Cloudflare, Vercel) never pass through it.

`verifyToken` decides what a claims object is; `authority.resolve(bindingId,
claims)` receives exactly what it returned, so an authority may carry claims
of its own beyond the runtime identity. `reportFailure` carries the runtime
identity the binding was spent under.

Requests outside a binding's method/path policy receive 403. Upstream
destinations must be HTTPS origins. The broker replaces incoming authentication
with the authoritative header, streams request and response bodies, refuses
every upstream 3xx with 502 and no Location, and reports upstream 401/403
against the exact revision used. It removes credential, cookie, and transport
headers from responses; it does not inspect or redact upstream response bodies.

A destination with an `exchange` route keeps the exchanged access token in the
broker's memory, so it is served only by a composition that stays in one
process (the desktop); the hosted plane refuses to bind such a destination.

Rotation replaces the value used by subsequent requests without changing the
placeholder. Withdrawal rejects subsequent requests. Tokens expire at the
supplied deadline; the caller must renew projections before expiry and supply a
fresh runtime generation after replacement. A host must explicitly supply a
broker handler — adding this package does not enable credential brokering.
