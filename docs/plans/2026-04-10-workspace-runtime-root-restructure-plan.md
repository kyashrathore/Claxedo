---
date: 2026-04-10
topic: workspace-runtime-root-restructure
status: active
origin: chat
---

# Workspace Runtime Root Restructure Plan

## Goal

Reduce `packages/workspace-runtime/src` root clutter by moving runtime-owned implementation modules into clearer directories without changing runtime behavior or collapsing distinct contracts that the package currently depends on.

This plan applies the reviewed recommendation, with one important correction:

- move shared MCP resolution into `src/mcp/`, not `src/agent-hooks/`
- group event modules under `src/events/`, but keep the two event channels separate
- group workspace host files under `src/workspace/`
- move the ACP-only persistence store out of root and closer to ACP ownership

This plan is aligned with the layering direction in [docs/plans/2026-04-09-workspace-runtime-type-refactor-plan.md](/Users/yashvardhansingh/test/opencode/docs/plans/2026-04-09-workspace-runtime-type-refactor-plan.md), especially its guidance that boundary contracts should stay at package edges and runtime-owned modules should live in focused areas.

## Scope

This plan covers:

- module moves and import rewrites inside `packages/workspace-runtime`
- compatibility shims to avoid a large one-shot import churn
- a follow-up pass to remove temporary shims after downstream imports are updated
- test and typecheck updates needed to keep behavior stable

This plan does not cover:

- changing event payload shapes
- merging `ClaxedoEvent` and `CompatEnvelope` into one bus
- changing runtime behavior for session, PTY, process, MCP, or adapter flows
- broad type-model cleanup beyond what is needed for the file moves
- unrelated root files such as `server.ts`, `main.ts`, `paths.ts`, `log.ts`, `target.ts`, `profile.ts`, or `capabilities.ts`

## Current Facts

The current `packages/workspace-runtime/src` root mixes at least four different concerns:

1. composition and process bootstrapping:
   - [packages/workspace-runtime/src/server.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/server.ts)
   - [packages/workspace-runtime/src/main.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/main.ts)
   - [packages/workspace-runtime/src/index.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/index.ts)
2. workspace host composition:
   - [packages/workspace-runtime/src/workspace-core.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace-core.ts)
   - [packages/workspace-runtime/src/workspace-host.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace-host.ts)
   - [packages/workspace-runtime/src/workspace-full-host.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace-full-host.ts)
   - [packages/workspace-runtime/src/workspace-minimal-host.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace-minimal-host.ts)
   - [packages/workspace-runtime/src/workspace-full.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace-full.ts)
   - [packages/workspace-runtime/src/workspace-minimal.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace-minimal.ts)
3. event contracts and buses:
   - [packages/workspace-runtime/src/bus.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/bus.ts)
   - [packages/workspace-runtime/src/compat-events.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/compat-events.ts)
   - [packages/workspace-runtime/src/global-event-bus.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/global-event-bus.ts)
4. shared runtime services:
   - [packages/workspace-runtime/src/mcp-resolver.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/mcp-resolver.ts)
   - [packages/workspace-runtime/src/store.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/store.ts)
   - [packages/workspace-runtime/src/agent-config.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/agent-config.ts)

Two details matter for the restructure:

1. [packages/workspace-runtime/src/mcp-resolver.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/mcp-resolver.ts) is shared by `agent-config`, both adapters, and `agent-hooks`, so it is not an `agent-hooks` implementation detail.
2. [packages/workspace-runtime/src/global-event-bus.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/global-event-bus.ts) and [packages/workspace-runtime/src/bus.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/bus.ts) serve different contracts, so they should be grouped, not merged.

Also, the earlier inventory was stale: there is no `tunnel.ts` in the current `packages/workspace-runtime/src` root.

## Problem Frame

The root directory currently hides ownership instead of clarifying it.

- workspace host code is split across six root files even though it is one composition area
- event contracts and event buses are root-level peers even though they form a cohesive runtime event surface
- shared MCP logic looks like a local utility even though it is a package-level boundary service
- the ACP persistence store sits at root even though only ACP currently imports it

The risk is not just aesthetics. Root-heavy layout makes future refactors more likely to choose the wrong owner for shared logic, especially around MCP and event translation.

## Architectural Decision

Use directory grouping to reflect ownership, but preserve behavior and public entrypoints during the move.

### Keep separate event channels

Do not merge:

- `ClaxedoEvent` bus for runtime-local PTY, process, and agent lifecycle events
- `CompatEnvelope` bus for `/global/event` payloads and OpenCode-compatible session events

Those are adjacent surfaces, not one surface.

### Keep boundary contracts at package scope

Do not bury shared boundary modules under more specific subtrees.

- `mcp-resolver` becomes `src/mcp/resolver.ts`
- `compat-events` becomes `src/events/compat.ts`

