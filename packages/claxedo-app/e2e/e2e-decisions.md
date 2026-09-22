# E2E test decisions register

> Archived register as of 2026-07-20, restored here from git history because
> specs and tests cite its numbered decisions (`e2e/e2e-decisions.md #N`). Line
> numbers and CI evidence inside are frozen at that date.

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

### 7. core-host-tunnel-workspace — ready-send + Share pair (behaviors 2/3, 7)
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
- **Status**: fixed — enabled and green 3× per auth mode, zero retries (Tier M, `local-unsigned` + `test-user`, 2026-09-14)
- **Tests**: an `@agent` mention in a just-sent user message renders a highlighted span (`:382`); neighbors `@ mention popover keyboard nav` (`:349`) and `draft/pill/reload` (`:518`) green in the same matrix.
- **Expected**: the optimistic user row shows a `[data-highlight="agent"]` span.
- **Why**: real bug. The projection half the entry blamed was already repaired by the other lane (`features/session/conversation/agent-conversation-codec.ts` carries `agent` parts through the raw-Part ↔ UIMessage boundary, and `build-request-parts.ts`/`prepare-request.ts` mint the optimistic part with source offsets; `session-ui`'s `HighlightedText` renders the span). The remaining live blockers were upstream of the assertion: (a) `session-selection`'s `agent.list` strips `mode === "subagent"` for the primary-agent selector and the composer fed that same list to the `@` popover, so pure subagents could never be mentioned — fixed by exposing `agent.catalog` (unfiltered rows) to the popover while `delegableAgent` keeps non-delegable modes out; (b) the intermittent pill-drop race — `useFilteredList`'s `list.active()` lags the painted options (captured `""` while `flat()` is empty, reset only in a post-resolve effect), so Enter in that window preventDefaulted and selected nothing — fixed with a first-item Enter fallback matching `initialActive`/`reset`, gated on `noInitialSelection`.
- **Options**:
  - **A (recommended)**: app — add the `"agent"` case to the part projection. S/M.
  - **B**: keep fixme (mention highlighting is cosmetic).
  - **C**: delete if inline agent-mention highlighting is dropped from scope.
- **Decision**: A applied by the projection lane; catalog reachability and the Enter race fixed in the fix lane; fixture updated to the real wire shape (`mode: "subagent"`).

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
- **Why**: the Sandbox-absent path needs `sandboxEnabled=false`, which `VITE_SANDBOX_ENABLED` bakes true at Vite start for the whole shared dev server and no spec can flip. The local-principal half is no longer blocked: `principal.kind==="local"` follows the server's `deployment.issuesSessions` declaration, which a spec sets per test through `installMockRuntime({ issuesSessions: false })` (see `core-deployment-posture.spec.ts`).
- **Options**:
  - **A (recommended)**: implement the local-principal half against the posture declaration; the Sandbox half still needs a per-spec build variant that flips `VITE_SANDBOX_ENABLED`. M.
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

### 42. core-session-rendering-navigation — browser Back and Forward preserve a chat visit made through the rail

- **Status**: fixed — enabled and green in both auth modes, zero retries (Tier M, `local-unsigned` + `test-user`, 2026-09-15).
- **Tests**: `browser Back and Forward preserve a chat visit made through the rail @core`.
- **Expected**: after opening New Session and selecting the completed chat through the rail, Back restores New Session and Forward restores the visible chat reply.
- **Why**: the Back assertion expects `/w/ws_mock_runtime/session` but receives `/s/ses_browser_history`. Both preceding assistant-reply oracle checks pass; the reviewed failure screenshot shows the chat still painted. Forward is not reached in the failing run. Evidence is retained in `docs/verification/session-rendering/2026-09-12/evidence/history-e2e-1049/`.
- **Options**:
  - **A (recommended)**: fix the canonical workbench route publication so user navigation creates traversable history entries, then enable and validate the regression. M.
  - **B**: change the product contract to make session navigation replace history and explicitly remove browser-history support. Requires a product decision; weakens the requested behavior.
  - **C**: retain the known failure and leave browser Back unreliable across rail visits.
- **Decision**: Option A applied 2026-09-15: `rail-sidebar.tsx`'s user rail activation now routes through `pushSessionUrl` instead of `replaceSessionUrl`, so a rail click creates a traversable history entry; the create→session redirect keeps its intentional replace. The e2e is enabled and passes in both auth modes.

### 43. core-timeline-rendering-scroll — user Markdown image loading preserves reserved space

- **Status**: fixed 2026-09-16 — enabled and passing in both auth modes (build-preview). Was skipped after a reproduced build-preview geometry failure (1 failed, 0 retries).
- **Tests**: `loading a user Markdown image preserves its reserved space and the existing transcript position`.
- **Expected**: approximately 80 × 80 CSS-pixel thumbnail tiles matching the user-provided Codex reference, with identical loading/loaded/corrupt/HTTP-404 dimensions, no transcript or composer movement, and full-image viewing on click.
- **Why**: the updated compact-tile assertion fails on a loading width of 645.75px versus the 80px target (`Expected <= 1; Received 565.75` width deviation), recorded in `docs/verification/session-rendering/2026-09-12/evidence/image-reference-1063/`. Run 1070 extends the same test to corrupt bytes: browser decoding fails, the corrupt tile measures 645.75 × 37.1875px, and loading the adjacent valid image moves the same row upward 416px with unchanged composer geometry. Soft geometry assertions allow the click-to-preview check to run; it fails with `Expected: visible; Error: element(s) not found`. Reviewed before/after/click screenshots and the trace are retained in `docs/verification/session-rendering/2026-09-12/evidence/image-corrupt-1070/`. Closing a preview remains unverified. Runs 1228/1229 additionally prove HTTP 404 renders the same incorrectly sized 645.75 × 37.1875px box in both auth modes. Thirty post-decode samples catch 449px/474px upward movement, avoiding the single-frame timing gap observed in 1227. Both reply oracles and before/after screenshots were reviewed; full videos remain unreviewed. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/image-404-1228/` and `image-404-1229/`. The earlier expansion reproduction shows the placeholder is 37.1875px high and the loaded image is 512px high. The same message row moves from y=276 to y=-79; the composer stays at y=691 with height=52. The reserved-space assertion reports `Expected: <= 1; Received: 474.8125`. Both preceding reply oracles pass. Before/after screenshots were reviewed; the video and geometry are retained in `docs/verification/session-rendering/2026-09-12/evidence/image-e2e-1062/`.
- **Options**:
  - **A (recommended)**: use fixed compact thumbnail tiles in the canonical Markdown media renderer, retaining those dimensions through loading and failure, and invoke the existing image preview on click. M.
  - **B**: explicitly accept expanding image layout and revise the product's no-shift contract. Requires a product decision.
  - **C**: retain the known failure and leave image-load transcript shifts unresolved.
- **Decision**: Option A applied 2026-09-16: `stabilizeImages` (`session-ui/components/markdown.tsx`) now mounts every transcript image as a fixed 80×80 tile — loading and failed/corrupt/404 URLs keep the `markdown-image-fallback` chip at the same box, and a probed-ok URL swaps in a `markdown-image-tile` button wrapping the `<img>` (`object-fit: cover`, tile chrome on the img so the img itself measures 80×80). The tile's click opens the existing `ImagePreview` dialog; the opener is threaded through `decorate`/`updateBlock` from the `Markdown` component, which tolerates a dialog-less host (tiles still render; clicks do nothing). `data:` URIs tile directly without probing. The regression is enabled and passes in both auth modes: all six states measure 80×80±1, zero row/composer movement across 30 post-decode frames, and click→preview→close preserves the reading position.

### 44. core-docks — completed todo list survives the end of the turn and reload

- **Status**: fixed — enabled and green in both auth modes, zero retries (Tier M, `local-unsigned` + `test-user`, 2026-09-15).
- **Tests**: `todo dock preserves all five completed steps after the turn ends and reloads`.
- **Expected**: the final list retains exactly five completed steps after the turn ends and after reload.
- **Why**: the completed SSE batch contains all five completed steps before reload; the reply oracle passes after reload, but the final dock assertion fails: `Expected: visible; Error: element(s) not found`. The reviewed screenshot shows the reply and composer without a todo list. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/todo-e2e-1067/`. The initial run without a delivery guard is retained as unqualified evidence. Final checkbox assertions are not reached.
- **Options**:
  - **A (recommended)**: retain the final todo state in the canonical session surface and enable the regression. M.
  - **B**: explicitly change the product contract to discard completed lists. Requires a product decision.
  - **C**: retain the known failure with the final task state unavailable.
- **Decision**: Option A applied 2026-09-15: `session-controller.ts`'s `todoState` keeps a completed list open instead of scheduling an auto-dismiss; the dead `opening`/`closing`/`closeMs` machinery it fed was removed. Reload hydration rides the existing `syncSessionTodo` activation fetch — the test asserts the canonical dock (`5 of 5 todos completed`) plus all five labels through the non-`aria-hidden` `TextStrikethrough` span. The e2e is enabled and passes in both auth modes.

### 45. real-harness-local — Codex retains the selected answer card after completion and reload

- **Status**: skipped after a reproduced Tier R build-preview failure (1 failed, 0 retries).
- **Tests**: `codex native question retains the selected answer card after completion and reload`.
- **Expected**: the completed question retains its question text and selected Staging answer after reload.
- **Why**: the real Codex binary returns Staging in its function-call output to the scripted endpoint; both completion and reload reply oracles pass. The result-card assertion fails with `Expected: visible; Error: element(s) not found`. The replayed messages contain only text parts. The reviewed screenshot shows the completed reply without a question card or a fold control. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/question-retained-1068/`. This scenario makes no route interceptions; the existing answer-delivery scenario remains enabled. Custom and dismissal retention are not exercised by this run.
- **Options**:
  - **A (recommended)**: preserve resolved question information in the canonical runtime presentation contract so the existing renderer can show it. M.
  - **B**: explicitly remove resolved question cards from the product contract. Requires a product decision.
  - **C**: leave completed questions without a visible record of the user's answer.
- **Decision**:

### 46. real-harness-local — Codex sends synchronize rail order across browser tabs

- **Status**: fixed client-side — the recency projection now applies `message.updated` monotonically; qualified via a mock e2e + unit tests in both auth modes. The real-harness leg is enabled but unqualified here: codex-cli 0.154.0 errors every scripted turn in this environment (2026-09-15).
- **Tests**: `Codex sends converge on the same session order in both browser tabs`.
- **Expected**: after a new send to the older session, both tabs place it first and show the same complete rail order.
- **Why**: both tabs begin with `[newer, older]`; the real Codex send completes and its reply passes the oracle in both tabs. The sender becomes `[older, newer]`, while the receiver stays `[newer, older]` through the 15-second index assertion. The expected first id is `dca246b4-2544-4b91-9d45-87cb38f39039`; the receiver returns `8fb8a83f-1be5-45c1-98c5-653cbdf3b3db`. Both screenshots were reviewed. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/rail-sync-1073/`. The scenario uses a real server and binary with only the model HTTP endpoint scripted; no route interception. The OpenCode variation remains untested by this scenario.
- **Options**:
  - **A (recommended)**: publish and apply the canonical human-turn ordering timestamp to all clients, then enable this regression. M.
  - **B**: explicitly make rail order window-local. Requires a product decision and contradicts the requested synchronization.
  - **C**: retain inconsistent ordering across windows.
- **Decision**: Option A applied 2026-09-15: `directory-event-projector.ts` now handles `message.updated` — the directory stream already carries it, and turn completion publishes no `session.updated`. A user-role message bumps the row's `lastHumanTurnAt` (the `human_turn_desc` rail key) and every message bumps `updatedAt`, both through a new `monotonic` flag on `SessionListUpdate` so retained replays cannot regress recency. Unit coverage in `directory-event-projector.test.ts` (reorder under `updated_desc`, monotonic replay guard, user-turn `lastHumanTurnAt` bump); a new mock e2e (`a human turn landing on another pane reorders this pane's rail`) qualifies the event path in both auth modes. The real-harness leg is un-skipped; codex-cli 0.154.0 errors every scripted turn in this environment, so Tier R qualification is outstanding — the fix is harness-agnostic.

### 47. real-harness-local — Codex failed shell header identifies its command

- **Status**: skipped after a reproduced Tier R build-preview failure (1 failed, 0 retries).
- **Tests**: `Codex failed shell header retains its command and exit code after reload`.
- **Expected**: the failed shell header identifies the command and shows exit code 23 after reload and a subsequent successful tool.
- **Why**: actual failed and recovery scripts execute through Codex; persisted error and output checks pass. The stored failed part contains the full `fail.cjs` command and exitCode 23. The header assertion expects `fail.cjs` but receives `ShellFailedexit 23`. The separate exit-code assertion passes and the reviewed screenshot confirms it is legible. This narrows the older live report: the remaining reproduced defect is the missing command, not the exit chip in this case. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/shell-exit-1074/`. Existing failure/recovery cases stay enabled; this added presentation case has no route interceptions.
- **Options**:
  - **A (recommended)**: render the authoritative failed command in the canonical error-card header and enable this test. S.
  - **B**: explicitly accept a generic failed header while requiring users to find the command elsewhere. Requires a product decision.
  - **C**: retain the missing command context for failed shells.
- **Decision**:

### 48. real-harness-local — Codex preserves the full completed shell output

- **Status**: skipped after two reproduced Tier R build-preview failures (each 1 failed, 0 retries).
- **Tests**: `Codex completed shell exposes all 240 output lines after reload`.
- **Expected**: the expanded completed command retains all 240 output lines after reload and offers Show all for its overflowing output.
- **Why**: the real command prints 240 lines, waits eight seconds, then prints a final marker. Codex returns all 240 lines in its function-call output to the scripted model endpoint; the captured list is verified in order. Claxedo's stored completed part contains only the final marker, as does the reviewed expanded row. The assertion expects `OUTPUT_LINE_1` but receives only the command and `LONG_RESULT_1789276952882`. Both reply oracles and persistence checks pass. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/shell-output-1076/`. The final-line and Show all assertions are not reached. Exact internal cause remains unproven, but the loss is already present in stored presentation data and cannot be repaired solely in the renderer. Existing short-output persistence tests stay enabled.
- **Options**:
  - **A (recommended)**: preserve the complete authoritative command output through runtime presentation updates, then enable the regression. M.
  - **B**: explicitly document final-chunk-only output as a product limitation. Requires a product decision.
  - **C**: leave earlier command output unavailable to readers.
- **Decision**:

### 49. core-timeline-rendering-scroll — streaming tables and lists paint as complete blocks

- **Status**: fixed 2026-09-15 — enabled and passing in both auth modes (build-preview). Was skipped after a reproduced build-preview failure (1 failed, 0 retries).
- **Tests**: `streamed tables and ordered lists first appear as complete blocks`.
- **Expected**: every sampled block has either zero items or its complete item count: thirty table rows and eight list items. Both completed replies remain readable.
- **Why**: of 211 sampled frames, 59 show fifteen rows, 135 show none, and 17 show all thirty. The first and last partial samples span about 1.96 seconds. The reviewed first-visible screenshot shows row 15 ending in `Chec` while Thinking remains; the final screenshot shows all thirty rows and TABLE_DONE. The completed reply oracle passes. The assertion expects no partial frames and receives 59. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/table-1078/`. The viewport is 1280 × 2400 so the entire thirty-row reply satisfies the shared geometric oracle. An earlier 1600px-high run fails that prerequisite and is not the registered red assertion. The combined run 1079 also reproduces the ordered list: 66 frames show five of eight items and 16 show all eight; the first-visible screenshot shows item 5 containing only `S`. That run records 76 partial-table frames and passes both completed reply oracles. The list screenshots were reviewed. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/blocks-1079/`.
- **Options**:
  - **A (recommended)**: keep incomplete structured blocks unpainted until their boundary is known, then enable the regression. M.
  - **B**: explicitly permit progressive table growth and revise the requested whole-block rendering contract. Requires a product decision.
  - **C**: retain the visible partial-table growth.
- **Decision**: Option A applied 2026-09-15: `markdown-stream.ts`'s `stream` projection now withholds trailing `table`/`list` tokens until a following block token proves their boundary — a mid-row table still lexes as a single `table` token, so the hold is the only way to prevent the partial paint. Unit coverage in `markdown-stream.test.ts`; the e2e is enabled and passes 3x per auth mode with zero retries.

### 50. core-harness-rendering-matrix — process inspection does not create an app preview

- **Status**: fixed — enabled and green in both auth modes, zero retries (Tier M, `local-unsigned` + `test-user`, 2026-09-15).
- **Tests**: `process inspection output does not turn an MCP endpoint into a Local preview`.
- **Expected**: a process-list result containing an MCP control endpoint creates no Local preview; a development server announcing port 8766 creates the correct preview link.
- **Why**: the negative assertion expects zero preview rows and receives one. The separate positive development-server link assertion passes. The reviewed screenshot shows the control URL with serialized header syntax promoted into a preview, matching the original live screenshot. The fixture is sanitized and reconstructed from that screenshot; it is not a retained raw provider payload. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/preview-1081/`. No preview navigation or Browser-tab persistence is tested.
- **Options**:
  - **A (recommended)**: identify app server announcements in the canonical preview producer and exclude control endpoints and serialized configuration, then enable this test. M.
  - **B**: require explicit user selection before promoting an arbitrary output URL to an app preview. Requires a product decision.
  - **C**: retain incorrect preview targets from process inspection output.
- **Decision**: Option A applied 2026-09-15: the URL extraction moved to a pure `localPreviewUrl()` in `session-ui/src/components/local-preview.ts` — it rejects loopback URLs embedded in quotes (serialized JSON/env) and `/api/` control-plane paths while keeping development-server announcements (`127.0.0.1`, `localhost`, `0.0.0.0` normalized). Unit coverage in `message-part.test.ts`; the e2e is enabled and passes in both auth modes.

### 51. real-harness-local — Codex running command remains painted

- **Status**: reproduced intermittent Tier R build-preview failure (2 failed, 1 passed, 0 retries); skipped after reproduction.
- **Tests**: `Codex running shell paints its command before completion`.
- **Expected**: the running shell command becomes painted after its entrance animation and stays readable when reloaded during execution. Its completed result survives reload.
- **Why**: two of three runs keep the initial command at effective opacity zero through a one-second poll, despite nonzero dimensions, a successful hit-test, and a Running row. Expected opacity greater than 0.9, received 0. The reviewed screenshot shows Running and an empty command area, matching the original live observation. Reload restores the command in all three runs; completed reply oracles and stored output checks pass. The one-second bound exceeds the renderer's 320ms entrance animation; earlier immediate snapshots were rejected as timing-sensitive evidence. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/running-1086/`. This scenario uses a real server and Codex binary with only the model HTTP endpoint scripted. The heavy-session rail-return variation remains unproven, and full video review is outstanding.
- **Options**:
  - **A (recommended)**: ensure the canonical shell command animation reaches its visible state through reactive updates, then enable this regression. M.
  - **B**: remove the command entrance animation and display the command immediately. Requires a design decision.
  - **C**: retain intermittent invisible commands while work runs.
- **Decision**:

### 52. core-harness-rendering-matrix — collapsed turn identifies its tool-group count

- **Status**: fixed — enabled and green 3× per auth mode, zero retries (Tier M, `local-unsigned` + `test-user`, 2026-09-14). `foldCount` already reached the `TurnFold` row model; `TurnFoldRow` now renders it as `· N groups` beside `Worked for Xs` in both call paths (`message-part.tsx`, `message-timeline.tsx`).
- **Tests**: `a manually folded Codex turn retains its three-group count after completion`.
- **Expected**: after three foldable tool groups are manually collapsed and the turn completes, the header remains collapsed and identifies three groups.
- **Why**: the two-read context group, standalone shell, and trailing read all pass their group-presence assertions. Manual collapse persists through completion and the completed reply passes its oracle. The count assertion expects `3 groups` but receives only `Worked for 0s`; the reviewed screenshot confirms no count is displayed. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/fold-count-1088/`. The fixture uses normalized tool parts through the shared mock transport. This is the missing-count branch of the live observation, not a failure to retain the manual fold. Unsigned run 1090 also fails at the same count assertion after explicitly observing Working and all three groups; expanded and completed screenshots were reviewed. Unsigned run 1089 stopped in setup and is not qualified evidence.
- **Options**:
  - **A (recommended)**: pass the canonical foldable-group count to the fold header and render it, then enable this test. S.
  - **B**: remove the fold-count requirement from the product contract. Requires a product decision.
  - **C**: keep the collapsed header without a group count.
- **Decision**:

### 53. core-harness-rendering-matrix — MCP group header identifies its members

- **Status**: fixed — enabled and green 3× per auth mode, zero retries (Tier M, `local-unsigned` + `test-user`, 2026-09-14). `otherSegment` in `work-group-summary.ts` now joins the distinct member labels (`used sessions list, processes`) instead of a bare `used N tools`; a same-name run still counts by that tool.
- **Tests**: `a consecutive MCP group names the tools hidden inside it`.
- **Expected**: a group containing consecutive sessions_list and processes calls identifies those tools in its collapsed header.
- **Why**: both header-name assertions receive only `Used 2 tools`. Expanding the group reveals both member rows, and both member visibility checks pass. Collapsed and expanded screenshots were reviewed. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/mcp-group-1091/`. The fixture uses normalized tool names corresponding to the live observation; it is not a retained raw MCP payload and does not test MCP execution. This is one shared regression for states 26 and 51; skill-tool coverage remains separate. Unsigned run 1092 also fails on both missing names, with both expanded-member checks passing and both screenshots reviewed. The assertion accepts either an underscore or a space in Sessions list so presentation normalization does not itself fail the test.
- **Options**:
  - **A (recommended)**: retain descriptive member names in the canonical mixed-tool group summary, then enable this test. S.
  - **B**: explicitly accept a count-only summary for mixed MCP tools. Requires a product decision.
  - **C**: leave the grouped tools unidentified until expanded.
- **Decision**:

### 54. core-session-rendering-navigation — permission control appears before hydration

- **Status**: fixed 2026-09-15 — enabled and passing in both auth modes (build-preview). Was skipped after reproduced Tier M build-preview failures: test-user at 1280px (1 failed), unsigned-local at 1280px and 720px (2 failed), zero retries.
- **Tests**: `permission control is visible before hydration and preserves composer geometry at 1280px` and its 720px parameter.
- **Expected**: the composer includes a visible permission control before its delayed harness/permission reports arrive, preserves its geometry when they resolve, and accepts a subsequent send.
- **Why**: the toolbar and editor are visible, both requests are observed and held, but the permission trigger does not exist. After release, the permission control appears; outer geometry checks and the send/reply oracle pass. The first run's before-hydration and completed-send screenshots were reviewed. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/permission-first-1093/` and `permission-first-1094/`. The former geometry-only tests missed this content-appearance failure. Their scenarios are extended in place, with permission response control owned by the shared mock. Known/default mode content, animation quality, and stale stored selections need additional coverage; this assertion does not require inventing an effective permission value before it is known.
- **Options**:
  - **A (recommended)**: keep the permission control visible with the authoritative known selection during hydration and retain its final dimensions; resolve genuinely unknown state explicitly. M.
  - **B**: show an explicit loading state when no authoritative default is available. Requires a design decision about first-boot content.
  - **C**: retain the empty slot followed by a late-appearing control.
- **Decision**: Option A applied 2026-09-15: `harnessPermissionModes`/`PermissionModeGroups` carry a `loading` flag for the in-flight report, and the toolbar `enabled` gate now hides the trigger only when the resolved answer offers zero rows — while harness options or permission modes are still loading, the trigger renders in its unresolved "Permissions" state (the menu explains loading or the reason no modes exist). The geometry assertion now checks the right-anchored cluster's stable right edge, height and row position rather than exact box equality — a content-sized trigger legitimately changes width when its loading label resolves; exact equality was unsatisfiable without a fixed-width trigger, which the caret regression (55) rules out. Both widths pass in both auth modes; the stale harness label in the setup was corrected to the catalog name.

### 55. core-session-rendering-navigation — harness caret stays adjacent to its model label

- **Status**: reproduced Tier M build-preview failure (1 failed, 0 retries); skipped after reproduction.
- **Tests**: `the harness selector keeps its caret beside a short model label`.
- **Expected**: a short model label uses a compact trigger with an adjacent caret. The regression permits a 16px gap as a concrete QA interpretation of adjacency, not a measurement supplied by the user.
- **Why**: after selecting Claude and completing a send through the reply oracle, the trigger measures 260px wide; Sonnet 4.6 text measures 65.734375px and the caret gap is 140.265625px. Expected gap at most 16px, received 140.265625px. The screenshot was reviewed and matches the reported distant caret. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/caret-1095/`. Geometry measures the actual text range, not the stretched label container. This covers the closed trigger with no effort label between model and caret; open-menu width and long-label/effort variants remain untested. Unsigned run 1096 fails on the same 140.265625px gap with its reply oracle passing; visual review of that run remains outstanding.
- **Options**:
  - **A (recommended)**: size the trigger to its contents within the available composer space and retain a consistent text/caret gap, then enable this regression. S.
  - **B**: retain a fixed outer reservation but align the visible label and caret together within it. Requires a design decision.
  - **C**: keep the distant caret and excess internal whitespace.
- **Decision**: Option A already satisfied by the current trigger — `composer-harness-model` is `min-w-0 max-w-[260px]` with shrink-0 children and no stretch: measured 127.7px wide with a sub-16px text/caret gap. The test was blocked by a stale harness option name ("Claude" → the catalog's "Claude Code"), not by the gap. Selector corrected; passes in both auth modes with no layout change needed.

### 56. core-timeline-rendering-scroll — keyboard reaches the first transcript turn

- **Status**: fixed 2026-09-15 — enabled and passing in both auth modes (build-preview). Was skipped after reproduced Tier M build-preview failures in both auth modes (1 failed per mode, 0 retries).
- **Tests**: `Home and End reach the endpoints of a fully loaded heavy transcript`.
- **Expected**: after all 61 turns are revealed and the transcript receives focus, Home reaches the first user row and scroll offset zero; End reaches the final prompt at the bottom.
- **Why**: Home remains at scrollTop 12777 after ten seconds and the first UserMessage row is not mounted. The reviewed screenshot shows turns 26–29. End reaches the bottom and its final prompt viewport assertion passes; the reviewed screenshot shows the final prompt and reply. A successful send/reply oracle precedes keyboard interaction. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/home-end-1102/`. Earlier run 1101 had two incorrect row selectors (pinned title and an exact-text wrapper); they are corrected in this run. This reproduces the shared endpoint branch of live state 84; transient blanking and OpenCode's first-End variation remain uncovered. Test-user run 1106 reproduces the same two Home failures at scrollTop 12778; End passes, and both endpoint screenshots were reviewed. Run 1105 ran no tests because the runtime-contract dist export was stale; its declared build script refreshed it before 1106. No internal cause is claimed.
- **Options**:
  - **A (recommended)**: make the canonical transcript keyboard navigation reach the requested endpoint through virtualizer measurement, then enable this test. M.
  - **B**: explicitly replace Home/End navigation with another accessible endpoint control and revise the interaction contract. Requires a product decision.
  - **C**: retain Home stopping in the middle of loaded history.
- **Decision**: Option A applied 2026-09-15: `scroll-view.tsx`'s Home/End handlers now jump with `behavior: "instant"`. A smooth scroll across a virtualized transcript cannot finish — every `measureElement` correction writes `scrollTop` directly, which cancels the animation mid-flight and leaves the scroll wherever the last correction landed (the observed 12777). End survived only because bottom-clamping rescued it. Instant endpoint jumps are the platform convention. The e2e is enabled and passes in both auth modes.

### 57. core-timeline-rendering-scroll — expanded output survives virtualized unmount

- **Status**: fixed 2026-09-15 — enabled and passing in both auth modes (build-preview). Was skipped after reproduced Tier M build-preview failures in both auth modes (1 failed per mode, 0 retries).
- **Tests**: `expanded shell output survives scrolling out of the virtualized transcript`.
- **Expected**: a manually revealed 300-line output retains Show less after scrolling to the final turn, unmounting its row, and returning.
- **Why**: the initial Show less assertion passes, the tool row is confirmed absent at the final prompt, and the outer tool accordion remains expanded on return. Its output toggle nevertheless changes to Show all, failing the retention assertion. All three stage screenshots were reviewed in each mode. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/output-retention-1103/` and `output-retention-1104/`. The initial send passes the shared reply oracle. The normalized fixture exercises the shared renderer; it does not rerun a real Codex command. ScrollableOutput owns a component-local revealed signal, so persistence across virtualized unmount is not provided by that owner. Full video review remains outstanding. The separate reading-position shift on Show all is not covered here.
- **Options**:
  - **A (recommended)**: keep output expansion with canonical per-part UI state that survives row virtualization and pass it to the output renderer, then enable the test. M.
  - **B**: keep expanded output mounted outside the virtualized lifecycle. Requires review of memory and rendering cost.
  - **C**: retain loss of manual output expansion when the row leaves the rendered range.
- **Decision**: Option A applied 2026-09-15: a `toolRevealed` store now lives beside the existing `toolOpen`/`groupOpen` timeline stores — keyed by part id, snapshotted through `timeline-mount-cache` so it survives row unmounts. It reaches `ScrollableOutput` as a controlled `revealed`/`onRevealedChange` pair through `MessagePart`'s `PART_MAPPING` forward and the tool renderers (`bash`, `edit`, `read`, `write`, `glob`, `generic`). Uncontrolled usage outside the timeline is unchanged. The e2e is enabled and passes in both auth modes.

### 58. core-timeline-rendering-scroll — Show all preserves output reading position

- **Status**: fixed 2026-09-15 — enabled and passing in both auth modes (build-preview). Was skipped after reproduced Tier M build-preview failures in both auth modes (1 failed per mode, 0 retries).
- **Tests**: `Show all preserves the visible line in already scrolled shell output`.
- **Expected**: revealing a 300-line shell output while reading line 16 preserves that named line's vertical position within 2px.
- **Why**: line 16 is initially inside the capped output at y204. After Show all it first moves to y484, then to y-5642 by the post-screenshot measurement: a 5846px displacement. Reviewed before/after screenshots show lines 12–22 replaced by lines 290–300. The unsigned run reproduces the same measurements, and its reply-oracle screenshot was reviewed. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/output-reading-1109/` and `output-reading-1110/`. The test uses the shared mock and a real send/reply oracle, then measures the same text range through the shared geometry helper. It reproduces output reading-position loss in a standalone shell; the original nested tool-group variation remains separate. Sampled video frames were reviewed for 1109; a full frame-by-frame review remains outstanding. No internal cause is claimed.
- **Options**:
  - **A (recommended)**: preserve the visible output anchor when removing the cap and coordinate that change with transcript scrolling, then enable this test. M.
  - **B**: expand output in a separate viewer with an explicit reading-position contract. Requires a product decision.
  - **C**: retain the jump to another part of the output on expansion.
- **Decision**: Option A applied 2026-09-15: two coordinated changes. The reveal click is a user-driven resize at the reading position, so `revealToolOutput` marks a scroll gesture — the resize anchor's `scrollEndThreshold` then stands down, which suppresses the virtualizer's `wasAtEnd` re-pin that produced the 5846px displacement. And `ScrollableOutput` now transfers the box's inner scroll offset to the transcript: it captures the outer `scrollTop` before the reveal, grows the containing virtual spacer synchronously so the write is not clamped, forces layout, then re-asserts `base + carried` across frames until the virtualizer's measure pass settles. The e2e is enabled and passes in both auth modes.

### 59. core-busy-abort-errors — Thinking survives completion refresh latency

- **Status**: fixed 2026-09-16 — enabled and passing in both auth modes (build-preview). Was skipped after three reproduced Tier M failures per auth mode with the final shared WebSocket transport (1128/1129), zero retries.
- **Tests**: `Thinking stays painted until the follow-up reply begins`.
- **Expected**: the active prompt retains painted Thinking until its assistant text starts painting, including when Idle arrives before the completed message refresh.
- **Why**: real OpenCode follow-ups 1118 and 1119 show sampled gaps of 508ms and 615ms. The latter captures Busy/Busy/Idle lifecycle frames without message events; the pre-Idle REST snapshot has an unfinished empty assistant, and the completed snapshot response arrives 691ms after Idle. The shared mock models lifecycle-only delivery and 700ms message-response latency. Run 1121 fails with 59 absent samples over approximately 722ms; reviewed video frames show the blank interval and subsequent reply. Both repeats in 1123 also fail. Unsigned passes 1122/1124 missed the central WebSocket transport and are invalid as continuity coverage. The shared EventBus now serves that WebSocket without a real server connection. Final runs 1128/1129 reproduce the gap three times per auth mode (716–733ms). Both normal-turn controls pass three times per mode, 12 passes total. Every run has reviewed transition or busy/final frames. The regression requires an intercepted central WebSocket so a missing mock transport cannot silently pass. Both sends use the shared reply oracle. Evidence: `docs/verification/session-rendering/2026-09-12/live-ordering-1119/` and `evidence/thinking-gap-1121/`, `thinking-gap-1122/`, `thinking-gap-1123/`. Full recording review remains outstanding. The initial delayed-response prototype read mutable messages after its wait and passed; the retained helper snapshots messages at request time.
- **Options**:
  - **A (recommended)**: make the canonical turn presentation retain pending work until the completed transcript is available, then enable the regression. M.
  - **B**: coordinate lifecycle and transcript delivery so completion is visible before Idle, with end-to-end proof under delayed reads. Requires producer-contract review.
  - **C**: retain the blank interval between Thinking and the reply.
- **Decision**: Option A applied 2026-09-16: the turn is "working" while its canonical settle read is still owned, not merely while `session.status` is busy. `constructMessageRows` gains `settlePending` (Thinking emits when `status === "busy" || settlePending`), and `workingTurn` in `message-timeline.tsx` reads the same signal. The signal is the existing accepted-prompt reconciliation registry (`acceptedPromptRefreshRequest()?.messageID === userMessageID`, `accepted-prompt-refresh.ts`): it exists from prompt acceptance until `completeAcceptedPromptRefresh` runs — after `syncSessionHistory`'s canonical snapshot is already in the conversation store — so Thinking yields directly to the painted reply with no blank interval, and a turn whose refresh lands still-unsettled (cancel) still drops to its outcome row once the read completes. Unit coverage in `accepted-prompt-refresh.test.ts` and `message-timeline.data.test.ts`; the regression is enabled and passes in both auth modes (build-preview), and all 15 busy/abort spec tests pass in local-unsigned.

### 60. core-busy-abort-errors — Stop presents the canonical cancellation outcome

- **Status**: fixed 2026-09-16 — enabled and passing in both auth modes (build-preview). Was skipped after reproduced Tier M build-preview failures in both auth modes (one failure per mode, zero retries).
- **Tests**: `Stop shows the canonical cancelled-turn outcome without reloading`.
- **Expected**: a stopped turn shows its interruption explanation without requiring navigation or reload; the composer returns to ready.
- **Why**: real OpenCode probes 1130/1131 stop without an interruption explanation, then reload reveals You stopped. Probe 1131 records an HTTP 200 abort response with `status: cancelled`, an Idle lifecycle event, and no interruption explanation during the following 20-second capture. The session metadata loaded on reload carries `lastTurn.status: cancelled` with the matching assistant ID; message snapshots carry no abort error. The shared mock models this through a held turn, persisted cancellation outcome, and lifecycle delivery. Runs 1132/1133 fail the pre-reload visibility assertion after 15 seconds; the ready-control and post-reload divider assertions pass. Before/after screenshots were reviewed in both modes. The stopped turn intentionally has no reply text, so its divider is the outcome oracle; the existing completed turn also passes the shared reply oracle. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/live-stop-1131/`, `stop-outcome-1132/`, `stop-outcome-1133/`. Full video review, interruption during tool execution, repeated Stop, later-turn retention, and automatic fold behavior remain unverified by this regression.
- **Options**:
  - **A (recommended)**: reconcile the canonical session outcome on Stop/Idle before settling the transcript presentation, then enable this test. M.
  - **B**: deliver the canonical outcome with the terminal lifecycle event and update its single client owner. Requires event-contract review.
  - **C**: retain interruption explanations appearing only after reload.
- **Decision**: Option A applied 2026-09-16: `createPromptAbort` (`submit-abort.ts`) now reconciles the canonical session row — `client.session.get` → `upsertDirectorySession` — alongside the existing status/requests reads. The runtime records the cancellation on the session row's `lastTurn` (`status: cancelled` + `assistantMessageId`); without this read the row only landed on reload. The read is inside the post-abort `Promise.all` reconcile — a failure there is logged, not a failed Stop — and the completed-message snapshot still arrives via the accepted-prompt reconcile. The regression is enabled and passes in both auth modes (build-preview), and all 15 busy/abort spec tests pass in local-unsigned.

### 61. core-harness-rendering-matrix — live folding preserves manual output expansion

- **Status**: fixed 2026-09-15 — enabled and passing in both auth modes (build-preview). Was skipped after reproduced Tier M build-preview failures in both auth modes (one failure per mode, zero retries).
- **Tests**: `enabling live folding preserves a manually opened Codex shell output`.
- **Expected**: enabling live folding during a turn preserves shell output the user explicitly opened.
- **Why**: live state 15 shows a manually opened pwd card disappear when the setting is enabled. The regression sends a real mocked prompt into a held pending turn, delivers three normalized tool groups through the shared runtime, opens the middle shell output, and enables the setting through Settings. Runs 1134/1135 fail the output visibility assertion after 10 seconds. The pre-toggle output, busy state, one-prompt count, and completed reply oracle pass. Before/after screenshots and the final oracle screenshot were reviewed in both auth modes. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/live-fold-1134/` and `live-fold-1135/`. Full video review, disabling the setting, and retention across subsequent tool events remain outstanding.
- **Options**:
  - **A (recommended)**: preserve explicit user expansion in the canonical folding owner when automatic folding changes, then enable this test. M.
  - **B**: defer automatic folding changes until the next turn, with explicit product review.
  - **C**: retain the disappearance of manually opened output when the setting changes.
- **Decision**: Option A applied 2026-09-15: `FoldablePart` gains `userOpen` (`session-ui/components/turn-fold.ts`) and `foldedGroupKeys` keeps an automatically folded group visible when a member part is user-opened; explicit folds still hide all groups. `constructMessageRows` decorates resolved parts via a new `isPartExpanded` callback fed by the `toolOpen`/`toolRevealed` stores in `message-timeline.tsx`. The e2e is enabled and passes in both auth modes.

### 62. core-harness-rendering-matrix — withdrawn title-overlap classification

- **Status**: withdrawn as a product finding; the fixme is removed. Corrected restoration control passes three times per auth mode (runs 1142/1143, zero retries); every commentary screenshot and follow-up oracle frame is reviewed.
- **Tests**: `restored Codex failure commentary renders each reply passage once`.
- **Expected**: ordinary upward scrolling makes the expanded preceding commentary readable, and each stored passage renders once after restoration and reload.
- **Why**: runs 1139/1140 hit the sticky title after Playwright scrollIntoViewIfNeeded. That did not prove the text was unreachable. Real Codex probe 1141 completes two turns, expands the preceding work, and recovers its opening commentary with ordinary upward scrolling. The diagnostic also read the outer ScrollView wrapper (always zero) instead of its data-scrollable viewport. The shared reply oracle now reports the actual viewport associated with the measured element. The existing wheel-to-top helper is shared between the scroll and harness specs; the corrected control uses it before checking readability. No product layout change is made. The historical duplicate-reply finding remains open and requires its original streaming/event sequence. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/live-commentary-1141/`; old failures 1137–1140 remain archived as superseded test evidence.
- **Options**:
  - **A (selected)**: withdraw the unsupported product classification and retain accurate restoration coverage.
  - **B**: reclassify only if ordinary user scrolling also fails in a qualified reproduction.
  - **C**: retain the unsupported inaccessible-text claim.
- **Decision**: A. The live recovery contradicts the claimed inability to reach the text.

### 63. core-docks — answered question flashes on a session-to-session return

- **Status**: fixed 2026-09-15 — enabled and passing in both auth modes (build-preview). Was skipped after reproduced Tier M failures in both auth modes (1150/1151, one failure each, zero retries).
- **Tests**: `Codex questions answered while away stay absent on rail return`.
- **Expected**: a question resolved while this client visits another session never repaints as pending when the client returns, including after a missed resolution event and retained runtime replay.
- **Why**: live cross-tab probe 1144 shows two pending flashes after another tab visibly completes its answer; both return question-list responses are empty. The regression drives a real mocked first send, opens a pending question through shared transports, visits another existing session through the rail, waits for that session's runtime stream and completed reply, removes the server's pending snapshot without delivering a resolution to this client, and returns. It requires the retained question body to actually arrive on the runtime stream. The no-visible-question assertion fails with three painted samples in each auth mode; both return flashes and the settled reply are visually reviewed. The mock now supplies other completed root sessions through its canonical navigation projection and filters runtime envelopes by requested parent. Earlier immediate draft-return tests never changed stream scope; their green result did not cover this flow. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/runtime-question-1150/` and `runtime-question-1151/`. The test models a missed resolution; it does not prove which live transport lost or reordered that event. Reload, OpenCode, and all event-order variations remain unverified.
- **Options**:
  - **A (recommended)**: reconcile resolved requests and retained replay through the canonical request owner before painting a pending dock, then enable this test. M.
  - **B**: explicitly present request hydration as a stable loading state pending product review.
  - **C**: retain transient pending questions during navigation.
- **Decision**: Option A applied 2026-09-15: `SessionRequestsQueryData` gains `reconciledAt`, stamped only by `applyDirectorySessionMeta` when both request legs read; `sessionComposerState` holds request ids that were pending at attach (pane visibility or session switch) until that session's entry is reconciled since attach — live asks carry fresh ids and paint immediately, and the hold releases after 6s for session kinds that never reconcile. The attach-time `refreshMeta` now forces the requests read instead of short-circuiting on the push cache. The e2e is enabled and passes in both auth modes.

### 64. core-docks — approved permission replays after switching sessions

- **Status**: fixed 2026-09-15 — enabled and passing in both auth modes (build-preview). Was skipped after reproduced Tier M build-preview failures in both auth modes (1158/1159, one failure each, zero retries).
- **Tests**: `an approved Codex permission stays absent after switching sessions and replaying runtime events`.
- **Expected**: after Allow once succeeds, visiting another session and returning never paints the same permission as pending again.
- **Why**: live state 74 shows an already-approved parent command reappear during a session round trip. The regression sends a real mocked prompt, publishes the canonical permission request on both presentation and runtime transports, clicks Allow once, validates exactly one `once` response, and publishes the authoritative permission resolution. It then visits another existing session, verifies its scoped stream and completed reply, and returns through the rail. The return must receive the retained runtime request body; the pending-dock assertion fails with one painted sample among 35 in each auth mode. The flash and all six first/other/return reply screenshots were visually reviewed. The permission-response count stays one and no request escapes the shared mock. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/permission-replay-1158/` and `permission-replay-1159/`. Full video review, child-panel opening, repeated round trips, and other harness variants remain outstanding.
- **Options**:
  - **A (recommended)**: preserve canonical resolution ordering across request hydration and retained runtime replay, then enable the test. M.
  - **B**: explicitly reserve a stable request-hydration surface pending product review.
  - **C**: retain transient actionable approval controls for an already-approved request.
- **Decision**: Option A applied 2026-09-15: the resolved-request ledger (`resolved-requests` query sibling in `data/sync/writers.ts`) gains a permanent `everResolved` list — the retiring `permissions`/`questions` lists still serve canonical reads, but `permission.asked`/`question.asked` events in `directory-event-projector` now consult `sessionRequestResolved` and drop replayed asks for ids this client already answered, so a retained `permission-request` frame cannot re-open the request on return. Unit coverage in `directory-event-projector.test.ts`; the e2e is enabled and passes in both auth modes.

### 65. core-harness-rendering-matrix — closed completed work exposes tools during replay

- **Status**: fixed 2026-09-15 — enabled and passing in both auth modes (build-preview). Was skipped after reproduced Tier M build-preview failures in both auth modes (1165/1166, one failure each, zero retries).
- **Tests**: `a manually closed latest Codex turn stays closed through retained runtime replay`.
- **Expected**: completed work that the user closes stays closed throughout a session-to-session return and retained runtime replay.
- **Why**: fresh real Codex first-visit probe 1164 initially shows a folded completed turn, removes the fold and exposes both completed commands for about 0.9 seconds, then folds again. The fixture retains its two stored messages and 35 normalized rendering events, without raw diagnostics. The regression explicitly expands and closes the latest completed turn, visits another existing session, waits for its scoped stream and reply, and returns through the rail with a required retained-runtime body. Fourteen of 99 unsigned samples and twelve of 87 test-user samples contain painted tool rows. All six reply-oracle screenshots and return transition frames are reviewed. A prior selector watched only an expanded fold button and missed the disappearance of the entire fold. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/fold-first-open-1164/`, `fold-replay-1165/`, and `fold-replay-1166/`. This is completed-turn restoration coverage; it intentionally sends no follow-up that would turn the subject into an older turn. Cold first-visit automation, reload, other harnesses, and full-video review remain outstanding.
- **Options**:
  - **A (recommended)**: preserve authoritative completion and explicit fold state while reconciling retained runtime events, then enable the test. M.
  - **B**: introduce a stable hydration presentation only with explicit product review.
  - **C**: retain transient tool exposure and transcript movement on return.
- **Decision**: Option A applied 2026-09-15: `preserveMessageFields` now carries `time.completed` (`conversation-snapshot.ts`), so a replayed `message.updated` cannot un-settle a completed turn and its fold row stays; explicit fold choice persists in the per-session `createTurnFoldStore` module cache across the pane remount. Also fixed a declaration-order crash (`toolOpen`/`toolRevealed` stores must precede the eagerly-computed timeline row memos that read them through `isPartExpanded`). The e2e is enabled and passes in both auth modes.

### 66. core-session-rendering-navigation — workspace file selection leaks across sessions

- **Status**: fixed — enabled and green in both auth modes, zero retries (Tier M, `local-unsigned` + `test-user`, 2026-09-15).
- **Tests**: `workspace file selection returns to the file chosen by each session @core`.
- **Expected**: returning through the rail restores the workspace file selected by that session.
- **Why**: live Codex recheck 1183 returns to a session that selected README.md but shows CLAUDE.md after a neighbour selected it. The shared-mock regression sends a first prompt, verifies the reply, selects first.txt, visits a second populated session, selects second.txt and returns. The final attribute assertion expects file://first.txt and receives file://second.txt throughout its 10-second polling interval. All six reply-oracle screenshots and six selection screenshots across the two modes are reviewed; the return shows second.txt contents beside the first session's reply. The first selection screenshot precedes content loading, so first-file content rendering is not claimed. Live previews fail to fetch. This covers file selection, not child/browser selection, reload or continuous geometry. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/file-scope-1183/`, `file-scope-1186/`, `file-scope-1187/`.
- **Options**:
  - **A (recommended)**: retain each session's chosen file selection while preserving the canonical workspace file data owner, then enable this regression. M.
  - **B**: explicitly revise the per-session selection requirement after product review to use workspace-wide selection.
  - **C**: leave selection changes on session return unresolved.
- **Decision**: Option A applied 2026-09-15: per-session panel snapshots in `app/workbench/state/workspace-panel.ts` now carry `{ panel, filePath }` — the workspace review working set stays the owner of tabs/review state; the snapshot only remembers the leaving session's active file and `restoreSession` re-issues it through the focus channel when it differs from the live working set. `WorkspacePanelState` gained a monotonic `focusVersion` (`workspace-panel-state.ts`) because clearing `focus` restarted the counter and a re-issued request for an already-consumed target minted the identical (version, kind, target) triple the body's `consumedPanelFocus` dedup drops — the same hole also blocked a user re-selecting a just-focused file. The shared working-set helpers moved from the deleted `rail/workspace-panel-working-set.ts` into `review-workspace-working-set.ts` so the state layer reads them without importing rail UI. Unit coverage in `workspace-panel.test.ts`; the e2e is enabled and passes in both auth modes.

### 67. core-timeline-rendering-scroll — idle session return restores the middle

- **Status**: fixed 2026-09-15 — enabled and passing in both auth modes (build-preview). Was skipped after reproduced Tier M build-preview failures in both auth modes (1188/1189, one failure each, zero retries).
- **Tests**: `returning to an idle heavy session opens its first turn instead of restoring the middle`.
- **Expected**: an idle heavy session opens at its first turn on return, as the session-rendering QA brief requires.
- **Why**: recorded live OpenCode and Codex returns retain scrollTop 13340 and 13127 respectively. The regression loads all 60 seeded turns, sends and verifies another completed turn, leaves the transcript in the middle, visits a distinct populated session through the rail and returns. Both auth modes retain scrollTop 12492 (maximum 23475); the expected top of at most 2 pixels never arrives within ten seconds. The measurement and return screenshot precede any recovery scroll. A subsequent explicit scroll to the top and reply oracle prove that the first reply remains available. All six oracle screenshots and four middle/return screenshots are reviewed. This covers settled position only; first-frame blanking, folds/title timing, live-session bottom anchoring and full-video review remain outstanding. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/idle-return-1188/` and `idle-return-1189/`.
- **Options**:
  - **A (recommended)**: apply the requested idle-return position policy through the canonical session view owner, then enable the regression. M.
  - **B**: explicitly revise the brief after product review to preserve the reader's prior position.
  - **C**: leave the implementation and acceptance requirement inconsistent.
- **Decision**: Option A applied 2026-09-15: `createIdleReturnScrollReset` (`features/session/ui/idle-return-scroll.ts`) runs in `session-screen.tsx`. On the hidden-to-visible edge of a kept-mounted surface it resets `scrollTop` to zero — but only for an idle session with no message target: hash seeks, pending-message jumps, and live sessions keep their existing owners (hash seek, `followOnAppend`). Unit coverage in `idle-return-scroll.test.ts`; the e2e is enabled and passes in both auth modes.

### 68. real-session-rendering-harnesses — OpenCode rejects its advertised default agent

- **Status**: fixed 2026-09-16 — enabled and passing in both auth modes (build-preview, `CLAXEDO_TIER_REAL_E2E=1`). Was skipped after real-server build-preview reproductions in unsigned and test-user modes (opencode-ui-1198/1199, one failure each, zero retries).
- **Tests**: `OpenCode default agent completes a browser-submitted prompt @core @tier-real @surface-web`.
- **Expected**: the default agent advertised by OpenCode accepts the browser-submitted prompt and renders the completed assistant reply.
- **Why**: the real agent catalog returns `name: "Build"`; the browser submits `agent: "Build"`; the engine stores `Agent not found: "Build"` and makes no model request. The shared reply oracle fails after 20 seconds because no reply appears. Both reviewed failure screenshots visibly show the submitted prompt and the same agent error. This is an agent identity failure before tool execution, not the original missing-tool-data rendering regression. The isolated API probe that omits an explicit agent can execute the tool, but that does not repair this browser flow. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/opencode-ui-1198/` and `opencode-ui-1199/`.
- **Options**:
  - **A (recommended)**: preserve the executable agent identity through the canonical catalog and selection contract, then enable this regression.
  - **B**: remove unsupported agents from the authoritative catalog and explicitly expose only executable selections.
  - **C**: leave default-agent sends failing before model execution.
- **Decision**: Option A applied 2026-09-16: the engine's `Agent.Info` splits `id` (executable identity — what `prompt_async`'s `agent` field resolves) from `name` (display label "Build"), and the catalog chain forwarded only the label. `AgentAgent` and the catalog `AgentEntry` now carry `id`; `catalog-port.ts` emits `row.id`, `harness-adapter.ts` `listAgents` forwards it, `agentRow` (`data/query/directory.ts`) validates it, and `resolveSubmitAgent`/`submit-model-gate` submit `id ?? name` (ACP/name-keyed catalogs are unchanged). `session-selection`'s `agent.set` persists the id in the session scope — which doubles as the persisted/submitted `agent` — and `pickAgent` resolves id-or-name so stored selections still bind. `promptAgentOptions` sends the id as the @-mention agent value. Unit coverage in `resolve.test.ts`; the Tier R regression is enabled and passes in both auth modes against the real embedded engine — the scripted model returned `OPENCODE_DEFAULT_AGENT_DONE`.

