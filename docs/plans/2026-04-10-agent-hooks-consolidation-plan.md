---
title: "refactor: Consolidate Agent Hook Setup Ownership"
type: refactor
status: completed
date: 2026-04-10
deepened: 2026-04-10
---

# refactor: Consolidate Agent Hook Setup Ownership

## Overview

Consolidate the duplicated agent hook setup/template surface so there is one canonical owner for generated hook artifacts, wrapper scripts, shell integration, and terminal environment construction. Keep the Solid UI listener logic in the app, but move it out of the misleading `agent-hooks` setup namespace so the app no longer looks like it owns hook installation.

## Problem Frame

The repo currently has two agent-hook implementations with overlapping responsibilities:

- `packages/claxedo-app/src/agent-hooks/` contains app-side setup, constants, notify/shell/wrapper templates, and UI lifecycle listeners.
- `packages/workspace-runtime/src/agent-hooks/` contains a richer runtime/server implementation with core setup, templates, shell integration, external agent config upserts, opencode integration, MCP integration, and tests.

The active runtime flow already uses `workspace-runtime`: `packages/claxedo-server/src/agent-hooks.ts` re-exports it, `packages/claxedo-server/src/server.ts` calls `setupAgentHooks`, and `packages/workspace-runtime/src/pty/index.ts` injects `getTerminalEnvVars`. The app setup surface appears unused except for `listener.ts`, which is imported by `packages/claxedo-app/src/claxedo-ui/ClaxedoLayout.tsx`.

The consolidation goal is not to force browser-only UI code into the Node/runtime package. The goal is a clean ownership split:

- Runtime owns hook installation, wrapper generation, shell setup, and env construction.
- App owns visual tab/session status listeners.

The desired end state is that `packages/claxedo-app/src/agent-hooks/` no longer exists. Runtime hook setup should live under `packages/workspace-runtime/src/agent-hooks/`, while the app-side listener should live under an app UI/context path with a name that describes what it actually does.

## Requirements Trace

- R1. One canonical implementation for hook setup artifacts, wrappers, shell integration, and terminal environment variables.
- R2. Preserve existing UI behavior for terminal lifecycle status, session status, attention clearing, and PTY exit cleanup.
- R3. Preserve or intentionally resolve behavior parity for agents covered by the old app setup, especially `amp`, `aider`, `goose`, and `cline`.
- R4. Remove misleading or unused app-side setup files so future changes land in the runtime owner.
- R5. Keep browser app code free of Node-only runtime imports such as `fs`, `path`, `os`, and workspace-runtime server modules.
- R6. Keep tests grounded in existing package boundaries and avoid broad unrelated refactors.
- R7. Characterize lifecycle `Error` event handling before moving UI listener code so consolidation does not silently reinterpret terminal attention/error states.
- R8. Improve readability and scalability by separating runtime setup modules from UI status-listener modules, using names that reflect ownership and avoiding compatibility shims that preserve the misleading app-side setup namespace.

## Scope Boundaries

- Do not change the `/api/claxedo/hook/agent-lifecycle` route contract.
- Do not redesign lifecycle event semantics beyond parity gaps discovered during consolidation.
- Do not move Solid UI listeners into `workspace-runtime`; they depend on app layout state, settings, sound playback, and browser-facing providers.
- Do not rewrite the workspace-runtime agent-hooks architecture. Build on the current `core/` and `integrations/` structure.
- Do not revert existing uncommitted workspace-runtime agent-hooks work; implementation should integrate with the current working tree.
- Do not leave a compatibility barrel file at `packages/claxedo-app/src/agent-hooks/index.ts` or a renamed app-side `agent-hooks` setup namespace. If no production import needs the old setup surface, delete it.

## Context & Research

### Relevant Code and Patterns

