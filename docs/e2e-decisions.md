# E2E test decisions register

This doc lists every e2e test that is failing or intentionally skipped (`test.fixme`) and needs an owner call. Each entry is self-contained: the user-visible behavior under test, why it's off, and A/B/C options. **Fill in the `Decision:` line per entry** — that's the only field you need to edit. Options are labelled by effort (S ≈ <½ day, M ≈ 1–2 days, L ≈ multi-day). Line numbers are as of 2026-07-20 (`dev`); CI evidence is from test.yml run `9995fa239a` (12-shard × 2-worker) unless noted.

| Section | Entries | Tests covered |
| --- | --- | --- |
| 1. Failing — needs a decision | 8 | 10 (5 failing-everywhere, 5 failing-CI-only) |
| 2. Skipped (`test.fixme`) — needs a decision | 35 (2 since resolved) | 41 fixme sites (39 open; #35 + #39 un-fixme'd + passing) |
| 3. Live-suite skips (not in core CI) | 1 table | 12 live `test.fixme`/`test.skip` bodies (3 marketplace rows have UI landed) |

> Also tracked, no entry needed: `core-busy-abort-errors.spec.ts:611` (stale-busy reconcile, behavior 2) was a contention suspect but **passed** in the 12-shard tune — resolved, watch for flake.
>
> Resolved since publish: **#35** (core-session-actions behavior 14) un-fixme'd and passing after the app-shell refactor; **#39** (core-turns-reload-recovery behavior 8) implemented per option A and passing 7/7 — see those entries. §3 marketplace UI (`:726` disable/enable, `:744` adopt/ignore, `:735` plugin-kind path) now **landed** in the app, though the live specs stay Tier L (`CLAXEDO_E2E_LIVE`) fixmes. §3 codex native SDK (`:600`, behavior 5) was a **false alarm** — the `thread not found` skew doesn't reproduce; promoted from `test.fixme` to a live test that now passes (Tier-L UI smoke green, 35.1s), no app fix needed.

Decisions recorded 2026-07-20; execution in progress (see git history).

---

## 1. Failing — needs a decision

### 1. core-sidebar-tree — "a harness-created session appears once its session.lifecycle event arrives — behavior 15"
- **Status**: failing-everywhere
- **Tests**: You're working in the app with the sidebar rail open. A harness (e.g. Codex) creates a new session in the background — say a subagent or an external CLI kicked one off.
- **Expected**: The new session row pops into the sidebar's session list within a few seconds, without you touching anything. Today it only shows up after a full reload.
- **Why**: real product bug. The lifecycle `created` event refetches the flat inventory (`GET /api/control/sessions`, verified 3 refetches) but never the paginated per-section query (`GET /api/control/session-list`) that actually feeds the rendered rail rows. Spec at `core-sidebar-tree.spec.ts:864`.
- **Options**:
  - **A (recommended)**: app — invalidate/refetch the `session-list` query on `session.lifecycle` events. S/M.
  - **B**: spec — assert only the flat-inventory refetch effect (weakens the test; no longer proves the user-visible row appears).
  - **C**: accept as a known limitation (users must reload to see harness-created sessions — poor UX).
- **Decision**: A (owner: agreed with recommendation)

### 2. core-workgraph — "executes GitHub, Linear, and Jira issues through real Session V2 Connections end to end"
- **Status**: failing-CI-only (workgraph-real job; the other 3 tests in that job pass)
- **Tests**: You bring a GitHub issue, a Linear issue, and a Jira issue into your personal WorkGraph; each becomes a Task that a real agent session executes using your live Connections.
- **Expected**: All three Tasks run end to end and their results land back on the WorkGraph's stream/Task cards.
- **Why**: the shared `beforeEach` (`core-workgraph.spec.ts:27`) times out at **240000ms** for this one test — it boots a separate production OpenCode process + native harness + the real Connections env, and never reaches ready within 4 min. The 3 sibling "real Session V2" tests share the same hook and pass, so the delta is specific to what this test's Connections setup requires. Failed on all 3 attempts (2 retries).
- **Options**:
  - **A (recommended)**: diagnose the `beforeEach` stall (download the `playwright-workgraph-real` artifact's `error-context.md`/trace for this test), then fix the setup or raise the hook budget honestly. M.
  - **B**: `test.fixme` until after launch with a "beforeEach 240s timeout, Connections env boot" note.
- **Decision**: A (owner: agreed with recommendation)

### 3. core-harness-rendering-matrix — "pi — shares the native rendering path (text renders) — behavior 1"
- **Status**: failing-everywhere
- **Tests**: You start a new session with the **pi** harness selected in the composer's harness picker and send your first message.
- **Expected**: The message sends and the assistant's reply streams into the session timeline like any other harness. Today the send never dispatches — the composer waits forever, because pi never gets a model: it's excluded from model auto-pick, and the composer's model picker doesn't render in pi mode, so there is no way to choose one.
- **Why**: the harness selector's `picked()` (`src/features/session/ui/controls/agent-harness-selector.tsx:~231`) deliberately excludes `pi` from the bare-id model fallback, and the model control (`[data-action="prompt-model"]`) is absent in pi mode (verified — the spec times out trying). Spec at `core-harness-rendering-matrix.spec.ts:702`.
- **Options**:
  - **A (recommended)**: app — give `pi` a default-model auto-pick path, or render the model control in pi mode (selector owner decides semantics). M.
  - **B**: app — expose pi model selection in whatever UI is intended and update the spec choreography to drive it. M.
  - **C**: remove `pi` from the rendering matrix until pi model UX is designed. S.
- **Decision**: A (owner: agreed with recommendation)

### 4. core-settings-auth — "/cli-login behaviors 28 & 29" (exchange CLI token / exchange-failure error)
- **Status**: failing under the production build only (pass under dev serving)
- **Tests**: You run `claxedo login` in your terminal; a browser tab opens the `/cli-login` page while you're already signed in to the web app.
- **Expected**: (28) The page exchanges your browser session for a CLI token and hands it back to the CLI automatically — you see a brief status line, then you're logged in. (29) If the exchange fails, the page shows you the server's actual error message and nothing is sent back to the CLI.
- **Why**: reproduced locally under a full prod-env boot, so **not** the VITE-flag issue that fixed behaviors 2,4,21–25 (that separate fix is what the in-progress `f02e6b934d` run bakes). Symptom for 29: the error message text never renders in the built bundle. Undiagnosed prod-build delta — suspect error-surface rendering or timing in the production bundle. Specs at `core-settings-auth.spec.ts:1573` and `:1611`.
- **Options**:
  - **A (recommended)**: diagnose properly under prebuilt serving (trace the built bundle), then fix at the honest layer. M.
  - **B**: `test.fixme` both with a "prebuilt-delta, undiagnosed" note until someone can trace it.
  - **C**: run just these two under dev serving in CI (split-mode hack) — dishonest: it hides a real prod-only regression. Not recommended.
- **Decision**: A (owner: agreed with recommendation)

### 5. documents-core — "repository index is metadata-only and edits file in place without a managed copy — behavior 2"
- **Status**: failing-everywhere
- **Tests**: You open the Documents index for a project whose repo contains Markdown files, and (as originally specced) use an importer on the index itself to bring a repo file into Documents.
- **Expected**: (as written) The index carries a repository importer; imported files stay in place in the repo — Documents tracks them metadata-only, and editing edits the real file, no managed copy. In today's app that importer no longer exists: you add a repo file from its own file tab via the per-file "Add to Documents" icon instead.
- **Why**: the repository-importer UI was **intentionally removed** from the Documents index (commit `76953781d7`; the unit test `document-index.vitest.tsx` now asserts it "does not carry a repository importer"). The flow moved to the Markdown file tab (`src/app/workbench/content/tab-file.tsx`). The spec asserts the old surface. Spec at `documents-core.spec.ts:703`.
- **Options**:
  - **A (recommended)**: rewrite the spec against the new per-file "Add to Documents" flow. M.
  - **B**: delete the test if behavior 2's contract is now obsolete.
  - **C**: `test.fixme` with a "Documents surface in flux" note until Documents settles.
- **Decision**: A (owner: agreed with recommendation)

### 6. core-cloud-offline-roles — reconnect-overlay pair (behaviors 4, 6/7)
- **Status**: failing-CI-only (still red on the 12-shard × 2-worker tune)
- **Tests**: You're working in a cloud workspace when the connection blips: ready → reconnecting → ready.
- **Expected**: (b4) No error toast ever appears, and when the connection comes back you just keep working — no reload. (b6/7) During the blip a reconnect overlay appears **on top of** your content; your session timeline and composer survive intact underneath and are still there when the overlay lifts.
- **Why**: pass locally, failed in CI at 8 shards × 4 workers; the 12×2 tune did **not** clear them (both still red in shard 1/12, `:631` and `:674`). Suspected runner-contention timing, not a source diagnosis.
- **Options**:
  - **A (recommended)**: per-test timing hardening (widen the reconnect/toast-absence polls, reduce reliance on wall-clock cadence), then re-run. M.
  - **B**: quarantine as flaky with a tracking issue and re-enable once runner contention is understood.
- **Decision**: A (owner: agreed with recommendation)

### 7. core-user-hosted-workspace — ready-send + Share pair (behaviors 2/3, 7)
- **Status**: failing-CI-only (still red on the 12-shard × 2-worker tune)
- **Tests**: (b2/3) You open a user-hosted (self-hosted) workspace; its startup gate walks through its 3 steps and reaches ready, unlocking the composer; you type a message and send. (b7) You use the in-app "Share workspace" entry point on a local workspace.
- **Expected**: (b2/3) The send goes through your host's relay and the assistant reply renders in the session timeline. (b7) The workspace gets registered for sharing and a confirmation toast appears.
- **Why**: pass locally, failed in CI at 8×4; the 12×2 tune did **not** clear them (shard 11/12, `:668` and `:798`). Suspected runner-contention timing.
- **Options**:
  - **A (recommended)**: per-test timing hardening (the oracle-send and toast waits are the likely victims of a starved runner). M.
  - **B**: quarantine as flaky with tracking, re-enable after contention fix.
- **Decision**: A (owner: agreed with recommendation)

### 8. core-sidebar-tree — "account footer exposes utilities and restores focus across nested panels"
- **Status**: failing-CI-only (still red on the 12-shard × 2-worker tune)
- **Tests**: You click the account footer at the bottom of the sidebar rail, open its menu, drill into a nested panel (e.g. View options), then back out.
- **Expected**: Each panel opens and closes cleanly, and keyboard focus lands back where you were — you can keep navigating by keyboard without focus getting lost.
- **Why**: pass locally, failed in CI at 8×4; still red in the 12×2 tune (shard 9/12, 2 retries). Focus-restoration assertions are timing-sensitive under contention. Spec at `core-sidebar-tree.spec.ts:726`.
- **Options**:
  - **A (recommended)**: harden the focus-restore assertions (await focus transitions explicitly rather than on a fixed budget). M.
  - **B**: quarantine as flaky with tracking, re-enable after contention fix.
- **Decision**: A (owner: agreed with recommendation)

---

## 2. Skipped (`test.fixme`) — needs a decision

Ordered by user impact: confirmed real app bugs first, then dead/unreachable UI, then harness/out-of-scope test-seam gaps.

### 9. core-panes-split-tabs — switcher status dot (behaviors 11 & 12)
- **Status**: skipped (test.fixme, `:703` + `:740`)
- **Tests**: You have a session running in a background tab of the tab switcher strip while you work in another tab — the classic "is my other agent done yet?" glance.
- **Expected**: The background tab shows an amber "working" dot while its agent is busy, flips to a "done" dot when it settles, and the dot clears when you focus that tab. Today the dot changes **once** after you background the tab and then freezes — it will happily show "working" forever on a finished session.
- **Why**: real app bug (both fixmes share one root cause, cross-referenced in-file). The status data updates correctly under the hood, but `useRailHeaderSurfaces`'s `switcherItems` memo (`src/claxedo-ui/layouts/rail-header-surfaces.ts:110-136`, built on `useQueries(..., {enabled:false})`) never re-renders off the **second** external `setQueryData` write for a never-focused tab — a solid-query `enabled:false` + external-write reactivity gap.
- **Options**:
  - **A (recommended)**: app — make `switcherItems` react to external cache writes (drop `enabled:false`, or subscribe to the status query). M.
  - **B**: keep fixme as a launch-known-issue (background dots are cosmetic).
  - **C**: delete both if the switcher dot is being removed.
- **Decision**: A (owner: agreed with recommendation)

### 10. core-panes-split-tabs — "empty workbench auto-opens a draft, and closing it suppresses the immediate re-open — behavior 15"
- **Status**: skipped (test.fixme, `:826`)
- **Tests**: You close the only open draft tab with its X button — you wanted an empty workbench, at least for a moment.
- **Expected**: The workbench respects the close for ~2 seconds before auto-opening a fresh draft. Today a brand-new draft replaces the one you closed within ~100ms — closing the last draft visibly does nothing.
- **Why**: real app bug, confirmed via 10ms in-browser sampling. The `blockNextAutoOpen()`/2s suppression window in `rail-empty-draft-controller.ts` never engages (either the close path doesn't reach it, or the auto-open effect ignores the flag).
- **Options**:
  - **A (recommended)**: app — fix the suppression wiring so the close path honors `blockedUntil`. S/M.
  - **B**: keep fixme as a known-issue (mild UX churn, not data loss).
  - **C**: drop the "suppression window" from the behavior spec if product decides immediate reopen is fine — then delete.
- **Decision**: A (owner: agreed with recommendation)

### 11. core-sidebar-tree — rail-width collapse/resize (behaviors 13, 11, 12)
- **Status**: skipped (test.fixme, `:938` + `:959` + `:973`)
- **Tests**: Three ways you'd control the sidebar rail's width: (13) you click the collapse toggle; (11) with the rail unpinned and collapsed, you hover the left edge to peek it open, then move away to let it re-collapse; (12) you drag the rail's resize handle to make it wider or narrower.
- **Expected**: The rail visibly collapses/expands/resizes and remembers your chosen width across reloads. Today none of it works: the toggle flips internal state (the button itself disappears) but the rail stays frozen at 260px wide; dragging the handle changes nothing, even mid-drag; and there's never a collapsed rail to peek open.
- **Why**: one real app bug behind all three (cross-referenced in-file). `railToggleCommand` (`src/shell/layout/commands.ts:31-43`) dispatches both `docked` and `size` on the rail region, but `sidebarWidth()` (`src/shell/app-shell-layout.tsx:229`) never reflects the dispatched `size.value`. Hot-zone (11) and drag-resize (12) read/write the same accessor, so they're blocked by the same defect.
- **Options**:
  - **A (recommended)**: app — fix `size` propagation through the rail-region dispatch; all three tests re-enable together. M.
  - **B**: keep all three fixme as one launch-known-issue.
  - **C**: n/a (these are real behaviors, deletion not defensible).
- **Decision**: A (owner: agreed with recommendation)

### 12. core-sidebar-tree — "mobile drawer opens on entry, scrim-closes, and closes on session select — behavior 14"
- **Status**: skipped (test.fixme, `:993`)
- **Tests**: On a phone, you open the app and want the sidebar: the drawer slides in, you tap the dark scrim to dismiss it, or you tap a session row and it closes as the session opens.
- **Expected**: A working mobile sidebar drawer. Today there is **no gesture or button anywhere that opens it** — on a phone you simply cannot reach the sidebar.
- **Why**: dead code. `mobileSidebarOpen` (`rail-shell-chrome-state.ts:18`) has no production call site that sets it `true` — only `closeMobileSidebar` is wired; and `RailSidebar`'s `onSessionSelect` prop (`rail-sidebar.tsx:212`) is declared but never invoked, so close-on-select is dead too.
- **Options**:
  - **A**: app — wire a mobile entry point (tap/swipe) so the drawer is reachable. M.
  - **B**: keep fixme until mobile nav is designed.
  - **C (recommended if mobile drawer is not on the roadmap)**: delete the test and the dead drawer code.
- **Decision**: A+ (owner: full mobile responsive — fix it)

### 13. core-composer-modes — "the sent (optimistic) user message highlights an inline agent mention — behavior 11"
- **Status**: skipped (test.fixme, `:538`)
- **Tests**: In the composer you type `@`, pick an agent from the mention popover (e.g. `@reviewer`), finish your message, and send.
- **Expected**: Your just-sent message in the session timeline shows `@reviewer` as a highlighted mention, matching the pill you saw while composing. Today it renders as plain unstyled text (the mention still reaches the agent correctly).
- **Why**: real bug. `src/shell/chat/opencode-conversation.ts:217-265,325-369` has no `"agent"` case, so the agent part is silently dropped in the raw-Part ↔ UIMessage projection; the rendering half is implemented and correct.
- **Options**:
  - **A (recommended)**: app — add the `"agent"` case to the part projection. S/M.
  - **B**: keep fixme (mention highlighting is cosmetic).
  - **C**: delete if inline agent-mention highlighting is dropped from scope.
- **Decision**: A (owner: agreed with recommendation)

### 14. core-composer-modes — "Escape aborts an in-flight turn when not in shell mode and no popover is open — behavior 8"
- **Status**: skipped (test.fixme, `:431`)
- **Tests**: You send the very first message from a fresh draft, the agent starts working (the submit button becomes a stop button), and you press Escape to abort.
- **Expected**: The turn aborts. Today, on this specific fresh-draft-becomes-a-session transition, the composer never learns the session is busy — so Escape has nothing to abort, and the busy/stop affordance itself is unreliable in that moment.
- **Why**: INVARIANTS #4 ("submit control is the single source of truth for busy") is violated on the fresh-draft→session transition — the busy signal never reaches this composer instance via any path (the REST status-poll route was never even hit in verification).
- **Options**:
  - **A (recommended)**: app — fix busy-state propagation to the composer on the draft→session transition; then this and related busy tests re-enable. M.
  - **B**: keep fixme until the busy-source-of-truth gap is fixed.
  - **C**: n/a (real behavior).
- **Decision**: A (owner: stop control always present — idle when idle, stop when working; background agents stoppable via background button opening side panel — investigation scheduled)

### 15. core-composer-modes — "comment-linked context chips are hidden while shell mode is active — behavior 19"
- **Status**: skipped (test.fixme, `:690`)
- **Tests**: You've attached a code-line comment to the composer as a context chip, then flip the composer into shell mode to run a command.
- **Expected**: The comment-linked chip hides while shell mode is active (a shell command can't use it) and returns when you leave shell mode.
- **Why**: no known user-facing defect — the gating logic exists (`composer.tsx:388-392`); this entry is about where the coverage should live, not a bug. Inserting a comment-linked chip requires a real code-editor line selection (the file/diff line-comment UI), machinery this composer-focused spec doesn't stand up; it belongs to the file/diff specs.
- **Options**:
  - **A (recommended)**: move the assertion into a file/diff spec that already has a line-comment surface. S/M.
  - **B**: keep fixme as a documented cross-spec seam.
  - **C**: delete (the gating is unit-testable at `composer.tsx` level instead).
- **Decision**: A (owner: agreed)

### 16. core-workspace-lifecycle — New workspace Local/Cloud flow (behaviors 8, 9, cloud dialog)
- **Status**: skipped (test.fixme, `:544` + `:560` + `:576`)
- **Tests**: From the sidebar you'd add a **new workspace inside an existing project**: a dialog offers Local (a new git worktree) or Cloud Sandbox; picking Local creates the worktree and opens it; picking Cloud walks you through provider select → name → a 4-step provisioning pipeline.
- **Expected**: That whole flow works. Today it's triply broken: (8) **no button or menu anywhere opens the Local/Cloud dialog** — the sidebar's only "+" is "New Project", which opens the directory picker instead; (9) even if triggered, local worktree creation would **hang forever** on a wait nothing in production ever resolves; and the cloud dialog is only reachable through the same dead trigger.
- **Why**: real bugs + dead code (interlinked). `onNewWorkspace` is threaded from `app-shell.tsx:101` down to `rail-sidebar.tsx:215` but **never called** from any handler. Independently, `onWorktreeCreated(..., wait=true)` (`project-actions.tsx:176-193`) awaits `WorktreeState.wait` with no timeout, and there are zero `.ready()`/`.failed()` call sites outside tests.
- **Options**:
  - **A (recommended)**: app — wire the trigger AND add a timeout/resolution path to the worktree wait; re-enable all three. M/L.
  - **B**: keep fixme until New-workspace is prioritized.
  - **C**: delete the dead Local/Cloud picker code and tests if the feature is cut.
- **Decision**: C (owner: dialog is dead — everything happens through the session composer; delete)

### 17. core-settings-auth — "Log out signs out and navigates to /login — behavior 5"
- **Status**: skipped (test.fixme, `:883`)
- **Tests**: In Settings → General → Account, you click **Log out**.
- **Expected**: You're signed out — persisted auth state is purged — and you land on `/login`. Note the confirmed state-purge bug lives in the dev/test auth-bypass path; whether production Clerk sign-out is affected is untested from e2e.
- **Why**: unreachable in-harness **plus** a real app bug. (1) Under Playwright (`navigator.webdriver===true`) `isSignedIn()` (`auth-client.ts:295`) is unconditionally true, so `/login`'s redirect-if-signed guard bounces straight back — verified live. (2) Real bug: `initializeClerk()`'s test-bypass branch (`auth-client.ts:164-173`) never sets `clerkLoadPromise`, so `signOut()` no-ops at line 308 — sign-out under the dev/test bypass never purges persisted auth state (reproduced: a marker survives Log-out).
- **Options**:
  - **A (recommended)**: app — fix `signOut()` so the bypass path purges state; add an `/__e2e` hook or non-webdriver mode to make it drivable. M.
  - **B**: keep fixme, file the sign-out no-op as its own bug.
  - **C**: delete the e2e assertion, cover sign-out at the unit level only.
- **Decision**: A (owner: agreed with recommendation)

### 18. core-settings-auth — Sandbox tab + local-principal (baked-flag unreachables)
- **Status**: skipped (test.fixme, `:810` + `:878`)
- **Tests**: Two configuration-off negatives: on a build with the sandbox feature disabled, you open Settings — the **Sandbox tab should simply not be there**; running fully local with auth disabled, you open Settings → General — the **Account section should be hidden entirely** (nothing to sign in or out of).
- **Expected**: Flag-off builds hide those surfaces. Matters mainly for self-host/local-only builds; hosted-cloud users never see these configurations.
- **Why**: unreachable in the e2e harness — `VITE_SANDBOX_ENABLED` and `VITE_AUTH_ENABLED` are baked true at Vite start for the whole shared dev server (`.env.local`), not flippable per-spec. No evidence of an app bug; this is purely untestable-config coverage.
- **Options**:
  - **A (recommended)**: add a per-spec/per-project build variant (or runtime override) that flips these VITE flags, then implement both. M.
  - **B**: keep fixme as documented baked-flag gaps.
  - **C**: delete — the flag-off branches are covered by reading source; low value without a build variant.
- **Decision**: Remove the flag entirely (owner: sandbox options always present)

### 19. core-settings-auth — "an anonymous principal on a non-loopback transport is force-redirected to /login"
- **Status**: skipped (test.fixme, `:1653`)
- **Tests**: You open the app pointed at a **remote** (non-localhost) server without being signed in — e.g. a shared/hosted deployment.
- **Expected**: You're immediately redirected to `/login` (with a brief loading placeholder) — never shown the workbench of a server you haven't authenticated to.
- **Why**: unreachable in-harness — CloudAuthGate's `server.url` traces to `getClaxedoServerUrl()`, hardcoded to the build-time `VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3001` (always loopback) for the shared dev server; nothing settable at request time flips it. No evidence of an app bug, but this is an auth boundary — worth real coverage eventually.
- **Options**:
  - **A (recommended)**: expose a runtime server-URL override for tests (or a dedicated non-loopback harness), then implement. M.
  - **B**: keep fixme as a baked-URL gap.
  - **C**: delete — covered by reading the gate source.
- **Decision**: A (owner: agreed with recommendation)

### 20. core-settings-auth — "InitError variants render their formatted chain with Restart — error page"
- **Status**: skipped (test.fixme, `:1660`)
- **Tests**: The app crashes during startup (an init error — bad config, failed boot dependency).
- **Expected**: Instead of a blank screen, you see the error page: the formatted error chain explaining what failed, plus a **Restart** button (and no "Check for updates" on web).
- **Why**: unreachable in-harness — there is no deterministic way to make the app crash on demand (unlike the dialog matrix, which has an `/__e2e/dialog-matrix` route, there's no `/__e2e/error-page?variant=...` injection route). No evidence the error page is broken; it's just unprovable end-to-end today.
- **Options**:
  - **A (recommended)**: add an `/__e2e/error-page?variant=...` injection route, then implement. S/M.
  - **B**: keep fixme until the injection route exists.
  - **C**: delete — cover ErrorPage formatting via a component/unit test.
- **Decision**: A (owner: agreed with recommendation)

### 21. core-settings-auth — "double-submit guard: a reactive re-trigger never re-exchanges"
- **Status**: skipped (test.fixme, `:1636`)
- **Tests**: During CLI login (`/cli-login`), after the token exchange has already succeeded once, an internal re-evaluation of the page must not fire a **second** exchange.
- **Expected**: Exactly one exchange per visit. No direct user impact — this guards an internal re-entrancy invariant with no visible surface; a violation would only show up as a duplicate token exchange behind the scenes.
- **Why**: not black-box triggerable — the guard (`if (submitted()) return`, `cli-login.tsx:99-100`) sits in a `createEffect` keyed on signals that never change again after the first successful run in a normal SPA navigation; there's no external trigger without an app-exposed test hook or white-box reactive poking, which this suite avoids.
- **Options**:
  - **A**: add a minimal app-exposed re-trigger hook for the test, then implement. S/M.
  - **B (recommended)**: keep fixme — the guard is unit-testable; a black-box e2e adds little.
  - **C**: delete and cover at the unit level.
- **Decision**: B (owner: agreed — keep fixme)

### 22. core-processes — "a process crashing after launch lights the toolbar attention dot — behavior 10 (attention-dot half)"
- **Status**: skipped (test.fixme, `:1166`)
- **Tests**: You start a managed process from the Processes panel (say your dev server), close the panel, and keep working. The process crashes.
- **Expected**: The Processes toolbar icon lights an attention dot so you notice the crash without having the panel open.
- **Why**: an adjacent real defect is flagged in-file — `process-pane.tsx:990-994`'s cleanup resets crash state unconditionally on any panel unmount, so even a correctly-lit dot gets silently wiped when you visit then close the panel. The attention-dot-on-reconcile half itself isn't reproduced here.
- **Options**:
  - **A (recommended)**: app — make the crash-state cleanup conditional, then assert the attention dot. M.
  - **B**: keep fixme, file the unmount-clobber as its own bug.
  - **C**: n/a (real behavior).
- **Decision**: A (owner: agreed with recommendation)

### 23. core-processes — "diagnostics dialog opens, shows tabs/health/metrics, lists a running managed process — behavior 17"
- **Status**: skipped (test.fixme, `:1377`)
- **Tests**: You open the account menu at the bottom of the sidebar rail and pick **Diagnostics**.
- **Expected**: A dialog opens with health/metrics tabs, listing your running managed processes. Only applies on desktop or sandbox-disabled builds — on the hosted web build the menu item is intentionally absent (verified live: the menu shows only View options/Usage limits/Settings/Help/Log out).
- **Why**: unreachable in-harness — the item is gated by `platform==="desktop" || sandboxEnabled!==true` (`rail-account-menu.tsx`); this harness bakes `VITE_SANDBOX_ENABLED=true` and runs the web platform. Same baked-flag class as entry 18. No evidence of a bug.
- **Options**:
  - **A**: add the sandbox-flag build variant (see entry 18), then implement. M.
  - **B (recommended)**: keep fixme until a desktop or flag-off harness exists.
  - **C**: delete if Diagnostics stays desktop-only.
- **Decision**: Update test as web-negative (owner: desktop-only is correct behavior)

### 24. core-processes — "viewer role hides Add/Start/Stop/Restart/Edit controls — behavior 18 (read-only half)"
- **Status**: skipped (test.fixme, `:1402`)
- **Tests**: You open the Processes panel in a shared workspace where your role is **viewer**.
- **Expected**: The panel is read-only — no Add process, Start, Stop, Restart, or Edit controls; you can watch but not touch.
- **Why**: coverage-placement question, not a known bug — role gating needs a live workspace connection with a minted viewer token; reproducing it here would duplicate `core-cloud-offline-roles`' role fixture rather than exercise anything Processes-specific.
- **Options**:
  - **A (recommended)**: fold the viewer-role Processes assertion into `core-cloud-offline-roles` (or a shared role fixture). M.
  - **B**: keep fixme as a documented cross-spec seam.
  - **C**: delete — role gating is generic, covered by the roles spec.
- **Decision**: A (owner: whatever is best, avoid duplication)

### 25. core-processes — "project-shared process config is visible across two local workspaces, no leaks after stop"
- **Status**: skipped (test.fixme, `:1413`)
- **Tests**: You define a project-shared process (e.g. the dev server) and open two local workspaces of the same project.
- **Expected**: Both workspaces list the shared process, each gets its own sibling port, and stopping leaves no orphaned OS ports.
- **Why**: no additional user risk from this skip — the behavior is already covered **live** by `e2e-legacy/process-project-shared.spec.ts` (`CLAXEDO_PROCESS_PROJECT_SHARED_LIVE=1`, real backend/worktrees/child processes). A mocked HTTP layer has no real port to leak, so this copy can't assert the real invariant.
- **Options**:
  - **A**: keep the live coverage as the source of truth; leave this as a pointer.
  - **B**: keep fixme with the live-spec cross-reference.
  - **C (recommended)**: delete — it duplicates a live spec and can't assert the real invariant.
- **Decision**: C (owner: behavior is correct; entry was only about a mocked duplicate — delete it)

### 26. core-model-effort-agent-controls — "agent selector disabled-while-harnessPending is unreachable — behavior 7"
- **Status**: skipped (test.fixme, `:595`)
- **Tests**: While the composer is still resolving which harness backs a session, the agent picker would render visible but momentarily disabled.
- **Expected**: A visible, disabled agent picker during that resolution window. No user has ever seen this state — in the current wiring the picker simply isn't shown at all while the harness is pending, which may be the intended design. No direct user impact.
- **Why**: `showAgentSelector()` and `harnessPending()` are mutually exclusive (`composer.tsx:91-101`, `selector-visibility.ts`), so the state is unreachable through the public composer surface.
- **Options**:
  - **A**: app — if a disabled-during-pending state is intended, adjust `selector-visibility.ts` and implement. M.
  - **B (recommended)**: keep fixme — likely the state simply doesn't exist by design.
  - **C**: delete if the mutual exclusion is the intended contract.
- **Decision**: Hide agent picker for non-opencode harnesses like upstream (owner); update/delete test to match

### 27. core-harness-ownership-local — "draft harness resets to OpenCode when directory changes away from a workspace-runtime ref — behavior 9"
- **Status**: skipped (test.fixme, `:818`)
- **Tests**: You have a draft composer targeting a cloud or user-hosted workspace with a non-default harness picked, then you switch the draft's directory to a plain local folder.
- **Expected**: The harness picker resets to OpenCode — a cloud-only harness choice shouldn't silently carry over to a local directory that can't honor it.
- **Why**: coverage-placement question, not a known bug — the reset (`store-policy.ts:80-92`) only fires when a `cloud`/`user-hosted` backing exists, and this local-only spec's mock has no such backing. Belongs to `core-harness-ownership-cloud` (spec 12).
- **Options**:
  - **A (recommended)**: move the assertion into `core-harness-ownership-cloud`. S/M.
  - **B**: keep fixme as a documented cross-spec seam.
  - **C**: delete (covered by the transition's unit logic).
- **Decision**: Remove the auto-reset (owner: bad UX; local embedded runtime supports all harnesses — persist the choice); spec asserts persistence

### 28. core-harness-rendering-matrix — "opencode native — compaction divider renders on the assistant timeline — behavior 7"
- **Status**: skipped (test.fixme, `:606`)
- **Tests**: During a long OpenCode session, the agent compacts its context mid-conversation.
- **Expected**: A compaction divider appears in the session timeline at that point, so you can see where the context was condensed. Today it never renders — the conversation just flows on with no marker.
- **Why**: UNRESOLVED — the compaction part never reaches its renderer (`[data-component="compaction-part"]`) even though every other part in the same trace renders; possible collision with `session-turn.tsx`'s separate user-message compaction divider. Needs interactive store inspection the remediation pass lacked.
- **Options**:
  - **A (recommended)**: diagnose with devtools/store inspection, fix the assistant-timeline compaction path. M.
  - **B**: keep fixme with the "undiagnosed, store-inspection needed" note.
  - **C**: n/a (real behavior; deletion not defensible).
- **Decision**: A (owner: agreed with recommendation)

### 29. core-harness-rendering-matrix — "claude-sdk (native) — reasoning part renders — behaviors 2,17"
- **Status**: skipped (test.fixme, `:847`)
- **Tests**: You run a session on the native claude-sdk harness and the model thinks before answering.
- **Expected**: The reasoning/thinking block renders in the session timeline (and diagnostics add zero extra rows). Today the reasoning never appears — you only see the final answer, with the thinking silently missing.
- **Why**: UNRESOLVED — the reasoning part's text never reaches its renderer despite arriving through the exact same accumulator path the sibling (working) text part uses. Gap is specific to reasoning-typed parts; needs interactive store inspection.
- **Options**:
  - **A (recommended)**: diagnose the reasoning-part accumulator path with store inspection, fix. M.
  - **B**: keep fixme with the "undiagnosed" note.
  - **C**: n/a (real behavior).
- **Decision**: A (owner: agreed with recommendation)

### 30. core-harness-rendering-matrix — "assistant file-type parts (image/audio/resource-link) render — behavior 6"
- **Status**: skipped (test.fixme, `:908`)
- **Tests**: The assistant includes a file in its reply — an image, an audio clip, or a resource link.
- **Expected**: It renders in the session timeline with a dedicated component (an image you can see, a link you can click). Today it's silently dropped — the reply renders as if the file was never sent.
- **Why**: real, source-verified gap — no `PART_MAPPING["file"]` is registered anywhere; `registerPartComponent` (`message-part.tsx:~947`) is exported but has **zero** call sites, so a `file`-type assistant part never reaches the DOM.
- **Options**:
  - **A (recommended)**: app — register a `file` part component. M.
  - **B**: keep fixme as a known rendering gap (file parts are rare today).
  - **C**: delete if assistant file parts are out of scope for launch.
- **Decision**: A (owner: agreed with recommendation)

### 31. core-harness-rendering-matrix — "pi — one dedicated tool renderer (config.json subtitle) — behavior 3"
- **Status**: skipped (test.fixme, `:723`)
- **Tests**: Using the pi harness, the agent runs a tool (e.g. reads `config.json`).
- **Expected**: The timeline shows a proper tool row with its subtitle (the file name), like other harnesses. Whether this actually works today is **unknown** — no evidence of a bug; the test simply has nothing to replay.
- **Why**: fixture gap, not a diagnosed defect — the committed pi trace (`e2e/fixtures/harness-traces/pi.json`) contains no tool call at all (only text + reasoning). Hand-editing fixtures is forbidden (DoD #4: must be regenerated via `bun run e2e/fixtures/generate-harness-fixtures.ts`), which was out of the remediation's safe scope.
- **Options**:
  - **A (recommended)**: regenerate `pi.json` with a tool envelope via the generator script, then implement. M.
  - **B**: keep fixme until the fixture is regenerated.
  - **C**: delete if pi tool rendering isn't a launch requirement (see also entry 3).
- **Decision**: A (regenerate fixture after the pi fix)

### 32. core-boot-deep-links-home — "Home lists recent projects and Open project opens the platform dialog — behavior 3"
- **Status**: skipped (test.fixme, `:551`)
- **Tests**: You open the app at `/` (Home) with existing projects.
- **Expected**: (as originally specced) A "Recent projects" list, and an "Open project" button that opens the directory dialog. Today no recents list exists anywhere in the UI — with projects present, `/` auto-navigates away entirely, and the "+New project" flow always opens the directory/cloud dialog directly.
- **Why**: the spec pins a Home surface that was never built or was retired; the real "+New project" flow (`project-actions.tsx:96-150`) always opens `DialogSelectDirectory` (cloud branch under this build's config), and its dialog coverage lives in `core-workspace-lifecycle` per this spec's OUT OF SCOPE.
- **Options**:
  - **A**: app — if a recents list is intended on Home, build it, then implement. M.
  - **B (recommended)**: keep fixme until Home's recents UX is decided.
  - **C**: delete — the recents list may be a retired concept; dialog coverage lives elsewhere.
- **Decision**: B — keep fixme (owner asked what this is: answered — the spec pinned a never-built Home recents surface; recents would come from the local project store, not the control plane; revisit when Home UX is decided)

### 33. core-busy-abort-errors — "escalation ladder reaches the failed/unresponsive stage with Cancel and Retry — behavior 8"
- **Status**: skipped (test.fixme, `:987`)
- **Tests**: The agent goes completely silent mid-turn and stays silent for five minutes.
- **Expected**: The busy indicator escalates through its stages and finally shows the "failed/unresponsive" state with **Cancel** and **Retry** — you're never left staring at an eternal spinner.
- **Why**: not provable at CI speed, not a known bug — the failure stage fires at `OPTIMISTIC_STATUS_FAILURE_MS = 5*60_000` (`session-status-dispatcher.ts:15`) of real wall-clock, and the earlier "pending"/"long" stages of the identical mechanism **are** proven by passing tests in this spec. Only the wall-clock distance differs.
- **Options**:
  - **A (recommended)**: add a test-only env knob to scale down the `OPTIMISTIC_STATUS_*_MS` timers (gated), then implement. S/M.
  - **B**: drive the page with Playwright `page.clock` (risky — also freezes the mock's SSE reconnect backoff; needs careful choreography).
  - **C**: keep fixme — the failed stage shares code with the proven pending/long stages.
- **Decision**: A + policy (owner: no wall-clock/retry waits anywhere in e2e; simulate time where deliberate)

### 34. core-cloud-offline-roles — "a role that live-flips (viewer → editor) unlocks the composer in place, no reload — behavior 9"
- **Status**: skipped (test.fixme, `:797`)
- **Tests**: You're in a shared cloud workspace as a **viewer** — the composer is locked with a "Read-only workspace (viewer)" placeholder. While you're looking at it, an admin upgrades you to **editor**.
- **Expected**: The composer unlocks in place the next time your access token refreshes — placeholder gone, submit enabled — with no reload or navigation.
- **Why**: real behavior, but the test depends on fragile choreography — a near-expiry (500ms) token racing the app's own post-ready traffic to trigger a refresh inside the 60s window. Harness-timing gap; no diagnosed app bug.
- **Options**:
  - **A (recommended)**: harden the fixture so the refresh→role-flip is deterministic (control the mint/refresh sequencing), then implement. M.
  - **B**: keep fixme until the role-refresh fixture is deterministic.
  - **C**: n/a (real behavior).
- **Decision**: A (owner: agreed with recommendation)

### 35. core-session-actions — "a permission raised on the child bubbles into the parent's dock and resolves — behavior 14"
- **Status**: RESOLVED — un-fixme'd and passing honestly (2026-07-20); no longer needs a decision
- **Tests**: You're watching a parent session while one of its subagents (a child session) hits a permission gate — it needs your approval to proceed.
- **Expected**: The permission card surfaces in the **parent's** composer dock — you shouldn't have to hunt down the child session — and answering it there resolves the child's request.
- **Why**: the original fixme diagnosis (a `children.has(directory)` gate blocking the child's event) was true under the old `src/context/*` layout but no longer holds. Post app-shell-refactor, `applyDirectoryEventToShellQueries` (`src/features/session/data/sync/directory-event-projector.ts`) runs in **both** branches of the `children.has(directory)` check (`event-ingress.ts`) and keys the permission cache by `permission.sessionID` (the child's id), not by directory — so the child's permission reaches the parent dock regardless of how the workspaceId remap lands, nothing bypassed. The shared mock already emits production-shaped `permission.asked` (sessionID=CHILD_ID) over the real `/api/wr/events` + `/api/wr/runtime-events` channels — no mock change was needed.
- **Evidence**: passes 3/3 standalone, full spec 15/15, subagent block 4/4; negative control (drop the emit) leaves the dock empty and times out; the `replied.sessionID === CHILD_ID` oracle only holds if the parent dock rendered the child's permission and Allow-once POSTed to `/session/CHILD_ID/permissions/...`. Un-fixme'd in `core-session-actions.spec.ts:912` (HISTORY comment kept; the stale `:226` cross-ref was fixed). Verified against the spec by this session.
- **Options** (historical): A (recommended at the time) — extend the shared mock — turned out **unnecessary**; the refactor closed the gap on its own. B — keep fixme. C — n/a.
- **Decision**: A (owner: agreed with recommendation)
- **Resolution**: Closed by the app-shell refactor; no mock/fixture change required. Owner's decision A is preserved above but was moot — recommendation A was not needed to make this pass.

### 36. core-session-actions — "title syncs to the session's own switcher-strip tab label without reload" — RESOLVED
- **Status**: fixed and green (was `test.fixme(true)`, `:1124`; rewritten test at `core-session-actions.spec.ts:1123`).
- **Tests**: You rename the session you're in — the tab that represents it in the switcher strip should update live, no reload.
- **What changed**: the real surface is the compact switcher strip (`src/app/workbench/compact-switcher/compact-switcher.tsx`, `[data-testid="compact-switcher"]`/`[data-testid="compact-switcher-tab"]`), rendered in the workbench header only while the sidebar rail is unpinned (`workbench-shell-header.tsx:80`, `<Show when={!props.sidebarPinned()}>`). Rewritten test: collapses the rail via `[data-testid="sidebar-toggle"]` (the collapse bug fixed for entry 11/behavior 13), confirms the strip renders the session's tab, renames through the real inline editor (behaviors 1-3 choreography: dblclick `h1[data-slot="session-title-child"]`, fill, Enter), confirms the PATCH fires and the header updates, then asserts the switcher tab's `[data-testid="switcher-title"]` text updates to the new title without navigation/reload. Passed on the first real run — no app fix was needed; the per-pane `Titlebar` referenced in the old text is still dead/commented out and is not the surface in play.
- **Verified**: `CLAXEDO_E2E_SUITE=core PLAYWRIGHT_VIDEO=0 PLAYWRIGHT_PORT=4497 npx playwright test e2e/playwright/core-session-actions.spec.ts --workers=1 --retries=0` — all 15 tests in the file pass, including this one.
- **Decision**: Done — rewritten against the real surface (owner: the tab strip shown when the sidebar is collapsed, not a per-pane titlebar).

### 37. core-panes-split-tabs — "mod+w on the last remaining pane opens the desktop Quit dialog — behavior 6"
- **Status**: skipped (test.fixme, `:591`)
- **Tests**: On the **desktop app**, you press mod+w with only one pane left open.
- **Expected**: The Quit dialog appears, asking whether closing the last pane should quit the app. No web-user impact — this is desktop-only behavior; the web build has no quit concept at all.
- **Why**: unreachable from this tier — the web target hardcodes `platform:'web'` (`main.tsx:41-46`) with no `quit` handler; `rail-keyboard-controller.tsx:27`'s `platform==="desktop"` branch can never be entered from a browser-driven spec.
- **Options**:
  - **A**: add a desktop/Electron-platform e2e tier, then implement. L.
  - **B (recommended)**: keep fixme — desktop-only, no web tier can reach it.
  - **C**: delete the e2e assertion; cover in a desktop smoke test.
- **Decision**: C for web (owner) + future desktop Electron-Playwright smoke tier noted

### 38. core-panes-split-tabs — "a 2-pane split survives a full reload on a non-owning URL — behavior 14"
- **Status**: skipped (test.fixme, `:778`)
- **Tests**: You've drag-split your workbench into a session pane beside a terminal pane, and you reload the browser while parked on a URL that doesn't belong to either pane.
- **Expected**: Both panes come back after the reload. Two real problems surfaced while investigating: a drag-split built while a pane-owning URL is active never persists to storage at all, and a force-reloaded terminal pane comes back as a **fresh draft composer** instead of the terminal (its metadata doesn't survive rehydration).
- **Why**: not reachable via real UI flows in this spec's harness — terminal creation always syncs the URL to the terminal's owning route before a split can exist, so the "non-owning URL" precondition can't arise; and the terminal-metadata-survival gap belongs to `core-terminal` per this spec's OUT OF SCOPE. Both blockers are documented in full in the fixme.
- **Options**:
  - **A**: build a multi-terminal / seeded-layout fixture in `core-terminal`, then assert reload survival there. M.
  - **B (recommended)**: keep fixme and route the terminal-metadata-survival gap to `core-terminal`.
  - **C**: delete — the underlying persistence is covered by other reload tests.
- **Decision**: B — keep fixme (owner asked what non-owning URL means: answered — a URL belonging to neither open pane; unreachable in real flows; terminal-rehydration gap routes to core-terminal)

### 39. core-turns-reload-recovery — "a forced dispatch failure restores a context-item chip into the composer — behavior 8"
- **Status**: RESOLVED — un-fixme'd and passing honestly (2026-07-20); no longer needs a decision
- **Tests**: You send a message that has a context chip attached (a referenced file), and the send fails to dispatch.
- **Expected**: The chip is restored into the composer along with your text — nothing you attached is lost to a failed send.
- **Why**: no known user-facing defect — the rollback mechanism is already proven generically by this spec's passing text+attachment case (`submit.ts` treats all context items uniformly). What was missing was purely a test seam: inserting a context-item chip needs the composer's `@`-mention file-search endpoint (`GET /find/file`, hit by `searchFilesAndDirectories` in `src/app/providers/file.tsx`) stubbed so a file row appears in the popover. Implemented entirely inside the spec: register a per-test `**/find/file**` route (returning one fixed file path) AFTER `installMockRuntime` — Playwright's last-registered-first matching makes it win — then reuse `core-composer-modes.spec.ts` behavior 10's mention choreography (type `@`+query, wait for the popover option row, Enter to insert the inline pill) for the file half of the same popover. The rest of the test is byte-identical in shape to the passing text+attachment sibling: forced-500 fail-once override, poll the forced-failure count, assert the "Failed to send prompt" toast, optimistic row removed, then verify the composer restores both the text AND the pill, and a plain resend (no dedicated Retry button) succeeds.
- **Evidence**: `core-turns-reload-recovery.spec.ts` full file 7/7 green (was 6/6 + 1 fixme); the new test also verified in isolation. `core-composer-modes.spec.ts` full file 18/18 green (untouched). `bunx tsgo --noEmit` clean. NOTE (honest scoping): the task brief anticipated needing a shared `/find/file` stub in `e2e/helpers/mock-runtime.ts`; I initially added one, but a red-state check proved the test passes purely from its own spec-local override, so the shared-mock change was dropped as unnecessary — no shared helper touched, keeping the change contained to this one spec (safer with other agents in the tree).
- **Options** (historical): A (recommended at the time) — reuse the @-mention route stubs once `core-composer-modes` owns them, then implement. B — keep fixme. C — delete.
- **Decision**: A (owner: agreed with recommendation)
- **Resolution**: Implemented per option A, spec-local. `core-composer-modes` owns an agent-mention stub (`overrideMentionAgents`) but no file-search stub; rather than reach into a shared helper, the file-search route was added directly in this test — small enough that a shared extraction wasn't warranted. Only `core-turns-reload-recovery.spec.ts` changed.

### 40. core-terminal — "a stale process-owned terminal tab is pruned instead of resurrected on reload — behavior 12"
- **Status**: skipped (test.fixme, `:1088`)
- **Tests**: A terminal tab was owned by a managed process (from the Processes panel); the process is long gone; you reload the app.
- **Expected**: The dead terminal tab is quietly pruned — not resurrected as a zombie tab pointing at nothing.
- **Why**: coverage-placement gap, not a known bug — the pruning only runs when the Process feature's data loads, which needs `core-processes`' panel mocks and a persisted owner seed; and the underlying store operation (`terminal.removeStale`) is already unit-covered (`terminal-zombie.test.ts`).
- **Options**:
  - **A (recommended)**: move the assertion into `core-processes` where the Process mocks exist. M.
  - **B**: keep fixme with the cross-spec + unit-coverage note.
  - **C**: delete — the store logic is unit-tested.
- **Decision**: A (owner: agreed with recommendation)

### 41. mobile-smoke — "multipane split and pane/tab/session drag-reorder have a touch equivalent — behavior 4"
- **Status**: skipped (test.fixme, `:290`)
- **Tests**: On a touch device, you long-press and drag a pane grip, a switcher tab, or a sidebar session row to split or reorder — everything mouse-drag can do.
- **Expected**: Touch drag works like mouse drag. The engine itself is shipped and unit-proven (mouse + touch + pen, `pointer-drag.ts`); what's missing is end-to-end proof on a real viewport.
- **Why**: no assertable surface at phone width in this harness — below the 768px breakpoint a split renders as one full-bleed pane (geometry unobservable), the tab strip shows zero tabs with a single session, and the sidebar lists zero rows with the default empty seed. Touch input itself works (CDP dispatch drives the engine) — the block is surface availability, not touch. Needs a tablet-width project + a pre-seeded multi-surface fixture.
- **Options**:
  - **A (recommended)**: add a tablet-width (≥768) project + a pre-seeded multi-surface fixture (2 panes or 2+ tabs), then assert drop targets + split geometry via CDP touch. M.
  - **B**: keep fixme until the fixture convention for multi-surface seeding is decided.
  - **C**: n/a (engine is real; this is a coverage gap, not deletable behavior).
- **Decision**: A (owner: agreed with recommendation)

---

## 3. Live-suite skips (not in core CI)

These four `*.spec.ts` suites are gated behind `CLAXEDO_E2E_LIVE=1` (Tier L: real claxedo-server, real relay/tunnel, real MCP subprocess, real harness binaries) and do **not** run in core CI. Within them, the following bodies are `test.fixme` (real app bug/gap) or `test.skip` (missing prereq). Listed for triage; not blocking core CI.

| Spec / line | Test | Why off | Recommendation | Decision |
| --- | --- | --- | --- | --- |
| live-claxedo-mcp-tools `:547` | process tool add/update/remove hit the wrong path and 404 — behavior 5 | REAL BUG: `process-handler.ts:275/299/311` POST/PUT/DELETE to bare `/process` instead of `/api/wr/process` (list/start/stop use the right `PROCESS_PATH`); the package's own unit test asserts the wrong path, hiding it | app fix in `process-handler.ts`; correct the unit test | approved |
| live-claxedo-mcp-tools `:739` | summarize_logs never surfaces a raw JSON-parse crash — behavior 10b | REAL BUG: `server.ts:66-67` `JSON.parse`s the body before checking `res.ok`; fallback `GET /session/:id/message/:messageId` (`:637-645`) is a 404 route — `JSON.parse("404 Not Found")` throws a raw SyntaxError | app fix: check `res.ok` first; fix/remove the dead fallback route | approved |
| live-claxedo-mcp-tools `:409/:825` | describe/beforeAll gates | `test.skip(!LIVE)` Tier L gate; inner `:825` skip on missing prereq | keep as loud env-gated skips | keep |
| live-agent-extensions-materialization `:726` | disable/enable a package via the marketplace UI — behavior 6 | **UI LANDED (2026-07-20)**: the card install group hover-reveals Disable/Enable next to Uninstall, wired to POST `/extensions/:id/{disable,enable}`; logic unit-tested (`install-flow.test.ts`, `cards.ui.vitest.tsx`). Spec body rewritten, real — **stays `test.fixme`, Tier L** (awaiting an idle `CLAXEDO_E2E_LIVE` run) | un-fixme on an idle machine with `CLAXEDO_E2E_LIVE=1` | approved |
| live-agent-extensions-materialization `:735` | install a Cursor plugin via the marketplace UI — behavior 7 | **UI PATH LANDED, blocked on catalog (2026-07-20)**: the card/install path is now kind-agnostic (a `kind:"plugin"` entry renders "Plugin" and installs via the same POST); the only remaining gap is that the curated catalog (`claxedo-server/src/agent-extensions/catalog.ts` ENTRIES) has zero `kind:"plugin"` entries. Left fixme per "don't invent catalog entries" | add a real `kind:"plugin"` catalog entry, then un-fixme | approved |
| live-agent-extensions-materialization `:744` | adopt a discovered item via the marketplace UI — behavior 8 | **UI LANDED (2026-07-20)**: `DiscoveredSection` rows now hover-reveal per-item Adopt/Ignore → POST `/extensions/{adopt,ignore}` (top-level Dismiss kept); proven by install-flow helpers + `cards.ui.vitest.tsx`. Spec body rewritten, real — **stays `test.fixme`, Tier L** | un-fixme on an idle machine with `CLAXEDO_E2E_LIVE=1` | approved |
| live-agent-extensions-materialization `:463/:756` | cloud-half / gates | `test.skip` on `CLAXEDO_ENABLE_DOCKER_SANDBOX=1` (+ built sandbox image/authority wiring) | keep as env-gated skip; implement once docker sandbox lands | keep |
| live-real-harness-smoke `:600` | codex native SDK completes 3 turns + survives reload — behavior 5 | **NOT A BUG — corrected 2026-07-20; promoted `test.fixme`→live test, now passing**. The reported `thread not found` skew does **not** reproduce on codex-cli 0.143.0 or 0.144.x: the driver's fresh-process `thread/resume` recovery (`startTurnWithThreadRecovery`, commit `086be6cb7d`) already resolved it; the original live repro almost certainly ran a pre-recovery build. Proven three ways: (a) the real `CodexHarnessAdapter` (createSession+sendMessage — the `POST /session/:id/prompt_async` path) did 3 turns + reload on 0.143.0 AND 0.144.1; (b) the published `@claxedo/agent-sdk-runtime@0.5.3` bundle did the same on 0.143.0; (c) the **full Tier-L UI smoke passed (35.1s)** — real claxedo-server + real codex subprocess + real ChatGPT auth. Now a normal `test()` mirroring the codex-acp sibling (`/^Codex$/`, optionIndex 1, id `codex-sdk`) | RESOLVED — no app fix needed; live test green. Harness note: running this Tier-L smoke needs `CLAXEDO_WORKGRAPH_REPOSITORY=<abs repo dir>` in the env or claxedo-server fatals before `/api/claxedo/health` — the `startServer` helper doesn't set it (separate harness gap, not codex) | approved |
| live-real-harness-smoke `:517/:556/:569/:584` | Tier L + missing-binary gates | `test.skip(!LIVE)` and per-binary `test.skip(!claude/!codex on PATH)` | keep as loud named skips | keep |
| live-user-hosted-relay `:795` | prompt through the relay lane completes a real turn — behavior 3 | **ROUTING ROOT CAUSE FIXED** (2026-07-20): `routeWorkspaceKind`'s directory-ref fallback in `session-screen.tsx:277-291` collapsed ANY resolved `ws_`-shaped ref into `"cloud"` regardless of the ref's OWN resolved kind, discarding `sessionWorkspaceRuntimeRef`'s already-correct `kind: "user-hosted"` default — this is what mis-routed a fresh DRAFT nav for a `ws_`-shaped id into the Local/Cloud picker → cloud pipeline. Fix: extracted pure `resolveDraftWorkspaceKind` (`view-state.ts`), unit-tested (`view-state.test.ts`); proof: `core-user-hosted-workspace.spec.ts` (the synchronous mock of this exact draft-nav pattern) passes all 6 behaviors, verified in 2 isolated runs. Test STAYS fixme: the remaining blocker is a real assistant reply needing a real model provider — no provider credentials are configured for `packages/claxedo-server` in this environment (fixture's embedded runtime has no model/auth wired, only a deliberately-stubbed `forbiddenOpencodeServer()`) | routing fix landed; re-check with real model/provider credentials once available | approved |
| live-user-hosted-relay `:925` | pause/resume the real host tunnel surfaces offline + Retry — behaviors 5,6 | Was BLOCKED by behavior 3's gap; **that gap is now fixed** (see :795 above) and this test needs no model credentials (pause/resume + offline view only). Real body written (no longer a placeholder) but left `test.fixme`: this machine had OTHER agents' concurrent Playwright/Vite processes saturating CPU and racing the shared `e2e/playwright/test-results` dir while authoring (verified via `ps aux`), producing non-reproducible timeouts — traces/screenshots themselves failed to write (ENOENT), so no clean pass/fail signal was obtainable here | re-run this file alone on an idle machine (`CLAXEDO_E2E_LIVE=1 CLAXEDO_E2E_SUITE=live PLAYWRIGHT_SKIP_WEBSERVER=1 npx playwright test live-user-hosted-relay.spec.ts -g "behaviors 5,6"`), then flip `test.fixme` to `test` | approved |
| live-user-hosted-relay `:984` | near-expiry token triggers a real refresh, workspace stays usable — behavior 4 | UNCONFIRMED (not disproven), and **confirmed unrelated to the :795/:925 routing gap** — its own note states `gateReachesReady` passed on a real run, ruling out the draft-workspace-ambiguity cause; no `POST .../connection/refresh` observed within 20s once the gate reached ready. Not investigated further this pass (out of scope: routing fix only) | diagnose the refresh trigger timing; distinguish from the draft-nav gaps (already distinguished — this is independent follow-up work) | approved |
| live-user-hosted-relay `:682/:904` | Tier L + TTL gates | `test.skip(!LIVE)` describe gates (main + token-refresh block with shortened TTL) | keep as env-gated skips | keep |
