---
title: "platform: Hosted Control Plane + Frontend Convergence Plan"
type: platform
status: active
date: 2026-04-22
origin: chat
---

# platform: Hosted Control Plane + Frontend Convergence Plan

## Summary

This plan is for integrating two dirty detached worktrees that both started from the same base commit and each pushed a different half of the same product direction:

- backend/control-plane refactor:
  `/Users/yashvardhansingh/.codex/worktrees/b0da/opencode`
- frontend/pane-local orchestration refactor:
  `/Users/yashvardhansingh/.codex/worktrees/00f0/opencode`

The deeper conclusion after reading the docs, tracing the code, and checking the tests is:

- the backend branch is not "the new architecture complete"; it is a contract branch that introduces the first real hosted control-plane seams
- the frontend branch is not "the frontend refactor complete"; it is a convergence branch that introduces runtime gating, pane-scoped preferences, a draft-session UI surface, and a compatibility session controller
- after merging them, the majority of remaining product work is still frontend work, not because the backend is unimportant, but because the backend already exposes enough contract surface to unblock frontend convergence while still leaving its own deeper cleanup for later phases

One important correction after verifying the merged tree, not just the two source worktrees:

- the integrated code still preserves one major proxy-era assumption: `packages/claxedo-app/src/extensions/server.tsx` returns `null` from `resolveSessionUrl(...)`
- because of that, the browser still falls back to `workspaceRuntimeProxy` for workspace-hosted attachment
- this makes proxy removal the first post-merge corrective phase, not a late cleanup task

The most important architectural decision for the merge is:

- treat `b0da` as the source of truth for hosted attach/bootstrap contracts
- treat `00f0` as the source of truth for pane/runtime/session/prefs ownership in the browser
- do not keep the frontend branch's older hosted attach inference path as the primary model
- do not mistake the backend branch's thin control-plane wrappers for the finished canonical metadata/projection architecture

## What We Are Actually Building

Across the docs, the intended system is consistent even though the current code is not yet there:

- `workspaceId` is the stable product identity
- `claxedo-server` is the public control plane
- `workspace-runtime` is the workspace-local execution surface
- a durable workspace authority owns lease, epoch, sandbox identity, and reconnect fencing
- canonical metadata, replay, and projections own hosted reads
- the browser should stop assuming localhost plus proxy routing is the permanent hosted model
- the frontend should stop treating one directory-scoped bootstrap blob as the owner of shell, runtime readiness, session state, and pane preferences

From the backend docs:

- `docs/plans/2026-04-11-durable-workspace-control-plane-implementation-plan.md`
- `docs/plans/2026-04-22-hosted-control-plane-phased-tdd-plan.md`
- `docs/vm-control-plane-workstreams.md`

the hosted architecture target is:

1. public requests hit the control plane
2. the control plane resolves the active runner host and attach target
3. `workspace-runtime` reports host/session state back to the control plane
4. hosted browser reads move to canonical metadata plus projections
5. the old proxy path becomes rollout compatibility, not the architecture center

From the frontend docs:

- `docs/plans/2026-04-13-pane-local-frontend-orchestration-plan.md`

the frontend target is:

1. shell and read-mostly queries become one layer
2. runtime readiness becomes a separate workspace-scoped layer
3. session hydration becomes per-session
4. pane or draft preferences become first-class
5. draft composer identity becomes separate from attached workspace identity

The merge has to preserve both directions at once.

## Source Documents Used

Primary planning anchors:

- `docs/plans/2026-04-11-durable-workspace-control-plane-implementation-plan.md`
- `docs/plans/2026-04-22-hosted-control-plane-phased-tdd-plan.md`
- `docs/plans/2026-04-13-pane-local-frontend-orchestration-plan.md`
- `docs/sync-architecture.md`
- `docs/sync-architecture-target.md`
- `docs/brainstorms/2026-03-31-claxedo-sync-strategy-requirements.md`
- `docs/vm-control-plane-workstreams.md`
- `docs/plans/2026-04-11-big-repo-workspace-reliability-plan.md`
- `docs/cloud-architecture-hardening.md`

Directional reference notes consulted for execution posture and seam quality:

- `/Users/yashvardhansingh/test/superset-terminal-ref/plans/chat-mastra-rebuild-execplan.md`
- `/Users/yashvardhansingh/test/superset-terminal-ref/plans/v2-workspace-chat-drift-audit.md`
- `/Users/yashvardhansingh/test/superset-terminal-ref/plans/20260417-automations.md`

