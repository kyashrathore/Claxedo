# Multi-Backend Migration: Implementation Plan

## Purpose

This document is the execution and implementation companion to [multi-backend-migration.md](./multi-backend-migration.md).

Use the migration doc for architecture, behavioral differences, and design constraints.
Use this doc for sequencing, file-level implementation scope, delivery order, test gates, and rollout.

## Core invariants

These rules apply to every phase:

1. **Feature gate before runner rename.** `CLAXEDO_ADAPTERS` must exist before `"claude"` or `"codex"` can be safely persisted or instantiated.
2. **Runner rename only.** In this migration, `runner.type` changes, but provider IDs, auth IDs, and compat API IDs stay on `claude-acp` / `codex-acp` / `cursor-acp`.
3. **No legacy read support.** We do not carry mixed `"claude-acp"` / `"codex-acp"` and `"claude"` / `"codex"` runtime reads in steady-state code.
4. **Fail closed.** If an adapter is disabled, unknown, malformed, or partially configured, requests must fail with a clear error instead of silently falling back.
5. **Cursor stays on ACP.** This migration removes Claude and Codex from ACP ownership, but Cursor remains there.
6. **No premature abstraction.** Each adapter owns its full lifecycle. Shared helpers are extracted only after real duplication appears.

## Deliverables

By the end of the migration, we should have:

- `ClaudeSDKAdapter`
- `CodexAppServerAdapter`
- Claude and Codex translator test coverage
- deny-by-default permission mapping coverage
- cutover migration for persisted runner state
- feature-flagged rollout with explicit destructive rollback behavior
- `ACPAdapter` scoped down to Cursor-only behavior

## Phase 0: Spikes and decision gates

### Goal

Resolve the two open unknowns before implementation starts, then update the architecture doc if the answers differ from the current assumptions.

### Spike A: Claude SDK auth refresh behavior

Question:
- Does `@anthropic-ai/claude-agent-sdk` re-read auth from env or config on each query, or cache it at init?

Required output:
- short note in the migration doc
- chosen mechanism: env mutation or `CLAUDE_CONFIG_DIR/.credentials.json`
- proof reference: local experiment, docs, or upstream code path

### Spike B: Codex app-server auth update path

Question:
- Can auth be updated over RPC, or is env-at-spawn the only supported path?

Required output:
- short note in the migration doc
- chosen mechanism: live RPC update or process restart
- recovery implication for existing threads

### Exit criteria

- both spikes have written outcomes
- sections 3 through 5 of the migration doc match those outcomes
- no implementation starts on a stale assumption

## Phase 1: Safe groundwork

### Goal

Make the codebase safe to carry new runner names before any new adapter behavior exists.

### Workstream 1: Feature gate first

Implement `CLAXEDO_ADAPTERS` parsing before persisting or constructing any new runner type.

Required behavior:
- default remains `cursor-acp,opencode`
- disabled adapters return a clear error
- disabled persisted runners do not crash startup
- session listing, health, and config endpoints still function when a disabled runner is encountered

Likely touchpoints:
- `packages/workspace-runtime/src/server.ts`
- `packages/claxedo-server/src/local-agent-engine.ts`
- any helper that constructs adapters eagerly from stored config

### Workstream 2: Runner-type rename plumbing

Add `"claude"` and `"codex"` as runner values across the stack.

Required updates:
- runtime type unions
- config validation
- persisted runner rewrite/reset
- UI runner lists and display labels
- header/query override parsing

Required files and areas:
- `packages/workspace-runtime/src/routes/config.ts`
- `packages/workspace-runtime/src/adapters/index.ts`
- `packages/workspace-runtime/src/server.ts`
- `packages/workspace-runtime/src/store.ts`
- `packages/claxedo-server/src/agent-config.ts`
- `packages/claxedo-server/src/local-agent-engine.ts`
- `packages/claxedo-server/src/session-runner.ts`
- `packages/claxedo-server/src/routes/agent-config.ts`
- `packages/claxedo-server/src/routes/agent-session.ts`
- `packages/claxedo-server/src/routes/opencode-compat.ts`
- `packages/claxedo-app/src/claxedo-ui/context/acp-config.ts`
- `packages/claxedo-app/src/claxedo-ui/components/agent-runner-selector.tsx`
- submit/bootstrap flows that send `x-claxedo-runner`

