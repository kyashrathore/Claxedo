---
title: "frontend: Multi-Session Frontend State Refactor"
type: frontend
status: active
date: 2026-04-13
origin: chat
---

# frontend: Multi-Session Frontend State Refactor

## Summary

Claxedo's frontend should stop treating the app like one bootstrapped workspace with one active session. The current Claxedo fork already supports multi-pane layout, multiple workspaces, cloud runtimes, and per-runner session config, but the main state path still inherits the upstream OpenCode center of gravity:

- bootstrap one directory store
- eagerly hydrate many unrelated concerns together
- let session/runtime state leak into shell state
- treat cloud readiness as a variation inside bootstrap instead of a first-class product state

The refactor in this plan re-centers the frontend around multi-session frontend state with four explicit client domains:

1. shell store
2. workspace runtime store
3. session store
4. pane preferences store

It also adds a real query/cache layer for heavy, slow-changing backend reads and a backend data abstraction so durable frontend reads can move onto a reactive database-backed sync path without rewriting UI consumers. Query cache remains useful for expensive request/response resources, but durable session/workspace/message state should sit behind a stable abstraction now so a reactive source can be turned on as soon as we want instead of requiring another UI-facing refactor later.

## Problem Frame

The current frontend architecture is functionally rich but conceptually overloaded.

Repo evidence:

- `packages/claxedo-app/src/overrides/context/global-sync/types.ts` defines one per-directory `State` that mixes agents, commands, config, provider list, sessions, session status, diffs, todos, permissions, questions, MCP, LSP, VCS, messages, parts, and usage.
- `packages/claxedo-app/src/overrides/context/global-sync/bootstrap.ts` still performs a generic bootstrap pass that fetches provider, agent, path, commands, session status, sessions, MCP, LSP, VCS, permissions, and questions together for a directory.
- `packages/claxedo-app/src/claxedo-ui/ClaxedoLayout.tsx` reads active session title and badge straight from `globalSync.child(workspaceId).session`, so layout concerns still depend on a workspace-global session cache.
- `packages/claxedo-app/src/claxedo-ui/context/acp-config.ts` already has draft/session scoping for runner and model via `acpScope(...)`, which proves session-scoped preferences are the right direction but not yet the main frontend model.
- `packages/claxedo-app/src/overrides/app.tsx` already installs `QueryClientProvider`, but the app barely uses TanStack Query. Most expensive reads still live in manual bootstrap and ad hoc caches.

Concrete regression evidence:

- `docs/bug-reports/2026-04-13-cloud-new-session-bootstrap-regression.md` shows the exact failure mode this refactor is meant to prevent: cloud `+ new session` enters the normal draft session route too early, starts the usual bootstrap fan-out, and misses the intended pre-navigation runtime gate.

This leaves Claxedo with the wrong mental model for the product we actually want:

- multiple sessions visible at once
- multiple workspaces alive at once
- each pane able to use a different runner
- each pane able to use a different provider/model
- cloud workspaces with explicit runtime startup states

## Requirements Traceability

This plan directly carries forward the requested frontend direction:

- R1. Treat Claxedo as a multi-workspace, multi-session frontend, not "OpenCode with extra tabs".
- R2. Split shell metadata from workspace runtime state, session state, and session/draft-scoped preferences.
- R3. Add SWR-style caching for heavy, mostly-static reads such as project list and provider list.
- R4. Put durable frontend state behind a frontend data abstraction so reactive database-backed sync can be enabled quickly without rewriting UI consumers.
- R5. Cloud new-session must show an explicit workspace startup gate before revealing the composer.
- R6. Local workspaces may skip the startup gate when runtime readiness is already implicit.
- R7. Session hydration must happen only for sessions the UI is actively rendering, not for every visible workspace.
- R8. Runner, provider, model, variant, draft, and related local UI state must be scoped to the relevant session or draft context, not a global singleton.
- R9. `global-sync` should be reduced to shell metadata only during migration and deleted if it no longer earns its keep.
- R10. Prefer adapting upstream structures behind thin Claxedo seams before introducing new permanent Claxedo-only state systems.
- R11. Prefer using `opencode` components from `packages/app` and `packages/ui` through wrappers/extensions before adding new copied overrides or Claxedo-only replacements.

## Non-Goals

- Rewriting the entire Claxedo shell in one pass.
- Replacing existing message/event transport with database polling.
- Solving final `tanstack/db` adoption in this refactor.
- Eliminating every override in the same milestone.
- Moving all current directories into `src/shell` and `src/cloud` before behavior changes are proven.