## Worktree Reality

Both worktrees are detached at the same base commit and only differ by working tree state, not meaningful branch ancestry.

Implication:

- this is not a normal branch merge problem
- the correct integration shape is a fresh worktree from `dev`, then deliberate file-set adoption and conflict resolution

Observed scope:

- backend worktree: 32 changed files, mostly `packages/claxedo-server` and `packages/workspace-runtime`
- frontend worktree: 59 changed files, mostly `packages/claxedo-app`
- true overlap is tiny:
  - `packages/claxedo-app/src/extensions/server.tsx`
  - `packages/claxedo-app/src/extensions/server.test.ts`
  - `packages/claxedo-server/src/session-grouping.integration.test.ts`

That tiny overlap matters because it sits exactly on the attach/bootstrap seam between the two branches.

## Backend Branch: What Is Actually Landed

### Composition root and injected service seam are real

In `packages/claxedo-server/src/server.ts`:

- `createControlPlaneServices({ sync: createSyncDB(...) })` is now the server-owned composition root
- `AgentSessionRoutes` receives `services`
- `controlPlaneTrpcHandler(services)` is mounted at `/api/control/trpc`
- `ControlPlaneSessionRoutes(services)` is mounted at `/api/control`
- `services.durableSessionLog.subscribe_message_replay(globalBus)` replaces a direct local call site

This is a meaningful architecture move. It makes control-plane services explicit in composition.

### Runtime-to-control-plane mutation path is real

In `packages/workspace-runtime/src/control-plane-client.ts` and `packages/workspace-runtime/src/routes/session.ts`:

- `workspace-runtime` now creates a typed tRPC client using `CLAXEDO_CONTROL_PLANE_URL`
- session CRUD hooks call:
  - `client.session.sync.mutate`
  - `client.session.syncMany.mutate`
  - `client.session.delete.mutate`
- runtime lifecycle reports:
  - `client.runtime.register.mutate`
  - `client.runtime.heartbeat.mutate`

This means the backend branch has already landed the first real host-to-control-plane contract, even though it uses tRPC rather than the exact REST examples in the phased plan.

### Hosted attach/bootstrap route is real

In:

- `packages/claxedo-server/src/control-plane/trpc.ts`
- `packages/claxedo-server/src/routes/control-plane-session.ts`

the backend branch adds:

- `resolveSessionGateway(services, sessionId)`
- `GET /api/control/sessions/:sessionId/gateway`

The route returns:

- `gatewayUrl`
- `workspaceId`
- `directory`
- `runnerHost`

and it already uses:

- projection metadata
- workspace lookup
- runner host resolution
- authority lease `runtime_url`

This is the correct attach/bootstrap direction for the frontend to consume.

There is one important proof-pass correction here: in the backend worktree, browser consumption was already further along than a first pass suggested.

In:

- `packages/claxedo-app/src/extensions/server.tsx`
- `packages/claxedo-app/src/overrides/pages/directory-layout.tsx`

the backend worktree already switches the browser to the control-plane gateway route and removes the older localhost-only auto-switch guard in directory layout.

That means Phase 7 was more landed in the backend worktree than “route exists on the server” alone.

But that progress did not survive as the active merged behavior.

In the merged tree we are actually shipping today:

- `packages/claxedo-app/src/extensions/server.tsx` still returns `null` from `resolveSessionUrl(...)`
- `packages/claxedo-app/src/overrides/pages/directory-layout.tsx` is still ready to switch to a gateway URL, but never receives one
- `packages/claxedo-server/src/proxy.ts` therefore remains the effective hosted byte-routing center for workspace-hosted attachment

So the right conclusion is not “browser integration is already done.” It is:

- the backend worktree proved the control-plane browser seam is viable
- the merged code still needs an explicit corrective pass to make that seam canonical
- proxy demotion must move to the front of the remaining work, ahead of broader frontend convergence

### Cloud session reads are partially cut over

In `packages/claxedo-server/src/routes/agent-session.ts`:

- cloud `listSessions` already reads from `projectionStore.list_session_metas(...)`
- global and central session creates call `projectionStore.put_session_meta(...)` and `projectionStore.sync_session_meta(...)`

This is real progress toward hosted canonical reads.

### Hosted experimental listing is still compatibility composition

