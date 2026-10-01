# Capability projection

`wire.ts` is the one projection from `TransportCapabilities` and a transport's operation groups to the public `AgentCapabilities` and `HarnessConnectionCapabilities`. The projection is a literal of the public type, so a public field without a contract source fails to typecheck, and the per-transport table in `wire.test.ts` pins every value.

- `abort` is the host's per-session fact, supplied in the context: an ACP child session cannot be aborted directly. The context must carry it; the projection throws when it does not, so no caller gets an invented `true`.
- `commands`, `fork` and `configOptions` are the presence of the `commands`, `fork` and `config` operation groups. A transport that lists nothing still has the operation; one without the group has no command, fork or option surface at all.
- `replay` follows `history`: a store-owned history always replays from the runtime store, and a harness-owned history replays only when the transport serves `history`.
- `reconnect`, `revert` and `unrevert` are `false` for every transport, in one place, because the contract has no reconnect and no history-mutation operation.
- `permissions`, `questions`, `todos` and `subagents` are copied from the declared capabilities.

`mcp-filter.ts` is the one remote-harness MCP filter.
