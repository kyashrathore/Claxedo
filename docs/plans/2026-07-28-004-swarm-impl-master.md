# Swarm substrate — implementation master plan

## START HERE (for the executing agent)

You are implementing one workstream of this plan. Protocol:

1. Read this file fully, then read **your** WS doc from the table below (if you weren't assigned one, take the lowest-numbered WS whose dependencies are merged — that is **WS-A** (`2026-07-28-005`) if nothing has landed yet).
2. Read the design authority for the amendments your WS implements: `docs/plans/2026-07-28-003-workgraph-v2.1-swarm-substrate.md` (only the sections your WS doc cites). For system orientation read `docs/workgraph.md`; do not read the other plan history.
3. Re-verify every `file:line` anchor in your WS doc before editing it. If reality contradicts the doc, STOP and report the discrepancy — do not improvise.
4. Work on a branch named `swarm/ws-<letter>-<slug>`; commit with `git commit --only`; never touch files owned by another WS (listed in its doc) except where your doc says to coordinate.
5. Your PR description must reproduce your WS doc's DoD list as checkboxes, each linking the test that proves it — positive controls must state "fails on base, passes on branch".
6. Follow the Global gates section below without exception; the build-order note in gate 6 is mandatory after any `packages/workgraph` edit.
7. When done, append one line to the Progress log at the bottom of this file.

**Status:** READY FOR EXECUTION (owner go pending) · **Design authority:** `2026-07-28-003-workgraph-v2.1-swarm-substrate.md` (amendments A1–A13, M1–M5) — this plan turns it into six executable, code-grounded workstreams. **Grounding:** six code sweeps (2026-07-28) whose facts are baked into each WS doc as file:line anchors — executing agents do not need to re-derive them, only re-verify at the exact anchors before editing.

## The workstream docs

| WS | Doc | Scope | Depends on |
|---|---|---|---|
| **A** | `2026-07-28-005-swarm-ws-a-schema-vocabulary.md` | The one breaking pass: attempt→run rename, `generation` required, `parked`/`draft` states, parent columns, `agent_profile` contract | — (lands first) |
| **B** | `2026-07-28-006-swarm-ws-b-motion-layer.md` | Kill the owner-cursor hot row, cursor-carrying doorbells, dirty-set sweep, identity cache + timeouts | A |
| **C** | `2026-07-28-007-swarm-ws-c-runtime-autonomy.md` | Autonomous streams, draft capture, resume-first runs + fencing, budgets | A (B first if merge-order conflicts on `workgraphCommands.ts`) |
| **D** | `2026-07-28-008-swarm-ws-d-execution-scale.md` | Placement (worktree/sandbox per run), width, landing funnel, subtasks, profiles v0, child streams | A, C; **B1 before real parallelism; chip task_cc97c709 before sandbox placement** |
| **E** | `2026-07-28-009-swarm-ws-e-surfaces.md` | Task Composer (two tabs), per-project WorkGraph pane, autonomy/budget/profile UI | A; renders C/D features as they land |
| **F** | `2026-07-28-010-swarm-ws-f-verification.md` | The headless whole-system e2e ×2 (local + hosted), conformance-on-Convex, the stress suite with gates | harness first; scenarios grow with B–E |

**Parallelism:** after A lands, B / C / E / F-harness run concurrently (disjoint files except `workgraphCommands.ts` — B before C there). D starts when C1/C4 merge. F is continuous.

```
A ──► B ──┬──► D ──► (E finishes) ──► F final audit
   ├──► C ──┘
   ├──► E (starts immediately, renders as C/D land)
   └──► F harness (immediately) → scenarios track B..E
```

## Decisions recorded (the owner's two questions answered)

**1. "We can change vocabulary today — see if we need to." → YES, do it now, in WS-A.** Evidence from the audit: the rename costs far less than feared — **zero i18n keys** (every workgraph UI string is hardcoded; no 16-locale ripple), **no planner/worker role vocabulary exists in shipped code at all** (nothing to remove — the feared cleanup is a no-op), and at zero users Convex tables rename by editing `schema.ts` (old tables orphaned; no migration code). The real costs are: volume (~4.3k mechanical hits), a strict exclusion list (generic retry counters, `SessionTurnOutcome`, git-"staged", the unrelated `planner` attachment kind), and the dist-rebuild ordering. All specified in WS-A. Outcomes are explicitly NOT touched (plan 004 owns their fate).

**2. "Not rebuilding — extending."** Every WS doc carries hard non-goal guards. The two places the grounding proved extension is cheap where a rewrite was feared: per-run placement rides an **existing unwired seam** (`childIsolationId` is typed, stored, and never populated — WS-D wires it), and resume rides existing primitives (deterministic session ids already used by masters; the completion-retry re-prompt path; sandbox checkpoint restore; Convex transcript replay).

## Global gates (every WS, every PR)

1. **Positive-control tests** for every coordination/cost/safety change — the test must fail on pre-change code; say so in the PR.
2. **Local-first** — no deploy to discover anything; Miniflare/convex-test/in-process compositions are the verification substrate.
3. **Both backends or neither** — any store-contract change lands in SQLite + Convex with a conformance invariant (the parity discipline is the product's cross-deploy guarantee).
4. **v0 authorship** (plan 003 §0): no version-archaeology in code/comments/strings; delete-don't-deprecate; breaking schema fine. Grep gate in WS-A/E DoD.
5. **Single-box self-host byte-identical** unless the WS doc says otherwise (autonomy defaults off; placement defaults `shared`).
6. **Dist ordering:** after `packages/workgraph` edits: `bun turbo build --filter=@claxedo/workgraph` → dependents' `tsgo -b` → `bunx convex codegen` → suites. The claxedo-server suite takes 210–280s; never kill it early.
7. **Vision review** for anything user-visible (WS-E).

## Execution protocol for the implementing agents

- One WS doc = one agent (or one agent per lettered section for B/C/D if further split is needed — sections are file-disjoint by construction).
- Before editing, re-verify each grounding anchor you touch (`file:line` in the doc). If reality contradicts the doc, STOP and report — do not improvise around a stale anchor (one prior "bug" evaporated on inspection; the pattern recurs).
- Branch per WS off the integration branch; commit with `--only` (shared-index hazard is real in this repo); PRs reference the WS doc + check off its DoD list verbatim.
- "Leave it better" sections are bounded permission — the listed cleanups in touched files only; anything bigger becomes a chip, not a detour.
- When a WS DoD conflicts with observed behavior of another in-flight WS, the master doc's dependency order wins; report, don't merge-fight.

## Out of scope for this plan (tracked elsewhere)

The CF platform remediation items that don't touch WorkGraph mechanics: relay prod config + data path (chips/review Part A6/B6), live-sync resume `id:` lines (review B3 problem 2 — superseded by WS-B's cursor doorbell + poll for the workgraph surface specifically), Clerk membership sweep (B7), R2 documents (B8), rate-limiting overhaul (A7). Sandbox GC (task_cc97c709) is a **dependency** of WS-D's sandbox placement, not part of it.

## Progress log

*(Executing agents append: date · WS · PR · DoD items closed · deviations.)*
