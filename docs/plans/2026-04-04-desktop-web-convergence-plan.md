---
date: 2026-04-04
topic: desktop-web-convergence
status: active
origin: chat
---

# Desktop/Web Convergence Plan

## Goal

Make the desktop app use the same app behavior as the web app by default.

Desktop-specific code should exist only for native-shell concerns:

- sidecar startup and bootstrap
- IPC and native storage
- window, notification, updater, and filesystem APIs
- OS-specific integration such as WSL or display backend

Everything else, especially request policy, auth propagation, directory routing, and session transport, should be shared behavior.

## Upstream Reference

Upstream already follows the thinner model we want:

- desktop `fetch` in [packages/desktop/src/index.tsx](/Users/yashvardhansingh/test/opencode/packages/desktop/src/index.tsx) is a thin `tauriFetch(...)` pass-through
- sidecar credentials are attached to the server connection in [packages/desktop/src/index.tsx](/Users/yashvardhansingh/test/opencode/packages/desktop/src/index.tsx)
- shared SDK auth comes from the server connection in [packages/app/src/utils/server.ts](/Users/yashvardhansingh/test/opencode/packages/app/src/utils/server.ts)

That is the right shape:

- desktop bootstraps a server connection
- shared app code owns transport semantics
- auth is part of connection state, not a second renderer-only fetch policy

## Current Drift

The current fork still has multiple behavior sources for request and session semantics:

1. Web platform auth is injected in [packages/claxedo-app/src/main.tsx](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/main.tsx).
2. Desktop platform auth is separately injected in [packages/claxedo-app/src/desktop/index.tsx](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/desktop/index.tsx).
3. Shared app-side API auth is separately injected again in [packages/claxedo-app/src/utils/api.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/utils/api.ts).
4. Directory routing is implicitly pushed through `window.__OPENCODE__.activeDirectory` in [packages/claxedo-app/src/overrides/pages/directory-layout.tsx](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/overrides/pages/directory-layout.tsx).
5. Server status fetching has an `OpenCodeAdapter` special case in [packages/claxedo-server/src/routes/agent-session.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/routes/agent-session.ts).
6. The `OpenCodeAdapter` in [packages/workspace-runtime/src/adapters/opencode.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/opencode.ts) still remains a high-risk divergence seam for transport behavior, even after the recent race fix.

This creates the failure mode we just hit:

- frontend entrypoints look shared
- runtime semantics still diverge later in the stack
- desktop-only hangs and auth/path bugs can appear even when the shared app path is correct

## Locked Direction

The repo should converge to these rules:

1. Desktop entrypoints may provide capabilities, not behavior policy.
2. Auth should come from one shared source of truth per request path.
3. Directory selection must be explicit request context, not a mutable global side channel.
4. Session transport semantics must be shared between desktop and web.
5. Any remaining desktop-only behavior must be justified by a native-shell constraint and covered by a focused test.

## Allowed Desktop-Only Surfaces

These are valid places for desktop to stay different:

- starting and monitoring the local sidecar
- receiving sidecar URL and password from native code
- native file dialogs, clipboard image reads, notifications, updater, window management
- WSL and display backend preferences
- native markdown parsing or other desktop-only utilities

These are not valid places for desktop to stay different:

- auth header policy
- directory propagation policy
- SDK or session transport semantics
- status polling behavior
- prompt submission behavior
- reconnection behavior unrelated to native transport constraints

## Target Architecture

The shared app should own request and session behavior.

Desktop should only provide:

- a `Platform` implementation for native capabilities
- a sidecar-backed `ServerConnection`
- optional desktop-only helpers where the web cannot provide the same API

The shared layers should own:

- how auth headers are attached
- how directory context is propagated
- how SDK clients are created
- how session status and prompt flows are executed
- how event streams are opened and recovered

## Workstreams

### 1. Inventory and classify every desktop seam

Create a short living inventory of desktop differences and mark each one as one of:

- keep: required native-shell difference
- collapse: behavior drift that should move into shared code
- defer: unclear, needs evidence or tests first

Primary files for this pass:

- [packages/claxedo-app/src/desktop/index.tsx](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/desktop/index.tsx)
- [packages/claxedo-app/src/main.tsx](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/main.tsx)
- [packages/claxedo-app/src/utils/api.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/utils/api.ts)
- [packages/claxedo-server/src/routes/agent-session.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/routes/agent-session.ts)
- [packages/workspace-runtime/src/adapters/opencode.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/opencode.ts)

### 2. Converge auth and request policy first

