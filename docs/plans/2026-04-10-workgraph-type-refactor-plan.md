---
date: 2026-04-10
topic: workgraph-type-refactor
status: active
origin: chat
---

# WorkGraph Type Refactor Plan

## Goal

Group the current TypeScript failures in `packages/workgraph`, then refactor the package toward a type architecture that is modular, reusable, scalable, and safe to extend.

This plan covers:

- current compiler failures in `packages/workgraph`
- grouping those failures by real root cause
- a complete type refactor direction for the package
- sequencing, file targets, and test strategy

This plan does not cover:

- product behavior changes to workgraph execution semantics
- upstream-wide type cleanup outside `packages/workgraph`
- replacing SQLite, Drizzle, Hono, or the event-sourced model itself

## Current Facts

Running `bun x tsc --noEmit -p tsconfig.json` in [packages/workgraph](/Users/yashvardhansingh/test/opencode/packages/workgraph) currently fails with 453 errors.

The current split is:

- 47 errors in `src/`
- 406 errors in `test/`

That ratio matters. Most failures are downstream noise from a smaller set of source contract drifts.

The most common error codes are:

- `TS2532` object possibly undefined
- `TS2339` property does not exist
- `TS18046` value is `unknown`
- `TS2345` argument type mismatch
- `TS2709` namespace used as a type

There is also an operational gap: [packages/workgraph/package.json](/Users/yashvardhansingh/test/opencode/packages/workgraph/package.json) has no `typecheck` script, so compiler drift is harder to keep visible than in the rest of the repo.

## Problem Frame

`workgraph` is currently carrying several independent type systems at once:

1. a mutable work-item domain under [packages/workgraph/src/model](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/model)
2. an event-sourced orchestrator domain under [packages/workgraph/src/orchestrator](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/orchestrator)
3. SQLite access shapes split across raw `better-sqlite3`, a custom compat wrapper, and Drizzle
4. route payloads and `Response.json()` values that are mostly inferred as `unknown`
5. tests written around an older `bun:sqlite` mental model, then patched at runtime in [packages/workgraph/test/helpers/vitest-setup.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/helpers/vitest-setup.ts)

The compiler failures are symptoms of those boundaries not being explicit enough.

## Grouped Error Map

These are the real groups to use for planning and execution.

### 1. Database Port Drift

This is the highest-leverage group.

Files:

- [packages/workgraph/src/sqlite.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/sqlite.ts)
- [packages/workgraph/src/sdk/graph-query.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/sdk/graph-query.ts)
- [packages/workgraph/src/model/db.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/model/db.ts)
- [packages/workgraph/src/cli-runner.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/cli-runner.ts)
- [packages/workgraph/src/orchestrator/core/services/event-store-sqlite.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/orchestrator/core/services/event-store-sqlite.ts)
- [packages/workgraph/test/helpers/vitest-setup.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/helpers/vitest-setup.ts)
- [packages/workgraph/test/helpers/node-db.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/helpers/node-db.ts)

Symptoms:

- `Database` is treated as both a runtime constructor and a structural DB type
- some functions accept `SqliteDb`, others accept raw `Database`, others wrap with `sqlite()`
- tests call `.run()` and `.query()` on `better-sqlite3` instances even though those methods only exist after runtime patching
- Drizzle-backed code reaches into `$client` and driver-specific details

This group explains most of:

- `TS2709`
- many `TS2339`
- many `TS2345`
- a large share of test failures

### 2. Contract Export Drift

Files:

- [packages/workgraph/src/orchestrator/events/connector.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/orchestrator/events/connector.ts)
- [packages/workgraph/src/connectors/github/github.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/connectors/github/github.ts)
- [packages/workgraph/src/connectors/linear/linear.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/connectors/linear/linear.ts)
- [packages/workgraph/src/providers.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/providers.ts)
- [packages/workgraph/test/connectors/integration/connector-roundtrip.test.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/connectors/integration/connector-roundtrip.test.ts)
- [packages/workgraph/test/helpers/fake-db.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/helpers/fake-db.ts)

