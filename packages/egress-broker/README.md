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

`authority` is supplied by the server that holds the credential values —
`@claxedo/local-server`'s `credentials/broker.ts` for the desktop composition.
This package owns request policy, header injection and runtime-token
verification, and nothing else.

Pass `egressBroker` to `createLocalApp` / `startLocalServer` or
`createSelfHostedApp` / `startControlPlaneStack` / `startServer`. These
compositions accept a Request-to-Response handler, so they do not own credential
resolution; `loopbackBrokerRoutes` is the one gate they mount it behind, and
`isBrokerPath` is the matching CORS carve-out. Alternatively,
`listenLoopbackBroker` from `@claxedo/egress-broker/node` owns a Node listener
bound to `127.0.0.1`; close it during shutdown.

Requests outside a binding's method/path policy receive 403. Upstream
destinations must be HTTPS origins. The broker replaces incoming authentication
with the authoritative header, streams request and response bodies, refuses
every upstream 3xx with 502 and no Location, and reports upstream 401/403
against the exact revision used. It removes credential, cookie, and transport
headers from responses; it does not inspect or redact upstream response bodies.

Rotation replaces the value used by subsequent requests without changing the
placeholder. Withdrawal rejects subsequent requests. Tokens expire at the
supplied deadline; the caller must renew projections before expiry and supply a
fresh runtime generation after replacement. A host must explicitly supply a
broker handler — adding this package does not enable credential brokering.