### 69. core-timeline-rendering-scroll — first reply token moves the existing prompt

- **Status**: fixed 2026-09-15 — enabled and passing in both auth modes (build-preview). Was skipped after Tier M build-preview reproductions in both auth modes (first-token-1206/1207, one failure each, zero retries).
- **Tests**: `a Codex first reply token preserves the existing prompt with a stationary composer`.
- **Expected**: inserting the first reply token preserves the existing prompt's viewport position while the composer stays stationary.
- **Why**: the portable fixture retains the recorded preceding turns and completed shell from the live Codex sequence. After a stable baseline, the first text moves the same prompt from y517 to y459, a 58px upward shift; scrollTop changes from 388 to 446. Composer y752/height52 remain unchanged. The final assertion checks 89 animation-frame samples and reports Expected <=1px, Received58px in both auth modes. The helper's synchronous initial sample is retained for diagnosis but excluded from painted-frame assertions. Both preceding and completed reply oracles pass per mode. All eight before/arrival and reply-oracle images were reviewed. Earlier recordings were reviewed frame-by-frame from60 through139 in both modes and corroborate58px; they do not establish the larger initial synchronous layout measurement as painted motion. This qualifies only the Codex first-token variation, not send, OpenCode, child-chip or separate tool-transition variants. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/first-token-1206/` and `first-token-1207/`.
- **Options**:
  - **A (recommended)**: preserve the existing prompt's viewport anchor through first-token insertion, then enable the regression.
  - **B**: reserve the first response row's space before its text arrives.
  - **C**: explicitly revise the position-stability requirement to allow this movement.
