# E2E test decisions register

This doc lists every e2e test that is failing or intentionally skipped (`test.fixme`) and needs an owner call. Each entry is self-contained: the behavior under test, why it's off, and A/B/C options. **Fill in the `Decision:` line per entry** — that's the only field you need to edit. Options are labelled by effort (S ≈ <½ day, M ≈ 1–2 days, L ≈ multi-day). Line numbers are as of 2026-07-20 (`dev`); CI evidence is from test.yml run `9995fa239a` (12-shard × 2-worker) unless noted.

| Section | Entries | Tests covered |
| --- | --- | --- |
| 1. Failing — needs a decision | 8 | 10 (5 failing-everywhere, 5 failing-CI-only) |
| 2. Skipped (`test.fixme`) — needs a decision | 35 | 41 fixme sites |
| 3. Live-suite skips (not in core CI) | 1 table | 12 live `test.fixme`/`test.skip` bodies |

> Also tracked, no entry needed: `core-busy-abort-errors.spec.ts:611` (stale-busy reconcile, behavior 2) was a contention suspect but **passed** in the 12-shard tune — resolved, watch for flake.

---

## 1. Failing — needs a decision

### 1. core-sidebar-tree — "a harness-created session appears once its session.lifecycle event arrives — behavior 15"
- **Status**: failing-everywhere
- **Tests**: a new session created by a non-opencode harness (e.g. codex-acp) shows up in the sidebar rail the moment its `session.lifecycle` "created" event arrives, without a reload.
- **Expected**: the new row renders within ~15s of the event.
- **Why**: real product bug. The lifecycle `created` event refetches the flat inventory (`GET /api/control/sessions`, verified 3 refetches) but never the paginated per-section query (`GET /api/control/session-list`) that actually feeds the rendered rail rows — the row only appears after reload. Spec at `core-sidebar-tree.spec.ts:864`.
- **Options**:
  - **A (recommended)**: app — invalidate/refetch the `session-list` query on `session.lifecycle` events. S/M.
  - **B**: spec — assert only the flat-inventory refetch effect (weakens the test; no longer proves the user-visible row appears).
  - **C**: accept as a known limitation (users must reload to see harness-created sessions — poor UX).
- **Decision**: _(owner fills in)_