## Existing Ground Truth In Code

### 1. Session-scoped preferences are already partially real

`packages/claxedo-app/src/claxedo-ui/context/acp-config.ts` already scopes runner/model selection by `draft:<directory>:<tabId>` or `session:<directory>:<sessionId>`.

That means the product direction is not speculative. We already have a working proof that Claxedo wants session/draft-scoped preferences more than workspace-global defaults.

### 2. Global bootstrap is still the main hydration path

`packages/claxedo-app/src/overrides/context/global-sync/bootstrap.ts` is still the central fan-out point for both shell and session-adjacent data. Even with the cloud pending fast path, it still treats readiness, providers, commands, statuses, questions, and permissions as one generalized bootstrap concern.

### 3. Query infrastructure exists but is underused

`packages/claxedo-app/src/overrides/app.tsx` already creates a `QueryClient` with long GC settings and `QueryClientProvider`. This is the right foundation for heavy, infrequently changing lists, but it is not yet the default data path.

### 4. Cloud startup gating is partially landed, but not runtime-owned yet

`packages/claxedo-app/src/claxedo-ui/claxedo-layout-actions/session-actions.tsx` now routes cloud `+ new session` clicks into a guarded "Preparing workspace..." path, `packages/claxedo-app/src/overrides/pages/session.tsx` renders `CloudStartupView` before the composer, and `packages/claxedo-app/src/overrides/context/global-sync/bootstrap.ts` already suppresses the full bootstrap fan-out while a cloud workspace is still pending.

That is real progress, and it means the blank draft-session shell regression is no longer the whole story. But readiness, logs, and failure presentation are still coordinated through page-local logic and ad hoc workspace resolve calls rather than a dedicated workspace runtime store. The gate exists; the ownership model behind it is still incomplete.

### 5. Durable message reads already come from central persisted state

Claxedo's frontend does not need to invent a new durable history model. The backend sync docs already establish the intended direction: durable session/message reads belong to the central synced store, while live runtime transport remains a separate concern.

- `docs/sync-architecture.md` describes the current replay-first message read path and the live event fan-in through central aggregation.
- `docs/sync-architecture-target.md` defines the target source of truth: central metadata ownership for message history, with runtime streams remaining real-time transport rather than canonical persistence.

Frontend work should build on that split:

- reactive DB / synced store for durable session, workspace, and message reads
- live host/runtime channels for readiness, execution, and transient interactivity

## Architecture Decision

The frontend should move to five explicit client-side layers:

1. Query layer for read-mostly request/response backend resources.
2. Backend data ports for shell/runtime/session operations.
3. Durable read abstraction for app data that may later be powered by reactive sync.
4. Shell store for projects, workspaces, tabs, panes, focus, and layout.
5. Workspace runtime store plus session/preference stores keyed by workspace, active session, or draft scope.

The key rule is:

Shell answers structure.
Runtime answers readiness and live connectivity.
Session answers conversation state.
Preferences answer execution choices.

No single store should answer all four.

Additional constraint:

- Prefer wrapping or narrowing existing upstream-derived structures before replacing them wholesale.
- New permanent Claxedo-only state systems should be introduced only where product requirements clearly exceed the upstream model.
- Reactive DB support is a product requirement, not a stretch goal, but the UI should depend on an abstraction for durable reads rather than on a specific reactive implementation.

## Target Model

### 1. Query Layer

Use TanStack Solid Query for backend reads that are:

- expensive relative to UI render cadence
- mostly static
- naturally shared across views
- not the primary owner of optimistic session state

Initial query candidates:

- project list
- provider list
- workspace provider auth status
- workspace resolve snapshots
- runner option snapshots for draft scopes

Recommended target files:

- `packages/claxedo-app/src/shared/query/query-client.ts`
- `packages/claxedo-app/src/shared/query/keys.ts`
- `packages/claxedo-app/src/shared/query/shell.ts`
- `packages/claxedo-app/src/shared/query/runtime.ts`

Bridge points during migration:

- `packages/claxedo-app/src/overrides/app.tsx`
- `packages/claxedo-app/src/overrides/context/global-sync/bootstrap.ts`

Decision:

- Query owns cacheability and revalidation.
- Stores own user intent, optimistic state, and view-local derivation.

### 1a. Durable Read Abstraction