- `packages/claxedo-app/src/agent-hooks/listener.ts`: app-only Solid hooks for agent lifecycle, session status, focus clearing, and PTY exit cleanup.
- `packages/claxedo-app/src/agent-hooks/listener.test.ts`: characterization coverage for PTY exit cleanup, server Idle events, interrupt cleanup, and recovery.
- `packages/claxedo-app/src/agent-hooks/index.ts`: unused app-side setup orchestration that writes `~/.claxedo` files with Node APIs.
- `packages/claxedo-app/src/agent-hooks/constants.ts`: old setup constants and agent list.
- `packages/claxedo-app/src/agent-hooks/templates/notify.ts`: old notify script generator.
- `packages/claxedo-app/src/agent-hooks/templates/shell.ts`: old shell integration generator.
- `packages/claxedo-app/src/agent-hooks/templates/wrappers.ts`: old wrapper generator.
- `packages/workspace-runtime/src/agent-hooks/setup.ts`: canonical runtime orchestration that wires status hooks, MCP setup, user config, and opencode integration.
- `packages/workspace-runtime/src/agent-hooks/core/setup.ts`: runtime artifact writer for notify scripts, hook bridges, wrappers, and shell files.
- `packages/workspace-runtime/src/agent-hooks/core/wrappers.ts`: runtime wrapper generator with shared wrapper composition.
- `packages/workspace-runtime/src/agent-hooks/core/shell.ts`: runtime terminal env and shell args owner.
- `packages/workspace-runtime/src/agent-hooks/core/hooks.ts`: runtime notify script and external agent config upserts.
- `packages/workspace-runtime/src/agent-hooks/wrappers.test.ts`, `packages/workspace-runtime/src/agent-hooks/shell.test.ts`, `packages/workspace-runtime/src/agent-hooks/core/setup.test.ts`: existing tests for runtime setup behavior.
- `packages/workspace-runtime/src/pty/index.ts`: runtime PTY env injection path.
- `packages/workspace-runtime/src/routes/agent-hook.ts`: setup/status/env HTTP route surface.
- `packages/claxedo-app/src/claxedo-ui/ClaxedoLayout.tsx`: app imports `useAgentHooks` from the current app agent-hooks listener.
- Runtime notify templates can emit `Error`, while the current app listener treats any non-`Busy`/`Idle` event as `permission`. The implementation should characterize and intentionally preserve or change this behavior instead of letting it drift during the move.

### Institutional Learnings

- No relevant `docs/solutions/` entry was found for agent hooks, terminal hooks, or workspace-runtime consolidation.

### External References

- Not used. Local repo patterns are sufficient for this consolidation.

## Key Technical Decisions

- Make `workspace-runtime/src/agent-hooks` the sole setup owner. It is already used by the server and PTY runtime, has richer behavior, and has tests for wrappers, shell integration, and setup artifacts.
- Keep UI listener code in `claxedo-app`, but rename or move it to a UI-status namespace. It is not hook setup and should not be confused with generated wrapper installation.
- Delete the app-side setup/template files after proving they are not imported. They use Node APIs and duplicate runtime behavior, so keeping them invites drift.
- Preserve old app generic-wrapper coverage where runtime does not have a stronger native integration. In particular, the old app setup treated `amp` as a generic Busy/Idle wrapper, while the current runtime setup writes `amp` as a passthrough shim and includes it in `SHIMMED_BINARIES`. Local scan did not find a native `amp` hook integration, so the implementation should preserve notification coverage by making `amp` generic, including the corresponding `SHIMMED_BINARIES`/custom-wrapper-filter change, or documenting a runtime-backed reason not to.
- Treat lifecycle `Error` events as an explicit compatibility decision. If current UI behavior is correct, add characterization coverage that proves `Error` still maps to the same terminal/tab state after the file move; if it is wrong, make the semantic change deliberately with app listener tests.
- Do not add an app dependency on `@opencode-ai/workspace-runtime`. The browser app should consume lifecycle events from providers and leave setup/env work to the server/runtime.
- Prefer a final app module name that describes UI state handling rather than hook installation, such as `agent-status-listener.ts`. This makes future work easier to place: generated hook artifacts go in runtime; tab/session rendering effects go in app UI context.
- Do not preserve the old app setup surface through re-exports. A compatibility re-export would keep the duplicate ownership signal alive and make future changes less predictable.

## Open Questions

### Resolved During Planning

- Should everything move into one physical directory? No. Runtime setup belongs in `workspace-runtime`; app UI lifecycle listeners belong in `claxedo-app` because they depend on Solid layout state and browser-only app providers.
- Is `claxedo-app/src/agent-hooks/index.ts` currently used? A repo search found no production imports of app-side `setupAgentHooks` or `getTerminalEnvVars`; the active setup imports come from `workspace-runtime`.
- Does workspace-runtime already have better hook infrastructure? Yes. It includes core setup, shared wrapper composition, template loading, external config upserts, shell-ready handling, env save/restore, MCP setup, opencode integration, and route-level setup/status/env APIs.

### Deferred to Implementation