Symptoms:

- `ProviderQueryMode` is used but not exported from the connector contract
- tests import symbols that are only locally declared and not exported
- helper code imports `RunMetrics` from the wrong module boundary

This is classic “the shape exists conceptually, but there is no single published contract.”

### 3. Domain Model Naming Drift

Files:

- [packages/workgraph/src/model/types.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/model/types.ts)
- [packages/workgraph/src/model/workgraph.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/model/workgraph.ts)
- [packages/workgraph/src/model/db.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/model/db.ts)
- [packages/workgraph/src/routes/graph.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/routes/graph.ts)
- [packages/workgraph/test/unit/run-store.test.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/unit/run-store.test.ts)

Symptoms:

- internal objects use camelCase (`repoRef`, `repoLabel`)
- DB rows use snake_case (`repo_ref`, `repo_label`)
- some logic builds unions that can contain both shapes at once
- `SourceKind` excludes `"markdown"` even though tests and route flows still use it

This is not just naming style. It means row shapes and domain shapes are bleeding into each other.

### 4. Schema and Nullability Hygiene Gaps

Files:

- [packages/workgraph/src/triggers/cron.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/triggers/cron.ts)
- [packages/workgraph/src/routes/triggers.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/routes/triggers.ts)
- [packages/workgraph/src/orchestrator/trace/trace-store.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/orchestrator/trace/trace-store.ts)
- [packages/workgraph/src/orchestrator/core/services/event-store-sqlite.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/orchestrator/core/services/event-store-sqlite.ts)
- [packages/workgraph/src/orchestrator/core/services/hash-chain-node.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/orchestrator/core/services/hash-chain-node.ts)
- [packages/workgraph/src/cli.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/cli.ts)

Symptoms:

- `zod` call sites appear to have drifted against the installed API
- array indexing and split results are used without narrowing
- first-row assumptions are encoded as direct access instead of guards

These are real correctness issues, but they are not the architectural root. They should be fixed after the type boundaries are cleaned up.

### 5. Untyped HTTP and JSON Edges

Files:

- [packages/workgraph/src/app.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/app.ts)
- [packages/workgraph/src/routes/graph.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/routes/graph.ts)
- [packages/workgraph/test/graph.test.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/graph.test.ts)
- [packages/workgraph/test/events.test.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/events.test.ts)

Symptoms:

- `Response.json()` values are treated as if they were typed objects
- route tests operate on `unknown` JSON bodies without parsing or narrowing
- response shapes are implicit instead of owned

This is the main source of the `TS18046` cluster in tests.

### 6. Test Fixture Drift

Files:

- [packages/workgraph/test/helpers/vitest-setup.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/helpers/vitest-setup.ts)
- [packages/workgraph/test/helpers/node-db.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/helpers/node-db.ts)
- [packages/workgraph/test/unit/run-store.test.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/unit/run-store.test.ts)
- [packages/workgraph/test/unit/graph-query.test.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/unit/graph-query.test.ts)
- [packages/workgraph/test/unit/execution-store.test.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/unit/execution-store.test.ts)

Symptoms:

- tests still assume the old DB shape at the type level
- many assertions rely on array positions existing without proof
- fixtures encode outdated literals such as `"markdown"` or older connector expectations

This group should be fixed after the source contracts settle, not before.

## Architectural Diagnosis

The package currently lacks a clean separation between these layers:

1. domain types
2. persistence row types
3. provider and external API contracts
4. route request and response contracts
5. test-only compatibility types

The scalable answer is not “add more casts.” The scalable answer is to make each layer explicit and to make conversion between layers deliberate.

## Target Architecture

The refactor should move `workgraph` to four explicit type layers.

### A. Domain Layer

Purpose:
canonical in-memory types used by the package’s business logic

Rules:

- owned by `workgraph`
- no raw DB row shapes
- no route `unknown`
- no provider-specific raw payloads

