---
title: "platform: Hosted Control Plane Workstreams Plan"
type: platform
status: active
date: 2026-04-22
origin: chat
---

# platform: Hosted Control Plane Workstreams Plan

## Summary

This plan defines the next workstreams for moving Claxedo from the current
proxy-first hosted model to the adopted hosted control-plane architecture.

This plan intentionally changes the execution order used by earlier planning:

- Phase 1 proves the architecture works while still unauthenticated
- Phase 2 hardens auth after the seams are already wired and testable
- `tRPC` remains the near-term runtime-to-control-plane mutation contract
- the first real milestone is browser direct attach to `workspace-runtime`
  through control-plane gateway resolution
- relay or tunnel work is intentionally deferred until the direct-attach path
  is proven and the proxy is no longer the architectural center

This plan is not a replacement for the larger architecture docs. It is the
execution-focused bridge between:

- `/Users/yashvardhansingh/test/opencode/docs/plans/2026-04-11-durable-workspace-control-plane-implementation-plan.md`
- `/Users/yashvardhansingh/test/opencode/docs/plans/2026-04-22-hosted-control-plane-phased-tdd-plan.md`
- `/Users/yashvardhansingh/test/opencode/docs/plans/2026-04-13-pane-local-frontend-orchestration-plan.md`
- `/Users/yashvardhansingh/test/opencode/docs/vm-control-plane-workstreams.md`
- `/Users/yashvardhansingh/test/opencode/docs/cloud-architecture-hardening.md`

## Why This Plan Exists

The merged tree is in an in-between state:

- the control plane already exposes a hosted gateway seam through
  `/api/control/sessions/:sessionId/gateway`
- the frontend already has a place to switch servers per session in
  `directory-layout.tsx`
- `workspace-runtime` already reports explicit runtime and session mutations via
  `tRPC`
- but the browser still behaves proxy-first for workspace-hosted sessions
  because `resolveSessionUrl(...)` still returns `null`

That means the current stack is close to the target architecture, but still
stabilized around the wrong transport center of gravity.

The key correction this plan makes is:

- do not treat auth hardening, relay work, or deeper frontend cleanup as the
  first milestone
- first prove that the browser can attach to the right hosted target through
  the control plane without relying on `workspaceRuntimeProxy` as the default
  path

## Current Grounding In Code

### Current hosted attach seam

- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/routes/control-plane-session.ts`
  already exposes `GET /sessions/:sessionId/gateway`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/control-plane/trpc.ts`
  already resolves `gatewayUrl`, `workspaceId`, `directory`, and `runnerHost`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/overrides/pages/directory-layout.tsx`
  already has the browser-side switch point for a session-specific server URL
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/extensions/server.tsx`
  still returns `null` from `resolveSessionUrl(...)`

That final `null` keeps the browser on the current `claxedo-server` path for
workspace-hosted sessions and leaves the proxy as the effective routing center.

### Current proxy reality

- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/proxy.ts`
  still proxies workspace-runtime traffic for cloud workspaces
- this remains useful as migration compatibility and backstop behavior
- it should not remain the normal hosted session attach path

### Current runtime-to-control-plane write seam

- `/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/control-plane-client.ts`
  already uses a typed `tRPC` client
- `/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/session.ts`
  already calls explicit session sync and delete mutations
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/control-plane/trpc.ts`
  already owns the receiving mutation surface

This is an important distinction:

- the write path is already explicit
- the problem is that the browser attach path is still not canonical
- auth is a separate missing property, not proof that the current contract is
  structurally wrong

## Clarifications

### “Keeps tRPC coupling a little longer”

This does **not** mean `tRPC` is inherently short-lived or transient.

It means:

- we are choosing to keep `tRPC` as the runtime-to-control-plane mutation
  boundary for now
- we are not redesigning that transport in the same phase as browser attach
  cutover
- the current problem is missing auth and transport ownership, not that `tRPC`
  exists

### “Keep proxy until relay or tunnel layer exists”

This is an alternative rollout strategy that this plan explicitly rejects for
Phase 1.

That alternative would mean:

- keep the browser talking to `claxedo-server`
- keep `workspaceRuntimeProxy` as the normal hosted transport
- wait until a future relay or tunnel system exists before cutting over browser
  attachment

This plan instead chooses:

- direct browser attach for workspace-hosted sessions in Phase 1
- proxy retained only as fallback and compatibility infrastructure
- relay or tunnel work later, after the direct path is proven

## Locked Decisions