### Workstream 3: Persistence cutover

Replace legacy persisted runner values during rollout instead of supporting them in steady-state runtime code.

Required persistence paths:
- `session-runners.json`
- `user-agent-config.json`
- runtime DB reads for `runner_type`

Required rule:
- `claude-acp` and `codex-acp` entries are rewritten or removed before the new runtime depends on them
- no `normalizeRunnerType()` helper remains in steady-state runtime logic
- unknown persisted runner values fail closed or are cleared during cutover

### Workstream 4: Identifier contract lock

Prevent accidental provider/auth/model ID drift while runner names change.

Required rules:
- auth keys stay as `claude-acp`, `codex-acp`, `cursor-acp`
- compat provider catalogs stay on those IDs
- `PromptModel.providerID` is not derived from `runner.type` for Claude/Codex

Likely touchpoints:
- `packages/claxedo-server/src/agent-config.ts`
- `packages/claxedo-server/src/local-agent-engine.ts`
- `packages/claxedo-server/src/routes/opencode-compat.ts`
- any helper that stores or reconstructs `PromptModel`

### Workstream 5: Stub adapter branches

Update adapter factories to recognize the new runner types immediately.

Required behavior:
- `claude` and `codex` must not route to `ACPAdapter`
- before adapters exist, they may throw `"not implemented"` intentionally
- that failure should be explicit, not a silent fallback

### Exit criteria

- branch boots without crashes
- `"claude"` and `"codex"` validate end-to-end as runner values
- legacy persisted runner strings are rewritten or cleared before runtime startup
- header/query runner overrides accept new names
- disabled new adapters fail cleanly under the feature flag

## Phase 2: Claude SDK adapter

### Goal

Replace Claude ACP behavior with an in-process Claude SDK adapter.

### Adapter scope

Build `ClaudeSDKAdapter` with:
- session creation and lookup
- send-message lifecycle
- session resume via Claude session ID
- permission request wiring
- config option synthesis
- slash command support if available
- abort behavior
- cleanup on dispose

### Required implementation areas

1. **Auth and filesystem isolation**
   - set up per-workspace `CLAUDE_CONFIG_DIR`
   - write `.credentials.json` with `0o600`
   - ensure config dir is workspace-scoped
   - clear credential material on dispose

2. **Permission mode management**
   - implement workspace-policy gate for `bypassPermissions`
   - audit all transitions
   - deny mode change when the workspace policy disallows it

3. **Send-message flow**
   - create/reuse query session
   - apply model and mode updates
   - wire `canUseTool` into pending permission flow
   - translate SDK events into `AgentEvent`

4. **Session resume**
   - persist Claude session ID in `agent_session_id`
   - validate resume handles in the adapter, not the store
   - recover from query-stream failure using `resume`

### New files expected

- `packages/workspace-runtime/src/adapters/claude-sdk.ts`
- `packages/workspace-runtime/src/adapters/translate-claude-sdk.ts`
- `packages/workspace-runtime/src/adapters/translate-claude-sdk.test.ts`

### Exit criteria

- Claude no longer routes through ACP for new `claude` runner sessions
- permissions round-trip through the UI
- session resume works with stored Claude session IDs
- config options return static/synthesized Claude choices
- credential file lifecycle is implemented and tested

## Phase 3: Codex app-server adapter

### Goal

Replace Codex ACP behavior with a singleton Codex app-server adapter over JSON-RPC stdio.

### Adapter scope

Build `CodexAppServerAdapter` with:
- singleton process management
- thread-backed session model
- `turn/create` messaging
- approval request handling
- config option probing from the live process
- restart/recovery behavior
- abort behavior

### Required implementation areas

1. **Process manager**
   - ensure a single app-server per runtime
   - support graceful shutdown
   - track active threads and in-flight turns