- **Decision**: Option A applied 2026-09-15: `createTimelineResizeAnchor.noteRowKeys` detects a near-tail insert that displaces a visible row by looking the displaced row up by stable key in `measurementsCache` (index lookups lie mid-flush). For ~250ms it holds every bottom-pin owner: `followOnAppend`, the anchor's queued `scrollToEnd`, the `wasAtEnd` resize compensation (via `scrollEndThreshold: -1`), and `createAutoScroll`'s ResizeObserver (via the new `mayFollow` predicate fed by the gesture-mark channel). When the hold lifts, a deferred check re-pins once iff the insert pushed the tail row below the fold — the reader follows the tail, not a fixed offset. Unit coverage in `timeline-virtualization.test.ts`; the e2e is enabled and passes in both auth modes, and the bottom-pin streaming test alongside it passes too.

### 70. real-harness-local — Pi first send references missing native history

- **Status**: still skipped 2026-09-16 — the session-file defect is fixed (`20fdb18874`) but the rerun fails on a real OpenAI 401: the seeded `local_only` credential is brokered to hardcoded `https://api.openai.com`, so the scripted endpoint is unreachable. Was skipped after real build-preview failures in both auth modes (native-first-send-1202/1203, zero retries).
- **Tests**: `pi-workspace harness completes exact turns, reload, and visible usage`.
- **Expected**: a new native Pi session accepts its first browser prompt and visibly renders the assistant reply before the existing reload/usage assertions.
- **Why**: the existing ordinary draft → composer → Submit journey renders the user prompt, then `Pi session file is missing for …`. The first shared reply oracle fails before any scripted model request. Both author and primary agent reviewed the unsigned and test-user error screenshots. Captured browser message responses corroborate the same errors; the initial extra diagnostic request omitted directory and returned404, which is excluded. Pinned Pi0.85.0 is used in the Pi run. This preserves the existing test rather than adding duplicate first-send coverage. It does not qualify the blocked image or Browser assertions. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/native-first-send-1202/` and `native-first-send-1203/`.
- **Options**:
  - **A (recommended)**: correct native session creation and durable identity ownership, then enable the existing journey.
  - **B**: explicitly distinguish new-session startup from resuming native history in the canonical contract.
  - **C**: defer exposing the affected native first-send flow until corrected.
- **Decision**: Option A applied 2026-09-14 (`20fdb18874`): the driver recreates a session id it created but never saw persisted, via `pi --session-id`, when the live process was lost (e.g. per-request credential rotation); unknown ids still refuse. The rerun journeys now reach the model request and fail on a real OpenAI 401 — the seeded `local_only` credential is brokered to hardcoded `https://api.openai.com`, so the scripted endpoint is unreachable. Resolving that is a credential-delivery decision (destination override or unbrokered local delivery) outside this entry; the session-file defect itself is closed. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/pi-session-fix/`.