Suggested files:

- [packages/workgraph/src/types/domain.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/types/domain.ts)
- [packages/workgraph/src/types/orchestrator.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/types/orchestrator.ts)
- [packages/workgraph/src/types/connectors.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/types/connectors.ts)
- [packages/workgraph/src/types/triggers.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/types/triggers.ts)

Contents:

- `WorkItem`, `WorkEdge`, `ScratchpadEntry`, `WorkEvent`
- run and node status unions
- `ProviderName`, `ProviderQueryMode`
- trigger unions and runtime hints

### B. Persistence Layer

Purpose:
own SQLite and Drizzle row shapes without leaking them into domain logic

Rules:

- snake_case row types live here
- row codecs map to and from domain types
- only store modules and query helpers should touch these directly

Suggested files:

- [packages/workgraph/src/types/rows.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/types/rows.ts)
- [packages/workgraph/src/codecs/db.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/codecs/db.ts)

Contents:

- `WorkItemRow`, `RunRow`, `NodeRow`, `AttemptRow`, `TraceEventRow`
- `rowToItem`, `itemToRow`, `rowToRun`, `rowToAttempt`

### C. Boundary Contract Layer

Purpose:
own external payloads and request-response shapes

Rules:

- Hono request schemas and response schemas live here
- connector adapter inputs live here
- route tests parse against these schemas instead of assuming shapes

Suggested files:

- [packages/workgraph/src/types/api.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/types/api.ts)
- [packages/workgraph/src/types/provider-wire.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/types/provider-wire.ts)

Contents:

- graph route response types
- trigger route input and response types
- connector hydrate/query parameter shapes

### D. Infrastructure Port Layer

Purpose:
normalize database access and keep runtime driver details local

Rules:

- almost all internal modules accept `SqliteDb`, not raw `Database`
- raw driver types are only allowed at factory edges
- tests should use the same port as production code

Suggested files:

- [packages/workgraph/src/sqlite.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/sqlite.ts)
- [packages/workgraph/test/helpers/sqlite.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/helpers/sqlite.ts)

Contents:

- `SqliteDb` as the one internal DB contract
- raw-driver adapter helpers
- typed test factory returning `SqliteDb`

## Type Ownership Matrix

Use this as the contract of record during the refactor.

### Work item model

- owner:
  workgraph domain layer
- canonical shape:
  camelCase domain type
- persisted shape:
  snake_case row type
- boundary conversion:
  DB codecs only

### Orchestrator run and node types

- owner:
  orchestrator domain layer
- canonical shape:
  typed unions for phase, runtime, status, metrics
- persisted shape:
  run and node row types
- boundary conversion:
  execution store and planner store

### Connector query and issue preview types

- owner:
  connector contract layer
- canonical shape:
  `ProviderName`, `ProviderQueryMode`, `NormalizedIssue`, `ProviderPreview`
- persisted shape:
  only provider metadata snapshots, not raw provider responses
- boundary conversion:
  provider adapters

### Trigger payload and API shapes

- owner:
  route and trigger contract layer
- canonical shape:
  trigger domain type plus request-response schemas
- persisted shape:
  trigger row shape
- boundary conversion:
  trigger store and route schemas

### SQLite access

- owner:
  infrastructure port layer
- canonical shape:
  `SqliteDb`
- raw driver types:
  allowed only in factories

## Refactor Principles

### 1. Separate Domain Types From Row Types

Never allow a union like `{ repo_ref } | { repoRef }` to leak into business logic. Convert once at the boundary.

### 2. Keep `SqliteInput` At Factory Edges Only

`createApp()`, `openSqliteRunStore()`, and similar constructors may accept raw DB inputs. Internal helpers should accept `SqliteDb` only.

### 3. Prefer Published Contracts Over Deep Imports

If multiple modules need `ProviderQueryMode`, it must be exported from a canonical contract file rather than reconstructed locally.