- Exact destination name for the UI listener file: choose the smallest rename that makes ownership clear, such as `packages/claxedo-app/src/claxedo-ui/context/agent-status-listener.ts`.
- Whether `amp` should be moved from passthrough shim to generic wrapper or handled by a native hook path: implementation should inspect the latest runtime intent before editing, but default to preserving old notification coverage.
- Whether tests should be moved with `listener.ts` or left in place temporarily with updated imports: choose the least disruptive path after seeing the implementation diff. The preferred final state is that the test lives beside the renamed app listener so the old `agent-hooks` directory can be removed entirely.
- Whether `Error` lifecycle events should continue to surface as permission/attention state in the UI or receive a distinct state: characterize the current behavior first, then choose deliberately.

## High-Level Technical Design

> This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

```mermaid
flowchart LR
  PTY[workspace-runtime PTY spawn] --> Env[workspace-runtime getTerminalEnvVars]
  Setup[workspace-runtime setupAgentHooks] --> Artifacts[~/.claxedo hooks, wrappers, shell files]
  Artifacts --> AgentCLI[Agent CLI wrappers and native hooks]
  AgentCLI --> Route[/api/claxedo/hook/agent-lifecycle]
  Route --> Events[claxedo event bus]
  Events --> UI[claxedo-app agent status listener]
  UI --> Tabs[Claxedo layout tab indicators and sounds]
```

## Success Criteria

- `packages/claxedo-app/src/agent-hooks/` is removed after the listener move and setup/template deletion.
- No production import references app-side `setupAgentHooks`, `getTerminalEnvVars`, or `packages/claxedo-app/src/agent-hooks/templates/*`.
- Runtime setup continues to expose and use `setupAgentHooks`, `getTerminalEnvVars`, setup/status/env routes, and generated wrapper artifacts from `packages/workspace-runtime/src/agent-hooks`.
- App UI still mounts the combined lifecycle/status listener from a UI-context module and preserves terminal/session tab indicators.
- The browser app import graph no longer includes the old Node-only app setup modules that imported `fs`, `path`, or `os`.
- Wrapper parity gaps between the old app setup and runtime setup are either fixed in runtime tests or explicitly documented as intentional runtime behavior.

## Implementation Units

- [x] **Unit 1: Runtime Hook Setup Parity**

**Goal:** Make `workspace-runtime/src/agent-hooks` explicitly cover the runtime behavior that the old app setup used to cover, including agent wrapper parity.

**Requirements:** R1, R3, R6, R8

**Dependencies:** None

**Files:**
- Modify: `packages/workspace-runtime/src/agent-hooks/core/constants.ts`
- Modify: `packages/workspace-runtime/src/agent-hooks/core/setup.ts`
- Modify: `packages/workspace-runtime/src/agent-hooks/core/wrappers.ts`
- Test: `packages/workspace-runtime/src/agent-hooks/wrappers.test.ts`
- Test: `packages/workspace-runtime/src/agent-hooks/core/setup.test.ts`

**Approach:**
- Treat the runtime `core/` package as canonical for hook artifact generation.
- Compare old app agent coverage with runtime coverage:
  - Old app: `claude`, `codex`, `amp`, `aider`, `goose`, `cline`.
  - Current runtime: `claude`, `codex`, `opencode`, `gemini`, `cursor`, `cursor-agent`, `copilot`, `mastracode`, `droid`, `amp`, plus default generic wrappers `aider`, `goose`, `cline`, `pi`.
- Resolve `amp` parity explicitly. If no runtime native hook exists, use `generateGenericWrapper("amp", notify)` instead of passthrough so Busy/Idle/Error notifications remain available.
- If `amp` changes from passthrough to generic, update the `SHIMMED_BINARIES` relationship or setup filtering at the same time so the custom-wrapper exclusion rules do not accidentally suppress or duplicate the wrapper.
- Keep runtime-specific improvements such as codex watcher/native hook support, external config upserts, opencode integration, and custom wrappers.
- Keep the runtime wrapper taxonomy easy to extend: each default agent should have exactly one obvious classification path, either special shim/passthrough/native integration or generic lifecycle wrapper.

**Patterns to follow:**
- `packages/workspace-runtime/src/agent-hooks/core/setup.ts` for artifact orchestration.
- `packages/workspace-runtime/src/agent-hooks/core/wrappers.ts` for shared wrapper composition through `buildWrapperScript`.
- `packages/workspace-runtime/src/agent-hooks/wrappers.test.ts` for script-content and lightweight integration assertions.