### 2. core-workgraph — "executes GitHub, Linear, and Jira issues through real Session V2 Connections end to end"
- **Status**: failing-CI-only (workgraph-real job; the other 3 tests in that job pass)
- **Tests**: a full personal WorkGraph journey that runs GitHub, Linear, and Jira issues through real Session V2 Connections.
- **Expected**: the journey completes end to end.
- **Why**: the shared `beforeEach` (`core-workgraph.spec.ts:27`) times out at **240000ms** for this one test — it boots a separate production OpenCode process + native harness + the real Connections env, and never reaches ready within 4 min. The 3 sibling "real Session V2" tests share the same hook and pass, so the delta is specific to what this test's Connections setup requires. Failed on all 3 attempts (2 retries).
- **Options**:
  - **A (recommended)**: diagnose the `beforeEach` stall (download the `playwright-workgraph-real` artifact's `error-context.md`/trace for this test), then fix the setup or raise the hook budget honestly. M.
  - **B**: `test.fixme` until after launch with a "beforeEach 240s timeout, Connections env boot" note.
- **Decision**: _(owner fills in)_

### 3. core-harness-rendering-matrix — "pi — shares the native rendering path (text renders) — behavior 1"
- **Status**: failing-everywhere
- **Tests**: the `pi` harness renders injected assistant text through the native rendering path (same as other harnesses).
- **Expected**: first send resolves and the text renders.
- **Why**: the harness selector's `picked()` (`src/features/session/ui/controls/agent-harness-selector.tsx:~231`) deliberately excludes `pi` from the bare-id model fallback, so `pi` never auto-picks a model; the composer's model control does not render in pi mode either, so the spec can't pick one via `[data-action="prompt-model"]` (verified — it times out). First send defers forever. Spec at `core-harness-rendering-matrix.spec.ts:702`.
- **Options**:
  - **A (recommended)**: app — give `pi` a default-model auto-pick path, or render the model control in pi mode (selector owner decides semantics). M.
  - **B**: app — expose pi model selection in whatever UI is intended and update the spec choreography to drive it. M.
  - **C**: remove `pi` from the rendering matrix until pi model UX is designed. S.
- **Decision**: _(owner fills in)_

### 4. core-settings-auth — "/cli-login behaviors 28 & 29" (exchange CLI token / exchange-failure error)
- **Status**: failing under the production build only (pass under dev serving)
- **Tests**: 28 (`:1573`) — a signed visitor with valid params exchanges the browser token for a CLI token and auto-submits the callback form; 29 (`:1611`) — an exchange failure surfaces the server's error message and never submits.
- **Expected**: 28 submits the callback form; 29 renders the mocked error text.
- **Why**: reproduced locally under a full prod-env boot, so **not** the VITE-flag issue that fixed behaviors 2,4,21–25 (that separate fix is what the in-progress `f02e6b934d` run bakes). Symptom for 29: the mocked error message text never renders in the built bundle. Undiagnosed prod-build delta — suspect error-surface rendering or timing in the production bundle.
- **Options**:
  - **A (recommended)**: diagnose properly under prebuilt serving (trace the built bundle), then fix at the honest layer. M.
  - **B**: `test.fixme` both with a "prebuilt-delta, undiagnosed" note until someone can trace it.
  - **C**: run just these two under dev serving in CI (split-mode hack) — dishonest: it hides a real prod-only regression. Not recommended.
- **Decision**: _(owner fills in)_

### 5. documents-core — "repository index is metadata-only and edits file in place without a managed copy — behavior 2"
- **Status**: failing-everywhere
- **Tests**: the Documents index treats the repository as metadata-only and edits files in place (no managed copy), via a repository-importer UI on the index.
- **Expected**: (as written) the index carries a repository importer.
- **Why**: the repository-importer UI was **intentionally removed** from the Documents index (commit `76953781d7`; the unit test `document-index.vitest.tsx` now asserts it "does not carry a repository importer"). The flow moved to a per-file "Add to Documents" icon on the Markdown file tab (`src/app/workbench/content/tab-file.tsx`). The spec asserts the old surface. Spec at `documents-core.spec.ts:703`.
- **Options**:
  - **A (recommended)**: rewrite the spec against the new per-file "Add to Documents" flow. M.
  - **B**: delete the test if behavior 2's contract is now obsolete.
  - **C**: `test.fixme` with a "Documents surface in flux" note until Documents settles.
- **Decision**: _(owner fills in)_

### 6. core-cloud-offline-roles — reconnect-overlay pair (behaviors 4, 6/7)
- **Status**: failing-CI-only (still red on the 12-shard × 2-worker tune)
- **Tests**: b4 (`:631`) — `ready → reconnecting → ready` never raises a toast and resumes without reload; b6/7 (`:674`) — arm-once: ready content survives a same-key reconnect and the overlay reappears on top.
- **Expected**: both pass; they pass locally.
- **Why**: pass locally, failed in CI at 8×4; the 12×2 tune did **not** clear them (both still listed under "2 failed" in shard 1/12). Suspected runner-contention timing, not a source diagnosis.
- **Options**:
  - **A (recommended)**: per-test timing hardening (widen the reconnect/toast-absence polls, reduce reliance on wall-clock cadence), then re-run. M.
  - **B**: quarantine as flaky with a tracking issue and re-enable once runner contention is understood.
- **Decision**: _(owner fills in)_

### 7. core-user-hosted-workspace — ready-send + Share pair (behaviors 2/3, 7)
- **Status**: failing-CI-only (still red on the 12-shard × 2-worker tune)
- **Tests**: b2/3 (`:668`) — ready unlocks the composer and a send is proven by the oracle through the relay lane; b7 (`:798`) — the in-app "Share workspace" entry point registers the workspace and shows a confirmation toast.
- **Expected**: both pass; they pass locally.
- **Why**: pass locally, failed in CI at 8×4; the 12×2 tune did **not** clear them (both under "1 failed"/listed in shard 11/12). Suspected runner-contention timing.
- **Options**:
  - **A (recommended)**: per-test timing hardening (the oracle-send and toast waits are the likely victims of a starved runner). M.
  - **B**: quarantine as flaky with tracking, re-enable after contention fix.
- **Decision**: _(owner fills in)_

### 8. core-sidebar-tree — "account footer exposes utilities and restores focus across nested panels"
- **Status**: failing-CI-only (still red on the 12-shard × 2-worker tune)
- **Tests**: the sidebar account footer opens its utility panels and restores focus correctly when navigating nested panels.
- **Expected**: passes; it passes locally.
- **Why**: pass locally, failed in CI at 8×4; still red in the 12×2 tune (shard 9/12, "2 failed", 2 retries). Focus-restoration assertions are timing-sensitive under contention. Spec at `core-sidebar-tree.spec.ts:726`.
- **Options**:
  - **A (recommended)**: harden the focus-restore assertions (await focus transitions explicitly rather than on a fixed budget). M.
  - **B**: quarantine as flaky with tracking, re-enable after contention fix.
- **Decision**: _(owner fills in)_

---

## 2. Skipped (`test.fixme`) — needs a decision

Ordered by user impact: confirmed real app bugs first, then dead/unreachable UI, then harness/out-of-scope test-seam gaps.

### 9. core-panes-split-tabs — switcher status dot (behaviors 11 & 12)
- **Status**: skipped (test.fixme, `:703` + `:740`)
- **Tests**: a busy background tab shows an amber "working" dot that clears on focus (11); a settled background tab shows a "done" dot cleared on focus (12).
- **Expected**: the switcher dot tracks status changes for a backgrounded tab.
- **Why**: real app bug (both fixmes share one root cause, cross-referenced in-file). The status query cache updates correctly, but `useRailHeaderSurfaces`'s `switcherItems` memo (`src/claxedo-ui/layouts/rail-header-surfaces.ts:110-136`, built on `useQueries(..., {enabled:false})`) never re-renders off the **second** external `setQueryData` write for a never-focused tab — a solid-query `enabled:false` + external-write reactivity gap. The dot flips once (first transition) then freezes.
- **Options**:
  - **A (recommended)**: app — make `switcherItems` react to external cache writes (drop `enabled:false`, or subscribe to the status query). M.
  - **B**: keep fixme as a launch-known-issue (background dots are cosmetic).
  - **C**: delete both if the switcher dot is being removed.
- **Decision**: _(owner fills in)_

### 10. core-panes-split-tabs — "empty workbench auto-opens a draft, and closing it suppresses the immediate re-open — behavior 15"
- **Status**: skipped (test.fixme, `:826`)
- **Tests**: closing the sole auto-opened draft should suppress the auto-reopen for 2s.
- **Expected**: a 2s suppression window after the user closes the last draft.
- **Why**: real app bug, confirmed via 10ms in-browser sampling. Closing the draft's X is followed by a brand-new draft contentId within ~80-100ms; the `blockNextAutoOpen()`/2s window in `rail-empty-draft-controller.ts` never engages (either `onLastFocusedSurfaceClosed` doesn't reach it, or the effect ignores the suppression flag).
- **Options**:
  - **A (recommended)**: app — fix the suppression wiring so the close path honors `blockedUntil`. S/M.
  - **B**: keep fixme as a known-issue (mild UX churn, not data loss).
  - **C**: drop the "suppression window" from the behavior spec if product decides immediate reopen is fine — then delete.