### 4. Use Small Value Schemas Where They Add Real Safety

Use zod for boundary payloads and narrow value objects. Do not force zod into every internal helper where a plain type alias is clearer.

### 5. Make Tests Use The Same Port As Production

Avoid compile-time reliance on prototype patching. Runtime monkeypatches can stay temporary, but the type system should not depend on them.

## Sequencing

This is deep work, so the safest sequence is staged.

## Phase 1: Create Compiler Lanes

Purpose:
group the current errors so source fixes are not buried under test noise

Changes:

- add `typecheck` scripts to [packages/workgraph/package.json](/Users/yashvardhansingh/test/opencode/packages/workgraph/package.json)
- add a source-only tsconfig, for example:
  [packages/workgraph/tsconfig.src.json](/Users/yashvardhansingh/test/opencode/packages/workgraph/tsconfig.src.json)
- optionally add a test-inclusive tsconfig, for example:
  [packages/workgraph/tsconfig.test.json](/Users/yashvardhansingh/test/opencode/packages/workgraph/tsconfig.test.json)

Target outcome:

- `typecheck:src` becomes the architectural work queue
- `typecheck:test` becomes the downstream cleanup queue

Why first:

Without this split, every foundational fix still leaves hundreds of test errors obscuring progress.

## Phase 2: Stabilize The DB Port

Purpose:
make the database contract explicit before touching higher-level modules

Changes:

- simplify and publish `SqliteDb` in [packages/workgraph/src/sqlite.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/sqlite.ts)
- change internal helpers to accept `SqliteDb` instead of raw `Database`
- remove raw `Database` references from:
  [packages/workgraph/src/model/db.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/model/db.ts)
  [packages/workgraph/src/sdk/graph-query.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/sdk/graph-query.ts)
  [packages/workgraph/src/cli-runner.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/cli-runner.ts)
  [packages/workgraph/src/orchestrator/core/services/event-store-sqlite.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/orchestrator/core/services/event-store-sqlite.ts)
- replace test compile-time dependence on prototype patching with a typed helper in:
  [packages/workgraph/test/helpers/sqlite.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/helpers/sqlite.ts)

Decision:

The package should standardize on one internal DB port, not one raw driver class.

## Phase 3: Extract Canonical Type Modules

Purpose:
stop type ownership from being spread across models, stores, routes, and tests

Changes:

- create `src/types/*` modules for domain, orchestrator, connectors, triggers, and rows
- move connector contracts out of ad hoc files into a canonical contract module
- explicitly export `ProviderQueryMode`
- decide whether `SourceKind` includes `"markdown"` or whether route and tests should migrate to another canonical literal
- adopt an explicit migration rule for legacy imports during the transition:
  keep old modules as temporary re-export shims until all callers move to the new canonical owners, then remove the shims in one cleanup pass

Decision:

Each concept should have one owner:

- domain type owner
- persistence row owner
- boundary schema owner

Migration policy:

- no big-bang import rewrite unless the source-only typecheck lane is already green
- old import paths may re-export from the new canonical type modules temporarily
- shims must be one-hop only and contain no new logic
- each implementation unit should either migrate callers fully or leave an explicit shim behind
- shim removal happens only after `typecheck:src` is green and tests no longer depend on the old path

## Phase 4: Add Row Codecs And Naming Boundaries

Purpose:
remove mixed snake_case and camelCase unions from business logic

Changes:

- create DB codecs in [packages/workgraph/src/codecs/db.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/codecs/db.ts)
- move row mapping logic out of:
  [packages/workgraph/src/model/db.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/model/db.ts)
  [packages/workgraph/src/sdk/runs.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/sdk/runs.ts)
  [packages/workgraph/src/sdk/execution-store.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/sdk/execution-store.ts)
- remove mixed-shape inference from:
  [packages/workgraph/src/model/workgraph.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/model/workgraph.ts)

Decision:

All row-domain translation happens once, in codecs, never inline inside business workflows.

