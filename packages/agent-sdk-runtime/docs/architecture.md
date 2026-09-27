# Architecture

This package is a contract and helper library; it runs nothing. The pieces
below are ordered the way a turn flows through the system that uses them.

## Turn flow

1. A host receives a prompt and builds a `PromptInput` (`agent`, `parts`, message ids, optional `model`, `system`, `author`).
2. The runtime host in `@claxedo/workspace-runtime` resolves the session's `SessionConfig` with `resolveSessionModel` and `resolveTurnSystem`, admits the turn against the store contract (`startTurn` under a lease and fencing token), and sends it to a harness transport from `@claxedo/harness`.
3. The transport yields canonical `AgentRuntimeEvent`s (`@claxedo/agent-event-runtime`); the host commits them through the store (`appendEvent`) and publishes the client-presentation frames built by `./compat-events` (`toCompatEvent`, `messageUpdated`, `sessionIdle`, …).
4. The turn ends with `finishTurn` carrying an `AgentTurnOutcome`; a finalisation whose lease is stale is refused with `AgentRuntimeStaleTurnError`.

## Ownership

- Session identity and execution bindings are rows of the store contract (`AgentRuntimeSessionBinding`, `AgentExecutionBinding`).
- Provider credentials reach a harness as projections (`./provider-projection`): a base URL and a placeholder the broker resolves, never the secret.
- Session titles follow `acceptsSessionTitle`: a model-generated title beats the first-prompt placeholder, and a writer that chose a title is never overwritten by a placeholder.

## Persistence

`AgentRuntimeStoreWithRecovery` (`./adapters`) names every table the runtime host needs: sessions, config, bindings, turn leases, committed events, todos, pending requests and recovery operations. `MemoryRuntimeStore` keeps them in memory and `SqliteRuntimeStore` persists the same reducer to SQLite; the workspace runtime's `RuntimeStore` is the production implementation.

## Package boundaries

`@claxedo/agent-runtime-contract` holds the wire-level types this package re-exports; `@claxedo/agent-event-runtime` holds the canonical event union the compat bridge reads. Nothing here depends on a harness SDK or on `@claxedo/harness`.