### 71. real-harness-local — Codex first send references missing native history

- **Status**: skipped after real build-preview failures in both auth modes (native-first-send-1202/1203, zero retries).
- **Tests**: `codex native SDK harness completes exact turns, reload, and visible usage`.
- **Expected**: a new native Codex session accepts its first browser prompt and visibly renders the assistant reply before the existing reload/usage assertions.
- **Why**: the existing ordinary draft → composer → Submit journey renders the user prompt, then `no rollout found for thread id …`. The first shared reply oracle fails before any scripted model request. Both author and primary agent reviewed the unsigned and test-user error screenshots. Captured browser message responses corroborate the same errors; the initial extra diagnostic request omitted directory and returned404, which is excluded. Pinned Pi0.85.0 is used in the Pi run. This preserves the existing test rather than adding duplicate first-send coverage. It does not qualify the blocked image or Browser assertions. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/native-first-send-1202/` and `native-first-send-1203/`.
- **Options**:
  - **A (recommended)**: correct native session creation and durable identity ownership, then enable the existing journey.
  - **B**: explicitly distinguish new-session startup from resuming native history in the canonical contract.
  - **C**: defer exposing the affected native first-send flow until corrected.
- **Decision**:

### 72. real-session-rendering-harnesses — restored OpenCode shell loses command and output

- **Status**: skipped after real build-preview failures in both auth modes (api-tool-1208 and api-rendering-1209, zero retries).
- **Tests**: `API-started OpenCode shell retains its executed command and result in the restored transcript`.
- **Expected**: a completed shell tool retains its executed command and returned stdout when the browser opens and reloads the real session.
- **Why**: a real API-started OpenCode turn executes `printf OPENCODE_API_TOOL_RESULT`; two model requests prove returned stdout reaches the model. Stored presentation data instead has `call_1` and empty input/output. Both completed-reply oracles pass, but the expanded tool shows only “Call 1,” failing both command/output checks. The author reviewed all four tool reply-oracle images and both expanded outcomes; the primary agent independently reviewed the unsigned expanded tool. Full videos remain unreviewed. This qualifies the restored-shell variant of the existing tool-data family, not read/edit/MCP/permission, grouping, exits, or live-command rendering. API session/message creation does not prove browser first-send recovery. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/api-tool-1208/result.json` and `api-rendering-1209/result.json`.
- **Options**:
  - **A (recommended)**: preserve canonical tool name, input and result through the authoritative OpenCode presentation producer, then enable this regression.
  - **B**: explicitly revise the product contract for which completed shell details must be retained, with equivalent user-visible execution evidence.
  - **C**: defer the affected tool-detail surface until the contract is implemented and verified.