Add a durable read abstraction for state that should eventually update through sync rather than ad hoc bootstrap refreshes.

Target responsibilities:

- session lists and session summaries
- durable message history and message parts
- workspace metadata and resolve snapshots when backed by sync
- other central persisted state that benefits from push-based updates across panes/devices

Recommended target files:

- `packages/claxedo-app/src/shared/data/durable-state.ts`
- `packages/claxedo-app/src/shared/data/http-durable-state.ts`
- later `packages/claxedo-app/src/shared/data/reactive-durable-state.ts`

Decision:

- UI stores/controllers should depend on a durable-read interface, not directly on a reactive DB library.
- The first adapter may stay HTTP/SDK plus query-backed hydration where that is simplest.
- A reactive adapter should be able to replace or augment those reads without changing store consumers.
- Query remains appropriate for expensive request/response resources that do not need live synced semantics.
- Live runtime transports remain separate from durable sync; do not force transport streams through the reactive DB layer.

### 2. Backend Data Ports

Introduce explicit frontend data ports so stores/controllers stop reaching directly into `globalSDK`, raw fetches, or ad hoc route calls.

Recommended target files:

- `packages/claxedo-app/src/shared/data/backend.ts`
- `packages/claxedo-app/src/shared/data/http-backend.ts`
- `packages/claxedo-app/src/shared/data/types.ts`

Initial backend interfaces:

- `ShellBackend`
- `WorkspaceRuntimeBackend`
- `SessionBackend`
- `PanePrefsBackend`
- `DurableStateBackend`

Expected responsibilities:

- `ShellBackend`: list projects, list grouped sessions, list workspaces
- `WorkspaceRuntimeBackend`: resolve workspace, ensure runtime, subscribe to provision/runtime status
- `SessionBackend`: load one session, send prompt, load questions/permissions/todos/diffs for one session, subscribe to session events
- `PanePrefsBackend`: read and persist runner/provider/model scope data
- `DurableStateBackend`: read durable workspace/session/message state through a transport-agnostic interface

Decision:

- UI code talks to ports, not directly to transport details.
- The first adapter is HTTP/SDK-backed.
- A reactive adapter should be able to satisfy the same interfaces for durable reads.
- These ports should initially wrap existing upstream-derived behavior where possible rather than forcing immediate replacement of working code paths.

### 2a. Upstream Reuse Tiers

Not every upstream-derived frontend surface should be treated the same. Use three reuse tiers:

- Reuse as-is: presentational components and low-assumption UI pieces that already fit Claxedo's product direction.
- Wrap behind Claxedo ports/providers: hooks, contexts, and controllers that are still useful but currently assume upstream transport or bootstrap behavior.
- Replace: singleton/global client dependencies and any surface that prevents reactive DB-backed durable reads or multi-workspace state ownership.

This keeps the refactor aligned with R10. The goal is not premature replacement of upstream code; the goal is to be explicit about which surfaces are safe to keep, which should be wrapped, and which block the architecture we actually want.

### 2b. Upstream Component Reuse Strategy

The default frontend migration posture should be to reuse `opencode` components before building parallel Claxedo-owned UI.

Decision:

- Prefer direct use of `packages/ui/src/components/*` for presentational building blocks.
- Prefer wrapping/extending `packages/app/src/components/*` and `packages/app/src/pages/*` when provider topology or product behavior differs but the component contract is still useful.
- Treat copied overrides in `packages/claxedo-app/src/overrides/**` as a compatibility tool, not the default way to customize UI.
- When a Claxedo-specific screen needs upstream behavior plus product-specific state, introduce a wrapper/provider seam first and only copy the upstream file if extension points are insufficient.

Concrete exploration targets during migration:

- audit the override manifest in `packages/claxedo-app/src/overrides/README.md`
- identify which current Claxedo surfaces can switch from copied overrides to wrapped upstream imports
- prefer upstream component contracts in new work unless multi-pane or cloud-runtime requirements clearly force a Claxedo-only surface

### 3. Shell Store

Shell store should be fast, always-available, and ignorant of session message hydration.

Owns:

- projects
- workspaces visible in shell
- top tabs
- groups
- pane tree
- focus
- layout
- lightweight selection metadata

Does not own:

- messages
- permission requests
- question requests
- MCP/LSP runtime detail
- runtime readiness workflow

Recommended target files:

- `packages/claxedo-app/src/shell/store/shell-store.ts`
- `packages/claxedo-app/src/shell/store/shell-selectors.ts`
- `packages/claxedo-app/src/shell/store/shell-store.test.ts`

Primary migration sources:

- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/*`
- `packages/claxedo-app/src/overrides/context/layout.tsx`
- `packages/claxedo-app/src/overrides/context/global-sync.tsx`

### 4. Workspace Runtime Store

Own one state machine per workspace:

- `unknown`
- `resolving`
- `stopped`
- `ensuring`
- `ready`
- `failed`

Owns:

- workspace runtime readiness
- last resolve snapshot
- provision/startup logs
- wake/resume requests
- health summary
- gating signals for composer/session views

Recommended target files:

- `packages/claxedo-app/src/cloud/runtime/workspace-runtime-store.ts`
- `packages/claxedo-app/src/cloud/runtime/workspace-runtime-events.ts`
- `packages/claxedo-app/src/cloud/runtime/workspace-runtime-selectors.ts`
- `packages/claxedo-app/src/cloud/runtime/workspace-runtime-store.test.ts`

Primary migration sources:

- `packages/claxedo-app/src/components/dialog-create-cloud-workspace.tsx`
- `packages/claxedo-app/src/overrides/context/global-sync/bootstrap.ts`
- `packages/claxedo-app/src/claxedo-ui/components/workspace-sdk-provider.tsx`
- `packages/claxedo-server/src/routes/workspace.ts`

Decision:

- Runtime readiness is a first-class product surface.
- Cloud startup is not a "partial bootstrap" variant.

### 5. Session Store

Own one store/controller per actively rendered session.

Owns:

- messages
- parts
- optimistic sends
- diffs
- todos
- permission requests
- question requests
- per-session status and usage

Does not own:

- workspace runtime readiness
- project/workspace navigation
- cross-pane layout

Recommended target files:

- `packages/claxedo-app/src/session/store/session-store.ts`
- `packages/claxedo-app/src/session/store/session-controller.ts`
- `packages/claxedo-app/src/session/store/session-cache.ts`
- `packages/claxedo-app/src/session/store/session-store.test.ts`
- `packages/claxedo-app/src/session/store/session-controller.test.ts`

Primary migration sources:

- `packages/claxedo-app/src/overrides/context/global-sync/types.ts`
- `packages/claxedo-app/src/overrides/context/global-sync/bootstrap.ts`
- `packages/claxedo-app/src/overrides/context/global-sync.tsx`
- `packages/claxedo-app/src/overrides/pages/session.tsx`
- `packages/claxedo-app/src/overrides/pages/layout.tsx`

Decision:

- The UI hydrates only the sessions it shows.
- Other visible workspaces may remain shell-visible without pulling their full session state.

### 6. Preferences Store

Preferences should become an explicit store, not a side concern inside ACP config.

Owns:

- runner
- provider
- model
- variant
- composer draft
- review mode
- local UI mode for the current rendered context

Recommended target files:

- `packages/claxedo-app/src/pane/store/pane-preferences.ts`
- `packages/claxedo-app/src/pane/store/pane-preferences.test.ts`

Primary migration sources:

- `packages/claxedo-app/src/claxedo-ui/context/acp-config.ts`
- `packages/claxedo-app/src/claxedo-ui/components/agent-runner-selector.tsx`

Decision:

- Keep `session:` and `draft:` scoping semantics.
- Expand them into the canonical preferences layer instead of leaving them buried inside ACP configuration behavior.

## UX Changes

### Cloud new-session flow

For cloud workspaces, clicking new session should open a startup gate first:

- the user should enter a guarded startup pane immediately, not a blank composer shell
- runtime readiness ownership should move out of page-local logic into a workspace runtime store
- full-screen startup state inside the pane
- live provision or wake logs
- clear current phase
- no composer while runtime is not ready
- automatic reveal of composer once runtime becomes ready

Target UI files:

- `packages/claxedo-app/src/claxedo-ui/claxedo-layout-actions/session-actions.tsx`
- `packages/claxedo-app/src/claxedo-ui/components/tab-content-area.tsx`
- `packages/claxedo-app/src/claxedo-ui/components/tab-page.tsx`
- `packages/claxedo-app/src/claxedo-ui/components/multi-pane/floating-session-overlay.tsx`
- `packages/claxedo-app/src/overrides/pages/session.tsx`
- `packages/claxedo-app/src/overrides/components/session/cloud-startup-view.tsx`

Related transport file:

- `packages/claxedo-app/src/extensions/server.tsx`

Decision:

- The runtime gate should move earlier than the session page mount for cloud `+` entry paths.
- Route-level cloud gating may remain as a safety net, but it must stop being the first and only guard.
- Cloud session URL promotion must be an implemented extension contract, not a dead hook expected by `packages/claxedo-app/src/overrides/pages/directory-layout.tsx`.

### Local new-session flow

For local workspaces:

- runtime store may resolve immediately to `ready`
- startup gate is skipped
- composer opens directly

## What Must Be Removed Or Reduced

This refactor should aggressively stop using one generic bootstrap pass for:

- fetching agents, commands, provider lists, session status, sessions, questions, permissions, diffs, MCP, and LSP together for every mounted directory
- coupling workspace readiness to session readiness
- using one shared sync abstraction for both shell metadata and live session state
- treating provider/model as effectively global defaults during active multi-pane work

Target migration destination:

- `packages/claxedo-app/src/overrides/context/global-sync.tsx` becomes a compatibility wrapper over new stores and query adapters
- later, delete it or retain only a thin shell-metadata facade if upstream compatibility still needs the name

## Phased Implementation

### Phase 1: Query layer + runtime gate foundation

Goals:

- land shared query keys and query-backed readers for project list, provider list, and workspace resolve
- create workspace runtime store with explicit readiness states
- introduce the first durable-state abstraction with a non-reactive adapter so later reactive enablement is a backend swap, not a UI rewrite
- preserve the now-landed cloud startup gate and move its status/log ownership out of page-local session logic
- keep cloud `+ new session` on a guarded startup path and do not regress to the blank draft-session shell
- keep `directory-layout` and `extensions/server.tsx` aligned with the control-plane gateway contract; `resolveSessionUrl` should become non-null for workspace-hosted sessions that must switch away from `claxedo-server`, while central-hosted sessions should stay attached to `claxedo-server`
- audit the relevant upstream `packages/app` and `packages/ui` components before adding new Claxedo-only UI for the startup flow
- do this with the smallest possible new permanent architecture, preferring wrapper seams around current code paths and upstream component reuse where possible

Primary files:

- `packages/claxedo-app/src/overrides/app.tsx`
- `packages/claxedo-app/src/shared/query/*`
- `packages/claxedo-app/src/cloud/runtime/*`
- `packages/claxedo-app/src/claxedo-ui/claxedo-layout-actions/session-actions.tsx`
- `packages/claxedo-app/src/claxedo-ui/components/tab-page.tsx`
- `packages/claxedo-app/src/claxedo-ui/components/tab-content-area.tsx`
- `packages/claxedo-app/src/overrides/pages/session.tsx`
- `packages/claxedo-app/src/overrides/components/session/cloud-startup-view.tsx`
- `packages/claxedo-app/src/overrides/pages/directory-layout.tsx`
- `packages/claxedo-app/src/extensions/server.tsx`

Tests:

- `packages/claxedo-app/src/cloud/runtime/workspace-runtime-store.test.ts`
- `packages/claxedo-app/src/claxedo-ui/components/tab-page.integration.vitest.tsx`
- new integration coverage for clicking `+` on a cloud workspace row and asserting the first visible state is the startup gate, not the blank draft session shell
- regression coverage proving runtime-bound bootstrap requests stay suppressed until workspace readiness is satisfied
- regression coverage for the startup gate's phase rendering, ready-state timing, and human-readable error presentation

### Phase 2: Session hydration leaves global-sync

Goals:

- create session store/controller for one active session
- move message, todo, permission, question, diff, and usage hydration out of generic directory bootstrap
- adapt session pages and tab views to read from session controllers
- prefer consuming upstream session components through Claxedo wrappers before widening the override surface

Primary files:

- `packages/claxedo-app/src/session/store/*`
- `packages/claxedo-app/src/overrides/pages/session.tsx`
- `packages/claxedo-app/src/overrides/pages/layout.tsx`
- `packages/claxedo-app/src/overrides/context/global-sync/bootstrap.ts`

Tests:

- `packages/claxedo-app/src/session/store/session-store.test.ts`
- `packages/claxedo-app/src/session/store/session-controller.test.ts`
- `packages/claxedo-app/src/claxedo-ui/components/tab-page.integration.vitest.tsx`

### Phase 3: Pane preferences become first-class

Rename note:

- “pane preferences” here means the execution preferences needed by the currently rendered session or draft context. It does not mean every concern should be modeled as pane-owned state.

Goals:

- extract pane preferences from ACP config
- scope runner/provider/model/variant/draft/review mode to pane/session
- keep current `draft:` to `session:` promotion behavior

Primary files:

- `packages/claxedo-app/src/pane/store/*`
- `packages/claxedo-app/src/claxedo-ui/context/acp-config.ts`
- `packages/claxedo-app/src/claxedo-ui/components/agent-runner-selector.tsx`

Tests:

- `packages/claxedo-app/src/pane/store/pane-preferences.test.ts`
- `packages/claxedo-app/src/claxedo-ui/components/agent-runner-selector.vitest.tsx`

### Phase 4: Reduce global-sync to shell metadata

Goals:

- keep only shell-visible metadata in any remaining global sync facade
- remove directory bootstrap ownership of session/runtime concerns
- collapse `global-sync` into shell store adapters or delete it

Primary files:

- `packages/claxedo-app/src/overrides/context/global-sync.tsx`
- `packages/claxedo-app/src/overrides/context/global-sync/types.ts`
- `packages/claxedo-app/src/overrides/context/global-sync/bootstrap.ts`

Tests:

- `packages/claxedo-app/src/overrides/context/global-sync/bootstrap.test.ts`
- `packages/claxedo-app/src/claxedo-ui/layouts/workspace-bar.test.ts`
- `packages/claxedo-app/src/claxedo-ui/layouts/top-tab-bar.vitest.tsx`

### Phase 5: Introduce backend port abstraction

Goals:

- route stores/controllers through explicit backend interfaces
- keep HTTP/SDK as the first implementation
- prove that query/store consumers no longer depend on transport details

Primary files:

- `packages/claxedo-app/src/shared/data/*`
- adapters in shell/runtime/session/pane stores

Tests:

- `packages/claxedo-app/src/shared/data/http-backend.test.ts`
- targeted consumer tests for shell/runtime/session stores

## Key Risks

- `ClaxedoLayout.tsx` and the layout facade currently consume session-derived detail from `globalSync`, so migration order matters.
- `global-sync` also handles cache persistence and eviction, so removing it too early could regress restore behavior.
- Cloud and local workspaces share enough UI that runtime gating must not introduce a slower local path.
- ACP configuration already knows about draft/session scopes; extracting pane preferences must preserve that behavior rather than resetting user choices.
- It is easy to add indirection that feels architectural but does not actually reduce fork pain. Any new seam that does not reduce coupling or improve upstream portability should be rejected.
- It is easy to promise later reactive support while still baking reactive-library assumptions into stores. The abstraction only pays off if store APIs remain transport-agnostic.
- Upstream component reuse can fail if we keep designing new Claxedo state around copied component internals. Reuse has to shape the seam, not just be listed as a preference.

## Execution Notes

- Prefer behavioral extraction before large directory moves.
- Keep compatibility barrels or wrapper providers while consumers migrate.
- Align new modules with the layer direction in `docs/brainstorms/2026-04-10-claxedo-app-layer-boundaries.md`.
- Do not adopt `tanstack/db` directly in phase 1. Land the durable-state abstraction, ports, and query discipline first so the later adapter swap is incremental.
- Prefer adapting upstream structures behind thin Claxedo seams before introducing new permanent Claxedo-only state systems.
- For new UI in this refactor, start by checking `packages/app` and `packages/ui` for a reusable surface before adding a copied override or a new `claxedo-ui` component.

## Definition Of Done

This plan is complete when:

- cloud new-session is explicitly gated by workspace runtime readiness
- cloud `+ new session` no longer navigates into a misleading draft session shell before readiness is known
- project list and provider list use the shared query layer instead of bespoke bootstrap fetches
- only actively rendered sessions are hydrated
- runner/provider/model state is session/draft-scoped as a first-class store
- `global-sync` no longer acts as the catch-all owner for shell, runtime, and session state
- backend transport can be swapped behind explicit frontend data interfaces

## Regression Anchors

The following bug report should remain an explicit acceptance anchor for this work:

- `docs/bug-reports/2026-04-13-cloud-new-session-bootstrap-regression.md`

That report is not a side issue. It is a concrete example of why Claxedo cannot keep relying on route-reactive cloud gating plus generic global bootstrap. The refactor should be considered incomplete if that entry path can still regress.