- Keep `tRPC` for runtime-to-control-plane writes in both Phase 1 and Phase 2
- Skip auth hardening in Phase 1
- Phase 1 must prove direct browser attach for workspace-hosted sessions
- `workspaceRuntimeProxy` remains temporarily available as fallback and
  backstop infrastructure only
- Auth hardening is a dedicated follow-up phase after the functional cutover is
  verified
- Signed query-token attach URLs are not the chosen first auth model
- “Keep proxy until relay exists” is not the chosen rollout strategy

## Workstream 1: Functional Gateway Cutover (Unauthenticated)

### Purpose

Prove the hosted control-plane model works end-to-end without relying on
proxy-first browser transport.

### Current problem

The backend already knows how to resolve the right attach target, but the
frontend still declines to use it.

### Implementation

- Make `GET /api/control/sessions/:sessionId/gateway` the canonical
  attach-resolution endpoint for workspace-hosted session routing
- Change the frontend extension seam from a no-op URL transform into real
  session target resolution
- For `runnerHost === "workspace"`, switch the browser to the runtime gateway
  URL
- For `runnerHost === "central"`, keep the browser on `claxedo-server`
- Keep the gateway contract URL-oriented in Phase 1; do not add auth-bearing
  attach descriptors yet

### Files / subsystems

- `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/extensions/server.tsx`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/overrides/pages/directory-layout.tsx`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/routes/control-plane-session.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/control-plane/trpc.ts`

### Tests

- `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/extensions/server.test.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/overrides/pages/directory-layout.test.tsx`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/control-plane.integration.test.ts`

### Test scenarios

- workspace-hosted session resolves through `/api/control/sessions/:sessionId/gateway`
- browser switches to runtime gateway without manual reload
- central-hosted session stays on `claxedo-server`
- route restore and tab restore use the same gateway resolution path as a fresh
  navigation

### Pros

- Proves the real architecture rather than simulating it through proxy behavior
- Flushes out hidden frontend and server assumptions early
- Makes proxy demotion a real system change instead of a documentation claim

### Cons

- Temporarily runs unauthenticated direct attach
- Can surface runtime transport issues earlier than a more conservative rollout

### Exit criteria

- `resolveSessionUrl(...)` is no longer inert for workspace-hosted sessions
- runtime-hosted sessions can open, reopen, and restore through the control
  plane gateway seam
- the normal hosted path no longer depends on proxy routing

## Workstream 2: Immediate Proxy Demotion After Cutover

### Purpose

Ensure the app no longer behaves as proxy-first by default once gateway cutover
works.

### Implementation

- Narrow `workspaceRuntimeProxy` so it is not the primary hosted attach path
- Keep only explicit compatibility routes that still require server-side
  bridging
- Update comments, tests, and docs so proxy behavior is described as fallback
  infrastructure rather than architecture center
- Add an explicit rollback toggle only if it materially reduces rollout risk,
  but do not preserve proxy as the normal transport path

### Files / subsystems

- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/proxy.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/proxy.test.ts`
- `/Users/yashvardhansingh/test/opencode/docs/plans/2026-04-22-hosted-control-plane-frontend-merge-plan.md`
- `/Users/yashvardhansingh/test/opencode/docs/plans/2026-04-13-pane-local-frontend-orchestration-plan.md`

### Tests

- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/proxy.test.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/control-plane.integration.test.ts`

### Test scenarios

- proxy handles only explicitly retained compatibility routes
- no test encodes proxy as the primary hosted browser attach mechanism
- hosted session attach still works when the compatibility routes remain
  enabled

### Pros

- Prevents future work from stabilizing around the wrong model
- Makes transport ownership visible in tests and documentation

### Cons

- Removes some migration slack
- Requires a clear inventory of which routes are truly still compatibility-only

### Exit criteria

- proxy routing is documented and tested as transitional infrastructure
- the browser does not require proxy for the normal workspace-hosted session
  path

## Workstream 3: Explicit Runtime-to-Control-Plane Mutation Path (Still Unauthenticated)

### Purpose

Keep runtime-originated metadata and lifecycle writes explicit while the browser
transport changes.

### Implementation

- Keep the current `tRPC` mutation path for:
  - runtime register
  - runtime heartbeat
  - session sync
  - session syncMany
  - session delete
- Do not redesign the mutation transport in this phase
- State clearly in code comments and docs that this surface is explicit but not
  yet authenticated

### Files / subsystems

- `/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/control-plane-client.ts`
- `/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/session.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/control-plane/trpc.ts`

### Tests

- `/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/session.test.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/runtime-contract.test.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/control-plane.integration.test.ts`

### Test scenarios

- runtime register and heartbeat still succeed after gateway cutover
- explicit session mutations remain idempotent under retry
- browser attach cutover does not regress runtime-originated sync behavior

### Pros

- Minimal churn while the browser transport is changing
- Keeps one explicit control-plane seam stable during the highest-risk cutover

### Cons

- Leaves the known trust gap in place temporarily
- Requires careful wording so “explicit” is not mistaken for “secure”

### Exit criteria

- runtime writes remain stable while browser transport changes land
- no new proxy-era write coupling is introduced during Phase 1

## Workstream 4: Frontend Convergence On Top Of Correct Transport

### Purpose

Finish pane-local and session-state convergence only after the browser is using
the correct hosted path.

### Implementation

- Preserve the session controller seam
- Make draft binding authoritative
- Reduce `global-sync` ownership of runtime and session concerns
- Continue query, store, and pane cleanup on top of the corrected transport
  model instead of around it

### Files / subsystems

- `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/session/store/session-controller.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/draft/draft-binding.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/overrides/context/global-sync.tsx`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/overrides/context/global-sync/bootstrap.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/claxedo-ui/layouts/rail-sidebar.tsx`

