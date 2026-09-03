# Boundaries

`@claxedo/agent-sdk-runtime` owns the normalized host-facing runtime contract
for agent harnesses.

## Runtime Owns

- `AgentRuntime` facade
- session/message/config host-visible shapes
- prompt submission shape
- harness config shape
- harness capabilities
- harness factory registration
- canonical event stream handoff
- local process/filesystem environment abstraction

## Host Owns

- user authentication
- authorization and role policy
- database persistence
- workspace and project visibility
- workspace sharing
- channel ingestion
- channel idempotency
- channel audit logs
- HTTP/RPC route shape
- gateway resolution
- billing and quotas
- product UI state

## Adapter Owns

- translating the harness driver contract to one harness
- harness process or SDK integration when applicable
- harness-specific config probing
- harness-specific permission/question/todo behavior
- emitting canonical or compatibility event streams

Concrete adapters should not know control-plane schemas, identity-provider
orgs, share links, channel retry policy, or Claxedo route names.

## Session Environment Owns

- working directory
- command execution
- file reads/writes
- path resolution
- placement metadata supplied by the host

The session environment should not decide who may access a workspace or where
HTTP traffic should be routed.