- **Decision**:

### 73. real-session-rendering-harnesses — restored OpenCode local-file image renders only alt text

- **Status**: skipped after real build-preview failures in both auth modes (api-rendering-1209 and api-image-1210, zero retries).
- **Tests**: `API-started OpenCode local-file image restores as a compact tile with a full preview`.
- **Expected**: a real existing local PNG referenced by the assistant renders as an approximately 80×80px tile, with full image available on click after browser restoration/reload.
- **Why**: the API-started real OpenCode turn completes and stores Markdown referencing an existing 512×512 PNG; both completed-reply oracles pass on open/reload. The browser shows only “QA local image” alt text and no matching image element. The image-presence assertion fails, so tile geometry and preview checks are unreached. The author reviewed all four image reply-oracle images and both restored outcomes; the primary agent independently reviewed the test-user restored image. Full videos remain unreviewed. This qualifies the OpenCode web variant of the original file-image family; desktop and other harnesses remain open. API session/message creation does not prove browser first-send recovery. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/api-rendering-1209/result.json` and `api-image-1210/result.json`.
- **Options**:
  - **A (recommended)**: make the canonical local-image delivery and Markdown rendering path supply an actual image in the fixed-size tile, then enable the full preview regression.
  - **B**: explicitly revise the local-file image contract and corresponding user-visible behavior before adjusting acceptance.
  - **C**: defer exposing local-file image rendering until delivery, fixed-size loading/error states and preview are verified.
- **Decision**:

### 74. core-session-rendering-navigation — splash disappears before visible composer readiness

- **Status**: fixed 2026-09-16 — enabled and passing in both auth modes (build-preview). Was skipped after build-preview failures in both auth modes (boot-handoff-1216/1217; 0 pass / 1 fail each, zero retries).
- **Tests**: `cold boot keeps one steady logo through shell readiness and accepts the first prompt`.
- **Expected**: cold draft entry retains the splash until the main draft composer is visibly rendered, then accepts one first UI prompt with its completed reply visible.
- **Why**: the shell container becomes present before meaningful main content. The strengthened visibility probe includes ancestor opacity and records three unsigned / six test-user samples with neither splash nor composer. All 291 encoded video frames were reviewed through full-frame contact sheets, with native-resolution boundary checks: splash at 0.720s, missing main content at 0.760s, composer at 0.800s. The test-user sidebar remains visible. Both runs subsequently create one session, send one UI prompt and render the completed reply, with zero unhandled mock API requests. Signed Reconnecting persists after visual settlement. Earlier 1211/1212 greens checked the weaker shell-container condition and do not establish continuity. DOM and video sampling are separate clocks; exact gap duration is not inferred. This qualifies a shared-mock browser boot handoff, not real-provider or packaged-desktop reliability. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/boot-handoff-1216/result.json` and `boot-handoff-1217/result.json`.
- **Options**:
  - **A (recommended)**: make the canonical readiness owner retain the splash until the actual main composer is visible, then enable the strengthened journey.
  - **B**: define and implement a stable intermediate main-content presentation as an explicit handoff contract before revising acceptance.
  - **C**: defer the affected cold-entry flow until continuity and first-prompt readiness are verified.
