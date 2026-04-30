# Cloud Workspace New Session Bootstrap Regression

Date: 2026-04-13
Status: Confirmed bug
Area: Frontend session bootstrap / cloud workspace routing
Severity: High

## Summary

Starting a new session from the cloud workspace `misty-panda` does not behave like a cloud-gated flow. After clicking the `+` button in the cloud workspace row, the app opens a draft `New Session` tab and immediately begins the normal directory/session bootstrap fan-out instead of first ensuring that the cloud workspace is in a workable state.

The recording shows the UI entering the standard blank new-session screen while the Network panel fills with the usual directory-scoped requests. The dedicated cloud startup state exists in the product, but this entry path still behaves like a regular local session bootstrap.

## User-Facing Impact

- Users can land on a misleading blank `New Session` view for a cloud workspace that is not actually ready.
- The app issues normal session/bootstrap requests before the workspace readiness contract has been satisfied.
- The flow obscures what is happening. Instead of a clear "preparing cloud workspace" state, users see a normal session shell plus background traffic.
- If the runtime is cold, waking, or stale, the UX can look broken even when the backend is still trying to recover.

## Environment

- Product: `packages/claxedo-app`
- Workspace type: cloud workspace
- Workspace name shown in video: `misty-panda (cloud)`
- Trigger: click the `+` button in the cloud workspace row to start a new session
- Evidence source: local screen recording provided by user

## Reproduction

1. Open Claxedo with a visible cloud workspace row.
2. Find `misty-panda (cloud)` in the left rail.
3. Open DevTools Network tab.
4. Click the `+` button for that cloud workspace.
5. Observe the resulting `New Session` tab and the immediate request fan-out.

## Actual Behavior

- The app navigates immediately into a draft `New Session` route.
- The main panel shows the standard empty new-session shell, not a clear cloud-bootstrap-first flow.
- Network traffic starts immediately with normal directory/session bootstrap requests.
- From the recording, representative requests include the standard directory-scoped family such as health/config/current/resolve/provider/agent/command/session/mcp/lsp/vcs/permission/question/file calls.

## Expected Behavior

- Clicking `+` for a cloud workspace should first ensure the workspace runtime is workable.
- Until that is true, the UI should stay in the explicit cloud startup state (`Preparing cloud workspace`) and avoid normal runtime-bound bootstrap traffic.
- Only after the workspace is ready should the app open the interactive session/composer flow.
- If the session becomes cloud-scoped, the frontend should also switch onto the cloud session/gateway URL path instead of continuing to behave like a plain localhost session.

## Frontend Evidence

### 1. New-session click path navigates immediately with no cloud-specific guard

`packages/claxedo-app/src/claxedo-ui/claxedo-layout-actions/session-actions.tsx:64-105`

- `handleNewSession()` treats cloud and local workspaces the same.
- It adds a draft `"new"` session tab immediately.
- It navigates straight to `sessionRoute(workspaceDir)` with no readiness check.

This is the first frontend contract break. The cloud workspace flow is allowed to enter the standard session route before readiness is established.

### 2. The session page does have a cloud startup gate, but it is route-level and reactive

`packages/claxedo-app/src/overrides/pages/session.tsx:299-350`

- The gate only opens after the session page is already mounted on a `"new"` route for a cloud workspace.
- The gate resolves `/api/workspace/resolve`, subscribes to provision events, then calls `/api/workspace/ensure`.
- This means the cloud readiness protection is happening after navigation, not before navigation.

The UX in the recording matches this late gating model: the app has already entered the normal session route when the cloud logic begins.

### 3. Intended bootstrap behavior already says runtime-bound requests must be skipped during cloud provisioning

`packages/claxedo-app/src/overrides/context/global-sync/bootstrap.ts:259-273`

- `workspaceBoot()` checks whether the workspace is a non-ready cloud workspace.
- `pendingCloud(ws)` short-circuits the normal bootstrap fan-out and intentionally skips runtime-bound requests.

There is direct test coverage for this contract:

`packages/claxedo-app/src/overrides/context/global-sync/bootstrap.test.ts:415-470`

- The test name is explicit: `skips runtime-bound requests while a cloud workspace is still provisioning`.

The recording shows the opposite symptom at the UX layer: a normal request fan-out begins immediately after opening the draft cloud session.

### 4. Cloud session URL auto-switch is wired in the UI but never implemented in the registered server extension

The route-level auto-switch hook expects `resolveSessionUrl`:

`packages/claxedo-app/src/overrides/pages/directory-layout.tsx:46-68`

But the actual server extension only exposes `transformUrl`:

`packages/claxedo-app/src/extensions/server.tsx:17-35`

And the config surface still advertises cloud-specific routing support:

`packages/claxedo-app/src/index.tsx:17-27`

- `gatewayUrl`
- `cloudAutoSwitch`

This is a second frontend contract break. Even after a cloud session exists, the extension point intended to switch localhost onto a cloud session/gateway URL is not implemented.

## Likely Root Cause

This looks like a layered frontend regression rather than a single missing `if`:

1. The action layer opens a draft new-session route immediately for cloud workspaces instead of treating cloud session creation as a guarded bootstrap flow.
2. The cloud readiness gate lives inside the session page, so the app enters the normal route before readiness has been established.
3. The cloud session URL resolver is missing, so the route layer has no extension-backed way to promote a localhost session route into the cloud session/gateway transport it expects.

In practice, this creates a mixed-mode startup:

- cloud readiness is partially handled by the session page
- standard directory bootstrap still appears to start as though the session were local/normal
- the session transport/routing layer is missing the final cloud-specific URL resolution hook

## Why This Is High Severity

- It breaks trust in the cloud session UX at the exact moment a user tries to start work.
- It makes cloud startup failures look like generic blank-session failures.
- It increases the odds of racey or misleading frontend state because the app is trying to render a normal session shell before the backing workspace is confirmed workable.
- The codebase already contains the intended contract and tests for the guarded path, so users are experiencing behavior that appears to violate product intent, not just an unimplemented enhancement.

## Recommended Fix Direction

### Primary fix

Make cloud `+ new session` a pre-navigation guarded flow.

- Detect cloud workspaces in `handleNewSession()`.
- Resolve and ensure the workspace before opening the draft session tab.
- Keep the user in an explicit cloud bootstrap UI until readiness is confirmed.

### Secondary fix

Implement the missing `resolveSessionUrl` server extension.

- Use the existing extension hook in `directory-layout.tsx`.
- Respect `gatewayUrl` / `cloudAutoSwitch`.
- Ensure a real cloud session route can promote localhost into the correct gateway/session URL when needed.

### Hardening

- Add an integration test for clicking `+` on a cloud workspace row and asserting that the first visible state is the cloud startup flow, not the normal blank session shell.
- Add coverage proving that the normal runtime-bound bootstrap requests do not fire before cloud readiness is satisfied for this entry path.
- Add coverage for `resolveSessionUrl` registration so the override contract in `directory-layout.tsx` cannot silently drift out of sync again.

## Acceptance Criteria

- Clicking `+` on a cloud workspace never drops the user into a misleading plain `New Session` shell before readiness is known.
- While the cloud workspace is provisioning or waking, the user sees `Preparing cloud workspace` with progress logs.
- Normal session bootstrap traffic is suppressed until readiness is satisfied.
- Once a cloud session is real, the frontend can switch onto the cloud-specific session/gateway URL path.
- A regression test covers this exact entry flow.

## Short Version

The frontend currently treats cloud `new session` like a normal draft session too early. The session page contains a cloud gate, but the action layer navigates before the gate is established, and the extension hook that should promote a real cloud session onto a cloud URL is missing entirely.