**Test scenarios:**
- Happy path: setup artifact generation writes wrappers for every canonical default agent and returns the manifest.
- Happy path: `generateGenericWrapper("amp", notify)` sends Busy on start and Idle/Error on exit if `amp` is changed to generic.
- Edge case: `amp` classification remains internally consistent with `SHIMMED_BINARIES`, `DEFAULT_GENERIC_WRAPPERS`, and custom wrapper filtering.
- Edge case: custom wrappers continue to ignore shimmed binaries and do not duplicate default wrappers.
- Error path: passthrough agents still report a missing real binary with the standard wrapper error message.
- Integration: setup artifact generation writes both native/special wrappers and generic wrappers into the same `bin` directory without clobbering expected files.

**Verification:**
- Runtime tests show the canonical wrapper list and generated files cover the old app setup behavior plus runtime-specific integrations.

- [x] **Unit 2: Remove App-Side Setup Duplication**

**Goal:** Remove the unused Node-oriented setup/template surface from `claxedo-app` so hook setup has a single owner.

**Requirements:** R1, R4, R5, R8

**Dependencies:** Unit 1

**Files:**
- Delete: `packages/claxedo-app/src/agent-hooks/index.ts`
- Delete: `packages/claxedo-app/src/agent-hooks/constants.ts`
- Delete: `packages/claxedo-app/src/agent-hooks/templates/notify.ts`
- Delete: `packages/claxedo-app/src/agent-hooks/templates/shell.ts`
- Delete: `packages/claxedo-app/src/agent-hooks/templates/wrappers.ts`
- Modify: any import/export file that still references these setup modules, if implementation finds one.
- Test: `packages/claxedo-app/src/agent-hooks/listener.test.ts` or its moved successor from Unit 3.

**Approach:**
- Confirm no production imports use app-side `setupAgentHooks`, `getTerminalEnvVars`, or template generators.
- Delete only the setup/template files. Do not delete the UI listener until Unit 3 moves or renames it.
- Avoid adding runtime imports to the app. The server/runtime remains responsible for setup and env injection.
- Do not add a temporary app-side barrel export for runtime setup. If a missed import appears, repoint it to the runtime/server owner only when that import belongs in Node code; otherwise remove it.

**Patterns to follow:**
- Current runtime entrypoint: `packages/workspace-runtime/src/agent-hooks/index.ts`.
- Current server bridge: `packages/claxedo-server/src/agent-hooks.ts`.

**Test scenarios:**
- Happy path: app typecheck still resolves `useAgentHooks` after the UI listener move or import update.
- Edge case: no browser bundle import pulls in `fs`, `path`, or `os` from removed app setup files.
- Integration: server/runtime setup imports remain unchanged and still point at `workspace-runtime`.

**Verification:**
- A repo search for app-side setup symbols finds no remaining production references.
- The only remaining `packages/claxedo-app/src/agent-hooks` references are historical plan text or deleted-file paths during the active diff; no live source import uses that directory.

- [x] **Unit 3: Rename the App UI Listener Boundary**

**Goal:** Keep UI status behavior in the app but move it out of the setup-looking `agent-hooks` folder.

**Requirements:** R2, R4, R5, R6, R7, R8

**Dependencies:** Unit 2 can run before or after this unit, but the final tree should not leave an ambiguous `claxedo-app/src/agent-hooks` setup namespace.

**Files:**
- Move: `packages/claxedo-app/src/agent-hooks/listener.ts` to a clearer app UI path, for example `packages/claxedo-app/src/claxedo-ui/context/agent-status-listener.ts`
- Move or update: `packages/claxedo-app/src/agent-hooks/listener.test.ts`
- Modify: `packages/claxedo-app/src/claxedo-ui/ClaxedoLayout.tsx`
- Modify: `packages/claxedo-app/src/overrides/context/notification.tsx`
- Test: moved listener test file, for example `packages/claxedo-app/src/claxedo-ui/context/agent-status-listener.test.ts`