- **Decision**: Option A applied 2026-09-16: `app-shell-bootstrap.tsx` owns a `BootSplashOverlay` sibling of the shell Suspense that keeps `claxedo-splash` mounted past the boundary until real main content marks ready. Readiness is a window flag (`__claxedoMainContentReady`, `shell-revealed.ts`) set by a `MainContentReady` marker — mounted by `ContentRenderer` (non-session surfaces), the canvas empty-state branches, and the `__CLAXEDO__` diagnostic stage — plus a per-frame poll for a visible, non-zero-size composer (`visibleComposerEditor` in `composer-focus.ts`) for the draft/session composer path, which is deliberately exact rather than presence-based. The `animate-pulse` on both splash renderers is removed so the logo is steady for the whole hold. The regression is enabled and passes in both auth modes (build-preview), including the first-prompt send with the completed reply painted.

### 75. real-session-rendering-harnesses — steering intermittently hides a completed OpenCode reply

- **Status**: fixed 2026-09-16 — enabled and passing in both auth modes (build-preview; unsigned 8/8 repeats post-correction plus a prior 5/5 + 6/6, test-user 3/3). Was skipped after intermittent real build-preview failure: unsigned 1213/1214 totals 3 pass / 0 fail; test-user 1215 has 1 pass / 2 fail; zero retries.
- **Tests**: `API-started OpenCode steering keeps the completed reply visible through reload`.
- **Expected**: after a steering addition completes in canonical stored messages, the live browser transcript visibly retains its assistant reply before reload.
- **Why**: both failed 20-second shared reply oracles see two user prompts only, while full canonical messages contain completed `OPENCODE_STEERING_INITIALOPENCODE_STEERING_FINAL`. Actual browser latest-surface/latest-turn responses retain only the steering user. The 24-request analysis establishes that failed repeat 1's initial empty history completed approximately 47ms before the first API prompt; a still-pending initial hydration alone is insufficient to explain the failure. The primary agent reviewed eight passing reply-oracle observations and two failure screenshots; full videos remain unreviewed. Failed runs never reach reload. API-started live steering qualifies this variation of the original missing-reply family, not browser first-send, native restart or mature-session variations. Runtime stream contents and the passing repeat's network trace are unavailable; event loss and an exact internal cause are not claimed. The proposed exact-session history guard is not implemented; the tested body is unchanged except fixme. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/steering-reply-1213/result.json`, `steering-reply-1214/result.json`, `steering-reply-1215/result.json` and `steering-reply-1215/analysis/network-ordering.json`.
- **Options**:
  - **A (recommended)**: correct the canonical latest-view and steering-turn association so the completed assistant remains in the visible turn, then enable the existing regression.
  - **B**: explicitly revise the canonical turn-association contract for steering additions while preserving the completed reply in all supported views.
  - **C**: defer the affected steering flow until canonical visibility and the relevant lifecycle variants are verified.
- **Decision**: Option A applied 2026-09-16. The lane is hydrate-driven: a page-level probe run showed zero conversation events reaching the registry even on passing repeats (`cur: []` until each hydrate), so the reply only renders when a hydrate carries it — and `latest-turn` is anchored on the last user boundary, which a steered prompt joins instead, so the running turn's reply is filed under the earlier user message and can never re-enter that window. The `latestTurnCompletion` read now escalates once when the hydrated registry still ends at a bare user message (`latestTurnWindowNeedsTailSync` in `first-fold-prefetch.ts`) — to the explicit tail page (`{limit}` paging with `replace-window` merging, `tail: true` on `syncSessionHistory`), since `latest-surface` shares the same last-user anchor and cannot recover the reply. Separately, `createPromptEventProjection` (`workspace-runtime/session/service.ts`) sets `announcesAssistantMessage: true` with `announceAssistantIdentity` carrying the prompt's agent/model/variant, so the first part event publishes the reply row with the same identity fields turn admission emits — before consumers can drop parts for a missing row, and without sparse values downgrading a populated row on merge. Adapter compat passthrough is unchanged. Unit coverage: announce ordering and identity in `service.test.ts`, the bare-user predicate in `session-controller.test.ts`. Enabled and passing in both auth modes (build-preview): unsigned 8/8 repeats post-correction (plus 5/5 + 6/6 earlier), test-user 3/3.

### 76. desktop-unsigned-embedded — Browser loses its loaded page on session return

- **Status**: skipped after the intended failure in packaged native run 1225 (0 pass / 1 fail, zero retries).
- **Tests**: `the native Browser retains its address and page after a Claude session round trip`.
- **Expected**: a loaded Browser tab retains its address and page when the user switches to another completed chat and back.
- **Why**: both genuine UI sends reach the real Claude binary and scripted model endpoint. The Browser initially loads a real loopback HTTP page; the address and Electron guest URL/body match. After rail navigation away and back, the tab remains but the address is empty and the guest is `about:blank` with an empty body. All five reply-oracle screenshots and before/return page images were reviewed. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/browser-return-1225/`. This qualifies the unsigned Claude variation of the historical Browser-loss family. It does not prove the original Codex variation, signed-native behavior, or the separate early-navigation lead in 1222. Full video timing remains unreviewed.
- **Options**:
  - **A (recommended)**: retain the Browser's canonical URL and restore it when its session panel remounts, then enable this regression.
  - **B**: keep each session's Browser guest mounted through session switches while preserving resource limits and session isolation.
  - **C**: defer Browser persistence until a documented lifecycle contract and acceptance test are implemented.