### Tests

- `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/session/store/session-controller.test.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/claxedo-ui/components/draft-session-pane.vitest.tsx`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/overrides/components/prompt-input/submit.test.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/overrides/pages/directory-layout.test.tsx`

### Test scenarios

- draft restore still works
- attach existing workspace still works
- first prompt handoff still works
- multi-pane session restore still works
- runtime gate behavior remains correct

### Pros

- Avoids frontend cleanup that would otherwise bake in proxy-era assumptions
- Preserves the useful state-management work already landed

### Cons

- Delays some frontend cleanup until after transport correction
- Requires discipline not to keep patching `global-sync` as a permanent owner

### Exit criteria

- session and draft ownership are no longer implicitly tied to proxy-era
  bootstrap assumptions
- `global-sync` is reduced to shell and compatibility responsibilities

## Workstream 5: Auth Hardening (Phase 2)

### Purpose

Secure the now-working hosted path rather than debating auth before the wiring
is proven.

### Implementation

- Add runtime-to-control-plane bearer auth for `/api/control/trpc`
- Evolve gateway resolution from URL-only into an attach descriptor with auth
  policy
- Extend the frontend server connection model so runtime-direct attach can carry
  ephemeral auth-bearing configuration
- Keep signed query-token and preview-URL trust models out unless testing shows
  header auth is infeasible

### Files / subsystems

- `/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/control-plane-client.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/control-plane/trpc.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/routes/control-plane-session.ts`
- `/Users/yashvardhansingh/test/opencode/packages/app/src/context/server.tsx`
- `/Users/yashvardhansingh/test/opencode/packages/sdk/js/src/v2/client.ts`

### Tests

- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/runtime-contract.test.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/control-plane.integration.test.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/extensions/server.test.ts`

### Test scenarios

- unauthenticated runtime mutation is rejected
- authenticated runtime mutation succeeds
- runtime-direct browser attach receives and uses ephemeral auth correctly
- expired attach auth forces re-resolution instead of silent failure

### Pros

- Security work lands on a proven path
- Keeps auth design grounded in real attach behavior instead of speculation

### Cons

- Requires revisiting public contract shape after Phase 1
- Expands app and server connection plumbing

### Exit criteria

- runtime-to-control-plane writes are authenticated
- runtime-direct browser attach is authenticated without falling back to query
  tokens

## Workstream 6: Canonical Hosted Read Cutover

### Purpose

Align hosted reads with the new attach and write model.

### Implementation

- Move hosted session list, detail, and timeline reads onto canonical metadata
  and projection-backed sources
- Keep merged compatibility reads only as explicit fallback behavior
- Stop letting proxy or merged compat logic define hosted read ownership

### Files / subsystems

- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/routes/agent-session.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/routes/opencode-compat.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/session-meta.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/cloud/message-replay.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/control-plane/trpc.ts`

### Tests

- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/control-plane.integration.test.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/session-grouping.integration.test.ts`
- `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/cloud/message-replay.test.ts`

### Test scenarios

- hosted session list and detail reads come from canonical or projection-backed
  sources
- timeline reads prefer projection or replay sources over ad hoc merged paths
- compatibility reads stay available only where explicitly intended

### Pros

- Unifies the ownership model
- Removes hidden merged-source behavior from the normal hosted path

### Cons