In `packages/claxedo-server/src/routes/opencode-compat.ts`:

- `/experimental/session` still manually builds a merged view
- cloud workspaces currently source rows from `listSessionMetas(...)`
- local workspaces still source rows from `listLocalSessions(...)`
- the route then normalizes and merges them

This means hosted read cutover is not finished. The backend branch has not eliminated merged compat views as the main fallback surface.

### Workspace authority is more explicit, but supervisor still does too much

In:

- `packages/claxedo-server/src/cloud/authority.ts`
- `packages/claxedo-server/src/workspace-supervisor.ts`

the branch does improve the situation:

- supervisor comments and state now explicitly describe the in-memory map as transport-only
- remote runtime start writes `CLAXEDO_CONTROL_PLANE_URL`, `CLAXEDO_WR_LEASE_ID`, `CLAXEDO_WR_EPOCH`, and `CLAXEDO_WR_SANDBOX_ID`
- authority lease and lifecycle helpers are used during remote start, health, and failure paths

But the supervisor still owns substantial live lifecycle orchestration:

- provider calls
- retry logic
- health monitoring
- event stream bridging
- local runtime spawn

This matches the phased plan: authority separation is started, not finished.

### The current control-plane abstractions are still thin wrappers

In:

- `packages/claxedo-server/src/control-plane/services.ts`
- `packages/claxedo-server/src/control-plane/projection-store.ts`
- `packages/claxedo-server/src/control-plane/durable-session-log.ts`

the new services are mostly aliases over `SyncDB`.

This is useful for dependency injection and route ownership, but it is not yet the deeper split promised by the architecture docs:

- canonical metadata store
- timeline log
- projection rebuilds
- workflow engine

So the backend branch has landed the seam, not the fully separated internals.

## Backend Branch: Phase Status

Relative to `docs/plans/2026-04-22-hosted-control-plane-phased-tdd-plan.md`:

- Phase 1: mostly landed
  - explicit composition root and injected services exist
- Phase 2: only partially landed
  - the names exist, but `ProjectionStore` and `DurableSessionLog` still delegate straight to `SyncDB`
- Phase 3: partially landed
  - authority semantics are more explicit, but supervisor is still the real orchestrator
- Phase 4: landed in spirit
  - runtime mutation contracts exist via tRPC
- Phase 5: partially landed
  - cloud session reads use projection metadata in some routes, but compat merged reads remain
- Phase 6: not started
  - no `WorkflowEngine` seam exists yet
- Phase 7: more landed than the first pass suggested
  - attach/bootstrap route exists, and the backend worktree’s app extension plus directory layout already consume it
  - the remaining issue is convergence with `00f0`, not proving browser integration
- Phase 8: not started
  - compatibility cleanup is not done

## Frontend Branch: What Is Actually Landed

### Runtime gating is real

In:

- `packages/claxedo-app/src/cloud/runtime/workspace-runtime-store.ts`
- `packages/claxedo-app/src/claxedo-ui/claxedo-layout-actions/session-actions.tsx`
- `packages/claxedo-app/src/overrides/context/global-sync/bootstrap.ts`

the branch clearly moves cloud startup earlier:

- `workspaceRuntimeBlocksBootstrap(...)` explicitly blocks bootstrap while cloud runtime is still pending
- `prepareWorkspaceRuntime(...)` resolves workspace state, listens to `provision` events, and calls `/api/workspace/ensure`
- `handleNewSession(...)` now waits on cloud workspace preparation before opening the normal new-session flow

This is a real fix for the cloud `+ new session` regression described in the frontend plan.

### Query layer groundwork is real

In:

- `packages/claxedo-app/src/shared/query/*`
- `packages/claxedo-app/src/overrides/context/global-sync/bootstrap.ts`

the branch already routes:

- project list
- provider list
- workspace resolve

through shared query helpers instead of raw one-off fetches.

### A compatibility session controller exists

In:

- `packages/claxedo-app/src/session/store/session-controller.ts`
- `packages/claxedo-app/src/session/store/session-store.ts`
- `packages/claxedo-app/src/session/store/session-transport.ts`
- `packages/claxedo-app/src/overrides/pages/session.tsx`

the branch introduces a dedicated session controller surface.

But the important nuance is:

- it still depends on `useSync()`
- it still reads and writes `globalSync`-owned state
- it still uses the existing `State` shape from `context/global-sync/types`