- **Decision**:

### 77. core-harness-rendering-matrix — interrupted Codex command returns to Running when its start frames replay on reattach

- **Status**: fixed 2026-09-15 — enabled and passing in both auth modes (build-preview). Was skipped after intended Tier M build-preview failures in both auth modes (interrupted-replay-1270/1271; 0 pass / 1 fail each, zero retries).
- **Tests**: `an interrupted Codex command stays interrupted when rail-return replay resends its start`.
- **Expected**: a stored tool part with `status: "error"` stays terminal when the runtime stream resends that tool's `tool-start`/`tool-input` frames after a rail return and reload.
- **Why**: this qualifies the numbered-inventory issue Codex #19 (interrupted command returns as Running). Mechanism proven in code and in the run: the reattached `/api/wr/runtime-events` stream replays the turn's start frames; a fresh client-presentation projection has no record of the terminal state and re-mints the stored part id (`seqId` = `000000_<callID>`) with `status: "running"`; the store's live-event path (`upsertPart` → `upsertChatParts`) replaces the stored part unconditionally, with none of the terminality ranking `mergeChatPart` applies on the REST snapshot path. The row renders Running with an advancing elapsed timer (sampled 0s→7s) until a later canonical refetch reverts it — the same Running + shimmer signature captured in the original heavy-transcript report. The replay's announced `message.updated` also strips `time.completed` (`preserveMessageFields` keeps only author and ranked error), un-settling the message and disabling the late-part guard. A `QA_REPLAY_PROBE` text-delta assertion proves the replayed frames reached this session's conversation, so the failure is the overwrite, not a silent channel. The fix belongs in the live-event merge: live frames must not downgrade a part/message state that canonical data already settled. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/interrupted-replay-1270/result.json` and `interrupted-replay-1271/result.json`.
- **Options**:
  - **A (recommended)**: apply the settled/terminal ranking to live `message.part.updated` and `message.updated` upserts — an existing terminal part cannot be replaced by a non-terminal state, and a completed message does not lose `time.completed` — then enable the regression.
  - **B**: carry per-call terminal memory in the client-presentation projection across reattach so a replayed `tool-input` emits the terminal state like `tool-start` already does when it knows the outcome — insufficient alone, since the projection cache is evicted at turn end and cannot see stored history.
  - **C**: defer the affected reattach flow until terminal-state protection is verified.
- **Decision**: Option A applied 2026-09-15: `upsertPart` (`agent-conversation.ts`) rejects a non-terminal frame when the stored part's carried `agentPart.state.status` is `completed`/`error`, and `preserveMessageFields` keeps `time.completed` so the settled guard survives replayed `message.updated` envelopes. The test's liveness probe moved to a `session-title` frame — a settled message now correctly drops replayed text-deltas. Unit coverage in `agent-conversation.test.ts`; the reload and rail-return e2es are enabled and pass in both auth modes.