## Phase 5: Stabilize Schema Substrate And Strictness

Purpose:
repair the current schema and narrowing drift before adding any new schema-owned boundary surface

Changes:

- fix `zod` API drift in:
  [packages/workgraph/src/routes/triggers.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/routes/triggers.ts)
  [packages/workgraph/src/orchestrator/trace/trace-store.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/orchestrator/trace/trace-store.ts)
- add guards in:
  [packages/workgraph/src/triggers/cron.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/triggers/cron.ts)
  [packages/workgraph/src/orchestrator/core/services/event-store-sqlite.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/orchestrator/core/services/event-store-sqlite.ts)
  [packages/workgraph/src/orchestrator/core/services/hash-chain-node.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/orchestrator/core/services/hash-chain-node.ts)
- treat this as a prerequisite for any new request-response schema work in route and provider boundaries

Decision:

The package should not expand its schema surface until the current schema substrate compiles cleanly and the narrowing rules are stable.

## Phase 6: Refactor Route And Provider Boundaries

Purpose:
make route payloads and connector payloads explicit and extensible

Changes:

- add request-response schemas for route payloads
- add typed `json` helpers for tests
- add explicit provider query parameter types instead of `Record<string, any>`
- narrow connector client interfaces in:
  [packages/workgraph/src/connectors/github/github.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/connectors/github/github.ts)
  [packages/workgraph/src/connectors/linear/linear.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/connectors/linear/linear.ts)
  [packages/workgraph/src/providers.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/providers.ts)

Decision:

Connectors should own normalization, not raw provider payloads, and routes should own validated HTTP shapes, not `unknown`.

## Phase 7: Rebuild Test Typing On Top Of The New Contracts

Purpose:
move tests from compatibility hacks to typed helpers

Changes:

- replace raw `Database` test signatures with `SqliteDb` or a typed helper return
- add response parsing helpers for `app.request()` tests
- add small narrowing helpers for first-row assertions
- update outdated literals and fixtures

Primary files:

- [packages/workgraph/test/helpers/node-db.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/helpers/node-db.ts)
- [packages/workgraph/test/helpers/fake-db.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/helpers/fake-db.ts)
- [packages/workgraph/test/helpers/vitest-setup.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/helpers/vitest-setup.ts)
- [packages/workgraph/test/graph.test.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/graph.test.ts)
- [packages/workgraph/test/unit/graph-query.test.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/unit/graph-query.test.ts)
- [packages/workgraph/test/unit/run-store.test.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/unit/run-store.test.ts)

## Implementation Units

An implementer should break the work into these bounded units.

### Unit 1: Typecheck Baseline

Files:

- [packages/workgraph/package.json](/Users/yashvardhansingh/test/opencode/packages/workgraph/package.json)
- [packages/workgraph/tsconfig.json](/Users/yashvardhansingh/test/opencode/packages/workgraph/tsconfig.json)
- [packages/workgraph/tsconfig.src.json](/Users/yashvardhansingh/test/opencode/packages/workgraph/tsconfig.src.json)
- [packages/workgraph/tsconfig.test.json](/Users/yashvardhansingh/test/opencode/packages/workgraph/tsconfig.test.json)

Tests:

- source-only compile passes or has a sharply smaller, source-owned failure list
- test compile is preserved as a separate lane

### Unit 2: DB Port Unification

Files:

- [packages/workgraph/src/sqlite.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/sqlite.ts)
- [packages/workgraph/src/app.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/app.ts)
- [packages/workgraph/src/model/db.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/model/db.ts)
- [packages/workgraph/src/sdk/graph-query.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/sdk/graph-query.ts)
- [packages/workgraph/src/cli-runner.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/cli-runner.ts)
- [packages/workgraph/src/orchestrator/core/services/event-store-sqlite.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/orchestrator/core/services/event-store-sqlite.ts)

Tests:

- internal modules compile without raw `Database` mismatches
- DB-backed unit tests can use one helper shape consistently

