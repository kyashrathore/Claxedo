# @claxedo/egress-broker

A process-owned credential delivery adapter and streaming HTTP broker. The authority owns raw values; runtimes receive a signed, binding-scoped placeholder and a `/bindings/<id>` base URL. Bindings include user, organization, workspace, lease generation, runtime identity, revision, destination policy, and header injection policy.

Activate a runtime, apply its bindings, and call `adapter.project(bindingId, brokerOrigin, expiresAt)` to produce harness settings. Rotation replaces the value used by subsequent requests without changing the placeholder. Withdrawal rejects subsequent requests; a withdrawn binding ID cannot be reused. Tokens expire at the supplied deadline. The caller must renew projections before expiry and supply a fresh runtime generation after replacement.

```ts
import { createEgressBroker, createGenericDeliveryAdapter, verifyRuntimeToken } from "@claxedo/egress-broker"

const adapter = createGenericDeliveryAdapter({ signingKey, reportFailure })
const egressBroker = createEgressBroker({
  authority: adapter.authority,
  verifyToken: (token) => verifyRuntimeToken(token, signingKey),
})
```

Pass `egressBroker` to `createLocalApp` / `startLocalServer` or `createSelfHostedApp` / `startControlPlaneStack` / `startServer`. These compositions accept a Request-to-Response handler, so they do not own credential resolution. Local composition requires loopback and withholds browser CORS access. Control-plane composition allows remote runtimes and delegates authentication to the broker. Alternatively, `listenLoopbackBroker` from `@claxedo/egress-broker/node` owns a Node listener bound to `127.0.0.1`; close it during shutdown.

Requests outside a binding's method/path policy receive 403. Upstream destinations must be HTTPS origins. The broker replaces incoming authentication with the authoritative header, streams request and response bodies, refuses every upstream 3xx with 502 and no Location, and reports upstream 401/403 against the exact revision used. It removes credential, cookie, and transport headers from responses; it does not inspect or redact upstream response bodies.

This package is an in-memory skeleton. Persistent hosted storage, automatic provisioning selection, harness configuration, and token renewal are not implemented here. A host must explicitly supply its broker handler; adding this package does not enable credential brokering by default.