**Approach:**
- Keep `useAgentLifecycleListener`, `useSessionStatusListener`, `useClearAttentionOnFocus`, `usePtyExitCleanup`, and `useAgentHooks` behavior unchanged.
- Rename only the module boundary and import paths unless implementation reveals obvious local-only cleanup.
- Preserve the current test harness, which uses the real layout store via `_test-helper` and mocked event providers.
- Update relative imports and mock module paths carefully when the listener moves. The current test and listener use paths relative to `src/agent-hooks`, so the new `claxedo-ui/context` location will need adjusted paths for providers, overrides, and layout test helpers.
- Add or update characterization for runtime `Error` lifecycle events before changing the listener mapping. Current code maps all non-`Busy`/`Idle` events to permission-style state, so either preserve that explicitly or change it with a test that names the new intended behavior.
- Consider extracting small local helpers only if it clarifies tab lookup or active-tab checks without changing semantics.
- Prefer readability-preserving extraction over broad refactor. Reasonable extraction candidates are tab resolution, active-tab detection, and lifecycle-event-to-terminal-status mapping; avoid splitting the hook into many tiny files unless a helper is reused by tests or other UI listeners.

**Patterns to follow:**
- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/*` for app layout state boundaries.
- `packages/claxedo-app/src/claxedo-ui/context/_test-helper.ts` for tests that need the real layout store.

**Test scenarios:**
- Happy path: Busy events set terminal status to `working` and tab `loading`.
- Happy path: Idle events clear terminal status and clear tab `loading`.
- Happy path: `UserActionRequired` events set terminal status to `permission` and tab `attention`.
- Edge case: `Error` events keep the existing mapped UI behavior or intentionally move to a named new behavior.
- Edge case: lifecycle event lookup still resolves tabs by terminal ID when tab ID is missing or stale.
- Edge case: multi-terminal tab aggregation keeps loading true while any terminal remains working.
- Error path: PTY exit cleanup ignores missing IDs, untracked terminals, and already idle terminals.
- Integration: `useAgentHooks` still wires all four app listeners from `ClaxedoStateBridge`.

**Verification:**
- Existing listener tests pass after the move with no behavioral expectation changes.
- The renamed module reads as app UI state glue, not runtime hook setup, and `ClaxedoLayout` imports it from the new UI-context location.

- [x] **Unit 4: Tighten Runtime/App Documentation and Public Exports**

**Goal:** Make the ownership split discoverable so future work lands in the right place.

**Requirements:** R1, R4, R5, R8

**Dependencies:** Units 1-3

**Files:**
- Modify: `packages/workspace-runtime/src/agent-hooks/index.ts`
- Modify: `packages/workspace-runtime/src/agent-hooks/setup.ts`
- Modify: `packages/claxedo-app/src/claxedo-ui/ClaxedoLayout.tsx`
- Modify: `packages/claxedo-app/src/overrides/context/notification.tsx`
- Optional: update or add a small README/comment near `packages/workspace-runtime/src/agent-hooks/` if the repo has a nearby doc pattern.
- Test: existing runtime and app tests from Units 1-3.

**Approach:**
- Add concise comments only where they prevent future ownership confusion.
- Make the runtime public API read as the canonical setup/env surface.
- Make app comments describe status-listener behavior without calling it setup.
- Avoid broad docs churn unless there is already an agent-hooks README-like home.
- Update stale comments that point to `agent-hooks/listener.ts`, including notification ownership notes, so search results guide future readers to the renamed module.

**Patterns to follow:**
- Existing concise module headers in `packages/workspace-runtime/src/agent-hooks/setup.ts`.
- Existing comment in `packages/claxedo-app/src/overrides/context/notification.tsx` that points to the status listener for sound ownership.

**Test scenarios:**
- Happy path: public exports still include `setupAgentHooks`, `cleanupAgentHooks`, `isSetupComplete`, `getTerminalEnvVars`, `getShellArgs`, and `getCommandShellArgs`.
- Edge case: app comments/imports do not mention deleted app-side setup paths.

**Verification:**
- New comments and exports guide future readers to runtime setup and app UI status ownership without adding new behavior.

- [x] **Unit 5: Cleanup and Cross-Package Verification**

**Goal:** Prove the consolidation did not break runtime setup, app UI status behavior, or package boundaries.

**Requirements:** R2, R5, R6

**Dependencies:** Units 1-4

**Files:**
- Test: `packages/workspace-runtime/src/agent-hooks/wrappers.test.ts`
- Test: `packages/workspace-runtime/src/agent-hooks/shell.test.ts`
- Test: `packages/workspace-runtime/src/agent-hooks/core/setup.test.ts`
- Test: moved app listener test file from Unit 3
- Modify: no production files expected unless verification reveals missed references.

**Approach:**
- Verify runtime setup behavior at the workspace-runtime package level.
- Verify app listener behavior at the claxedo-app package level.
- Search for deleted `claxedo-app/src/agent-hooks` setup imports and stale comments.
- Keep any failures that reveal unrelated dirty-worktree issues separate from this consolidation.

**Patterns to follow:**
- Package-local testing guidance from AGENTS.md: run tests/typecheck from package directories, not repo root.

**Test scenarios:**
- Integration: runtime PTY env injection still points at `workspace-runtime` `getTerminalEnvVars`.
- Integration: server setup still calls `workspace-runtime` `setupAgentHooks`.
- Integration: app still mounts `useAgentHooks` from the renamed UI listener module.
- Edge case: no Node-only setup modules remain in the app-side browser import graph.

**Verification:**
- Package-local runtime and app checks pass or failures are documented as pre-existing/unrelated.

## System-Wide Impact

- **Interaction graph:** PTY spawn -> runtime env injection -> generated agent wrapper/native hook -> agent lifecycle route -> claxedo event bus -> app status listener -> tab UI.
- **Error propagation:** Runtime setup errors should remain logged in server/runtime paths. App status listener errors should not affect hook installation.
- **State lifecycle risks:** PTY exit cleanup and interrupt cleanup are defensive layers. Moving listener files must not change idempotency or multi-terminal aggregation.
- **API surface parity:** The HTTP setup/status/env routes in `workspace-runtime/src/routes/agent-hook.ts` should remain the external setup surface.
- **Integration coverage:** Runtime wrapper/setup tests and app listener tests cover different halves of the flow; both are needed.
- **Unchanged invariants:** `CLAXEDO_TAB_ID`, `CLAXEDO_TERMINAL_ID`, `CLAXEDO_WORKSPACE_ID`, `CLAXEDO_PORT`, and `/api/claxedo/hook/agent-lifecycle` remain stable.
- **Lifecycle event compatibility:** `Busy`, `Idle`, `UserActionRequired`, and `Error` events should be traced from runtime notification through app listener state before semantics change.
- **Maintainability impact:** Future agent integrations should be added in runtime setup/core/integration modules; future tab/session indicator behavior should be added in the renamed app status-listener module or adjacent app UI context files.

## Alternative Approaches Considered

- Keep `packages/claxedo-app/src/agent-hooks/index.ts` as a compatibility re-export: rejected because it preserves the misleading duplicate setup owner and keeps browser-side code looking like it can install runtime hook artifacts.
- Move all hook-related code into `workspace-runtime`: rejected because the app listener depends on Solid layout state, settings, sound playback, and browser-facing providers.
- Delete the whole app `agent-hooks` directory without moving the listener: rejected because `listener.ts` is actively mounted by `ClaxedoLayout` and owns visible tab/session status behavior.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Deleting app setup removes behavior not covered by runtime | Compare old app agent list and generated behavior against runtime before deletion, especially `amp`. |
| App accidentally imports Node-only runtime code | Keep UI listener in `claxedo-app`; do not import workspace-runtime into browser code. |
| File move obscures listener test intent | Move tests with the listener and preserve existing scenario names where possible. |
| Dirty workspace-runtime files get overwritten | Implement against current working tree and avoid reverting unrelated changes. |
| Runtime passthrough/generic wrapper differences change user-visible status dots | Add or update wrapper tests for any changed agent classification. |
| Runtime `Error` lifecycle events get reclassified accidentally during the listener move | Add characterization coverage before moving or changing app listener semantics. |

## Documentation / Operational Notes

- No user-facing docs are required unless implementation finds an existing developer doc for agent hooks.
- If a short internal note is added, it should say: runtime owns hook setup; app owns status rendering.

## Sources & References

- Related code: `packages/claxedo-app/src/agent-hooks/listener.ts`
- Related code: `packages/claxedo-app/src/agent-hooks/index.ts`
- Related code: `packages/claxedo-app/src/agent-hooks/templates/wrappers.ts`
- Related code: `packages/workspace-runtime/src/agent-hooks/setup.ts`
- Related code: `packages/workspace-runtime/src/agent-hooks/core/setup.ts`
- Related code: `packages/workspace-runtime/src/agent-hooks/core/wrappers.ts`
- Related code: `packages/workspace-runtime/src/agent-hooks/core/shell.ts`
- Related code: `packages/workspace-runtime/src/pty/index.ts`
- Related code: `packages/workspace-runtime/src/routes/agent-hook.ts`
- Related code: `packages/claxedo-server/src/agent-hooks.ts`
- Related code: `packages/claxedo-app/src/claxedo-ui/ClaxedoLayout.tsx`