- **Decision**: _(owner fills in)_

### 11. core-sidebar-tree — rail-width collapse/resize (behaviors 13, 11, 12)
- **Status**: skipped (test.fixme, `:938` + `:959` + `:973`)
- **Tests**: sidebar-toggle collapses/expands the rail width (13); hot-zone peek expands an unpinned collapsed rail then auto-collapses (11); drag-resizing the handle changes width live and persists (12).
- **Expected**: the rail's width reflects toggle/peek/drag.
- **Why**: one real app bug behind all three (cross-referenced in-file). `railToggleCommand` (`src/shell/layout/commands.ts:31-43`) dispatches both `docked` and `size` on the rail region, but `sidebarWidth()` (`src/shell/app-shell-layout.tsx:229`) never reflects the dispatched `size.value` — `docked` flips, width stays frozen at 260px. Hot-zone (11) and drag-resize (12) read/write the same accessor, so they're blocked by the same defect.
- **Options**:
  - **A (recommended)**: app — fix `size` propagation through the rail-region dispatch; all three tests re-enable together. M.
  - **B**: keep all three fixme as one launch-known-issue.
  - **C**: n/a (these are real behaviors, deletion not defensible).
- **Decision**: _(owner fills in)_

### 12. core-sidebar-tree — "mobile drawer opens on entry, scrim-closes, and closes on session select — behavior 14"
- **Status**: skipped (test.fixme, `:993`)
- **Tests**: the mobile sidebar drawer opens, closes on scrim tap, and closes on session select.
- **Expected**: a working mobile drawer.
- **Why**: dead code. `mobileSidebarOpen` (`rail-shell-chrome-state.ts:18`) has no production call site that sets it `true` — only `closeMobileSidebar` is wired; and `RailSidebar`'s `onSessionSelect` prop (`rail-sidebar.tsx:212`) is declared but never invoked. No UI action opens the drawer today.
- **Options**:
  - **A**: app — wire a mobile entry point (tap/swipe) so the drawer is reachable. M.
  - **B**: keep fixme until mobile nav is designed.
  - **C (recommended if mobile drawer is not on the roadmap)**: delete the test and the dead drawer code.
- **Decision**: _(owner fills in)_

### 13. core-composer-modes — "the sent (optimistic) user message highlights an inline agent mention — behavior 11"
- **Status**: skipped (test.fixme, `:538`)
- **Tests**: an `@agent` mention in a just-sent user message renders a highlighted span.
- **Expected**: the optimistic user row shows a `[data-highlight="agent"]` span.
- **Why**: real bug. The mention pill inserts fine and the text reaches the server, but `src/shell/chat/opencode-conversation.ts:217-265,325-369` has no `"agent"` case, so the agent part is silently dropped in the raw-Part ↔ UIMessage projection; the rendering half is implemented and correct.
- **Options**:
  - **A (recommended)**: app — add the `"agent"` case to the part projection. S/M.
  - **B**: keep fixme (mention highlighting is cosmetic).
  - **C**: delete if inline agent-mention highlighting is dropped from scope.
- **Decision**: _(owner fills in)_

### 14. core-composer-modes — "Escape aborts an in-flight turn when not in shell mode and no popover is open — behavior 8"
- **Status**: skipped (test.fixme, `:431`)
- **Tests**: pressing Escape aborts an in-flight turn on a fresh draft-created session.
- **Expected**: Escape triggers the abort request.
- **Why**: INVARIANTS #4 ("submit control is the single source of truth for busy") is violated on the fresh-draft→session transition — the busy signal never reaches this composer instance via any path (REST poll route was never even hit), so Escape has no in-flight turn to abort from the composer's view.
- **Options**:
  - **A (recommended)**: app — fix busy-state propagation to the composer on the draft→session transition; then this and related busy tests re-enable. M.
  - **B**: keep fixme until the busy-source-of-truth gap is fixed.
  - **C**: n/a (real behavior).
- **Decision**: _(owner fills in)_

### 15. core-composer-modes — "comment-linked context chips are hidden while shell mode is active — behavior 19"
- **Status**: skipped (test.fixme, `:690`)
- **Tests**: context chips linked to a code comment are hidden when the composer is in shell mode (gating at `composer.tsx:388-392`).
- **Expected**: comment-bearing context items filtered out in shell mode.
- **Why**: not an app bug — inserting a comment-linked context item requires a real code-editor line selection (`tab-file.tsx`/`review-tab.tsx` or `context.addSelection`), machinery this composer-focused spec doesn't stand up; it belongs to the file/diff specs.
- **Options**:
  - **A (recommended)**: move the assertion into a file/diff spec that already has a line-comment surface. S/M.
  - **B**: keep fixme as a documented cross-spec seam.
  - **C**: delete (the gating is unit-testable at `composer.tsx` level instead).
- **Decision**: _(owner fills in)_

### 16. core-workspace-lifecycle — New workspace Local/Cloud flow (behaviors 8, 9, cloud dialog)
- **Status**: skipped (test.fixme, `:544` + `:560` + `:576`)
- **Tests**: the "New workspace" Local/Cloud dialog has a reachable trigger (8); direct local-worktree creation (`handleNewWorkspace`) completes (9); the cloud create dialog runs its provider-select/pipeline/error flow (8, cloud half).
- **Expected**: a working New-workspace-within-a-project flow.
- **Why**: real bugs + dead code (interlinked). `onNewWorkspace` is threaded from `app-shell.tsx:101` down to `rail-sidebar.tsx:215` but **never called** from any handler — `DialogNewProject`'s Local/Cloud picker is dead from the UI. Independently, `onWorktreeCreated(..., wait=true)` (`project-actions.tsx:176-193`) awaits `WorktreeState.wait` with no timeout, and there are zero `.ready()`/`.failed()` call sites outside tests — so even if triggered it hangs forever. The cloud dialog is only reachable via the same dead trigger.
- **Options**:
  - **A (recommended)**: app — wire the trigger AND add a timeout/resolution path to the worktree wait; re-enable all three. M/L.
  - **B**: keep fixme until New-workspace is prioritized.
  - **C**: delete the dead Local/Cloud picker code and tests if the feature is cut.