So this is not yet a true independent session store. It is a compatibility lens over the old store.

### Pane preferences are more explicit

In:

- `packages/claxedo-app/src/pane/store/pane-preferences.ts`
- `packages/claxedo-app/src/claxedo-ui/context/acp-config.ts`

the branch does move preference scope in the right direction:

- `panePreferenceScope(...)` supports `draft:<draftId>` and `session:<directory>:<sessionId>`
- ACP config uses that scope
- ACP config can warm draft sessions for ACP modes
- promotions from draft scope to session scope are explicit

This is a real improvement.

### Draft-session UI is real

In:

- `packages/claxedo-app/src/claxedo-ui/components/draft-session-pane.tsx`
- `packages/claxedo-app/src/claxedo-ui/components/workspace-attach-browser.tsx`
- `packages/claxedo-app/src/claxedo-ui/components/workspace-create-flow.tsx`
- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/types.ts`
- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/tab-context-sync.ts`
- `packages/claxedo-app/src/claxedo-ui/components/multi-pane/multi-pane-tab.tsx`

the branch introduces a real draft-session surface with:

- `draft-session` tab type
- persisted `draftId`
- persisted `providerDirectory`
- optional attached `directory`
- `draftPanel`
- `draftProjectId`
- attach existing workspace flow
- create local/cloud workspace flow
- multipane restore support

This is substantial. The draft composer is not just a sketch.

The proof-pass tests make this stronger than the core abstraction alone suggests:

- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/route-intent.test.ts` already proves unattached `draft-session` tabs can be restored without collapsing back into a normal attached session
- `packages/claxedo-app/src/overrides/components/prompt-input/submit.test.ts` already proves first-session handoff behavior can patch and close the active `draft-session` tab correctly
- `packages/claxedo-app/src/draft/draft-binding.test.ts` already proves stable `draftId` and compatibility scope behavior

So the draft flow is more behaviorally landed than `draft-binding.ts` by itself would imply. The remaining work is model ownership and consolidation.

### The attach model is still split across several concepts

The current branch uses at least four different concepts that all matter:

- `draftId`
- `providerDirectory`
- attached `directory`
- pseudo directory from `draftScopeDirectory(draftId)`

The actual behavior today is:

- `providerDirectory` is the SDK/rendering seed for the draft pane
- attached `directory` is the real workspace target for session creation
- `draftScopeDirectory(draftId)` is only a compatibility scope key for prompt state

That is workable, but it is not yet expressed as one clear domain model.

### The dedicated `draft-binding.ts` module is still too thin

In `packages/claxedo-app/src/draft/draft-binding.ts`:

- `DraftBinding` only holds `draftId` and optional `directory`
- `attachDraftBinding(...)` only changes `directory`
- the module is not the real owner of the draft-session state machine

The real draft state machine currently lives across:

- `TabItem`
- `PaneContent`
- `DraftSessionPane`
- `prompt-input/submit`
- `acp-config`

So the branch started the draft-binding seam but did not yet make it authoritative.

### Hosted session URL resolution is still on the old path

In `packages/claxedo-app/src/extensions/server.tsx`:

- `resolveCloudSessionUrl(...)` still does:
  - `/api/claxedo/session/:id/meta`
  - then `/api/workspace/resolve`
  - then synthesize `${gateway}/s/${sessionId}`

This is the wrong long-term attach model once the backend branch exists.

It is the single most important merge conflict because it chooses which architecture the browser will actually follow.

## Frontend Branch: Phase Status

Relative to `docs/plans/2026-04-13-pane-local-frontend-orchestration-plan.md`:

- Phase 1: substantially landed
  - query groundwork, runtime gating, and startup flow are real
- Phase 2: partially landed
  - session controller exists, but it is still compatibility-wrapped around `global-sync`
- Phase 3: partially landed
  - pane preferences are real, but ACP config still carries a lot of runtime/bootstrap coupling
- Phase 4: not landed
  - `global-sync` is still a big owner, only slightly narrowed
- Phase 5: not landed
  - backend data ports and durable-read abstraction do not exist yet

For the focused R11 unbound draft slice:

- route, tab, restore, and UI surfaces are substantially landed
- a real attach/create UX exists
- submit guards and draft-to-session handoff behavior are covered in tests
- but the actual draft-binding model is still spread across many files rather than being one authoritative seam

## Deep Merge Truth

The real merge is not about the three overlapping files. It is about four architectural seams.

### 1. Hosted attach resolution and proxy ownership

Competing models:

- backend branch:
  control plane resolves `runnerHost` and `gatewayUrl`
- frontend branch:
  browser infers cloud attach target by looking up session meta plus workspace resolve

Decision:

- backend model wins
- current merged behavior is still wrong until the browser consumes the control-plane route first and stops treating proxy routing as the default hosted attach policy

Reason:

- it keeps attach policy in the control plane
- it supports `runnerHost === "central"`
- it avoids hard-coding gateway URL synthesis into the browser
- it matches the VM control-plane and hosted control-plane docs

### 2. Hosted read ownership

Current state after backend branch:

- some hosted reads already use projection metadata
- `opencode-compat` still builds merged views

Decision:

- this is not a merge blocker for the frontend branch
- it is backend debt that can remain behind compatibility for the next phase

Reason:

- the frontend branch mainly needs a stable attach/bootstrap contract and stable runtime/session APIs
- full hosted read cutover can happen after frontend convergence

### 3. Draft identity and attachment

Current state after frontend branch:

- draft UI exists
- attach/create UX exists
- preference promotion exists
- binding is still distributed and only partly formalized

Decision:

- keep the branch’s draft-session UX and tab model
- do not regress to directory-bound `"new"` only
- do a focused post-merge frontend pass to make one authoritative draft-binding model

Reason:

- the UX direction is correct
- the implementation seam is not yet coherent enough to be the long-term owner

### 4. Session hydration ownership

Current state after frontend branch:

- `createSessionController(...)` exists
- session page uses it
- `global-sync` is still the actual data owner

Decision:

- keep the controller surface
- treat it as the migration seam
- make the next major frontend phase a real extraction of session state from `global-sync`

Reason:

- the controller is already the right consumer-facing shape
- replacing it would waste the work already done
- the actual unfinished work is moving storage and refresh ownership behind it

## Merge Strategy

## Phase 0: Create a clean integration worktree from `dev`

Do not merge inside either dirty detached snapshot.

Reason:

- both worktrees are detached
- the integration needs clean validation and conflict control
- the post-merge frontend work will need its own commits and test checkpoints

## Phase 1: Land backend/control-plane branch first

Adopt the backend file set first, including:

- `packages/claxedo-server/src/server.ts`
- `packages/claxedo-server/src/control-plane/*`
- `packages/claxedo-server/src/routes/control-plane-session.ts`
- `packages/claxedo-server/src/routes/agent-session.ts`
- `packages/claxedo-server/src/routes/opencode-compat.ts`
- `packages/claxedo-server/src/workspace-supervisor.ts`
- `packages/workspace-runtime/src/control-plane-client.ts`
- `packages/workspace-runtime/src/routes/session.ts`
- related tests and docs

Why first:

- it establishes the attach/bootstrap contract the frontend must consume
- it moves hosted mutations onto explicit runtime-to-control-plane calls
- it is lower-risk to adapt the frontend to a real backend contract than to keep an inferred frontend contract and force the backend to emulate it

Validation checkpoint:

Run from package directories only:

- `packages/claxedo-server`
  - `bun test src/control-plane.integration.test.ts`
  - `bun test src/routes/control-plane-session.test.ts`
  - `bun test src/control-plane/trpc.test.ts`
  - `bun test src/session-grouping.integration.test.ts`
  - `bun typecheck`
- `packages/workspace-runtime`
  - `bun test src/control-plane-client.test.ts`
  - `bun test src/routes/session.test.ts`
  - `bun typecheck`

## Phase 2: Resolve the shared attach seam before bringing in the rest of frontend

Resolve these files immediately after backend lands:

- `packages/claxedo-app/src/extensions/server.tsx`
- `packages/claxedo-app/src/extensions/server.test.ts`
- `packages/claxedo-server/src/session-grouping.integration.test.ts`

Required outcome for `extensions/server.tsx`:

- keep a helper-based shape so it remains testable
- use `/api/control/sessions/:sessionId/gateway` as the primary fetch
- return normalized `gatewayUrl` when `runnerHost === "workspace"`
- return normalized control-plane URL when `runnerHost === "central"`
- keep `cloudAutoSwitch === false` as a hard short-circuit
- keep non-session or non-upstream ids attached to `getClaxedoServerUrl()`

Optional temporary fallback:

- only if the integration shows rollout gaps, the older meta plus workspace-resolve path may remain as a short-lived fallback behind the control-plane route
- it must not remain the primary implementation

Required outcome for `session-grouping.integration.test.ts`:

- keep the backend branch’s move toward projection-backed hosted session sync
- keep the frontend branch’s assertion that returned session bodies preserve `directory`

## Phase 3: Land the frontend branch on top of that contract

Adopt the frontend file set after the attach seam is aligned.

Keep:

- `packages/claxedo-app/src/shared/query/*`
- `packages/claxedo-app/src/cloud/runtime/*`
- `packages/claxedo-app/src/session/store/*`
- `packages/claxedo-app/src/pane/store/*`
- `packages/claxedo-app/src/draft/*`
- `packages/claxedo-app/src/claxedo-ui/components/draft-session-pane*`
- `packages/claxedo-app/src/claxedo-ui/components/workspace-attach-browser.tsx`
- `packages/claxedo-app/src/claxedo-ui/components/workspace-create-flow.tsx`
- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/*`
- `packages/claxedo-app/src/overrides/components/prompt-input/*`
- `packages/claxedo-app/src/overrides/context/global-sync/*`
- `packages/claxedo-app/src/overrides/pages/session.tsx`

Why this ordering:

- runtime gate and pane-local state should be built on the new hosted attach contract
- it avoids merging the frontend’s older `resolveCloudSessionUrl(...)` logic and then undoing it later

Validation checkpoint:

Run from `packages/claxedo-app`:

- `bun test src/cloud/runtime/workspace-runtime-store.test.ts`
- `bun test src/extensions/server.test.ts`
- `bun test src/draft/draft-binding.test.ts`
- `bun test src/overrides/components/prompt-input/submit.test.ts`
- `bun test src/claxedo-ui/components/draft-session-pane.vitest.tsx`
- `bun test src/claxedo-ui/context/claxedo-layout/route-intent.test.ts`
- `bun test src/claxedo-ui/context/acp-config.test.ts`
- `bun test src/session/store/session-controller.test.ts`
- `bun typecheck`

## Phase 4: Do one explicit convergence pass before any cleanup

Do not call the merge complete after the branches both apply cleanly.

At this point, there will still be an integrated-but-inconsistent app unless we do one deliberate convergence pass on:

- hosted attach resolution
- draft binding
- session hydration ownership
- global-sync boundaries

This ordering needs one important correction: the real remaining work does not begin with generic frontend convergence. It begins with removing the merged tree's remaining proxy-first browser assumption.

## Remaining Work After Merge: Remove Proxy-First Attachment First, Then Converge Frontend

This is the main conclusion from the code audit.

The backend branch already establishes enough of the contract surface that the next major block of value is frontend convergence, not more backend abstraction first.

### Frontend Phase A: Remove proxy-first browser attachment

Goal:

- make control-plane gateway resolution the canonical browser attach path
- stop treating `workspaceRuntimeProxy` as the default hosted session attachment model

Files:

- `packages/claxedo-app/src/extensions/server.tsx`
- `packages/claxedo-app/src/extensions/server.test.ts`
- `packages/claxedo-app/src/overrides/pages/directory-layout.tsx`
- `packages/claxedo-server/src/routes/control-plane-session.ts`
- `packages/claxedo-server/src/routes/control-plane-session.test.ts`
- `packages/claxedo-server/src/proxy.ts`
- `packages/claxedo-server/src/proxy.test.ts`
- any terminal/server-url tests referenced in the backend phased plan

Important nuance:

- the backend worktree already proved this seam can exist cleanly
- the merged tree regressed to `resolveSessionUrl(...) === null`, so this is now a corrective phase, not just a regression-prevention phase
- this should be treated as a cross-stack phase, not just a frontend patch, because `proxy.ts` and its tests must be narrowed around the new contract

Why this is first:

- it is the seam where the two branches disagree
- if we leave it ambiguous, the browser will keep encoding the old hosted model even though the backend contract changed
- every later frontend cleanup risks preserving the wrong center of gravity if the browser still assumes proxy attachment underneath it

Acceptance:

- hosted sessions resolve through `/api/control/sessions/:sessionId/gateway`
- central-hosted sessions stay attached to `claxedo-server`
- workspace-hosted sessions attach to the returned runtime gateway
- no frontend code assumes it can synthesize hosted attach targets from metadata lookups alone
- `resolveSessionUrl(...)` is non-null for workspace-hosted sessions that should switch
- `workspaceRuntimeProxy` is documented and tested as compatibility/backstop infrastructure, not as the primary hosted attach path

### Shared Phase A1: Narrow proxy responsibility immediately after browser cutover

Goal:

- demote proxy behavior from architecture center to explicit compatibility backstop as soon as browser attachment is gateway-driven

Files:

- `packages/claxedo-server/src/proxy.ts`
- `packages/claxedo-server/src/proxy.test.ts`
- `packages/claxedo-server/src/workspace-supervisor.ts`
- docs that still describe proxy-first hosted attachment

Required outcomes:

- hosted browser attachment no longer conceptually depends on `workspaceRuntimeProxy`
- proxy routing remains only for routes that still genuinely require transport compatibility during migration
- comments, tests, and docs stop presenting proxy routing as the normal hosted design
- any remaining proxy-only routes are called out explicitly as transitional debt

### Frontend Phase B: Make draft binding a real domain model

Goal:

- replace the current distributed draft-binding semantics with one clear owner

Important nuance:

- this phase is about consolidating an already-working draft flow, not inventing a new UX
- the existing branch already proves draft restore, attach/create, and first-session handoff behavior

Current problem:

- `draft/draft-binding.ts` is too thin
- the real model is spread across:
  - `TabItem.directory`
  - `providerDirectory`
  - `draftPanel`
  - `draftProjectId`
  - `draftScopeDirectory(draftId)`
  - prompt submit guards

Decision:

- either deepen `draft/draft-binding.ts` to represent the real draft state
- or explicitly delete it and move to a clearer single model in the layout layer

Do not leave the current half-state in place.

Files:

- `packages/claxedo-app/src/draft/draft-binding.ts`
- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/types.ts`
- `packages/claxedo-app/src/claxedo-ui/components/draft-session-pane.tsx`
- `packages/claxedo-app/src/overrides/components/prompt-input/submit.ts`
- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/tab-context-sync.ts`
- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/route-intent.ts`

Acceptance:

- one module or layer can answer:
  - what is the draft id
  - what is the provider or browsing seed
  - what is the attached target workspace
  - whether send is allowed
  - how draft prefs promote to a real session

### Frontend Phase C: Turn the session controller into a real session state seam

Goal:

- keep `createSessionController(...)` as the consumer-facing API, but remove `global-sync` as the real owner under it

Current problem:

- the session controller currently depends on `useSync`, `useGlobalSync`, and `State`
- it is a compatibility controller, not a true store boundary

Files:

- `packages/claxedo-app/src/session/store/session-controller.ts`
- `packages/claxedo-app/src/session/store/session-store.ts`
- `packages/claxedo-app/src/session/store/session-transport.ts`
- `packages/claxedo-app/src/overrides/pages/session.tsx`
- `packages/claxedo-app/src/overrides/context/global-sync/bootstrap.ts`

Acceptance:

- only actively rendered sessions hydrate
- session state is owned by session-layer code, not generic directory bootstrap
- `global-sync` no longer owns message, todo, permission, and question state for active sessions

### Frontend Phase D: Reduce `global-sync` to shell/runtime compatibility only

Goal:

- finish the migration the branch started

Current problem:

- `bootstrapDirectory(...)` still owns too much
- `global-sync` still performs major session/runtime/bootstrap work
- ACP config still refreshes directories through `globalSync`

Files:

- `packages/claxedo-app/src/overrides/context/global-sync.tsx`
- `packages/claxedo-app/src/overrides/context/global-sync/bootstrap.ts`
- `packages/claxedo-app/src/overrides/context/global-sync/types.ts`
- `packages/claxedo-app/src/claxedo-ui/ClaxedoLayout.tsx`
- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/selectors.ts`

Acceptance:

- shell-visible metadata can remain in a thin compatibility facade
- runtime readiness and session hydration no longer live there
- layout title and badge consumers stop depending on `globalSync.child(workspaceId).session`

### Frontend Phase E: Finish pane preference ownership

Goal:

- complete the move from ACP-config-side behavior to pane/session/draft-owned preferences

Current problem:

- pane preference maps exist
- ACP config still handles significant runtime, option-fetch, warming, and refresh behavior itself

Files:

- `packages/claxedo-app/src/pane/store/pane-preferences.ts`
- `packages/claxedo-app/src/claxedo-ui/context/acp-config.ts`
- `packages/claxedo-app/src/claxedo-ui/components/agent-runner-selector.tsx`
- `packages/claxedo-app/src/claxedo-ui/components/acp-selector.tsx`

Acceptance:

- runner/provider/model/variant ownership is clearly pane or session scoped
- ACP config becomes an adapter/provider layer, not the hidden owner of execution preference state

### Frontend Phase F: Introduce the missing backend data ports and durable-read abstraction

Goal:

- finish the part of the frontend plan that has not yet been started

Current problem:

- query helpers exist
- session controllers exist
- but the backend ports and durable-state abstraction from the frontend plan do not exist

Files:

- new `packages/claxedo-app/src/shared/data/*`
- consumers in query/runtime/session/pane layers

Acceptance:

- UI layers depend on explicit ports instead of raw SDK/fetch/globalSync reach-through
- durable reads can later swap to a reactive adapter without rewriting UI consumers

### Frontend Phase G: Add end-to-end regression coverage for the integrated flow

Goal:

- prove the merged architecture, not just the unit seams

Integrated user flows to cover:

1. cloud workspace `+ new session`
   - startup gate appears first
   - bootstrap fan-out stays suppressed while pending
2. draft composer with no attached workspace
   - render draft pane
   - attach existing workspace later
   - send first prompt
   - promote draft scope to session scope
3. hosted session reopen
   - browser resolves attach target through control-plane route
   - central-hosted sessions stay on control plane
   - workspace-hosted sessions switch correctly

## Backend Work That Can Wait Until After Frontend Convergence

These are still necessary, but they are not the next highest-value work once the merge lands.

### Backend deferred Phase 1: Make `ProjectionStore` and `DurableSessionLog` real

Today they are still wrappers over `SyncDB`.

Future work:

- canonical metadata adapter
- timeline log adapter
- projection rebuild logic

### Backend deferred Phase 2: Finish hosted read cutover

`opencode-compat.ts` still merges views manually.

Future work:

- move hosted read surfaces fully onto projection-backed reads
- keep merged compat views only behind explicit fallback

### Backend deferred Phase 3: Add `WorkflowEngine`

Still missing:

- scheduled runs
- approval wait semantics
- durable workflow projections

### Backend deferred Phase 4: Finish the rest of proxy cleanup

Still missing:

- real cleanup of old sync hooks
- final deletion or further narrowing of proxy paths that remain after Phase A1
- removal of dead compatibility code

## Recommended Commit Sequence

1. Fresh integration worktree from `dev`
2. Backend branch file set
3. Backend validation
4. Shared seam resolution:
   - `extensions/server.tsx`
   - `extensions/server.test.ts`
   - `session-grouping.integration.test.ts`
5. Frontend branch file set
6. Frontend validation
7. Cross-stack convergence pass A:
   control-plane gateway cutover + immediate proxy demotion
8. Frontend convergence pass B:
   draft-binding model
9. Frontend convergence pass C:
   real session store extraction
10. Frontend convergence pass D:
    `global-sync` reduction
11. Only then resume deeper backend cleanup phases

## Risks

- If the frontend keeps its older `resolveCloudSessionUrl(...)` path as primary, the merged code will silently preserve the wrong hosted architecture even though the backend branch added the right route.
- If we treat the current `draft/draft-binding.ts` as “done”, we will end up with a permanently split draft model across layout, prompt submit, and ACP config.
- If we assume the session controller means session extraction is done, `global-sync` will remain the hidden owner and the frontend architecture will still be conceptually overloaded.
- If we try to finish backend cleanup before frontend convergence, we will spend time perfecting abstractions the frontend is not yet consuming.

## Final Recommendation

Merge the backend branch first because it establishes the hosted control-plane contract.

Immediately resolve the browser attach seam in favor of the control-plane route and treat proxy demotion as part of that same corrective phase.

Then merge the frontend branch and treat the post-merge roadmap as frontend-first convergence work:

1. control-plane gateway cutover and proxy demotion
2. real draft-binding ownership
3. real session state extraction
4. `global-sync` reduction
5. pane preference cleanup
6. backend ports and durable-read abstraction

That sequence best matches both the code that already exists and the product direction described in the planning docs.
