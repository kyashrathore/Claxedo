# GOAL — Execute the claxedo-app OSS-Quality Refactor

Date: 2026-07-10
Status: ready to execute
Execution model: **leader = Fable (this doc's operator), workers = Sonnet subagents at scale via the Workflow tool.** Massive parallelism is pre-authorized — hundreds to thousands of worker agents across the run is expected and acceptable. What is NOT acceptable: two concurrent workers touching the same file, or a wave advancing without the leader's end-to-end verification gate passing.

## Objective (behavior terms)

`packages/claxedo-app` ends this goal in a state where:
- an external contributor can find any behavior's owner from the tree in under a minute and understands every directory's charter from `src/ARCHITECTURE.md`;
- the test suite reads as an executable spec (an agent holding only the test files could rebuild the features) and contains zero grep-the-source assertions outside `src/architecture/`;
- the app is keyboard-operable, screen-reader-viable, and usable at 375×812 for its core flows;
- and throughout, the running product never regresses: after every wave the app boots, connects, chats, opens a terminal, splits panes, and the Electron desktop build still works.

## Plan documents (read in this order)

1. HLD (waves, vocabulary, tests-as-specs standard): `2026-07-10-001-refactor-claxedo-app-oss-quality-hld.md`
2. LLD (worker packages WP-*): `2026-07-10-002-refactor-claxedo-app-oss-quality-lld.md`
3. Quality-audit findings appendix: `2026-07-10-003-claxedo-app-audit-findings-appendix.md`
4. Organization-review appendix (file placement / naming / test location): `2026-07-10-004-claxedo-app-org-review-appendix.md`

## Invariants (must stay true after every wave)

- I1. `bun run typecheck` green from `packages/claxedo-app` (and monorepo typecheck green before merging a wave branch).
- I2. All pre-existing targeted test files that passed before the wave still pass (never run the full local vitest suite — it hangs; run explicit file lists).
- I3. Browser E2E green via the **Tier-M suite** (this replaces the old ad-hoc smoke; suite
  built 2026-07-10/11, see `2026-07-10-001-refactor-e2e-20-spec-consolidation-plan.md`):
  every wave gate runs `bun run test:e2e:core` (@core specs — first-prompt, turns/reload,
  harness ownership, model/effort, busy/abort, composer modes, docks, rendering matrix);
  a wave touching a surface with a dedicated spec additionally runs that spec
  (composer → `core-composer-modes`, timeline → `core-timeline-rendering-scroll`,
  sidebar → `core-sidebar-tree`, panes/tabs → `core-panes-split-tabs`, terminal →
  `core-terminal`, processes → `core-processes`, settings/auth → `core-settings-auth`,
  session actions → `core-session-actions`, cloud → `core-cloud-*`).
  Run rules (learned the hard way): against `bun run dev` — NEVER a `vite preview` prod
  build (DEV-only test seams get dead-code-eliminated; see the e2e plan's "Operational
  contract"); `--workers=1` per suite; **at most 2–3 concurrent Playwright suites
  machine-wide** (more DoS'es the dev server — proven twice); e2e gates are run by the
  LEADER serially, not by each worker in parallel. `test.fixme` entries are pinned
  known-bugs, not slack: a wave may flip a fixme to green (with the underlying fix) but
  must never delete one or let a green test regress to fixme without a written waiver.
- I4. Electron smoke green when a wave touched terminal/titlebar/browser-pane/platform glue: `claxedo-desktop` dev build boots, terminal opens, session sends (remember: fix BOTH prebuild.ts and predev.ts if the desktop build breaks — known trap).
- I5. Terminal perf: any wave touching `src/terminal/**` or `src/components/terminal.tsx` runs the frame-first perf harness (`packages/*/perf-harness`: `bun run run`) with no frame-rate regression.
- I6. `src/architecture` ratchet baselines only ever shrink. New guards (layering, retired-vocabulary, grep-test) stay green.
- I7. Public behavior unchanged except where a finding names a bug (double-bound mod+w, harness-kind unchecked cast, touch/a11y additions).
- I8. No `/share` command appears (deliberate product decision); no PRs to upstream `anomalyco/opencode` — branches and PRs go to origin `kyashrathore/Claxedo` only.

## Scope

**In:** everything in LLD Waves 0–4 + the WP-ORG organization moves; all inside `packages/claxedo-app` except where a WP explicitly names coordination (WP-D4 package scope; desktop smoke).
**Out:** engine/vendored packages, claxedo-server, upstream syncs, new product features beyond the named a11y/responsive work, the workspace-vs-directory split's *server-side* half (WP-D5 requires its own design note first — do not improvise).

## Execution steps (dependency order)

- [ ] **Wave −1 — Land the e2e suite + bug-fix state (prerequisite, leader + user).**
      The working tree currently carries the entire new e2e suite (25 specs, helpers,
      INVARIANTS.md), ~8 app-source bug fixes, and interleaved changes from parallel
      Codex sessions — all uncommitted. Before Wave 0 can "cut branch from dev", this
      state must be reviewed, separated, committed, and merged (feature branch to origin
      `kyashrathore/Claxedo`, never upstream). Also reconcile the e2e **fixme ledger**
      (~25 source-cited app bugs pinned as `test.fixme` across the specs, each with
      file:line citations) against the audit findings appendix: where a WP fixes a bug
      that has a pinned test, flipping that fixme to green IS the WP's falsifiable
      evidence — cheaper and stronger than fresh proof.

Run each wave as one or more Workflow invocations of Sonnet workers. Standard wave shape:

```
a. Leader: cut branch wave-N-<name> from dev; re-read the wave's WPs + appendix sections.
b. Dispatch: one worker per WP (parallel; disjoint ownership lists in the LLD are law —
   a worker needing another WP's files STOPS and reports). Big WPs (B1, B4, B8, C3) may
   themselves fan out sub-workers per file-cluster inside their ownership.
c. Adversarial review workflow over the wave's combined diff: ≥3 independent verifiers
   (correctness/regressions; test quality vs HLD §5 — would the test pass against a
   shadow implementation?; missed duplication/dead-code in touched files). Confirmed
   findings → fix-up workers → re-verify.
d. Leader gate (Fable, personally — never delegated): I1–I6 as applicable, plus the
   wave's own gate below. Evidence recorded in the progress log. Only then merge and
   start the next wave.
```

- [ ] **Wave 0 — Foundations** (WP-01, WP-02, WP-03; may run as 3 parallel workers).
      Gate: new guards green on current tree with shrink-only baselines; mobile Playwright
      project + axe sweep run (fixmes allowed); VOCABULARY/ARCHITECTURE/CONTRIBUTING docs
      reviewed by leader for truthfulness (truthfulness is a release gate).
- [ ] **Wave 1 — Mechanical cleanup** (WP-A1…A8; parallel).
      Gate: I1–I3; grep-proofs per WP (deleted symbols gone, renamed literals single-sourced).
- [ ] **Wave 1.5 — Organization moves** (WP-ORG-1…4; parallel; move/rename ONLY, no
      behavior change).
      Gate: I1–I3; per-WP grep-proof that old paths are gone; moved files' tests green
      from their new locations; WP-02's layering baseline shrank (ORG-4) or is unchanged
      — never grew.
- [ ] **Wave 2 — Directory deep refactors** (WP-B1…B11; parallel; B4/B7 also gate on I4+I5).
      Gate: I1–I6; every WP's named test gaps closed; god-file baseline strictly smaller;
      grep-test count strictly smaller.
- [ ] **Wave 3 — Product goals** (WP-C1, WP-C2, WP-C3; C1/C2 may overlap C3 only where
      ownership is disjoint — check the LLD dependency notes).
      Gate: I1–I5 + mobile fixmes converted to enforced and green + axe sweep enforced on
      touched surfaces + keyboard-only walkthrough of: open session → prompt with
      @-mention → split pane → resize panel → switch tab → close pane.
- [ ] **Wave 4 — Structural migrations** (WP-D1 → WP-D2 strictly ordered; then WP-D3;
      WP-D4 and WP-D5 land solo, last; D5 only after its design note is written and
      approved).
      Gate: full I1–I6, demo build (`dist-demo`), self-host build, Electron package
      (`package:mac`), and a fresh-clone contributor dry-run: can a worker agent, given
      only README + ARCHITECTURE.md, locate and correctly modify a named behavior?
- [ ] **Final sweep:** completeness-critic workflow — re-run a compact version of the
      original 18-lens audit; every remaining critical/high finding is either fixed or
      waived in writing in the LLD. Delete these plan docs per docs/plans/README policy
      once nothing cites them, or move surviving standards (vocabulary, test standard,
      charters) into their permanent homes (they should already live in src/ and
      CONTRIBUTING.md — verify, don't assume).

## Operating rules

- **Discovered-bug rule (user directive, 2026-07-11):** bugs discovered during any wave
  do not get waved past. Disposition, in preference order: (1) fix in-wave when small and
  inside the discovering WP's ownership (with a test written first); (2) fix via a
  leader-dispatched fix-up worker when cross-cutting but cheap; (3) otherwise PIN it —
  a colocated `test.fixme`/`test.todo` unit/vitest test in src (never silently in e2e/**,
  which the live e2e session owns) that reproduces the bug, cites file:line of the
  suspected cause, and names the owning WP — plus a row appended to
  `2026-07-11-002-fixme-ledger-wp-reconciliation.md`. A pinned bug is closed only by
  flipping its test green. Out-of-scope-package bugs additionally get a task chip.

- Workers are **Sonnet** (`model: 'sonnet'` in every Workflow agent call) or **Codex CLI
  background workers** (below); the leader stays Fable and never delegates gate
  verification.
- **User directive 2026-07-11 (speed/capability escalation):** from Wave 2 onward, use
  the strongest available worker configuration per WP instead of defaulting to Sonnet:
  Opus with `effort: 'high'` for deep-refactor/design-sensitive WPs (B1-B11, C*, D*) and
  for adversarial verifiers; Sonnet or Codex CLI workers for mechanical slices
  (moves, renames, import churn, grep-proofs); fan sub-workers out per file-cluster
  inside big WPs aggressively. Waves stay barriers and disjoint ownership stays law —
  the escalation is about per-worker capability and within-wave parallelism, not about
  skipping gates.
- **Verification doctrine** (inherited from the e2e plan, non-negotiable): green output
  is a claim, not proof. Any worker claiming a UI behavior works must attach visual
  evidence (screenshot/video) that a vision-capable reviewer actually viewed; the leader
  gate includes viewing a sample with its own eyes. If evidence contradicts an
  assertion, the assertion is the bug.

### Codex CLI background workers (second worker pool)

Some WPs suit OpenAI Codex CLI workers (user-preferred models: luna / sol — pass via
`--model`; verify the exact model id your plan exposes with a 1-line probe run first,
the public docs don't enumerate them).
**Probed 2026-07-11 (leader):** CLI upgraded 0.143.0 → 0.144.1 (older CLI rejects the
account's default model). Verified working ids: `gpt-5.6-sol`, `gpt-5.6-luna`
(bare `luna`/`sol` are rejected); CLI default resolves to GPT-5.3-Codex. Use
`-m gpt-5.6-sol -c model_reasoning_effort="high"` (0.144 dropped `--ask-for-approval`).
**HARD LESSON (Wave 2):** TWO CONCURRENT `codex exec` sessions on this account hang
indefinitely (2h42m at 0% CPU, zero output; a single session with identical flags works).
Run AT MOST ONE Codex worker at a time; anything wider goes to Opus/Sonnet agents. Best fit: mechanical waves (WP-A*, WP-ORG-*) and
single-file refactors — NOT wave gates, NOT shared-helper/e2e-infra edits.

How to dispatch (non-interactive, per the official CLI docs):

```bash
codex exec \
  --cd /Users/yashvardhansingh/test/opencode/packages/claxedo-app \
  --model <luna-or-sol-model-id> \
  --config model_reasoning_effort="high" \
  --sandbox workspace-write \
  --ask-for-approval never \
  --output-last-message /tmp/wp-a3-report.md \
  "WP-A3 from docs/plans/2026-07-10-002-...-lld.md. Ownership: <explicit file list>.
   Rules: smallest complete change; tests first for named gaps; if you need a file
   outside your ownership list, STOP and write why to the report instead."
```

- `codex exec` streams to stdout; add `--json` for NDJSON events when the leader wants
  to machine-parse progress. Resume an interrupted worker with
  `codex exec resume --last` (from the same `--cd` directory).
- Run each under the leader's process supervision (background shell with output file),
  one Codex worker per WP, same disjoint-ownership law as Sonnet workers.
- NEVER `--dangerously-bypass-approvals-and-sandbox` in this repo; `workspace-write`
  is the ceiling. Codex workers must not run Playwright suites (they'd collide with the
  leader's serialized e2e gates) — their DoD is typecheck + targeted unit tests +
  report; the leader runs the e2e gate.
- A Codex worker's report is a claim like any other — stage (c) review applies
  unchanged. Read `--output-last-message` for the summary; treat the session transcript
  (`codex exec resume` can reopen it) as the audit trail.
- Workers follow `packages/claxedo-app/AGENTS.md` (tests first for named gaps, smallest
  complete change, one canonical path, record skipped verification with reason).
- Commit granularity: one commit per WP on the wave branch, message names the WP.
  Co-authorship per repo convention.
- A worker's report is a claim, not a fact: the review stage (c) exists because
  self-reported completion prose is not evidence. Checkboxes above are checked only
  with falsifiable evidence attached (test output, grep output, screenshot, perf run).
- If a WP proves mis-scoped mid-wave (ownership collision, design decision needed),
  the worker stops, the leader re-scopes in the LLD (edit the doc — it is the living
  source of truth), and only then redispatches.

## Progress log (leader appends evidence here)

| Date | Wave/WP | Evidence (tests run, checks, artifacts) | Result |
|---|---|---|---|
| 2026-07-11 | Wave −1 | E2e suite + 10 app bug-fixes landed by user in one commit (`6d4a661e8e`) together with connection-scoping/usage-limits/web work; separation analysis preserved in `2026-07-11-001-wave-minus1-commit-plan.md`. Fixme-ledger↔audit reconciliation NOT yet done — carry into Wave 0/1 prep. | DONE (single-commit variant) |
| 2026-07-11 | Wave −1 carry-over: fixme↔audit reconciliation | Done: `2026-07-11-002-fixme-ledger-wp-reconciliation.md` — 56 fixmes mapped (≈24 real bugs), per-WP evidence channels named; LLD ownership patched (app/main/index.tsx→WP-B8, shared/query/session-list.ts→WP-A7); out-of-scope orphans (agent-event-runtime projection, claxedo-mcp, session-ui renderers) spun off as separate-session chips. | DONE |
| 2026-07-11 | Wave 0 | Commits `2bed5a9796`(WP-01) `b835735740`(WP-02) `57c13ba54b`(WP-03a) `a27a9bc3bd`(theme-token fix) `e76ec13f0c`(leader docs). Gate run personally: architecture suite 87P/6F (the 6 = pre-existing e2e-session-owned), tsgo -b clean, lint:theme-tokens green (after popover token fix), test:performance 23P, mock-api fixture 14P. Docs truthfulness: 3 reviewers (14 findings) + 2 fix-up workers + leader spot-checks (37-entry count, 29-cycle baseline, bootstrap.ts writer lines, 5 workspace senses — all verified by hand). I3 e2e skipped: Wave 0 changed no runtime code (docs+guards+fixture only) and e2e session held the Playwright slots. Deferred, documented in LLD: WP-02 step 3 renames, WP-03b mobile+axe (gate item transfers to WP-03b dispatch). | DONE |
| 2026-07-11 | Wave 1 | Commits `0364e0bd01`(A1) `18307e31c9`(A2) `66de34c2b4`(A3) `f101eb8ee6`(A4) `05ac903a47`(A5) `5fca64a28b`(A6) `8917ee5505`(A7) `8ec29dcdc7`(A8) `4390e5614d`(baselines). 8 workers + 3 adversarial reviewers (14 findings) + 2 fix-up workers + leader fixes. Gate: full `bun run typecheck` GREEN (architecture 93P/0F — first fully-green state; incl. reconciled debt pins, grandfathered composer/usage-limits writers, process-pane ceiling 1042); route-audit exactly at pre-wave baseline 137P/7F (one stale alias-era string-pin rewritten); I3 per-spec: core-terminal 10P/2fixme, core-sidebar-tree 13P/7fixme (both = pinned baselines); I4: desktop tsgo+79 unit+3 contract green + Electron boot screenshot leader-viewed — CAUGHT that ServerConnection.Sidecar + context barrel were live in desktop (A1 partially reverted; ./context now a declared export; ./utils stale export dropped); I5: perf harness fails IDENTICALLY at pre-wave commit (A/B in isolated worktree; p95 81.5→73.7 post-wave) ⇒ pre-existing environmental+flow breakage, chip filed, no wave regression. NOTE for e2e session: A7 fixed mergeSessionListResponses — fixme core-sidebar-tree:671 is ready to flip. zh-TW→Simplified pinned, product decision pending. | DONE |
| 2026-07-11 | Wave 1.5 | Commits `648af8250e`(ORG-1..4 + leader gate fixes) `4d86def080`(zh-Traditional bug fix). 4 workers + 3 reviewers (7 findings) + opus doc-refresh worker + leader fixes. Gate: full typecheck GREEN (incl. theme lint after path-key renames), architecture 93P/0F (debt re-pinned), route-audit 2 pre-existing content-drift fails (down from 7 — moves satisfied 5 structure assertions; the 2 = grep-test drift owned by Wave 2 conversion), e2e: panes 12P/6f + behavior-19 leader-pinned fixme (A/B-proven pre-existing at BOTH pre/post-Wave-1 commits — not ours), settings-auth 34P=baseline, sidebar 12P+1 flake (passes isolated), boot 9P; desktop tsgo green. ORG-1's pane-preferences move reverted (new cycle) — knot documented, deferred to D3. Ops lessons: never pipe playwright through tail (masks exit code); never reuse a long-lived dev server across suites (wedges); backend :3001 must be up for core specs. e2e session landed `1b2d2bf2c3` → WP-03b + WP-02-step-3 renames now UNBLOCKED (queued pre-Wave-2). Ownership-cloud fixmes were mock-gaps, not agent-event-runtime bugs — orphan reclassified. | DONE |
| 2026-07-11 | Wave 2 | 12 commits (03356bc792..c10d68ccc0 + follow-ups this row). 11 opus/high WPs + 18 pipelined reviewers (36 findings: 0 crit/3 high/10 med/23 low) + 5 fix-up clusters + as-any/test-reconciliation/cheap-batch rounds + B3/B10 re-run on opus after a Codex two-concurrent-session hang (lesson codified). GATE (leader, personally): typecheck FULL GREEN incl. architecture 102/102 (debt re-pinned; as-any 50→46, 0 unjustified); unit sweep 4,065 bun + vitest per-dir — every failure A/B-classified, ZERO wave-caused left; route-audit 144/144; core e2e SERIAL FULL SUITE 212P/40skip with the 5 fails triaged: 2 flakes (pass isolated), behavior-8 = pre-existing racy guard→convergence assertion (4/4), fork flip = LONGSTANDING prod bug found+FIXED (prompt-cache key divergence since hard fork; 3/3), user-hosted = pre-existing harness gap→leader-pinned fixme; mobile 2P/2fixme + a11y 5/5 = baselines; Electron 79+3 tests + boot screenshot leader-viewed; perf p95 72.3ms vs 73.7 (post-W1) vs 81.5 (pre-W1) = non-regressed by 3-point trend (harness flow itself still broken, chip open). 7 fixmes flipped (6 proven green in the gate run), 6 skipped with verified reasons. Bugs fixed this wave: 4 B2 pins, 2 B4 pins, origin-check security bug, model-swap shadowing (found at gate), prompt-cache fork bug (found at gate), trimTrailingLines, WebGL probe ordering, cloud test window pollution. Branch pushed to origin (c10d68ccc0+). EXTRAS landed in parallel: i18n missing-keys baseline emptied (584 translations, 103/0), README rewritten (all commands executed), docs re-verified truthful post-W2, 7 pre-scope/design docs for Waves 3-4 (D1/D3/D4/D5/C1/C2/C3×3). | DONE — GATE CLOSED |
| 2026-07-11 | Wave 3 | Commits `02ea5d8c46`(C1) `d8dca2d962`(C2+kbd-flow) `0c6d94978f`(C3 collapse+DnD) `c300227fd7`(C3 tokens+accessory) `6cec75b4a7`(3 gate bug fixes) `e82b7279cd`(e2e reconciliations) `a712f6c3b7`(baselines). 4 opus WPs + 8 pipelined reviewers (36 findings; C1's FIRST agent produced ZERO work + garbage output — caught by reviewers, re-run clean) + 7 fix-up/bug agents + leader one-liners. GATE: full typecheck GREEN (arch 130/0 re-pinned); axe baseline 20→8 sweep 5/5 (residue = 5 color-contrast token decisions + vendored dropdowns); mobile 4P/1fixme (drawer LIVE, panel-guard, width, scroll enforced); core e2e 211P/39skip with all 7 fails dispositioned (2 flakes pass-isolated; 2 genuine W3 regressions = spec-reconciled to intentional contracts; 1 mis-authored body reconciled STRONGER; 2 disproven-as-W3 → root-caused to the composer scope double-wrap PROD BUG, fixed, both tests green); Electron green + skip-link renders on desktop; perf SAME-LOAD A/B 80.3 vs 80.5ms = identical; keyboard-only walkthrough run LIVE by leader (4 real gaps found → all fixed: 544-tab-stop bypass, session.new focus handoff, terminal.toggle dead drawer flag incl. header button, Kobalte closed-typeahead harness switch). Bugs fixed this wave: composer-never-cleared/history-dead (scope double-wrap), user-hosted overlay strand, PATCH retry churn, accessory-row self-unmount, drag tap side-effects, dead pane-grip input path, behavior-19 mock fidelity (app was correct). user-hosted behaviors 2,3 GREEN via contract-v3 mock lane. Walkthrough legs split/resize/close proven by I-keyboard/O-collapse/core-16-18 suites (live legs: palette, mention combobox, session open, skip-link). | DONE — GATE CLOSED |
| 2026-07-11 | I3 basis (e2e suite) | Tier-M: 21/21 specs green+visually verified as of 01:40 (each verified individually; e.g. settings-auth 34P/6fixme, processes 18P/3fixme, panes 13P/6fixme, terminal 10P/2fixme, cloud-offline-roles 8P/1fixme). ~25 real app bugs pinned as source-cited `test.fixme`s = ready-made WP evidence. IN FLIGHT by the e2e session (separate thread; owns `e2e/**`, helpers, perf-harness, workflows/test.yml — treat as foreign territory): shared-mock broadcast-bus upgrade + ownership-cloud fixme flips; ONE full-suite serialized baseline run; follow-up commit incl. debt-ratchet baseline bump (current commit is test:architecture-red on 7 counts from B1+usage-limits — known, owned); Tier-L live specs + CI wiring. Until the baseline lands, wave gates should run per-spec e2e (green individually) rather than the full suite. | Tier-M READY; baseline+CI pending |