- **Decision**: _(owner fills in)_

### 17. core-settings-auth — "Log out signs out and navigates to /login — behavior 5"
- **Status**: skipped (test.fixme, `:883`)
- **Tests**: clicking Log out signs out and lands on `/login`.
- **Expected**: sign-out purges auth state and navigates to `/login`.
- **Why**: unreachable in-harness **plus** a real app bug. (1) Under Playwright (`navigator.webdriver===true`) `isSignedIn()` (`auth-client.ts:295`) is unconditionally true, so `/login`'s redirect-if-signed guard bounces straight back. (2) Real bug: `initializeClerk()`'s test-bypass branch (`auth-client.ts:164-173`) never sets `clerkLoadPromise`, so `signOut()` no-ops at line 308 — sign-out under the dev/test bypass never purges persisted auth state (reproduced: a marker survives Log-out).
- **Options**:
  - **A (recommended)**: app — fix `signOut()` so the bypass path purges state; add an `/__e2e` hook or non-webdriver mode to make it drivable. M.
  - **B**: keep fixme, file the sign-out no-op as its own bug.
  - **C**: delete the e2e assertion, cover sign-out at the unit level only.
- **Decision**: _(owner fills in)_

### 18. core-settings-auth — Sandbox tab + local-principal (baked-flag unreachables)
- **Status**: skipped (test.fixme, `:810` + `:878`)
- **Tests**: the Sandbox settings tab is absent when `sandboxEnabled` is false (`:810`); the account section is hidden entirely for a `local` principal (`:878`).
- **Expected**: negative-path rendering when the flag is off.
- **Why**: unreachable — `VITE_SANDBOX_ENABLED` and `VITE_AUTH_ENABLED` are baked true at Vite start for the whole shared dev server (`.env.local`), not flippable per-spec. Reaching `principal.kind==="local"` needs `authEnabled=false`, and the Sandbox-absent path needs `sandboxEnabled=false` — neither is settable from a spec.
- **Options**:
  - **A (recommended)**: add a per-spec/per-project build variant (or runtime override) that flips these VITE flags, then implement both. M.
  - **B**: keep fixme as documented baked-flag gaps.
  - **C**: delete — the flag-off branches are covered by reading source; low value without a build variant.
- **Decision**: _(owner fills in)_

### 19. core-settings-auth — "an anonymous principal on a non-loopback transport is force-redirected to /login — behavior 31-ish"
- **Status**: skipped (test.fixme, `:1653`)
- **Tests**: an anonymous principal on a non-loopback transport is redirected to `/login` with a loading placeholder (CloudAuthGate).
- **Expected**: force-redirect for non-loopback anonymous sessions.
- **Why**: unreachable — CloudAuthGate's `server.url` traces to `getClaxedoServerUrl()`, hardcoded to the build-time `VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3001` (always loopback) for the shared dev server; nothing settable at request time flips the resolved default server.
- **Options**:
  - **A (recommended)**: expose a runtime server-URL override for tests (or a dedicated non-loopback harness), then implement. M.
  - **B**: keep fixme as a baked-URL gap.
  - **C**: delete — covered by reading the gate source.
- **Decision**: _(owner fills in)_

### 20. core-settings-auth — "InitError variants render their formatted chain with Restart — error page"
- **Status**: skipped (test.fixme, `:1660`)
- **Tests**: the top-level ErrorBoundary fallback renders InitError variants with the formatted chain + Restart (no Check-for-updates on web).
- **Expected**: a rendered error page for each InitError variant.
- **Why**: unreachable — unlike the dialog matrix (`/__e2e/dialog-matrix`), there is no analogous `/__e2e/error-page?variant=...` crash-injection route, so there is no deterministic black-box trigger for the ErrorBoundary. The in-file note recommends adding one.
- **Options**:
  - **A (recommended)**: add an `/__e2e/error-page?variant=...` injection route, then implement. S/M.
  - **B**: keep fixme until the injection route exists.
  - **C**: delete — cover ErrorPage formatting via a component/unit test.
- **Decision**: _(owner fills in)_

### 21. core-settings-auth — "double-submit guard: a reactive re-trigger never re-exchanges"
- **Status**: skipped (test.fixme, `:1636`)
- **Tests**: after a successful `/cli-login` exchange, a reactive re-trigger never re-runs the exchange (guarded by `if (submitted()) return`, `cli-login.tsx:99-100`).
- **Expected**: the guard blocks a re-entrant exchange.
- **Why**: not black-box triggerable — the guard sits in a `createEffect` keyed on `location.search`/`auth.status()`, neither of which changes again after the first run in a normal SPA nav; there's no external trigger without an app-exposed test hook or white-box reactive poking, which this suite avoids.
- **Options**:
  - **A**: add a minimal app-exposed re-trigger hook for the test, then implement. S/M.
  - **B (recommended)**: keep fixme — the guard is unit-testable; a black-box e2e adds little.
  - **C**: delete and cover at the unit level.
- **Decision**: _(owner fills in)_