- Backend-heavy
- Likely to surface current replay or projection drift

### Exit criteria

- hosted reads line up with the control-plane ownership model
- merged compat behavior is no longer the default hosted read path

## Workstream 7: Relay Or Tunnel Layer (Later)

### Purpose

Add a stronger long-term transport story only after direct attach and auth are
already correct.

### Implementation

- Introduce relay or tunnel brokering only after:
  - direct attach works
  - auth hardening works
  - proxy is no longer the primary hosted path

### Files / subsystems

- `/Users/yashvardhansingh/test/opencode/docs/vm-control-plane-workstreams.md`
- any future relay-specific service and client code

### Pros

- Keeps the first milestone focused and testable
- Matches the broader architecture direction without blocking immediate
  transport correction

### Cons

- Early hosted transport still relies on direct runtime gateway URLs
- Defers long-term connectivity abstraction work

### Exit criteria

- relay or tunnel work is additive improvement rather than a prerequisite for
  basic hosted correctness

## Recommended Order

1. Functional gateway cutover
2. Immediate proxy demotion
3. Keep explicit runtime writes stable
4. Frontend convergence on top of corrected transport
5. Auth hardening
6. Canonical hosted read cutover
7. Relay or tunnel evolution

## Dependencies

### Workstream 1 depends on

- existing gateway resolution in
  `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/control-plane/trpc.ts`
- existing browser-side attach switch point in
  `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/overrides/pages/directory-layout.tsx`

### Workstream 2 depends on

- Workstream 1 proving the browser can attach directly to runtime-hosted
  sessions

### Workstream 4 depends on

- Workstreams 1 and 2, because frontend cleanup should not stabilize around a
  proxy-first transport

### Workstream 5 depends on

- Workstream 1 proving which attach contract is actually needed

### Workstream 6 depends on

- runtime writes staying explicit through Workstream 3

## Public API And Interface Changes

### Phase 1

- `GET /api/control/sessions/:sessionId/gateway` becomes the canonical hosted
  attach-resolution endpoint
- `resolveSessionUrl(): Promise<string | null>` stops being effectively inert
  and becomes part of the real hosted session routing contract
- no auth fields are added yet

### Phase 2

- `workspace-runtime` control-plane `tRPC` calls add auth headers
- the session gateway response evolves from URL-only to an attach descriptor,
  likely including:
  - `gatewayUrl`
  - `runnerHost`
  - attach mode
  - auth policy or token metadata

## Execution Posture

- Characterization-first for changes that narrow proxy behavior
- Integration-first for browser attach cutover and restore flows
- Keep the first phase functionally correct before layering security and
  transport sophistication onto it

## Test Plan

### Phase 1: Functional proof

- workspace-hosted session reopen resolves through
  `/api/control/sessions/:sessionId/gateway`
- browser switches to runtime gateway without reload hacks
- central-hosted session stays on `claxedo-server`
- cloud startup and new-session flow still work
- restored tab and restored pane use the same attach logic as fresh navigation
- proxy is not required for the normal workspace-hosted browser path

### Proxy demotion

- `proxy.ts` only handles explicitly retained compatibility routes
- tests describe retained proxy coverage as fallback or transitional behavior
- no test encodes proxy as the primary hosted attach mechanism

### Frontend safety

- draft restore
- attach existing workspace
- first prompt handoff
- session reopen
- multi-pane session restore
- runtime gate behavior

### Phase 2: Auth hardening

- unauthenticated runtime mutation is rejected
- authenticated runtime mutation succeeds
- browser attach header or token behavior works for runtime-direct sessions
- expired attach auth forces re-resolution rather than silent failure

## Superset Reference Takeaways Applied Here

This plan uses the Superset reference material as directional evidence, not as
an instruction to clone Superset’s exact architecture.

The takeaways carried forward are:

- separate transport ownership from product ownership
- prove the runtime boundary before adding more transport complexity
- do not let proxy-style migration infrastructure become the long-term center
- prefer header-based auth over query-token auth when Phase 2 begins

## Non-Goals For Phase 1

- replacing `tRPC` with a new transport
- introducing a relay or tunnel layer before direct attach is proven
- solving canonical hosted reads in the same phase as browser attach cutover
- hiding direct-attach correctness behind the existing proxy path

## Plan Readiness Check

This plan is ready when:

- an implementer can make the gateway cutover without guessing which file owns
  browser attach behavior
- an implementer can demote proxy behavior without needing to infer the target
  architecture from multiple older docs
- reviewers can distinguish the functional proof phase from the later auth and
  read-model phases
