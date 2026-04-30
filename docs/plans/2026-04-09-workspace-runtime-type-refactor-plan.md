---
date: 2026-04-09
topic: workspace-runtime-type-refactor
status: active
origin: chat
---

# Workspace Runtime Type Refactor Plan

## Goal

Group and remove the current `workspace-runtime` typecheck failures, then refactor the package toward a single, runtime-owned type architecture that is scalable, reusable, modular, and safe to extend.

This plan covers:

- current TypeScript compiler failures in `packages/workspace-runtime`
- the broader type drift that caused them
- a complete refactor direction for runtime-owned types
- sequencing, file targets, and tests

This plan does not cover:

- upstream `opencode` app-wide contract changes outside `workspace-runtime`
- broad product behavior changes
- switching the package to a new runtime model or new agent backend

## Current Facts

Running `bun typecheck` in [packages/workspace-runtime](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime) currently fails with three errors:

1. [packages/workspace-runtime/src/adapters/acp.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/acp.ts) emits `status: { type: "recovering" }` into a status type that currently excludes `"recovering"`.
2. [packages/workspace-runtime/src/adapters/translate-chunk-to-event.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/translate-chunk-to-event.ts) performs the same emission and hits the same mismatch.
3. [packages/workspace-runtime/src/adapters/translate-event-to-chunk.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/translate-event-to-chunk.ts) assumes `"recovering"` is a valid compat status even though the imported event union no longer includes it.

The compiler surface is small, but the underlying design issue is larger: status and session-related types are defined in multiple places and no longer share a single source of truth.

## Requirements

From the user request, this plan must satisfy two outcomes:

1. Group `workspace-runtime` type errors into real categories so fixes land at the right seam instead of papering over local failures.
2. Define an architectural path for a full type refactor that is reusable, modular, extendable, and realistic for a growing multi-adapter runtime.

## Local Pattern To Follow

The strongest existing local pattern is the process subsystem:

- [packages/workspace-runtime/src/process/process.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/process/process.ts)

That file already uses:

- zod schemas as the source of truth
- inferred TypeScript types from those schemas
- a compact domain-focused module instead of scattered unions

That is the right model for runtime-owned types.

## Problem Frame

`workspace-runtime` currently mixes four different type sources:

1. upstream OpenCode SDK types in [packages/workspace-runtime/src/compat-events.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/compat-events.ts)
2. ACP SDK types in adapter files under [packages/workspace-runtime/src/adapters](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters)
3. runtime-local unions in [packages/workspace-runtime/src/adapters/index.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/index.ts) and [packages/workspace-runtime/src/routes/config.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/config.ts)
4. stringly-typed persisted rows and `unknown` parsing in [packages/workspace-runtime/src/store.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/store.ts) and several route files

Those layers are not clearly separated. The same concept often exists in three forms:

- raw external wire shape
- runtime-local shape
- persisted shape

Without explicit codecs between them, drift accumulates and the compiler only catches the parts that still happen to be typed.

## Canonical Contract Matrix

Before implementation starts, treat this matrix as the contract of record.

### Session status

- Authoritative runtime owner:
  `workspace-runtime` local domain model
- Canonical in-memory shape:
  runtime-owned status types in `src/types/status.ts`
- Persisted form:
  runtime-owned store row codec in `src/codecs/store.ts`
- External protocol form:
  projected into OpenCode compat events and UI chunks through dedicated status projectors
- Notes:
  upstream SDK `SessionStatus` is an input/output boundary type, not the runtime source of truth for recovery semantics

### Runner

- Authoritative runtime owner:
  `workspace-runtime` local domain model
- Canonical in-memory shape:
  runtime-owned runner types in `src/types/runner.ts`
- Persisted form:
  store row codec
- External protocol form:
  HTTP config payloads and adapter-selection inputs
- Notes:
  `RuntimeRunner` and `SessionRunner` should become projections or aliases of the same canonical runtime type, not peer definitions

### Session summary and session config

- Authoritative runtime owner:
  `workspace-runtime` local domain model
- Canonical in-memory shape:
  runtime-owned session types in `src/types/session.ts`
- Persisted form:
  store row codec
- External protocol form:
  adapter returns and route responses
- Notes:
  routes and adapters should exchange canonical runtime session shapes, then project to wire formats only at the edge

### Message and part data

- Authoritative runtime owner:
  upstream OpenCode SDK-compatible message/part model
- Canonical in-memory shape:
  existing compat/OpenCode message structures already used by persistence and replay