### 78. core-busy-abort-errors — Thinking anchors to the previous turn while its completion envelope is in flight

- **Status**: fixed 2026-09-15 — enabled and passing in both auth modes (build-preview). Was skipped after intended Tier M build-preview failures in both auth modes (thinking-anchor-1272/1273; 0 pass / 1 fail each, zero retries).
- **Tests**: `Thinking stays with the new prompt while the previous turn's completion envelope is in flight`.
- **Expected**: after a follow-up send, every painted Thinking row belongs to the new prompt's user message.
- **Why**: this qualifies the numbered-inventory issue Codex #5 (Thinking appears under the preceding turn). The prior turn's assistant envelope lacks `time.completed` (reply parts painted, completion envelope still in flight) and the session reads busy. `activeMessageID` resolves `pending()` — the last un-completed assistant — to its `parentID`, the OLD user message; the old turn stays `isActive && busy && !settled` and emits the Thinking row inside its own block, painted beneath its completed-looking reply and above the newly sent prompt bubbles — the layout in `evidence/codex-thinking-placement/previous-turn.jpg`. Per-frame sampling attributes 496 consecutive post-submit Thinking frames to the previous user message in the unsigned run; when the new turn's `message.updated`(pending) lands, the anchor relocates. The earlier normalized control (runs 1112–1114) never reproduced this because its seeded assistant was already completed, so `pending()` never resolved backwards. The defect is the anchor: once a newer user message exists, a stale un-completed assistant from an older turn must not win `activeMessageID`. Evidence: `docs/verification/session-rendering/2026-09-12/evidence/thinking-anchor-1272/result.json` and `thinking-anchor-1273/result.json`.
- **Options**:
  - **A (recommended)**: in `activeMessageID`, prefer the last user message when it postdates the pending assistant's parent — i.e., resolve `pending()`'s parent only when no newer user message exists — then enable the regression.
  - **B**: stamp the pending assistant's turn when its parent is superseded by a newer user message, so `settled`/anchor reads never point backwards.
  - **C**: leave the anchor and document the transitory wrong-owner window — rejected: the original defect was reported as a fail and the observed window exceeded half a second.
- **Decision**: Option A applied 2026-09-15: `activeMessageID` (`message-timeline.tsx`) returns the newest user message's id when it postdates the pending assistant's parent, so Thinking anchors to the new prompt while the previous completion envelope is in flight. The test's setup assertion reads the painted reply without the `:not([aria-hidden])` filter — the in-flight turn marks its content aria-hidden while busy, which is correct — while the Thinking-ownership assertions stay strict. Enabled and passing in both auth modes.

### 79. real-harness-local — a Codex child session's escalated command must surface an approval dock (state 75)

- **Status**: fixme; the scenario cannot currently reach the child turn — the parent's first send dies with "no rollout found for thread id" (the codex missing-rollout defect, same churn class as the Pi session-file defect fixed in `20fdb18874`: per-request config apply rotates the brokered placeholder, `replaceAuth` restarts the app-server, and a thread created-but-never-persisted is gone; `startTurnWithThreadRecovery` cannot help because its matcher (`/thread not found/i`) does not match "no rollout found" and `thread/resume` cannot recover a thread with no rollout file). The test detects that blocker and `test.skip`s explicitly so it can only go red on the actual defect once the parent turn works.
- **Tests**: `codex child session's escalated command surfaces an approval dock, not a silent denial`.
- **Expected**: a `spawn_agent` child whose `exec_command` carries `require_escalated` surfaces a permission dock on the parent (the child's own tab is read-only), so no command reports "User declined" without a user-visible decision.
- **Why**: this qualifies the numbered-inventory issue Codex #75 (child command reports denial without a visible decision). The Tier M control `a child session's permission request reaches a decision dock on the parent` (core-docks.spec) PASSES in both auth modes: `sessionTreeRequest` walks `parentID`-linked child sessions, so a `permission.asked` on the child mounts the dock on the parent's composer and Deny posts `reject` to the child's route. The UI path is therefore not the defect — the runtime must have auto-denied without ever asking. Only the real producer can prove that, which is why the repro lives at Tier R.
- **Options**:
  - **A (recommended)**: fix the upstream missing-rollout churn (driver-side recovery for created-but-unpersisted threads, as Pi got in `20fdb18874`, or stop rotating the brokered placeholder within its TTL), then this test reaches the child ask; if the dock still never mounts, the defect is the runtime auto-denying approvals for sessions without an active-thread entry.
  - **B**: route child-session approval asks to the parent's decision surface explicitly in the runtime, so a child can never be denied without a visible decision.
  - **C**: keep the denial semantics but relabel the stored error so it no longer claims a user decision that never happened.
- **Decision**:

### 80. core-harness-rendering-matrix — a settled reply must not re-render its streamed text when the turn's deltas replay (state 17)

- **Status**: fixed 2026-09-15 — enabled and passing in both auth modes (build-preview). Was fixme; fails in both auth modes (runs 1274/1275, zero retries) — the settled reply's text renders twice.
- **Tests**: `a settled reply does not re-render its streamed text when the turn's deltas replay`.
- **Expected**: replayed `text-delta` frames for a completed turn cannot add a second copy of already-stored reply text — the rendered transcript shows the text exactly once.
- **Why**: this qualifies the numbered-inventory issue state 17 (the two-item exit list rendered twice around failed tool rows while the stored text carried it once). The chain is the same replay family as register 77: a reattached `/api/wr/runtime-events` stream delivers the finished turn's `text-delta` frames; a fresh client-presentation projection announces `message.updated` whose `preserveMessageFields` merge drops `time.completed` (un-settling the stored envelope), then mints a fresh part id `000000_<msg>-text` that cannot collide with the stored `prt_…` part — so the settled-message guard passes and the delta appends a SECOND text part. When the delayed canonical fetch lands, `mergeChatParts` keeps both parts and the reply paints twice. Timing matters: deltas drained AFTER the canonical load are dropped by the settled guard on the unknown part id, which is why earlier idle-session rechecks never reproduced it.
- **Options**:
  - **A (recommended)**: keep `time.completed` through the `message.updated` merge (fix `preserveMessageFields` to carry the settled stamp) so the settled guard keeps dropping replayed parts — one fix covers this family and register 77's un-settling half.
  - **B**: dedupe on content identity at the merge — when a live part's accumulated text equals an already-stored part's text, prefer the stored one.
  - **C**: drop `text-delta` replays for sessions whose messages are still loading instead of applying then merging.
- **Decision**: Option A applied 2026-09-15: `preserveMessageFields` in `conversation-snapshot.ts` carries `time.completed` through the merge, so the settled-message guard keeps rejecting replayed `text-delta` frames on the fresh `000000_<msg>-text` part id. Enabled and passing in both auth modes.

### 81. real-harness-local — a scripted Pi turn in a local workspace reaches the real OpenAI endpoint

- **Status**: failing-everywhere (tier-real gate, every run since at least 2026-09-10); `test.fixme` 2026-09-23 pending this decision.
- **Tests**: `local new-worktree session receives its first reply`; the sibling `pi-workspace harness completes exact turns` fixme shares the routing and its recorded reason is unverified until this is decided.
- **Expected**: the Pi turn is answered by the scripted model server and the reply renders.
- **Why**: the scripted double cannot reach Pi. `configureScriptedPi` (`e2e/helpers/real-local-server.ts`) stores an `openai` key and hand-writes a `models.json` into `PI_CODING_AGENT_DIR`, but `piAgentDir()` (`agent-sdk-runtime/src/harnesses/pi/agent-dir.ts`) prefers the workspace store root, which every embedded workspace has, and the harness rewrites that profile's `models.json` from the broker projection on every apply. The broker sends an `openai` key to the hard-coded `https://api.openai.com` (`server-core/src/credentials/destinations.ts`), which answers 401 for `test-key`. The one product path that binds Pi to an owner-chosen origin, `PUT /api/claxedo/host-provider-config`, is mounted by `createLocalApp` only; tier-real runs the self-hosted-node app, which mounts no such route. CI additionally never installed the pinned Pi binary, so the picker offered no Pi models (fixed separately).
- **Options**:
  - **A**: mount `HostProviderConfigRoutes` and compose `hostProviderConfigProjectAuth` into the self-hosted-node app, then bind the scripted server through it. Widens that binary's loopback control surface to owner-chosen base URLs; a security call. M.
  - **B**: run the Pi tier-real scenarios against the desktop daemon composition (`startLocalServer`), which already mounts the push route. Changes which product the tier proves for Pi. M.
  - **C**: add a first-class custom OpenAI-compatible provider path for Pi (a real product gap: the harness replaces any user `models.json`). L.
- **Decision**:

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
| live-host-tunnel-relay `:795` | prompt through the relay lane completes a real turn — behavior 3 | REAL GAP: a fresh DRAFT nav to `/w/:workspaceId/session` for a `ws_`-shaped id renders the Local/Cloud draft picker and mis-routes through the CLOUD pipeline instead of the user-hosted gate (`session-new-workspace-options.ts` / `WorkspaceGate` mount order) | app: resolve inventory kind before rendering the Local/Cloud draft picker for a known relay-backed id |
| live-host-tunnel-relay `:880` | pause/resume the real host tunnel surfaces offline + Retry — behaviors 5,6 | BLOCKED by behavior 3's gap (gate can't reliably reach the genuine ready state for the draft-nav pattern); the tunnel lifecycle itself is proven real | fix behavior 3 first, then re-enable |
| live-host-tunnel-relay `:931` | near-expiry token triggers a real refresh, workspace stays usable — behavior 4 | UNCONFIRMED (not disproven): no `POST .../connection/refresh` observed within 20s once the gate reached ready; a different, narrower gap than 3/5/6 | diagnose the refresh trigger timing; distinguish from the draft-nav gaps |
| live-host-tunnel-relay `:682/:904` | Tier L + TTL gates | `test.skip(!LIVE)` describe gates (main + token-refresh block with shortened TTL) | keep as env-gated skips |
