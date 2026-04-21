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

It also adds a real query/cache layer for heavy, slow-changing backend reads and a backend data abstraction so the current HTTP/SDK path can later be replaced by a reactive database adapter without rewriting UI consumers.

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
- R4. Introduce a frontend data abstraction so UI code can swap HTTP/SDK reads for a reactive database or `tanstack/db` style source later.
- R5. Cloud new-session must show an explicit workspace startup gate before revealing the composer.
- R6. Local workspaces may skip the startup gate when runtime readiness is already implicit.
- R7. Session hydration must happen only for sessions the UI is actively rendering, not for every visible workspace.
- R8. Runner, provider, model, variant, draft, and related local UI state must be scoped to the relevant session or draft context, not a global singleton.
- R9. `global-sync` should be reduced to shell metadata only during migration and deleted if it no longer earns its keep.
- R10. Prefer adapting upstream structures behind thin Claxedo seams before introducing new permanent Claxedo-only state systems.

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

### 4. Cloud provisioning UI exists but is not the primary new-session gate

`packages/claxedo-app/src/components/dialog-create-cloud-workspace.tsx` already renders live provision logs for workspace creation. That gives us the right visual language for cloud runtime startup, but the startup gate still needs to become part of the regular pane/session flow instead of living only in create-workspace dialog logic.

## Architecture Decision

The frontend should move to five explicit client-side layers:

1. Query layer for read-mostly backend resources.
2. Backend data ports for shell/runtime/session operations.
3. Shell store for projects, workspaces, tabs, panes, focus, and layout.
4. Workspace runtime store keyed by workspace.
5. Session and preference stores keyed by active session or draft scope.

The key rule is:

Shell answers structure.
Runtime answers readiness.
Session answers conversation state.
Preferences answer execution choices.

No single store should answer all four.

Additional constraint:

- Prefer wrapping or narrowing existing upstream-derived structures before replacing them wholesale.
- New permanent Claxedo-only state systems should be introduced only where product requirements clearly exceed the upstream model.

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

Expected responsibilities:

- `ShellBackend`: list projects, list grouped sessions, list workspaces
- `WorkspaceRuntimeBackend`: resolve workspace, ensure runtime, subscribe to provision/runtime status
- `SessionBackend`: load one session, send prompt, load questions/permissions/todos/diffs for one session, subscribe to session events
- `PanePrefsBackend`: read and persist runner/provider/model scope data

Decision:

- UI code talks to ports, not directly to transport details.
- The first adapter is HTTP/SDK-backed.
- A later reactive adapter can satisfy the same interfaces.
- These ports should initially wrap existing upstream-derived behavior where possible rather than forcing immediate replacement of working code paths.

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

- action layer resolves and ensures workspace before normal session navigation
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
- new `packages/claxedo-app/src/cloud/runtime/workspace-startup-view.tsx`

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
- render startup gate for cloud new-session before composer
- move cloud `+ new session` to a pre-navigation guarded flow instead of immediate draft-route navigation
- implement the missing cloud session URL resolution hook expected by `directory-layout`
- do this with the smallest possible new permanent architecture, preferring wrapper seams around current code paths

Primary files:

- `packages/claxedo-app/src/overrides/app.tsx`
- `packages/claxedo-app/src/shared/query/*`
- `packages/claxedo-app/src/cloud/runtime/*`
- `packages/claxedo-app/src/claxedo-ui/claxedo-layout-actions/session-actions.tsx`
- `packages/claxedo-app/src/claxedo-ui/components/tab-page.tsx`
- `packages/claxedo-app/src/claxedo-ui/components/tab-content-area.tsx`
- `packages/claxedo-app/src/overrides/pages/directory-layout.tsx`
- `packages/claxedo-app/src/extensions/server.tsx`

Tests:

- `packages/claxedo-app/src/cloud/runtime/workspace-runtime-store.test.ts`
- `packages/claxedo-app/src/claxedo-ui/components/tab-page.integration.vitest.tsx`
- new integration coverage for clicking `+` on a cloud workspace row and asserting the first visible state is the startup gate, not the blank draft session shell
- regression coverage proving runtime-bound bootstrap requests stay suppressed until workspace readiness is satisfied
- regression coverage proving `resolveSessionUrl` is actually registered when cloud auto-switch is enabled

### Phase 2: Session hydration leaves global-sync

Goals:

- create session store/controller for one active session
- move message, todo, permission, question, diff, and usage hydration out of generic directory bootstrap
- adapt session pages and tab views to read from session controllers

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

## Execution Notes

- Prefer behavioral extraction before large directory moves.
- Keep compatibility barrels or wrapper providers while consumers migrate.
- Align new modules with the layer direction in `docs/brainstorms/2026-04-10-claxedo-app-layer-boundaries.md`.
- Do not adopt `tanstack/db` directly in phase 1. Land ports and query discipline first so the later adapter swap is incremental.
- Prefer adapting upstream structures behind thin Claxedo seams before introducing new permanent Claxedo-only state systems.

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