### Unit 3: Canonical Contract Extraction

Files:

- [packages/workgraph/src/orchestrator/events/connector.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/orchestrator/events/connector.ts)
- [packages/workgraph/src/types/connectors.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/types/connectors.ts)
- [packages/workgraph/src/types/domain.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/types/domain.ts)
- [packages/workgraph/src/model/types.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/model/types.ts)

Tests:

- connector source files compile
- tests no longer import non-exported local symbols

### Unit 4: Persistence Codecs

Files:

- [packages/workgraph/src/codecs/db.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/codecs/db.ts)
- [packages/workgraph/src/model/db.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/model/db.ts)
- [packages/workgraph/src/sdk/runs.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/sdk/runs.ts)
- [packages/workgraph/src/sdk/execution-store.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/sdk/execution-store.ts)

Tests:

- row mapping functions have direct unit coverage
- naming drift errors disappear from source compile

### Unit 5: Route And Provider Typing

Files:

- [packages/workgraph/src/routes/triggers.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/routes/triggers.ts)
- [packages/workgraph/src/routes/graph.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/routes/graph.ts)
- [packages/workgraph/src/connectors/github/github.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/connectors/github/github.ts)
- [packages/workgraph/src/connectors/linear/linear.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/connectors/linear/linear.ts)
- [packages/workgraph/src/providers.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/src/providers.ts)

Tests:

- route tests parse typed bodies instead of touching `unknown`
- connector tests use canonical query mode unions

Prerequisite:

- Unit 5 starts only after the `zod` and narrowing fixes from Phase 5 are in place

### Unit 6: Test Infrastructure Cleanup

Files:

- [packages/workgraph/test/helpers/sqlite.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/helpers/sqlite.ts)
- [packages/workgraph/test/helpers/node-db.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/helpers/node-db.ts)
- [packages/workgraph/test/helpers/fake-db.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/helpers/fake-db.ts)
- [packages/workgraph/test/helpers/vitest-setup.ts](/Users/yashvardhansingh/test/opencode/packages/workgraph/test/helpers/vitest-setup.ts)

Tests:

- tests compile without relying on monkeypatched prototype methods for typing
- no raw `unknown` JSON assertions remain in route tests

## Test Strategy

Use this sequence during implementation:

1. `bun x tsc --noEmit -p tsconfig.src.json`
2. targeted unit tests for DB helpers, codecs, and schema guards
3. targeted route and connector tests
4. `bun x tsc --noEmit -p tsconfig.test.json`

Per the repo guidance, tests should run from [packages/workgraph](/Users/yashvardhansingh/test/opencode/packages/workgraph), not the repo root.

## Risks

### 1. Over-centralizing All Types Into One Giant File

That would reduce drift temporarily but make extension harder. Prefer several small owner modules instead.

### 2. Letting Row Shapes Become The Domain Shapes

That would make SQLite naming constraints leak everywhere and make later storage changes painful.

### 3. Repeating The Same Query Param Pattern As `Record<string, any>`

That will recreate connector drift the next time a provider mode changes.

### 4. Fixing Test Noise Before Source Ownership

That risks spending time on hundreds of downstream assertions before stabilizing the contracts they depend on.

## Success Criteria

The refactor is complete when all of the following are true:

- `packages/workgraph` has a stable `typecheck` command
- source compile failures are zero
- tests compile without prototype-patch typing hacks
- DB row shapes and domain shapes are separated cleanly
- connector query modes and issue contracts are exported from one owner
- route tests no longer operate on `unknown` JSON bodies
- adding a new provider, route, or store field requires changing one canonical type owner plus explicit boundary adapters

## Recommended Execution Order

If this work starts now, the highest-signal path is:

1. establish source-only typecheck lane
2. unify the DB port
3. extract canonical contract types
4. add persistence codecs
5. stabilize the schema substrate and strictness layer
6. repair route and provider boundaries
7. clean up tests on top of the new contracts