- Persisted form:
  store codecs over the existing message/part JSON representation
- External protocol form:
  unchanged OpenCode-compatible events and route payloads
- Notes:
  this refactor should not invent a second bespoke message schema unless a concrete compiler or behavior problem requires it

### Permission and question data

- Authoritative runtime owner:
  `workspace-runtime` local domain model, shaped to current route and persistence needs
- Canonical in-memory shape:
  runtime-owned types under `src/types`
- Persisted form:
  store row codec
- External protocol form:
  compat events and route payloads
- Notes:
  keep these narrower than messages because they are already runtime-owned and not stable upstream contracts

## Error Groups

The current and near-future type failures in `workspace-runtime` should be grouped into these buckets.

### 1. Status Union Drift

This is the active compiler failure.

Files:

- [packages/workspace-runtime/src/adapters/acp.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/acp.ts)
- [packages/workspace-runtime/src/adapters/translate-chunk-to-event.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/translate-chunk-to-event.ts)
- [packages/workspace-runtime/src/adapters/translate-event-to-chunk.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/translate-event-to-chunk.ts)
- [packages/workspace-runtime/src/routes/session-status-snapshot.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/session-status-snapshot.ts)
- [packages/workspace-runtime/src/store.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/store.ts)

Symptoms:

- runtime persists `"recovering"`
- UI chunk types accept `"recovering"`
- snapshot projection intentionally hides `"recovering"`
- imported SDK `SessionStatus` no longer includes `"recovering"`

This is not a one-file bug. It is a modeling split between:

- live protocol status
- persisted local recovery marker
- UI transport status

### 2. Duplicated Domain Types

Files:

- [packages/workspace-runtime/src/adapters/index.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/index.ts)
- [packages/workspace-runtime/src/routes/config.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/config.ts)
- [packages/workspace-runtime/src/store.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/store.ts)

Examples:

- `SessionRunner` and `RuntimeRunner` duplicate the same union
- session status appears as SDK type, local chunk union, DB string, and recovery-specific branch logic
- todo and message payloads fall back to loose `string` and `unknown` shapes

This group will keep creating errors unless the canonical definitions move to one shared runtime module.

### 3. Untyped Persistence Boundary

Files:

- [packages/workspace-runtime/src/store.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/store.ts)

Symptoms:

- many row shapes use `status: string | null` and `runner_type: string | null`
- event/message/part data is repeatedly cast as `Record<string, unknown>`
- domain objects are reconstructed from rows without validation

This is the biggest source of silent drift because it bypasses the compiler.

### 4. Adapter Contract Erasure

Files:

- [packages/workspace-runtime/src/adapters/index.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/index.ts)
- [packages/workspace-runtime/src/adapters/acp.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/acp.ts)
- [packages/workspace-runtime/src/routes/session-core.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/session-core.ts)

Symptoms:

- `AgentAdapter` returns `unknown[]`, `unknown | null`, and loosely typed session/message payloads
- routes normalize those payloads ad hoc
- adapters own both transport logic and shape recovery logic

This makes it difficult to add new backends safely because every new adapter can invent its own shape.

### 5. Repeated Ad Hoc Parsing

Files:

- [packages/workspace-runtime/src/store.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/store.ts)
- [packages/workspace-runtime/src/routes/session-core.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/session-core.ts)
- [packages/workspace-runtime/src/routes/session-status-snapshot.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/session-status-snapshot.ts)
- [packages/workspace-runtime/src/mcp-resolver.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/mcp-resolver.ts)

Symptoms:

- repeated `rec`, `str`, `num`, `nullable`, `asRecord` helpers
- repeated `JSON.parse(...) as ...`
- similar normalization logic lives in unrelated files

This is the right place for small shared codecs, not more scattered helpers.

## Locked Architectural Direction

The refactor should standardize `workspace-runtime` around four layers.

### 1. External Wire Types

These are imported or validated shapes from outside the package:

- OpenCode SDK event/session/message types
- ACP session update types
- HTTP request payloads
- SQLite row payloads

These should stay at package boundaries only.

### 2. Runtime Domain Types

Create a runtime-owned canonical model for concepts that the package actually owns:

- runner
- session lifecycle
- recovery state
- tool state
- todo entry
- config snapshot
- persisted session record

These runtime types should not be aliases sprinkled across unrelated files. They should live in a dedicated runtime domain module and be imported everywhere else.

### 3. Codecs and Projections

Every boundary crossing should use an explicit translation function:

- ACP update -> runtime domain
- runtime domain -> compat event
- compat event -> UI chunk
- DB row -> runtime domain
- runtime domain -> DB row
- HTTP body -> runtime domain

No file outside the codec layer should need to guess what a raw `unknown` payload means.

### 4. Render or Route Adapters

Routes and adapters should consume the runtime domain model, not recreate it.

That means:

- adapters become producers of canonical runtime events
- store becomes persistence for canonical runtime records
- routes become thin formatters/projectors

## Dependency Rules

These rules make the modularity goal enforceable.

Allowed directions:

- `src/types/*` may depend on zod and other leaf utilities, but not on routes, store, or adapters
- `src/codecs/*` may depend on `src/types/*` and external SDK boundary types
- `src/store.ts` may depend on `src/types/*` and `src/codecs/*`
- `src/adapters/*` may depend on `src/types/*` and `src/codecs/*`
- `src/routes/*` may depend on `src/types/*` and `src/codecs/*`
- `src/server.ts` may depend on all of the above as composition root

Disallowed directions:

- `src/types/*` must not import from `src/routes/*`, `src/adapters/*`, `src/store.ts`, or `src/server.ts`
- routes must not define new domain unions that duplicate `src/types/*`
- adapters must not bypass codecs when crossing persistence or external wire boundaries
- store must not expose anonymous row bags or `Record<string, unknown>` to callers once codecs exist

Enforcement guidance:

- keep all new canonical unions in `src/types/*`
- if a route or adapter needs a one-off shape, define it as a projection type near the projector, not as a competing domain type
- during review, reject any new import that points from `src/types/*` upward into runtime orchestration code

## Proposed Module Shape

Keep the module tree small and explicit. Do not create a generic type jungle.

Recommended new area:

- [packages/workspace-runtime/src/types](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/types)

Recommended first files:

- [packages/workspace-runtime/src/types/status.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/types/status.ts)
- [packages/workspace-runtime/src/types/runner.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/types/runner.ts)
- [packages/workspace-runtime/src/types/session.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/types/session.ts)
- [packages/workspace-runtime/src/types/todo.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/types/todo.ts)
- [packages/workspace-runtime/src/types/config.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/types/config.ts)
- [packages/workspace-runtime/src/types/store.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/types/store.ts)

Recommended supporting boundary area:

- [packages/workspace-runtime/src/codecs](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/codecs)

Recommended first files:

- [packages/workspace-runtime/src/codecs/session-status.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/codecs/session-status.ts)
- [packages/workspace-runtime/src/codecs/runner.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/codecs/runner.ts)
- [packages/workspace-runtime/src/codecs/store.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/codecs/store.ts)
- [packages/workspace-runtime/src/codecs/compat.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/codecs/compat.ts)

Rule: domain modules define shapes; codec modules translate shapes.

## Key Design Decisions

### A. Separate Live Session Status From Recovery Marker

Do not keep treating `"recovering"` as just another peer of `"busy"` and `"idle"` everywhere.

Use two concepts:

- `LiveStatus`
  Values that represent protocol-visible session activity, such as `idle`, `busy`, `retry`, and `error`
- `RecoveryState`
  Local runtime state that explains why a session is currently degraded, such as `process_restart`

Then define one small projector for each consumer:

- compat session status projection
- UI chunk projection
- snapshot projection
- store projection

This avoids the current conflict where one layer wants `"recovering"` visible and another intentionally suppresses it.

### B. Runtime Owns Runner Types

Unify runner definitions in one place and import them into:

- [packages/workspace-runtime/src/adapters/index.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/index.ts)
- [packages/workspace-runtime/src/routes/config.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/config.ts)
- [packages/workspace-runtime/src/store.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/store.ts)
- [packages/workspace-runtime/src/server.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/server.ts)

The same zod-backed runner type should define:

- request validation
- persisted values
- adapter selection inputs

### C. Store Rows Need First-Class Types

`store.ts` should stop treating database output as anonymous bags.

Introduce typed row schemas for:

- session row
- message row
- part row
- todo row
- permission row
- question row

Each row gets:

- a row schema
- a row -> domain mapper
- a domain -> row writer input

This is the highest-leverage scalable change after the status split.

### D. Adapters Should Return Canonical Runtime Shapes

Refactor `AgentAdapter` away from broad `unknown` returns.

Target contract:

- `listSessions(): Promise<RuntimeSessionSummary[]>`
- `getSession(): Promise<RuntimeSession | null>`
- `getMessages(): Promise<RuntimeMessage[]>`
- `listPermissions(): Promise<RuntimePermission[]>`
- `listQuestions(): Promise<RuntimeQuestion[]>`