### 22. core-processes — "a process crashing after launch lights the toolbar attention dot — behavior 10 (attention-dot half)"
- **Status**: skipped (test.fixme, `:1166`)
- **Tests**: a process that crashes after launch lights the toolbar attention dot on the next reconcile.
- **Expected**: the attention dot appears on crash.
- **Why**: the fixme flags a nearby real defect — `process-pane.tsx:990-994`'s `onCleanup(() => setCrashed(dir, false))` fires unconditionally on any `ProcessPaneProvider` unmount, clobbering crash state when the panel is visited then closed. The attention-dot-on-reconcile half isn't reproduced here.
- **Options**:
  - **A (recommended)**: app — make the crash-state cleanup conditional, then assert the attention dot. M.
  - **B**: keep fixme, file the unmount-clobber as its own bug.
  - **C**: n/a (real behavior).
- **Decision**: _(owner fills in)_

### 23. core-processes — "diagnostics dialog opens, shows tabs/health/metrics, lists a running managed process — behavior 17"
- **Status**: skipped (test.fixme, `:1377`)
- **Tests**: the account-menu "Diagnostics" item opens a dialog with health/metrics tabs listing a running managed process.
- **Expected**: the Diagnostics dialog is reachable and populated.
- **Why**: unreachable — the "Diagnostics" menu item is gated by `platform==="desktop" || sandboxEnabled!==true` (`rail-account-menu.tsx`); this harness bakes `VITE_SANDBOX_ENABLED=true` and runs the web platform, so the item never renders (verified live). Same baked-flag class as entry 18.
- **Options**:
  - **A**: add the sandbox-flag build variant (see entry 18), then implement. M.
  - **B (recommended)**: keep fixme until a desktop or flag-off harness exists.
  - **C**: delete if Diagnostics stays desktop-only.
- **Decision**: _(owner fills in)_

### 24. core-processes — "viewer role hides Add/Start/Stop/Restart/Edit controls — behavior 18 (read-only half)"
- **Status**: skipped (test.fixme, `:1402`)
- **Tests**: a viewer-role workspace hides all process mutation controls.
- **Expected**: read-only process panel for viewers.
- **Why**: out of scope — role gating needs a live WorkspaceGate relay/cloud connection with a minted viewer token; reproducing it here would duplicate `core-cloud-offline-roles`' relay/role fixture rather than exercise anything Processes-specific.
- **Options**:
  - **A (recommended)**: fold the viewer-role Processes assertion into `core-cloud-offline-roles` (or a shared role fixture). M.
  - **B**: keep fixme as a documented cross-spec seam.
  - **C**: delete — role gating is generic, covered by the roles spec.
- **Decision**: _(owner fills in)_

### 25. core-processes — "project-shared process config is visible across two local workspaces, no leaks after stop"
- **Status**: skipped (test.fixme, `:1413`)
- **Tests**: a project-shared process config appears across two local workspaces with sibling port assignment and no port leaks after stop.
- **Expected**: shared config + no OS port leaks.
- **Why**: out of scope for a mocked HTTP layer — this is claxedo-server worktree-sharing + real OS port allocation, already covered live by `e2e-legacy/process-project-shared.spec.ts` (`CLAXEDO_PROCESS_PROJECT_SHARED_LIVE=1`). A mocked layer has no real port to leak.
- **Options**:
  - **A**: keep the live coverage as the source of truth; leave this as a pointer.
  - **B**: keep fixme with the live-spec cross-reference.
  - **C (recommended)**: delete — it duplicates a live spec and can't assert the real invariant.
- **Decision**: _(owner fills in)_

### 26. core-model-effort-agent-controls — "agent selector disabled-while-harnessPending is unreachable — behavior 7"
- **Status**: skipped (test.fixme, `:595`)
- **Tests**: the agent selector renders visible-but-disabled while the harness is pending.
- **Expected**: a visible, disabled agent selector during `harnessPending`.
- **Why**: unreachable — `showAgentSelector()` and `harnessPending()` are mutually exclusive in the current wiring (`composer.tsx:91-101`, `selector-visibility.ts`), so a visible-and-disabled agent selector cannot be produced through the public composer surface.
- **Options**:
  - **A**: app — if a disabled-during-pending state is intended, adjust `selector-visibility.ts` and implement. M.
  - **B (recommended)**: keep fixme — likely the state simply doesn't exist by design.
  - **C**: delete if the mutual exclusion is the intended contract.
- **Decision**: _(owner fills in)_

