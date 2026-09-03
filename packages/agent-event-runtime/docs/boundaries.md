# Boundaries

`@claxedo/agent-event-runtime` owns event translation and projection only.

## Runtime Owns

- `RawHarnessEvent` ingress envelope
- harness event adapter contract
- harness event adapter state
- canonical `AgentRuntimeEvent` values
- diagnostics for lossy mappings and failures
- runtime/projection snapshots
- deterministic clock/id injection
- projection contract

## Harness Event Adapters Own

- parsing harness-native payloads
- preserving harness-specific data in metadata
- translating harness-native lifecycle events into canonical events
- returning diagnostics for unmapped frames

Harness event adapters do not start processes, perform network I/O, persist
data, or authorize users.

## Projections Own

- deriving an output view from canonical events
- projection state and snapshots
- compatibility shape mapping
- debug trace shape mapping

Projections should not depend on harness-native payloads except through
canonical event metadata or diagnostics.

## Hosts Own

- process management
- WebSocket/EventSource/stdin/stdout transport
- auth and authorization
- database persistence
- workspace/session visibility
- HTTP route shape
- replay storage
- product-specific audit logs
- gateway routing

If an API needs a control-plane database, an identity provider, route guards,
channel idempotency, workspace sharing, or billing policy, it does not belong in
this package.