Do not do this as a single big-bang change. Introduce the runtime types first, then narrow adapter methods one family at a time.

Important boundary decision:

- messages and parts should remain OpenCode-compatible canonical data inside `workspace-runtime` for now
- session, runner, permission, question, todo, and recovery concepts should become runtime-owned canonical data
- if later work proves message/part modeling itself is the source of drift, that should be a separate follow-up decision with fresh evidence, not bundled into this refactor by default

### E. Prefer Small zod Schemas Over Clever Type Utilities

This repo already succeeds with schema-first modeling in the process subsystem. Reuse that approach.

Avoid:

- deep conditional utility types
- generic normalization helpers that hide behavior
- type-level abstractions with no runtime validation

Prefer:

- plain schemas
- inferred types
- small explicit mapper functions
- exhaustive `switch` statements with `never` checks

## Workstreams

### 1. Triage and Stabilize the Active Compiler Break

Goal:

- stop the current typecheck failure in a way that matches the long-term model

Files:

- [packages/workspace-runtime/src/adapters/acp.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/acp.ts)
- [packages/workspace-runtime/src/adapters/translate-chunk-to-event.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/translate-chunk-to-event.ts)
- [packages/workspace-runtime/src/adapters/translate-event-to-chunk.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/translate-event-to-chunk.ts)
- [packages/workspace-runtime/src/routes/session-status-snapshot.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/session-status-snapshot.ts)

Implementation direction:

- introduce a runtime-owned status module before touching logic
- define whether `"recovering"` is:
  a persisted local marker only
  or a first-class projected UI status derived from local recovery state
- update all three translators to depend on that decision instead of inline string unions

Test scenarios:

- ACP restart produces a recovery marker without failing typecheck
- compat event -> chunk translation preserves the intended UI recovery behavior
- session snapshot continues to hide non-live recovery markers if that remains product intent

### 2. Unify Runner and Session Domain Types

Goal:

- remove duplicated runtime definitions

Files:

- [packages/workspace-runtime/src/adapters/index.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/index.ts)
- [packages/workspace-runtime/src/routes/config.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/config.ts)
- [packages/workspace-runtime/src/server.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/server.ts)
- new files under [packages/workspace-runtime/src/types](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/types)

Implementation direction:

- move runner/session/todo/config definitions into runtime-owned modules
- make route request validation use those modules directly
- make adapters import those modules instead of redefining literals

Test scenarios:

- invalid runner types fail validation at config ingress
- adapter creation accepts only the canonical runner union
- session config read/update roundtrips keep the same runner model

### 3. Type the Persistence Boundary

Goal:

- make store drift visible to the compiler

Files:

- [packages/workspace-runtime/src/store.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/store.ts)
- new codecs under [packages/workspace-runtime/src/codecs](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/codecs)

Implementation direction:

- extract row schemas and row mappers
- replace stringly row casts with typed decoding
- isolate JSON serialization and parsing in a narrow persistence codec layer
- use lenient-read and strict-write behavior during migration:
  old or partial persisted rows should decode through compatibility mappers where safe
  newly written rows must always conform to the canonical runtime/store codecs

Test scenarios:

- session row with recovery marker decodes to the expected domain object
- stored runner data roundtrips through read and write helpers
- message and part persistence survive replay without `Record<string, unknown>` casts in calling code
- existing persisted rows from before the refactor continue to read successfully or fail with a deliberate, observable fallback path

### 4. Narrow the Adapter Interface

Goal:

- stop leaking `unknown` into routes and store consumers

Files:

- [packages/workspace-runtime/src/adapters/index.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/index.ts)
- [packages/workspace-runtime/src/adapters/acp.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/acp.ts)
- [packages/workspace-runtime/src/adapters/opencode.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/opencode.ts)
- [packages/workspace-runtime/src/routes/session-core.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/session-core.ts)

Implementation direction:

- define canonical runtime return types
- migrate low-risk methods first:
  `listSessions`
  `getSession`
  `getTodos`
- migrate message and permission/question methods next
- delete route-level shape recovery once each method is narrowed

Test scenarios:

- routes no longer need to coerce adapter output through ad hoc normalization
- both ACP and OpenCode adapters satisfy the same typed contract
- adapter additions require explicit implementation of every canonical method

### 5. Consolidate Parsing Helpers Into Small Codecs

Goal:

- eliminate repeated `rec` and `asRecord` parsing patterns

Files:

- [packages/workspace-runtime/src/store.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/store.ts)
- [packages/workspace-runtime/src/routes/session-core.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/session-core.ts)
- [packages/workspace-runtime/src/routes/session-status-snapshot.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/session-status-snapshot.ts)
- [packages/workspace-runtime/src/mcp-resolver.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/mcp-resolver.ts)

Implementation direction:

- extract a few shared codecs only where multiple files truly share semantics
- keep each codec focused on one domain shape
- do not build a global “parse utils” dumping ground

Test scenarios:

- malformed JSON input fails or falls back consistently at each boundary
- route normalization behaves identically before and after extraction

## Execution Order

Do the refactor in this order:

1. Introduce runtime-owned type modules for status and runner.
2. Fix the active `"recovering"` drift using the new status module.
3. Move config and adapter unions onto canonical runtime types.
4. Extract store row schemas and persistence codecs.
5. Narrow adapter return types one method family at a time.
6. Delete redundant route-level normalization and scattered parsing helpers.
7. Add type-only and runtime tests that lock the new shape.

This order keeps the changes reviewable and prevents a large multi-file migration from hiding behavioral regressions.

## Checkpoints

Add an explicit pause after the first two stages.

### Checkpoint A: After status and runner unification

Proceed to the store and adapter-wide refactor only if these conditions are true:

- `bun typecheck` is green in `packages/workspace-runtime`
- the `"recovering"` drift is resolved through the new status module rather than local casts
- runner duplication is removed between config, adapter selection, and persistence-facing code
- at least one translator test and one snapshot/store-facing test prove the new status contract

If those conditions are not met, keep the next slice focused on stabilization rather than expanding the architecture.

### Checkpoint B: After store codecs land

Proceed to broad adapter-interface narrowing only if these conditions are true:

- existing persisted session rows still replay or resume correctly under the compatibility policy
- route code is measurably simpler in the touched areas
- the new codecs reduced, rather than redistributed, `unknown` and `Record<string, unknown>` usage

If the evidence is weak, stop after the persistence boundary cleanup and reassess whether deeper adapter narrowing still pays for itself.

## Test Plan

Run package-local checks from [packages/workspace-runtime](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime):

- `bun typecheck`
- `bun test`

Add or expand tests in:

- [packages/workspace-runtime/src/adapters/translate-event-to-chunk.test.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/translate-event-to-chunk.test.ts)
- [packages/workspace-runtime/src/adapters/translate-chunk-to-event.test.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/translate-chunk-to-event.test.ts)
- [packages/workspace-runtime/src/routes/session-status-snapshot.test.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/session-status-snapshot.test.ts)
- [packages/workspace-runtime/src/store.test.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/store.test.ts)
- a dedicated type-assertion config such as `tsconfig.contracts.json` plus included guard files like `src/types/status.contract.ts`

Note:

- do not rely on `*.typecheck.ts` under the current package config, because `tsconfig.json` excludes that pattern
- either add a dedicated include-only contract tsconfig or use a file naming pattern that the package typecheck actually includes

Required coverage:

- session status projection from runtime domain to compat events
- session status projection from compat events to UI chunks
- persisted recovery marker visibility rules
- runner validation at config ingress
- session and message store roundtrips
- adapter contract compliance for ACP and OpenCode

## Risks

- If the refactor tries to type every route and adapter at once, it will create a large noisy diff with weak reviewability.
- If `"recovering"` remains both a live UI status and a persisted storage marker without separation, this drift will reappear.
- If store row decoding remains stringly typed, the package may compile while still carrying invalid runtime states.
- If adapters keep returning `unknown`, the route layer will continue rebuilding types ad hoc and erase refactor value.

## Definition Of Done

This refactor is done when:

- `workspace-runtime` typecheck passes without special-case casts for the current status drift
- runner, session, and status definitions each have one runtime-owned source of truth
- store row decoding uses explicit schemas or typed codecs
- adapter interfaces no longer expose broad `unknown` payloads for core session/message flows
- routes mostly project canonical domain objects instead of reconstructing them
- new adapter or session-state additions require touching one obvious canonical type module and a small set of codecs

## Recommended First Slice

The best first implementation slice is:

1. add `src/types/status.ts`
2. define `LiveStatus`, `RecoveryState`, and the projection helpers
3. migrate the three failing files plus `session-status-snapshot.ts`
4. add focused translator tests
5. rerun `bun typecheck`

That slice is small enough to land safely, but it forces the package onto the right architectural path instead of adding another local union tweak.