### 27. core-harness-ownership-local — "draft harness resets to OpenCode when directory changes away from a workspace-runtime ref — behavior 9"
- **Status**: skipped (test.fixme, `:818`)
- **Tests**: switching a draft's directory from a cloud/user-hosted ref to a plain local dir resets the harness to OpenCode.
- **Expected**: harness resets on the cloud→local directory transition.
- **Why**: not implementable in this local-only spec — `shouldResetWorkspaceDraftHarness` (`store-policy.ts:80-92`) only fires when a `cloud`/`user-hosted` backing exists; the local mock has no workspace-runtime ref. Belongs to `core-harness-ownership-cloud` (spec 12), which mounts the relay `/api/wr/*` routes.
- **Options**:
  - **A (recommended)**: move the assertion into `core-harness-ownership-cloud`. S/M.
  - **B**: keep fixme as a documented cross-spec seam.
  - **C**: delete (covered by the transition's unit logic).
- **Decision**: _(owner fills in)_

### 28. core-harness-rendering-matrix — "opencode native — compaction divider renders on the assistant timeline — behavior 7"
- **Status**: skipped (test.fixme, `:606`)
- **Tests**: a `part.type="compaction"` envelope renders the compaction divider on the assistant timeline.
- **Expected**: `[data-component="compaction-part"]` appears.
- **Why**: UNRESOLVED — the compaction envelope never reaches `[data-component="compaction-part"]` even though every other part in the same trace renders; possible collision with `session-turn.tsx`'s separate user-message compaction divider. Needs interactive store inspection the remediation pass lacked.
- **Options**:
  - **A (recommended)**: diagnose with devtools/store inspection, fix the assistant-timeline compaction path. M.
  - **B**: keep fixme with the "undiagnosed, store-inspection needed" note.
  - **C**: n/a (real behavior; deletion not defensible).
- **Decision**: _(owner fills in)_

### 29. core-harness-rendering-matrix — "claude-sdk (native) — reasoning part renders — behaviors 2,17"
- **Status**: skipped (test.fixme, `:847`)
- **Tests**: a native claude-sdk reasoning part renders and diagnostics add zero extra rows.
- **Expected**: `[data-component="reasoning-part"]` shows the reasoning text.
- **Why**: UNRESOLVED — the reasoning part text never reaches `[data-component="reasoning-part"]` despite a correctly-shaped `message.part.updated` + `.delta` pair (the same accumulator the sibling text part uses successfully). Gap is specific to reasoning-typed parts; needs interactive store inspection.
- **Options**:
  - **A (recommended)**: diagnose the reasoning-part accumulator path with store inspection, fix. M.
  - **B**: keep fixme with the "undiagnosed" note.
  - **C**: n/a (real behavior).
- **Decision**: _(owner fills in)_

### 30. core-harness-rendering-matrix — "assistant file-type parts (image/audio/resource-link) render — behavior 6"
- **Status**: skipped (test.fixme, `:908`)
- **Tests**: an assistant `file`-type part (image/audio data-url, resource link) renders with a dedicated component.
- **Expected**: the file part reaches the DOM.
- **Why**: real, source-verified gap — no `PART_MAPPING["file"]` is registered anywhere; `registerPartComponent` (`message-part.tsx:~947`) is exported but has **zero** call sites, so a `file`-type assistant part is silently dropped from `groupParts()`.
- **Options**:
  - **A (recommended)**: app — register a `file` part component. M.
  - **B**: keep fixme as a known rendering gap (file parts are rare today).
  - **C**: delete if assistant file parts are out of scope for launch.
- **Decision**: _(owner fills in)_

### 31. core-harness-rendering-matrix — "pi — one dedicated tool renderer (config.json subtitle) — behavior 3"
- **Status**: skipped (test.fixme, `:723`)
- **Tests**: a pi tool part renders through a dedicated tool renderer showing the config.json subtitle.
- **Expected**: a tool-type render for pi.
- **Why**: real fixture gap — `e2e/fixtures/harness-traces/pi.json`'s committed trace has no tool-type envelope at all (only text update/delta + reasoning). Hand-editing the fixture is forbidden (DoD #4: fixtures must be script-regenerated via `bun run e2e/fixtures/generate-harness-fixtures.ts`), which was out of the remediation's safe scope.
- **Options**:
  - **A (recommended)**: regenerate `pi.json` with a tool envelope via the generator script, then implement. M.
  - **B**: keep fixme until the fixture is regenerated.
  - **C**: delete if pi tool rendering isn't a launch requirement (see also entry 3).
- **Decision**: _(owner fills in)_

### 32. core-boot-deep-links-home — "Home lists recent projects and Open project opens the platform dialog — behavior 3"
- **Status**: skipped (test.fixme, `:551`)
- **Tests**: `/` shows a "Recent projects" list and "Open project" opens the platform directory dialog.
- **Expected**: a recents list + Open-project dialog on Home.
- **Why**: there is no reachable "recent projects" list anywhere in the current UI to assert against; the real "+New project" flow (`project-actions.tsx:96-150`) always opens `DialogSelectDirectory`, and this build ships `VITE_SANDBOX_ENABLED=true` so it takes the cloud-project branch — directory-dialog coverage lives in `core-workspace-lifecycle` per this spec's OUT OF SCOPE.
- **Options**:
  - **A**: app — if a recents list is intended on Home, build it, then implement. M.
  - **B (recommended)**: keep fixme until Home's recents UX is decided.
  - **C**: delete — the recents list may be a retired concept; dialog coverage lives elsewhere.
- **Decision**: _(owner fills in)_

### 33. core-busy-abort-errors — "escalation ladder reaches the failed/unresponsive stage with Cancel and Retry — behavior 8"
- **Status**: skipped (test.fixme, `:987`)
- **Tests**: the status escalation ladder reaches the "failed/unresponsive" stage with Cancel and Retry.
- **Expected**: the failed stage renders with Cancel/Retry.
- **Why**: `OPTIMISTIC_STATUS_FAILURE_MS = 5*60_000` (`session-status-dispatcher.ts:15`) — reaching "failed" costs 5 min wall-clock, impractical for a CI-speed mocked spec. The mechanism is identical to the pending/long stages already proven; only wall-clock distance differs.
- **Options**:
  - **A (recommended)**: add a test-only env knob to scale down the `OPTIMISTIC_STATUS_*_MS` timers (gated), then implement. S/M.
  - **B**: drive the page with Playwright `page.clock` (risky — also freezes the mock's SSE reconnect backoff; needs careful choreography).
  - **C**: keep fixme — the failed stage shares code with the proven pending/long stages.
- **Decision**: _(owner fills in)_

### 34. core-cloud-offline-roles — "a role that live-flips (viewer → editor) unlocks the composer in place, no reload — behavior 9"
- **Status**: skipped (test.fixme, `:797`)
- **Tests**: a near-expiry viewer token that refreshes into an editor role unlocks the composer in place without reload.
- **Expected**: the composer unlocks when a token refresh reports `editor`.
- **Why**: depends on precise timing between the near-expiry token (500ms) and the app's own post-ready relay traffic triggering a refresh inside the 60s window — a fragile choreography the in-file note pins rather than lands. (Real behavior; harness-timing gap, not a source diagnosis.)
- **Options**:
  - **A (recommended)**: harden the fixture so the refresh→role-flip is deterministic (control the mint/refresh sequencing), then implement. M.
  - **B**: keep fixme until the role-refresh fixture is deterministic.
  - **C**: n/a (real behavior).
- **Decision**: _(owner fills in)_

### 35. core-session-actions — "a permission raised on the child bubbles into the parent's dock and resolves — behavior 14"
- **Status**: skipped (test.fixme(true), `:915`)
- **Tests**: a permission raised on a child session surfaces in the parent's composer dock and can be resolved.
- **Expected**: `[data-slot="permission-header-title"]` appears in the parent dock.
- **Why**: shared-mock/app-architecture gap (verified live). Synthetic SSE `directory` is remapped by `eventDirectoryForLiveSession` (`global-sdk.tsx:72-82`) to the route's resolved workspaceId, then checked against `children.has(directory)` (`event-ingress.ts:103`) before the cache-only permission path runs — the remapped id isn't a key `children` tracks, so the dock never populates for a hand-rolled parent/child fixture that never went through the real create-session flow.
- **Options**:
  - **A (recommended)**: extend the shared mock to deliver directory/workspaceId-consistent events (or control the resolved workspaceId so the remap is a no-op). M/L.
  - **B**: keep fixme until the mock mirrors the real event-delivery pipeline.
  - **C**: n/a (real behavior).
- **Decision**: _(owner fills in)_

### 36. core-session-actions — "title syncs to a second open pane's tab label without reload" (unreachable UI)
- **Status**: skipped (test.fixme(true), `:1124`)
- **Tests**: renaming a session updates a second open pane's tab label live.
- **Expected**: the second pane's tab label updates without reload.
- **Why**: no mounted UI surface shows a second open session's title live — the tab strip (`titlebar.tsx TabNavItem`) is never rendered (`app-shell.tsx:115` has `titlebar={<Titlebar />}` commented out), and there's no labelled/keyboard split-creation command in `rail-keyboard-commands.ts`.
- **Options**:
  - **A**: app — wire the titlebar back in (or add a stable split-creation affordance) so the spec can drive it. M.
  - **B (recommended)**: keep fixme until the titlebar/tab-strip is re-enabled.
  - **C**: delete if the multi-pane title-sync surface is not planned.
- **Decision**: _(owner fills in)_

### 37. core-panes-split-tabs — "mod+w on the last remaining pane opens the desktop Quit dialog — behavior 6"
- **Status**: skipped (test.fixme, `:591`)
- **Tests**: `mod+w` on the last pane opens the desktop Quit dialog.
- **Expected**: the Quit dialog on last-pane close.
- **Why**: unreachable — this web target hardcodes `platform:'web'` (`main.tsx:41-46`) with no `quit` handler; `rail-keyboard-controller.tsx:27`'s `platform==="desktop"` branch can never be entered from this tier.
- **Options**:
  - **A**: add a desktop/Electron-platform e2e tier, then implement. L.
  - **B (recommended)**: keep fixme — desktop-only, no web tier can reach it.
  - **C**: delete the e2e assertion; cover in a desktop smoke test.
- **Decision**: _(owner fills in)_

### 38. core-panes-split-tabs — "a 2-pane split survives a full reload on a non-owning URL — behavior 14"
- **Status**: skipped (test.fixme, `:778`)
- **Tests**: a draft+terminal 2-pane split survives a full reload while parked on a bare non-owning URL.
- **Expected**: both panes rehydrate after reload.
- **Why**: not reachable with this spec's single-session+one-terminal harness. Terminal creation always syncs the URL to the terminal's owning route, and the drag-split is only possible after the terminal exists, so there's no path to a 2-pane split on a non-owning URL. A forced `page.goto` exposes a separate terminal-`ContentMeta`-doesn't-survive-rehydration gap that belongs to `core-terminal`.
- **Options**:
  - **A**: build a multi-terminal / seeded-layout fixture in `core-terminal`, then assert reload survival there. M.
  - **B (recommended)**: keep fixme and route the terminal-metadata-survival gap to `core-terminal`.
  - **C**: delete — the underlying persistence is covered by other reload tests.
- **Decision**: _(owner fills in)_

### 39. core-turns-reload-recovery — "a forced dispatch failure restores a context-item chip into the composer — behavior 8"
- **Status**: skipped (test.fixme, `:532`)
- **Tests**: a dispatch failure rolls a context-item chip back into the composer.
- **Expected**: the chip reappears after a failed send.
- **Why**: not an app bug — inserting a context-item chip needs the @-mention file-search wiring the shared mock doesn't stub (no `/find/file`-equivalent route); that's `core-composer-modes`' territory. The rollback mechanism itself is proven generically by the text+attachment case (`submit.ts` treats all context items uniformly).
- **Options**:
  - **A (recommended)**: reuse the @-mention route stubs once `core-composer-modes` owns them, then implement. M.
  - **B**: keep fixme as a documented shared-seam gap.
  - **C**: delete — the rollback is already proven generically.
- **Decision**: _(owner fills in)_

### 40. core-terminal — "a stale process-owned terminal tab is pruned instead of resurrected on reload — behavior 12"
- **Status**: skipped (test.fixme, `:1088`)
- **Tests**: a stale process-owned terminal tab is pruned (not resurrected) on reload.
- **Expected**: the orphaned process-terminal tab is removed.
- **Why**: out of scope — pruning only runs when the Process feature's `fetchProcesses()` resolves (`GET /api/wr/process`), which needs spec 20's Process panel mocks + a matching persisted `terminal.owner["process:<configId>"]` seed — genuinely `core-processes` territory. The store op (`terminal.removeStale`) is already unit-covered (`terminal-zombie.test.ts`).
- **Options**:
  - **A (recommended)**: move the assertion into `core-processes` where the Process mocks exist. M.
  - **B**: keep fixme with the cross-spec + unit-coverage note.
  - **C**: delete — the store logic is unit-tested.
- **Decision**: _(owner fills in)_

### 41. mobile-smoke — "multipane split and pane/tab/session drag-reorder have a touch equivalent — behavior 4"
- **Status**: skipped (test.fixme, `:290`)
- **Tests**: touch drag-reorder works for panes/tabs/sessions on a phone viewport.
- **Expected**: touch-drag produces a split / reorder.
- **Why**: the pointer-drag engine ships and is unit-proven (`pointer-drag.ts`, `pointer-drag.vitest.tsx`), but there's **no assertable surface at phone width** in this harness: below `BP_MD` (768) a split renders as one full-bleed pane (geometry unobservable), the compact switcher renders zero tabs with a single session, and the sidebar lists zero rows (empty mock session list). CDP touch input itself works — the block is surface availability, not touch.
- **Options**:
  - **A (recommended)**: add a tablet-width (≥768) project + a pre-seeded multi-surface fixture (2 panes or 2+ tabs), then assert `drop-target-*` + split geometry via CDP touch. M.
  - **B**: keep fixme until the fixture convention for multi-surface seeding is decided.
  - **C**: n/a (engine is real; this is a coverage gap, not deletable behavior).
- **Decision**: _(owner fills in)_

---

## 3. Live-suite skips (not in core CI)

These four `*.spec.ts` suites are gated behind `CLAXEDO_E2E_LIVE=1` (Tier L: real claxedo-server, real relay/tunnel, real MCP subprocess, real harness binaries) and do **not** run in core CI. Within them, the following bodies are `test.fixme` (real app bug/gap) or `test.skip` (missing prereq). Listed for triage; not blocking core CI.

| Spec / line | Test | Why off | Recommendation |
| --- | --- | --- | --- |
| live-claxedo-mcp-tools `:547` | process tool add/update/remove hit the wrong path and 404 — behavior 5 | REAL BUG: `process-handler.ts:275/299/311` POST/PUT/DELETE to bare `/process` instead of `/api/wr/process` (list/start/stop use the right `PROCESS_PATH`); the package's own unit test asserts the wrong path, hiding it | app fix in `process-handler.ts`; correct the unit test |
| live-claxedo-mcp-tools `:739` | summarize_logs never surfaces a raw JSON-parse crash — behavior 10b | REAL BUG: `server.ts:66-67` `JSON.parse`s the body before checking `res.ok`; fallback `GET /session/:id/message/:messageId` (`:637-645`) is a 404 route — `JSON.parse("404 Not Found")` throws a raw SyntaxError | app fix: check `res.ok` first; fix/remove the dead fallback route |
| live-claxedo-mcp-tools `:409/:825` | describe/beforeAll gates | `test.skip(!LIVE)` Tier L gate; inner `:825` skip on missing prereq | keep as loud env-gated skips |
| live-agent-extensions-materialization `:726` | disable/enable a package via the marketplace UI — behavior 6 | REAL GAP: no disable/enable control in `marketplace-panel.tsx` `InstallButton` (only Install/Uninstall); server capability exists + is unit-tested | app: add the UI control, or delete the UI-driven test and keep unit coverage |
| live-agent-extensions-materialization `:735` | install a Cursor plugin via the marketplace UI — behavior 7 | REAL GAP: no catalog entry with `kind:"plugin"` and no free-text install-by-source affordance | app: add plugin catalog/entry surface, or defer |
| live-agent-extensions-materialization `:744` | adopt a discovered item via the marketplace UI — behavior 8 | REAL GAP: `DiscoveredSection` has only a top-level Dismiss; no per-item Adopt/Ignore though the server implements both | app: add per-item Adopt/Ignore controls |
| live-agent-extensions-materialization `:463/:756` | cloud-half / gates | `test.skip` on `CLAXEDO_ENABLE_DOCKER_SANDBOX=1` (+ built sandbox image/authority wiring) | keep as env-gated skip; implement once docker sandbox lands |
| live-real-harness-smoke `:595` | codex native SDK completes 3 turns + survives reload — behavior 5 | REAL BUG: against codex-cli 0.143.0 every `turn/start` fails `thread not found` for the uuid `thread/start` just returned (`driver.ts:78-92,160-174`); `codex-acp` mode works | app: fix the native codex driver thread lifecycle |
| live-real-harness-smoke `:517/:556/:569/:584` | Tier L + missing-binary gates | `test.skip(!LIVE)` and per-binary `test.skip(!claude/!codex on PATH)` | keep as loud named skips |
| live-user-hosted-relay `:795` | prompt through the relay lane completes a real turn — behavior 3 | REAL GAP: a fresh DRAFT nav to `/w/:workspaceId/session` for a `ws_`-shaped id renders the Local/Cloud draft picker and mis-routes through the CLOUD pipeline instead of the user-hosted gate (`session-new-workspace-options.ts` / `WorkspaceGate` mount order) | app: resolve inventory kind before rendering the Local/Cloud draft picker for a known relay-backed id |
| live-user-hosted-relay `:880` | pause/resume the real host tunnel surfaces offline + Retry — behaviors 5,6 | BLOCKED by behavior 3's gap (gate can't reliably reach the genuine ready state for the draft-nav pattern); the tunnel lifecycle itself is proven real | fix behavior 3 first, then re-enable |
| live-user-hosted-relay `:931` | near-expiry token triggers a real refresh, workspace stays usable — behavior 4 | UNCONFIRMED (not disproven): no `POST .../connection/refresh` observed within 20s once the gate reached ready; a different, narrower gap than 3/5/6 | diagnose the refresh trigger timing; distinguish from the draft-nav gaps |
| live-user-hosted-relay `:682/:904` | Tier L + TTL gates | `test.skip(!LIVE)` describe gates (main + token-refresh block with shortened TTL) | keep as env-gated skips |