2. **Thread/session binding**
   - store thread ID in `agent_session_id`
   - validate thread IDs at resume time
   - reconnect sessions using `thread/read`

3. **Approval flow**
   - capture JSON-RPC approval requests
   - map UI decisions to Codex decision values
   - preserve deny-by-default behavior

4. **Recovery**
   - restart the singleton on exit
   - scope `processLost()` to Codex runner sessions
   - rebind recoverable threads
   - emit explicit errors for unrecoverable ones

### New files expected

- `packages/workspace-runtime/src/adapters/codex-appserver.ts`
- `packages/workspace-runtime/src/adapters/translate-codex-appserver.ts`
- `packages/workspace-runtime/src/adapters/translate-codex-appserver.test.ts`

### Exit criteria

- Codex no longer routes through ACP for new `codex` runner sessions
- live approvals work through the UI
- thread recovery succeeds after forced process restart
- config options come from app-server model discovery or safe fallback

## Phase 4: Shared cleanup and integration

### Goal

Consolidate the migration after both new adapters exist.

### Work items

1. Strip Claude and Codex branches out of `ACPAdapter`
2. Keep Cursor ACP behavior intact
3. Extract only proven shared helpers:
   - event queue helpers
   - title generation helper
   - optional tool-kind lookup registry
4. Update existing tests and snapshots for renamed runner values

### Exit criteria

- `ACPAdapter` is Cursor-only in responsibility
- no dead Claude/Codex ACP branches remain on critical paths
- helper extraction is minimal and justified by duplication

## Phase 4.5: Security gate

Before enabling either new adapter anywhere outside local development, verify:

- `bypassPermissions` is workspace-policy-gated
- deny-by-default permission mapping tests pass
- `.credentials.json` is written with `0o600`
- credential cleanup on dispose is implemented
- credential-adjacent logs are debug-only and contain no secrets or presence leaks
- malformed permission decisions/timeouts resolve to deny

## Phase 5: Testing and rollout

### Required test matrix

1. **Runner migration**
   - legacy persisted types are rewritten or cleared during cutover
   - new types validate
   - disabled new types fail cleanly

2. **Translator coverage**
   - Claude native events -> `AgentEvent`
   - Codex native events -> `AgentEvent`

3. **Permission coverage**
   - all 4 decisions × all 3 backends
   - malformed values deny
   - timeouts deny

4. **UI and route coverage**
   - runner selector
   - header/query runner overrides
   - config option endpoints
   - auth routes remain on provider IDs

5. **Recovery coverage**
   - Claude resume after query interruption
   - Codex resume after process restart

### Rollout sequence

1. keep `CLAXEDO_ADAPTERS=cursor-acp,opencode`
2. enable `claude` in staging
3. validate health, session create/send, permissions, resume, and config options
4. enable `codex` in staging
5. validate health, approvals, restart recovery, and options probing
6. promote both to production only after Phase 4.5 passes

### Rollback rehearsal

Must verify:
- turning the flag back off does not crash startup
- persisted `claude` / `codex` runner values can be cleared safely
- runner option endpoints still return safely
- rollback behavior explicitly allows loss of migrated Claude/Codex session state

## Parallelization

Recommended split:

- Engineer 1: Phase 2 Claude adapter
- Engineer 2: Phase 3 Codex adapter
- Shared prerequisite: Phase 1 must land first
- Shared follow-up: Phase 4 and rollout must be done together

## Estimated effort

- Phase 0: 1-2 days
- Phase 1: 2-3 days
- Phase 2: 3-5 days
- Phase 3: 3-5 days
- Phase 4 + 4.5 + Phase 5: 3-5 days

Total: roughly 12-18 days with two engineers working in parallel after Phase 1.

## Done means

This migration is done only when:

- Claude and Codex no longer depend on ACP
- Cursor continues working through ACP
- legacy persisted runner values are removed or rewritten during cutover
- rollback behavior is documented as destructive for migrated Claude/Codex session state
- security gate passes
- test coverage exists for translators, permissions, and recovery
