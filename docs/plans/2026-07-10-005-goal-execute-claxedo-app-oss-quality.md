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
- I3. Browser E2E smoke green: app boots on vite :4444 against backend :3001, `/s/:sessionId` renders, a prompt round-trips, a terminal tab opens and echoes, a pane splits and closes.
- I4. Electron smoke green when a wave touched terminal/titlebar/browser-pane/platform glue: `claxedo-desktop` dev build boots, terminal opens, session sends (remember: fix BOTH prebuild.ts and predev.ts if the desktop build breaks — known trap).
- I5. Terminal perf: any wave touching `src/terminal/**` or `src/components/terminal.tsx` runs the frame-first perf harness (`packages/*/perf-harness`: `bun run run`) with no frame-rate regression.
- I6. `src/architecture` ratchet baselines only ever shrink. New guards (layering, retired-vocabulary, grep-test) stay green.
- I7. Public behavior unchanged except where a finding names a bug (double-bound mod+w, harness-kind unchecked cast, touch/a11y additions).
- I8. No `/share` command appears (deliberate product decision); no PRs to upstream `anomalyco/opencode` — branches and PRs go to origin `kyashrathore/Claxedo` only.

## Scope

**In:** everything in LLD Waves 0–4 + the WP-ORG organization moves; all inside `packages/claxedo-app` except where a WP explicitly names coordination (WP-D4 package scope; desktop smoke).
**Out:** engine/vendored packages, claxedo-server, upstream syncs, new product features beyond the named a11y/responsive work, the workspace-vs-directory split's *server-side* half (WP-D5 requires its own design note first — do not improvise).

## Execution steps (dependency order)

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

- Workers are **Sonnet** (`model: 'sonnet'` in every Workflow agent call); the leader
  stays Fable and never delegates gate verification.
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
| | | | |
