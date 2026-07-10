# Wave −1 Commit Plan — Land the E2E Suite + Bug-Fix State

Date: 2026-07-11
Status: proposal (READ-ONLY investigation; no git state was changed to produce this doc)
Executed against: `/Users/yashvardhansingh/test/opencode`, branch `codex/feat-connection-scoping`
(currently identical to `dev` — zero commits of its own; every line below is uncommitted
working-tree/index state)
Prereq reading: `docs/plans/2026-07-10-005-goal-execute-claxedo-app-oss-quality.md` ("Wave −1")

## 0. Reality check — the working tree has SIX bodies of work, not three

The Wave −1 brief assumes the tree splits into three sources (A: e2e suite, B: our bug
fixes, C: parallel Codex sessions). Verified against `git status`, file-content diffs, and
file mtimes (a genuine session-boundary signal here — see §1), the actual tree has **six**:

| Group | What | Files (approx) | Verdict |
|---|---|---|---|
| **A** | New e2e suite + perf-harness trim + CI wiring | ~55 | In scope for Wave −1 |
| **B** | App-source bug fixes found during the e2e effort | ~28 across 11 sub-fixes | In scope for Wave −1 |
| **D** | **Connection-scoping / team-personal + role-gated terminal feature** (this branch's own namesake — `docs/plans/2026-07-10-004-feat-connection-scoping-team-personal-plan.md`) | ~51 | **NOT Wave −1. Leave uncommitted.** |
| **E** | **Usage-limits button feature** (`tokentracker-cli` integration — matches your memory's `project_usage_limits_button_tokentracker.md`) | ~13 | **NOT Wave −1. Leave uncommitted.** |
| **F** | **claxedo-web marketing-site rewrite** (Nav/Layout/index/app/framework `.astro`) | ~6 | **NOT Wave −1. Leave uncommitted.** |
| **C** | Parallel-session leftovers: scratch debug scripts, auto-generated local runtime state, one unrelated doc, one untracked research dir | ~12 | Discard / leave alone (see §5) |

**The task's assumed group C (`packages/agent-sdk-runtime/**`, `packages/agent-event-runtime/**`)
has zero uncommitted changes right now** — `git status` shows nothing under either package.
Both packages exist, and the two most recent commits on this branch (`4665a18a`, `4f7c0e15`)
are exactly that work, already landed. That part of the brief is stale; nothing to separate
out there.

**Correction to the debt-ratchet claim.** The brief states "`test:architecture` fails on 6
counts from group-C files — note it, don't fix it." I ran it
(`bun test ./src/architecture` from `packages/claxedo-app`): **7 failures**, and every one
traces to **Group B or Group E**, not to any parallel-session code:

```
70 pass / 7 fail (packages/claxedo-app/src/architecture)
1. size-budget: claxedo-ui/context/process-pane.tsx grew to 1042 lines > ceiling 1014
   → caused by B4 (stale-snapshot guard, ~34 new lines)
2. debt-ratchet setQueryDataCalls: 95 != baseline 91 (+4)
3. debt-ratchet setQueryDataFiles: 40 != baseline 38 (+2)
4. debt-ratchet sdkImportingFiles: 87 != baseline 86 (+1)
   → session-composer-region.tsx now imports `SessionStatus` from
     "@opencode-ai/sdk/v2/client" (part of B1)
5. debt-ratchet effectStateWrites: 115 != baseline 114 (+1)
   → composer.tsx new createEffect at line 336 (subscribePromptSessionStatusMeta, B1)
6. P5 Solid composer guard: session-client/composer/composer.tsx has a new
   write-effect (same B1 effect)
7. single-writer guard: two NEW direct setQueryData call sites outside the
   declared writer registry:
     - session-client/composer/composer.tsx   (B1)
     - claxedo-ui/components/usage-limits-popover.tsx   (E, new file)
```

This is not "someone else's debt to note and move past" — it's **our own B1 fix and E's new
file legitimately tripping the ratchet**, and the test's own failure message says what to do:
*"run `bun run scripts/update-debt-baseline.ts` and commit the new baseline in this same
commit."* This is a real action item for whoever lands B1 and E (see §6), not a footnote.

## 1. How the six groups were told apart

`git status --porcelain` alone doesn't separate these — file **mtimes** do, because each body
of work was produced in one continuous tool-driven session with no gaps inside a group and
clear gaps between groups (full listing captured, sorted, during this investigation):

- **D (connection-scoping)**: 2026-07-10 01:47:51 → 02:44:15 — one unbroken 56-minute run
  touching `claxedo-connections/**`, `connections-host/**`, `turn-credentials.*`,
  `migration.sql`, `workspace-relay*/**`, `workspace-runtime` auth files, plus the client-side
  role/terminal-gate files (`role.tsx`, `terminal-role-gate.ts`, `role-guarded-terminal.tsx`,
  `settings-connections*`, `dialog-connect-integration.tsx`, `ProcessPanePanel.tsx`,
  `terminal-content.tsx`, `rail-workbench-controller.ts`, `app-shell-layout.tsx`).
- **A (e2e fixtures/harness gen)**: 09:49:44 (a script-generated batch, `harness-traces/*.json`)
  and continuing through the day.
- **Scratch debug scripts**: 11:51 (`debug-model-popover2.mjs`, `probe-tmp.mjs`).
- **A (perf-harness trim + CI)**: 15:25:40 → 15:29:15.
- **A (more e2e specs) interleaved with B (bug fixes)**: 18:34 → 22:56 — this is the "e2e
  effort" session the brief describes; B's fixes are dated inside it (e.g. `process-pane.tsx`
  22:24:03, `opencode-compat-events.ts` 22:38:00).
- **E (usage-limits)**: 22:38:59 (`growth/` appears, unrelated) then a distinct cluster
  23:02:49 → Jul 11 01:06:16 (`package.json`, `bunfig.toml`, `bun.lock`,
  `server-usage-limits.ts`, `usage-limits-popover.tsx`, `claxedo-icon.tsx` gauge icon).
- **F (claxedo-web)**: Jul 11 01:01:09 → 01:06:16, overlapping E's tail.
- **A/D final polish**: Jul 11 01:12 → 01:23 (last e2e specs, `claxedo-connections/service.ts`
  final edit).
- **Auto-generated local state**: Jul 11 01:24:01, identical instant across
  `.agent-extensions/materialized.json` and both `.workspace-runtime/runtime-config/*.json` —
  these are dev-server/materialize side effects, not authored edits (see §5).

Every file below was also content-verified (not just time-clustered) by reading its diff.

## 2. Branch plan & git-semantics verification

**Proposal:** cut a fresh branch off the current tip (which is `dev` — `git merge-base dev
HEAD` == `HEAD`, so this is a pure branch-point, not a rebase):

```
git checkout -b wave-minus1-e2e-landing
```

This is safe and changes nothing on disk: `checkout -b` from the branch's own current commit
only moves the ref; every uncommitted file (staged or not) is untouched. **git branches don't
have separate working directories** (no worktree involved) — uncommitted changes belong to the
filesystem, not to whichever branch is checked out.

**Committing A+B only, explicitly by path, works cleanly:**
```
git add <explicit A file list>      # or per sub-commit, see §3
git commit -m "..."
git add <explicit B1 file list>
git commit -m "..."
... (repeat per B sub-fix)
```
`git add <path>` only touches the named paths' index entries — D/E/F/C files remain exactly
as uncommitted as they were. No `git add -A`, no `git add .` anywhere in this plan (repo
convention).

**What happens when you later switch back to `codex/feat-connection-scoping` to continue D:**
because `codex/feat-connection-scoping` has zero commits of its own (it #is# `dev`), after
`wave-minus1-e2e-landing` merges into `dev` you do **not** need a rebase — a fast-forward
suffices:
```
git checkout codex/feat-connection-scoping
git merge --ff-only dev        # picks up the new A+B commits, no rebase machinery
```
For A+B paths specifically: once `wave-minus1-e2e-landing`'s commits merge into `dev` and you
fast-forward `codex/feat-connection-scoping` onto the new `dev`, those files' working-tree
content (already matching what got committed) becomes clean automatically — nothing to redo,
nothing at risk of being clobbered, **provided you don't check out
`codex/feat-connection-scoping` in between committing on `wave-minus1-e2e-landing` and
fast-forwarding it**. If you do check it out in between, git will update A+B paths back to
their pre-Wave−1 (old `dev`) content for as long as you're on that branch — not data loss (the
content is safely committed on `wave-minus1-e2e-landing`), just a visually confusing "my e2e
suite disappeared" moment. Simplest: don't switch branches until the fast-forward step.

## 3. Group A — e2e suite (commit sequence)

One branch, ~4 commits, in this order (each independently buildable):

**A1 — e2e-legacy archive (pure renames, zero content risk).**
All 24 `R` entries from `packages/claxedo-app/e2e/playwright/*` and
`packages/claxedo-app/e2e/restoration-e2e-*` into `packages/claxedo-app/e2e-legacy/` (already
staged as renames — `git status` shows the `R` in column 1). Commit message:
`refactor(e2e): archive pre-Tier-M specs to e2e-legacy/`

**A2 — Tier-M harness infrastructure.**
`packages/claxedo-app/e2e/INVARIANTS.md`,
`packages/claxedo-app/e2e/fixtures/generate-harness-fixtures.ts`,
`packages/claxedo-app/e2e/fixtures/harness-traces/*.json` (8 files),
`packages/claxedo-app/e2e/helpers/mock-runtime.ts` (re-`git add` first — see §7 staged/unstaged
note), `packages/claxedo-app/e2e/helpers/turn-oracle.ts`.
Message: `feat(e2e): add Tier-M mock-runtime harness, turn-oracle, and fixture traces`

**A3 — the 24 new `core-*`/`live-*` specs** (re-`git add` the 8 `AM` ones first):
`core-boot-deep-links-home`, `core-busy-abort-errors`, `core-cloud-offline-roles`,
`core-cloud-provisioning`, `core-composer-modes`, `core-docks`, `core-first-prompt-local`,
`core-harness-ownership-cloud`, `core-harness-ownership-local`, `core-harness-rendering-matrix`,
`core-model-effort-agent-controls`, `core-panes-split-tabs`, `core-processes`,
`core-session-actions`, `core-settings-auth`, `core-sidebar-tree`, `core-terminal`,
`core-timeline-rendering-scroll`, `core-turns-reload-recovery`, `core-user-hosted-workspace`,
`core-workspace-lifecycle`, `live-real-harness-smoke`, `live-agent-extensions-materialization`
(untracked), `live-claxedo-mcp-tools` (untracked).
Message: `test(e2e): add Tier-M core/live spec suite (25 specs)`

**A4 — perf-harness trim + CI wiring + goal/e2e plan docs.**
`packages/claxedo-app/perf-harness/{README.md,src/browser-runner.ts,src/cli-options.ts,
src/flows.ts,src/seed.ts,src/types.ts,test/runner.test.ts}`, `.github/workflows/test.yml`,
`docs/plans/2026-07-10-001-refactor-e2e-20-spec-consolidation-plan.md` (re-`git add`; staged
snapshot is stale — see §7), `docs/plans/2026-07-10-005-goal-execute-claxedo-app-oss-quality.md`.
Message: `chore(e2e): trim perf-harness, wire Tier-M into CI, update e2e/goal plan docs`

## 4. Group B — app-source bug fixes (one commit per sub-fix)

Verified against reality: your ~8-item list was accurate for 9 of the file clusters and
undercounted by splitting one cluster too coarsely and missing one fix entirely. Corrected,
there are **11** independently reviewable fixes:

**B1 — composer busy/status wiring.**
`src/pages/session.tsx`, `src/pages/session/composer/session-composer-region.tsx`,
`src/session-client/composer/composer.tsx`,
`src/session/store/session-status-dispatcher.ts` + `.test.ts`.
Root cause (from the code's own doc comment): the embedded composer's `working()`/`busy()`
derivation defaults to always-idle unless `status`/`activeTurn` are threaded down from
`sessionController`; `promptSessionStatusStage` was a non-reactive cache snapshot, so
escalation-stage banners never re-rendered after their timers fired — fixed by
`subscribePromptSessionStatusMeta`. Pinned by: `core-composer-modes.spec.ts`,
`core-busy-abort-errors.spec.ts`. **Note:** this fix is what trips 4 of the 7
`test:architecture` failures (§0) — bump the debt-ratchet baseline
(`bun run scripts/update-debt-baseline.ts`) and the `size-allowlist.json` ceiling in this same
commit, or route the new `setQueryData` call through the declared writer registry instead.
Message: `fix(session): wire composer status/activeTurn so busy state renders`

**B2 — duplicate-content on session handoff.**
`src/session/submit/handoff.ts` + `.test.ts`. Retargets the submitting draft surface in place
(directory/sessionId/content) before navigating, instead of leaving it at `sessionId: "new"`,
which caused `openSession` to mint a duplicate content while the stale draft stayed mounted —
this is the "duplicate-mount+forced-idle false-positive chain" from your memory. Pinned by:
`core-first-prompt-local.spec.ts`, `core-turns-reload-recovery.spec.ts`.
Message: `fix(session): retarget submitting draft surface before navigating to avoid duplicate content`

**B3 — notification-permission gating.**
`src/main.tsx`, `src/components/settings-general.tsx`, `src/utils/notification-permission.ts`
(new) + `.test.ts` (new). Turn-completion no longer calls `Notification.requestPermission()`
(which was popping the browser permission prompt on an unrelated background event); permission
is now only ever requested from the explicit Settings toggle gesture. Pinned by: its own unit
test (browser permission UI isn't automatable in the Tier-M harness — no e2e coverage is
expected here).
Message: `fix(notifications): only request permission from explicit settings toggle, never on turn completion`

**B4 — process-pane stale-snapshot guard ("BUG B").**
`src/claxedo-ui/context/process-pane.tsx` + `process-pane.test.ts` (new). Guards against a
race where a slow HTTP response from `client.start()` (captured server-side at spawn time,
status "running") overwrites a newer "crashed"/"stopped" state already applied from an SSE
event, which left the status dot green for an already-dead process. Pinned by:
`core-processes.spec.ts`. **Note:** pushes `process-pane.tsx` to 1042 lines against a 1014-line
allowlist ceiling — bump `size-allowlist.json` in this commit (§0).
Message: `fix(process-pane): guard against stale HTTP snapshot clobbering SSE-applied crashed/stopped state`

**B5 — inventory title-fallback.**
`src/shell/data/inventory-writers.ts` + `.test.ts`. An "updated" event (e.g. a title arriving
after session creation) that can't resolve its own `projectID` now falls back to the
already-known `projectID` on the existing inventory row instead of being silently dropped —
needed because the ACP harness's auto-title fallback hardcodes `projectID: ""`. Pinned by:
`core-sidebar-tree.spec.ts`.
Message: `fix(inventory): fall back to existing projectID for title updates that can't resolve one`

**B6 — session-config save failures now surface a toast.**
`src/components/prompt-input/submit-transport.ts` + `.test.ts`,
`src/i18n/en.ts` (`prompt.toast.sessionConfigSaveFailed.title`). The PATCH response's `.ok` was
never checked, so a failed session-config save silently applied the optimistic cache write
anyway. Pinned by: `core-settings-auth.spec.ts` / `core-model-effort-agent-controls.spec.ts`.
Message: `fix(prompt-input): surface session-config save failures instead of swallowing non-OK responses`

**B7 — dead split-pane keyboard shortcuts removed.**
`src/claxedo-ui/layout/{workbench.tsx,keyboard.ts,types.ts}` +
`layout/tests/I-keyboard.vitest.tsx`. Removes `mod+\` / `mod+shift+\` split-horizontal/vertical
bindings from `KeyMap` entirely (dead/conflicting handlers). Pinned by: `I-keyboard.vitest.tsx`.
Message: `fix(layout): remove dead mod+backslash split-pane keybindings`

**B8 — models without a `family` vanish from the model picker.**
`src/context/models.tsx`, `models.test.ts` (new). `remeda`'s `groupBy` drops (rather than
buckets) items whose callback returns `undefined`; falls back to `x.id` when `x.family` is
unset. Pinned by: `core-model-effort-agent-controls.spec.ts`.
Message: `fix(models): stable groupBy fallback key so family-less models don't vanish`

**B9 — ACP/harness sessions never reach the sidebar.**
`packages/claxedo-server/src/routes/opencode-compat-events.ts` + `.test.ts` (new). The central
SSE stream only relayed `globalBus`; `session.lifecycle` (the only notification a non-opencode
ACP session's `POST /session` emits) travels on `claxedoBus` and was never subscribed, so
local/unsigned workspaces (which only ever see this central stream, never a workspace-scoped
`/api/wr/events` connection) silently dropped ACP session creation/title events. Pinned by:
`core-sidebar-tree.spec.ts`, `live-real-harness-smoke.spec.ts`.
Message: `fix(server): subscribe claxedoBus on the central SSE stream so ACP session.lifecycle reaches the sidebar`

**B10 — Linux Claude Code credential-sync fallback (NOT in your original list — found during verification).**
`packages/claxedo-server/src/credentials/sync.ts` + `.test.ts`. `claudeCodeOAuthToken()` only
ever tried macOS Keychain (`security find-generic-password`); added a fallback that reads
`~/.claude/.credentials.json` directly, closing the "Linux Claude cred-sync gap" your memory
already has a chip filed for. Pinned by: `sync.test.ts`.
Message: `fix(credentials): fall back to ~/.claude/.credentials.json for Claude Code token sync on non-macOS`

That's 10 numbered fixes across 11 file-clusters (B1 alone spans the "session.tsx +
session-composer-region.tsx" pairing your list already named plus 3 more files it didn't:
`composer.tsx` and `session-status-dispatcher.ts`+test, which implement the same fix's reactive
core). Nothing in your original list was wrong — B1 was just undercounted by 3 files, and B10
was missing entirely.

## 5. Disposition of everything else (NOT part of Wave −1)

**Group D — connection-scoping feature (~51 files).** Leave fully uncommitted. This is the
current branch's actual namesake feature (`docs/plans/2026-07-10-004-*`,
`docs/plans/2026-07-10-005-feat-orphaned-connection-deletion-plan.md` — the latter says "Phase
1 landed" already, confirming this is a live, partially-shipped feature, not scratch work).
Full list: `packages/claxedo-connections/**` (11 files), `packages/claxedo-server/src/{central-runtime.ts,
central-session-runtime.ts+test,connections-host/**,credentials n/a,hosted-node.ts+test,
server-workgraph.ts,storage/{repair.test.ts,connection.sql.ts,claxedo-migration/20260710000400_connection_scoping/migration.sql},
workspace-runtime-integration/session-env.ts+test}` (15 files), `packages/workspace-relay/**`,
`packages/workspace-relay-protocol/**`, `packages/workspace-runtime/src/{routes/pty.ts+test,
workspace-host-service-auth.ts+test,workspace-relay-e2e.test.ts}`, `workspace-runtime/README.md`
(9 files), `packages/claxedo-app/src/{components/settings-connections{-core}?.{ts,tsx}+tests,
dialog-connect-integration.tsx,shell/auth/role.tsx+test,shell/app-shell-layout.tsx,
terminal/{role-guarded-terminal.tsx,terminal-role-gate.ts+test},
claxedo-ui/{workspace-panel/ProcessPanePanel.tsx,content-renderers/terminal-content.tsx,
layouts/rail-workbench-controller.ts}}` (13 files), plus `docs/plans/2026-07-03-004-feat-connections-framework-plan.md`,
`docs/plans/2026-07-10-004-*`, `docs/plans/2026-07-10-005-feat-orphaned-connection-deletion-plan.md`.
Plus a **shared file with E** — `packages/claxedo-server/src/server.ts` (see §6 hazard).

**Group E — usage-limits button feature (~13 files).** Leave uncommitted.
`packages/claxedo-app/src/{claxedo-ui/components/usage-limits-popover.tsx,
claxedo-ui/components/claxedo-icon.tsx (gauge icon),claxedo-ui/layouts/rail-sidebar.tsx
(UsageLimitsButton wiring),claxedo-ui/styles.css (`.usage-bar-fill`),
utils/usage-limits-api.ts}`, `packages/claxedo-server/src/{server-usage-limits.ts,
tokentracker-cli.d.ts,usage-limits.contract.test.ts,package.json (tokentracker-cli dep),
worker.import-graph.test.ts (forbidden-import entries for the new package)}`, `bunfig.toml`
(`minimumReleaseAgeExcludes` entry + comment), `bun.lock`. Shares `server.ts` with D.

**Group F — claxedo-web marketing-site rewrite (~6 files).** Leave uncommitted.
`packages/claxedo-web/src/{components/Nav.astro,layouts/Layout.astro,pages/{app,framework,index}.astro}`,
`.claude/launch.json` (adds the `claxedo-web-astro` dev-server launch config for this work).
Matches your memory's `project_claxedo_com_positioning.md`.

**Group C — discard or leave alone, does not belong in any commit:**
- `packages/claxedo-app/debug-model-popover2.mjs`, `packages/claxedo-app/probe-tmp.mjs` — both
  **already `git add`-staged** (status `A`), both are throwaway one-off Playwright debug
  scripts (hardcoded `/tmp/e2e-debug-*` dirs, manual route-mocking). Recommend
  `git restore --staged` + delete; do not commit either.
- `.agent-extensions/materialized.json`, `.workspace-runtime/runtime-config/{accepted-snapshot,apply-status}.json`,
  `packages/workspace-runtime/.workspace-runtime/runtime-config/{accepted-snapshot,apply-status}.json`
  — confirmed by diff to be pure local dev-server state (a `materialized_at` epoch-ms
  timestamp; a `revision`/`acceptedAt`/harness-id flip from local `bun run dev` usage — e.g.
  `"harness": {"id": "claude"}` → `"id": "opencode"}`). All 5 are **already staged** despite
  being non-semantic. Recommend `git restore --staged` on all 5; consider adding them to
  `.gitignore` so future sessions stop re-staging them.
- `docs/plans/2026-07-07-002-feat-self-host-hosted-parity-and-channel-loop.md` — a 99-line
  addition of auth-tier design notes for the *self-host* project (your memory's
  `project_selfhost_parity_channel_loop.md`), unrelated to e2e/bug-fixes/connections/usage-limits/web.
  Leave uncommitted; belongs to whatever session resumes that project.
- `growth/` (untracked dir: `star-audience/{README.md,collect-stargazers.mjs,
  enrich-public-emails.mjs,repos.json}`) — GTM/audience research scripts, matches your memory's
  `project_claxedo_gtm_research.md`. Not app code at all. Leave untouched; if it should be
  tracked, that's a separate, unrelated commit whenever that project's owner decides.

## 6. Hazards

**Merge/split hazard: `packages/claxedo-server/src/server.ts` is touched by BOTH D and E in
the same file.** D adds `turnCredentials` wiring (`createConnectionTurnCredentials()`,
threaded into `createCentralControlApp` and `createConnectionsHost`); E adds
`mountLocalOnlyUsageLimits(app, ...)`. Neither is part of Wave −1's commits, so this is **not a
blocker for landing A+B** — Wave −1 never touches `server.ts` at all. It **will** matter
whenever D and E are eventually split into their own branches/commits: `git add -p
packages/claxedo-server/src/server.ts` (interactive hunk staging) will be needed for at least
one of the two, since a plain per-path `git add` would drag the other feature's hunks along.
Flagging now so it isn't a surprise later.

**Staged-vs-unstaged splits** (files showing both `M`/`A` columns non-blank — the index has a
stale partial snapshot of a file that's since been edited further):
- `packages/claxedo-app/e2e/helpers/mock-runtime.ts` (staged: +885 new-file lines; unstaged on
  top: +149/−26 more) — Group A2.
- `packages/claxedo-connections/src/service.ts` and `service.test.ts` (staged: +118/−69 and
  +49/−20; unstaged on top: +22 and +25 more) — Group D.
- `packages/claxedo-server/src/server.ts` (staged: +5/−1; unstaged: +2 more) — Group D+E, see
  above.
- `docs/plans/2026-07-10-001-refactor-e2e-20-spec-consolidation-plan.md` (staged: +58/−17;
  unstaged: +27 more) — Group A4.
- 8 of the new `core-*.spec.ts` files show `AM` (added-then-modified) — Group A3.
- `.agent-extensions/materialized.json` + both `.workspace-runtime/runtime-config/*.json` show
  `MM` with **identical staged and unstaged diffs** (the same single-value flip appears in
  both) — see Group C disposition above.

None of these are conflicts — `git add <path>` at commit time always captures the file's
*current* working-tree content, so re-adding before each commit in §3/§4 is sufficient. Listed
so whoever executes this doesn't assume the staged snapshot is already commit-ready.

**Debt-ratchet baseline — corrected, see §0.** Not a "note it, don't fix it" item: it's B1's
and E's own new debt, and the fix belongs in those commits per the test's own instruction.
Flagging again here so it isn't dropped: **B1's commit needs a debt-ratchet baseline bump (or
a writer-registry fix) before Wave 0 can start from a green `test:architecture`.** E's
`usage-limits-popover.tsx` will need the same when E is eventually committed — not Wave −1's
problem today, but will re-surface the single-writer-guard failure for whoever lands E if B1
already "used up" the baseline bump for the `setQueryDataFiles`/`setQueryDataCalls` counters at
a lower number than both changes combined.

## 7. Summary for the executor

1. `git checkout -b wave-minus1-e2e-landing` (from current HEAD == `dev`; safe, no file changes).
2. Land Group A as 4 commits (§3), Group B as 10 commits (§4) — 14 commits total, each with an
   explicit `git add <paths>` (never `-A`), each B commit's message citing its pinning e2e spec.
3. In B1's commit, also run `bun run scripts/update-debt-baseline.ts` from
   `packages/claxedo-app` and commit the updated baseline files in the same commit (§0, §6).
4. Do **not** touch: Group D (~51 files, connection-scoping — this branch's real feature, "Phase
   1 landed" per its own doc), Group E (~13 files, usage-limits button), Group F (~6 files,
   claxedo-web rewrite), or Group C (2 scratch scripts to delete, 5 auto-generated JSON files to
   unstage, 1 unrelated doc, 1 unrelated `growth/` dir).
5. Push `wave-minus1-e2e-landing` to `origin` (`kyashrathore/Claxedo`), open a PR against `dev`
   — never against upstream `anomalyco/opencode`, never direct-push to `dev`.
6. After merge, fast-forward `codex/feat-connection-scoping` onto the new `dev` tip (§2) to
   resume Group D's work with A+B already landed underneath it.