This is the highest-value cleanup because it removes the most drift with the least UI churn.

Implementation direction:

- make server connection state the source of truth for sidecar Basic auth, matching upstream
- make web token auth a shared request helper input, not a separate entrypoint-only policy
- remove duplicate auth mutation from desktop `platform.fetch`
- reduce or remove duplicate auth mutation from `packages/claxedo-app/src/utils/api.ts`

Expected end state:

- desktop `platform.fetch` becomes a thin pass-through again
- web and desktop both rely on the same shared request helper for app-owned APIs
- SDK auth continues to come from shared server connection creation in [packages/app/src/utils/server.ts](/Users/yashvardhansingh/test/opencode/packages/app/src/utils/server.ts)

### 3. Remove `window.__OPENCODE__` from request semantics

Bootstrap globals are acceptable during startup. They should not remain part of steady-state transport logic.

Implementation direction:

- stop reading `window.__OPENCODE__.serverPassword` inside shared auth helpers
- stop reading `window.__OPENCODE__.activeDirectory` inside shared auth helpers
- stop writing active directory globally just to make request headers work
- move directory propagation to explicit call-site or provider-level request context

Primary files:

- [packages/claxedo-app/src/utils/api.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/utils/api.ts)
- [packages/claxedo-app/src/overrides/pages/directory-layout.tsx](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/overrides/pages/directory-layout.tsx)
- [packages/claxedo-app/src/claxedo-ui/context/process-pane.tsx](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/claxedo-ui/context/process-pane.tsx)
- [packages/claxedo-app/src/overrides/context/global-sync.tsx](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/overrides/context/global-sync.tsx)

### 4. Remove backend bypasses and special-case fetches

The server and runtime layers should not quietly reintroduce a second transport policy.

Implementation direction:

- replace the `OpenCodeAdapter` special-case status fetch in [packages/claxedo-server/src/routes/agent-session.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/routes/agent-session.ts) with a shared adapter or auth-helper path
- audit direct upstream fetches for missing `opencodeHeaders(...)` usage
- ensure `OpenCodeAdapter` remains a thin pass-through over upstream endpoints and shared headers

This is where desktop-only regressions often hide, because the frontend looks shared while the server/runtime path is not.

### 5. Shrink the `opencode` adapter to the minimum viable bridge

The adapter should exist only because Claxedo supports multiple runners and may need to spawn a local `opencode` server.

It should not behave like a second bespoke client implementation.

Implementation direction:

- keep spawn and lifecycle logic
- keep thin header and endpoint forwarding
- avoid custom prompt/status/event semantics when upstream already defines them
- continue aligning behavior with the shared SDK contract used by the app

### 6. Add parity tests that prove the rule

This cleanup is not complete without tests that make drift expensive.

Add contract-style tests for:

- request auth precedence: web token vs sidecar password vs existing explicit header
- directory propagation without `window.__OPENCODE__.activeDirectory`
- desktop `platform.fetch` staying a pure transport pass-through
- `claxedo-server` status forwarding using the same auth/header helpers as other upstream calls
- `opencode` adapter prompt and event behavior staying aligned with shared session routes

Good homes for these tests:

- [packages/claxedo-app/src/claxedo-ui/context/process-pane.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/claxedo-ui/context/process-pane.test.ts)
- [packages/workspace-runtime/src/adapters/opencode.test.ts](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/adapters/opencode.test.ts)
- [packages/claxedo-server/src/process/client.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/process/client.test.ts)
- new focused tests near the request helper once it is extracted

## Execution Order

Do the work in this order:

1. Extract and unify request/auth policy.
2. Remove global active-directory coupling.
3. Collapse backend special-cases.
4. Add parity tests and delete any now-unused desktop-only branches.

This order keeps the blast radius controlled. If we start with transport or UI rewrites first, auth and directory regressions will be harder to isolate.

## Risks and Open Questions

- Some Claxedo-owned APIs still need web token auth, so the shared request helper must support cloud auth without reintroducing entrypoint drift.
- Some call sites may currently depend on implicit directory injection and will need explicit directory inputs.
- `window.__OPENCODE__.serverUrl` may still be temporarily useful during bootstrap, but it should not remain the steady-state source of request truth if `ServerConnection` already exists.

## Definition of Done

This plan is complete when:

- desktop request behavior is thin and mostly identical to upstream desktop
- shared app code owns auth and directory semantics
- no request path depends on `window.__OPENCODE__.activeDirectory`
- server/runtime paths do not special-case `opencode` in ways that change transport semantics
- tests make future desktop/web behavior drift obvious