These modules are consumed across adapters, routes, storage, and downstream packages.

### Prefer phased compatibility over one-shot churn

Do the restructure in two passes:

1. move implementations and add re-export shims
2. update downstream imports and remove shims once all call sites are on the new paths

This keeps the refactor reviewable and reduces breakage in `packages/claxedo-server` and any cross-package imports.

## Target Module Shape

### Final target

- `packages/workspace-runtime/src/workspace/host.ts`
- `packages/workspace-runtime/src/workspace/core.ts`
- `packages/workspace-runtime/src/workspace/full.ts`
- `packages/workspace-runtime/src/workspace/minimal.ts`
- `packages/workspace-runtime/src/workspace/index.ts`
- `packages/workspace-runtime/src/events/claxedo.ts`
- `packages/workspace-runtime/src/events/compat.ts`
- `packages/workspace-runtime/src/events/global.ts`
- `packages/workspace-runtime/src/events/index.ts`
- `packages/workspace-runtime/src/mcp/resolver.ts`
- `packages/workspace-runtime/src/mcp/index.ts`
- `packages/workspace-runtime/src/adapters/acp-store.ts`

### Root files that should remain after shim cleanup

- `packages/workspace-runtime/src/server.ts`
- `packages/workspace-runtime/src/main.ts`
- `packages/workspace-runtime/src/index.ts`
- `packages/workspace-runtime/src/log.ts`
- `packages/workspace-runtime/src/paths.ts`
- `packages/workspace-runtime/src/target.ts`
- `packages/workspace-runtime/src/profile.ts`
- `packages/workspace-runtime/src/capabilities.ts`
- `packages/workspace-runtime/src/agent-config.ts`
- `packages/workspace-runtime/src/lazy.ts`

### Temporary compatibility shims during migration

Keep these files as re-export shims in the first pass only:

- `packages/workspace-runtime/src/workspace-host.ts`
- `packages/workspace-runtime/src/workspace-core.ts`
- `packages/workspace-runtime/src/workspace-full-host.ts`
- `packages/workspace-runtime/src/workspace-minimal-host.ts`
- `packages/workspace-runtime/src/workspace-full.ts`
- `packages/workspace-runtime/src/workspace-minimal.ts`
- `packages/workspace-runtime/src/bus.ts`
- `packages/workspace-runtime/src/compat-events.ts`
- `packages/workspace-runtime/src/global-event-bus.ts`
- `packages/workspace-runtime/src/mcp-resolver.ts`
- `packages/workspace-runtime/src/store.ts`

## Implementation Units

### Unit 1: Consolidate workspace host modules under `src/workspace/`

Files to add:

- [packages/workspace-runtime/src/workspace/host.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace/host.ts)
- [packages/workspace-runtime/src/workspace/core.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace/core.ts)
- [packages/workspace-runtime/src/workspace/full.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace/full.ts)
- [packages/workspace-runtime/src/workspace/minimal.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace/minimal.ts)
- [packages/workspace-runtime/src/workspace/index.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace/index.ts)

Files to update:

- [packages/workspace-runtime/src/server.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/server.ts)
- [packages/workspace-runtime/src/index.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/index.ts)
- temporary shim files listed above

Decision:

- combine the current `workspace-*.ts` implementation files into one directory
- keep the public names `createWorkspaceFullHost`, `createWorkspaceMinimalHost`, `mountWorkspaceCore`, and `WorkspaceHost`
- use root shims first, then remove them in the cleanup pass

Rationale:

- [packages/workspace-runtime/src/server.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/server.ts) already treats these files as one composition area
- the one-line re-export files are not harmful during migration, but they should not be the final structure

Test targets:

- existing package typecheck via `bun typecheck` in [packages/workspace-runtime](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime)
- add [packages/workspace-runtime/src/workspace/index.test.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace/index.test.ts) as a smoke test for `full` and `minimal` host creation plus `mountWorkspaceCore` export wiring

Test scenarios:

- importing the workspace module tree does not create circular imports
- `createWorkspaceFullHost()` still mounts `/global/event`, session routes, config routes, and compat routes
- `createWorkspaceMinimalHost()` still exposes config and global event routes
- `mountWorkspaceCore()` still mounts capabilities, PTY, hook, event, process, diff, and file routes

### Unit 2: Group event contracts and buses under `src/events/`

Files to add:

- [packages/workspace-runtime/src/events/claxedo.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/events/claxedo.ts)
- [packages/workspace-runtime/src/events/compat.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/events/compat.ts)
- [packages/workspace-runtime/src/events/global.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/events/global.ts)
- [packages/workspace-runtime/src/events/index.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/events/index.ts)

Files to update:

- [packages/workspace-runtime/src/routes/events.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/events.ts)
- [packages/workspace-runtime/src/routes/session.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/session.ts)
- [packages/workspace-runtime/src/routes/session-core.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/session-core.ts)
- [packages/workspace-runtime/src/adapters/acp.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/acp.ts)
- [packages/workspace-runtime/src/adapters/opencode.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/opencode.ts)
- [packages/workspace-runtime/src/adapters/translate-chunk-to-event.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/translate-chunk-to-event.ts)
- [packages/workspace-runtime/src/adapters/translate-event-to-chunk.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/translate-event-to-chunk.ts)
- [packages/workspace-runtime/src/pty/index.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/pty/index.ts)
- [packages/workspace-runtime/src/process/index.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/process/index.ts)
- [packages/claxedo-server/src/bus.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/bus.ts)
- temporary shim files listed above

Decision:

- `claxedo.ts` owns `createBus`, `claxedoBus`, `ClaxedoEvent`, and `PtyInfo`
- `compat.ts` owns `CompatEvent`, `CompatEnvelope`, builders, parsers, and projection helpers
- `global.ts` owns `publishGlobalEvent` and `subscribeGlobalEvents`
- do not merge the buses or move compat types into consumers

Rationale:

- the current contracts are distinct and used by different routes and downstream consumers
- grouping them reduces root clutter without erasing package boundaries

Test targets:

- [packages/workspace-runtime/src/routes/session.test.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/session.test.ts)
- [packages/workspace-runtime/src/adapters/acp-title.integration.test.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/acp-title.integration.test.ts)
- [packages/workspace-runtime/src/compat-events.typecheck.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/compat-events.typecheck.ts)
- [packages/workspace-runtime/src/adapters/translate-chunk-to-event.test.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/translate-chunk-to-event.test.ts)
- [packages/workspace-runtime/src/adapters/translate-event-to-chunk.test.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/translate-event-to-chunk.test.ts)

Test scenarios:

- `/api/claxedo/events` still streams `ClaxedoEvent` payloads and heartbeat events
- session mutations still publish `CompatEnvelope` events to the global event bus
- ACP title updates still observe global compat events
- `toCompatEvent()` and `eventSessionId()` still accept all supported compat event types
- downstream `claxedo-server` imports still compile against the moved `ClaxedoEvent` contract

### Unit 3: Move shared MCP resolution into `src/mcp/`

Files to add:

- [packages/workspace-runtime/src/mcp/resolver.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/mcp/resolver.ts)
- [packages/workspace-runtime/src/mcp/index.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/mcp/index.ts)

Files to update:

- [packages/workspace-runtime/src/agent-config.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/agent-config.ts)
- [packages/workspace-runtime/src/adapters/opencode.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/opencode.ts)
- [packages/workspace-runtime/src/adapters/acp.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/acp.ts)
- [packages/workspace-runtime/src/agent-hooks/setup.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/agent-hooks/setup.ts)
- [packages/workspace-runtime/src/agent-hooks/index.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/agent-hooks/index.ts)
- [packages/workspace-runtime/src/agent-hooks/integrations/mcp/index.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/agent-hooks/integrations/mcp/index.ts)
- [packages/workspace-runtime/src/agent-hooks/integrations/opencode/config.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/agent-hooks/integrations/opencode/config.ts)
- [packages/workspace-runtime/src/agent-hooks/integrations/opencode/setup.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/agent-hooks/integrations/opencode/setup.ts)
- [packages/claxedo-server/src/agent-config.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/agent-config.ts)
- temporary shim file [packages/workspace-runtime/src/mcp-resolver.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/mcp-resolver.ts)

Decision:

- move the implementation into `src/mcp/resolver.ts`
- keep a root shim initially because cross-package imports already exist
- do not move this code under `agent-hooks/`

Rationale:

- `mcp-resolver` is used by multiple top-level subsystems
- `agent-hooks` is one consumer, not the owner

Test targets:

- [packages/workspace-runtime/src/mcp-resolver.test.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/mcp-resolver.test.ts)
- [packages/workspace-runtime/src/agent-hooks.test.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/agent-hooks.test.ts)
- [packages/workspace-runtime/src/agent-hooks/integrations/opencode/setup.test.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/agent-hooks/integrations/opencode/setup.test.ts)
- package typecheck in [packages/workspace-runtime](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime)

Test scenarios:

- managed MCP defaults and overrides still load and save correctly
- `resolveClaxedoMcpCommand()` still resolves bundle, sidecar, and dev entrypoint paths
- `toOpencodeConfig()` and `toAcpMcpServers()` still project the same transport shapes
- `agent-hooks` setup still rebuilds config using the moved resolver module

### Unit 4: Move ACP persistence store out of root

Files to add:

- [packages/workspace-runtime/src/adapters/acp-store.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/acp-store.ts)

Files to update:

- [packages/workspace-runtime/src/adapters/acp.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/acp.ts)
- temporary shim file [packages/workspace-runtime/src/store.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/store.ts)

Decision:

- move `RuntimeStore` to `src/adapters/acp-store.ts`
- keep the exported class name `RuntimeStore` for now to avoid mixed semantic and structural churn in one refactor
- defer any rename to `AcpStore` or `SessionStore` to a later, behavior-aware cleanup

Rationale:

- current usage is ACP-only
- this removes a large domain file from root without forcing a broader storage redesign

Test targets:

- [packages/workspace-runtime/src/store.test.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/store.test.ts)
- package `test` script in [packages/workspace-runtime/package.json](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/package.json)

Test scenarios:

- session rows, message rows, part rows, todo rows, and pending question or permission rows still replay correctly
- persisted compat events still rebuild assistant and user messages correctly
- ACP recovery normalization still runs on startup

### Unit 5: Remove temporary shims and normalize imports

Files to update:

- all remaining imports in [packages/workspace-runtime/src](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src)
- all remaining cross-package imports in [packages/claxedo-server/src](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src)
- [packages/workspace-runtime/src/index.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/index.ts)

Files to delete after call sites are migrated:

- [packages/workspace-runtime/src/workspace-host.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace-host.ts)
- [packages/workspace-runtime/src/workspace-core.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace-core.ts)
- [packages/workspace-runtime/src/workspace-full-host.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace-full-host.ts)
- [packages/workspace-runtime/src/workspace-minimal-host.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace-minimal-host.ts)
- [packages/workspace-runtime/src/workspace-full.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace-full.ts)
- [packages/workspace-runtime/src/workspace-minimal.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace-minimal.ts)
- [packages/workspace-runtime/src/bus.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/bus.ts)
- [packages/workspace-runtime/src/compat-events.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/compat-events.ts)
- [packages/workspace-runtime/src/global-event-bus.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/global-event-bus.ts)
- [packages/workspace-runtime/src/mcp-resolver.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/mcp-resolver.ts)
- [packages/workspace-runtime/src/store.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/store.ts)

Decision:

- delete shims only after `workspace-runtime` and `claxedo-server` no longer import them

Rationale:

- this is the safest point to collect the full root-file reduction

Test targets:

- full package typecheck in [packages/workspace-runtime](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime)
- relevant downstream typecheck in [packages/claxedo-server](/Users/yashvardhansingh/test/opencode/packages/claxedo-server) if available in that package

Test scenarios:

- no code in the repo imports deleted shim paths
- public exports from `packages/workspace-runtime/src/index.ts` still expose the same runtime API surface

## Sequencing

Recommended execution order:

1. workspace host move with shims
2. event grouping with shims
3. MCP move with shim
4. ACP store move with shim
5. import normalization across `workspace-runtime` and `claxedo-server`
6. shim deletion

Why this order:

- workspace and events are the clearest structural wins and mostly internal
- MCP has cross-package consumers, so it should move after the import pattern is already established
- the ACP store is isolated and can move late with low risk
- deleting shims last keeps the whole refactor reversible until the end

## Verification

Run from [packages/workspace-runtime](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime), not repo root:

- `bun typecheck`
- `bun test`

If `packages/claxedo-server` has its own typecheck entry, run that after the import cleanup pass as a downstream contract check.

Manual verification points:

- `workspace-runtime` still boots and reports health
- `/api/claxedo/events` still streams runtime-local events
- `/global/event` still streams compat envelopes in both minimal and full profiles
- ACP and OpenCode adapters still compile and still expose their current runtime APIs

## Risks

### 1. Silent contract drift through re-export shims

Risk:
import paths may keep resolving through root shims longer than intended, making the cleanup pass incomplete.

Mitigation:
after each move, search for old import paths and keep a checklist of remaining shim consumers before deletion.

### 2. Event channel confusion during the move

Risk:
it is easy to accidentally import `CompatEnvelope` helpers from the `ClaxedoEvent` module or vice versa.

Mitigation:
name the new files by contract, not by generic terms. Use `claxedo.ts`, `compat.ts`, and `global.ts`, not multiple `bus.ts` variants.

### 3. Cross-package import breakage

Risk:
`packages/claxedo-server` imports some `workspace-runtime` internals directly today.

Mitigation:
keep root shims until all downstream imports are updated and validated.

## Success Criteria

This plan is complete when:

- `packages/workspace-runtime/src` root no longer contains workspace host implementations, event implementations, MCP resolver implementation, or ACP store implementation
- event contracts remain behaviorally identical and still distinct
- MCP resolution is grouped under `src/mcp/` and still consumed across adapters, config, and hooks
- all package tests and typechecks still pass from package directories
- temporary root shims are removed after import normalization is complete
