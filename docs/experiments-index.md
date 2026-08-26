# Experiments index — where the experimental record lives

The performance/benchmark effort spans thousands of individual experiments
across many worktrees, branches, and sessions. No single document narrates
them all — the narratives live in agent-session transcripts that are not in
this repo. What IS durable is indexed here: every artifact family, where it
lives, and how to mine it. Newest-first within each section.

State as of 2026-08-21.

## 1. Experiment families

### A. Cross-app benchmark (T3 Code vs Claxedo) — ACTIVE contract
- **Kit + runbook + per-experiment log**:
  `packages/claxedo-app/perf-harness/compare/` — `README.md` (how to rerun),
  `EXPERIMENTS.md` (chronological record: light `core-v1`, heavy `heavy-v1`,
  graded `graded-v1`, the defects each surfaced, and result tables).
- **Raw run artifacts**: Claxedo `.artifacts/agent-app-benchmark/` in the
  perf worktree (~48 run dirs: `compare-*`, `heavy-*`, `graded-*`; each has
  `attempt.json`, `summary.md`, `resource-ticks-*.ndjson`, and a `run/`
  data dir with the materialized DBs). T3 side:
  `~/test/t3code/artifacts/agent-app-benchmark/` (~50 `attempt-*` dirs with
  `result.json`, `resources.ndjson`, per-run fixture state).
- **Driver/scenario code**: this repo `packages/claxedo-app/perf-harness/src/agent-*`;
  T3 repo `scripts/lib/agent-app-benchmark/` + `benchmarks/agent-app/corpora/`.

### B. Renderer performance harness (frame-first: scheduling, LCP/CLS)
- **Harness**: `packages/claxedo-app/perf-harness/` (`runner.ts`,
  `browser-runner.ts`, flows, `targets/five-times.json` budgets).
  Gate design: ABBA profiler-enabled/disabled runs, pooled p95 renderer
  interval targets (120hz-capable / 60hz floor).
- **Reports**: the gitignored `reports/` directory under the harness
  (`latest.md`/`latest.json` = most recent gated run; `run.md`/`run.json`).
  `packages/claxedo-app/perf-harness/src/storage.ts` owns its location and
  `packages/claxedo-app/perf-harness/src/browser-runner.ts` writes the latest report.
- **Prior evidence + baselines**: `perf-harness/evidence/prior-evidence.json`,
  `perf-harness/data/`.
- **Campaign history**: the bulk of the ~570 commits on
  `claude/claxedo-perf-optimization-1yzgej` (this branch). Mine with
  `git log --oneline -- packages/claxedo-app/perf-harness`.

### C. Memory optimization campaign
- **Harness lanes**: `perf-harness/src/memory-runner.ts`, `memory-lane.ts`,
  `heap-snapshot.ts`, `idle-process-family.ts`.
- **Branches** (each an experiment line; several merged, some superseded):
  `optimize/claxedo-idle-memory`, `optimize/claxedo-core-memory-300`,
  `optimize/claxedo-harness-lifecycle-memory`,
  `integrate/claxedo-memory-buckets` (+ its backup
  `backup/integrate-claxedo-memory-buckets-pre-dev-20260809`),
  `optimize/claxedo-sub60-under500` (checked out in the
  `codex/memory-workgraph-perf` worktree).
- **Plan**: `docs/plans/2026-08-07-003-refactor-claxedo-idle-memory-plan.md`.

### D. Plan-doc campaigns (each plan = one experiment campaign with DoD)
- `docs/plans/` — 35 dated plan docs (naming:
  `YYYY-MM-DD-nnn-kind-slug-plan.md`), each with acceptance criteria; many
  reference their proof runs inline.
- `docs/plans/evidence/` — 2.4 MB of captured proof artifacts (screenshots,
  classification docs) referenced by the plans.

### E. E2E / CI experiment campaigns
- Tiered e2e work (tier-M mock reconciliation, tier-R real, live lane),
  crabbox/Hetzner shard runs. The RUN outputs were on ephemeral cloud boxes
  and are gone; what remains is the merged test code itself
  (`packages/claxedo-app/e2e/`), the plan docs, and commit messages.
  Mine with `git log --all --oneline --grep="e2e\|tier\|shard"`.

### F. Relay/network benches
- Branches `fix/relay-frame-path-and-benches`,
  `fix/relay-preopen-queue-and-bench-diagnostics` — relay throughput and
  pre-open-queue experiments; bench code and diagnostics live in those
  branches' commits.

## 2. Worktrees (live experiment surfaces)

| Worktree | Branch | Campaign |
|---|---|---|
| `~/test/opencode` (root) | `dev` | integration trunk (1+ commit ahead of origin, unpushed) |
| `.worktrees/perf-lcp` | `claude/claxedo-perf-optimization-1yzgej` | perf harness + cross-app benchmark + timeline perf (570 commits; THIS index lives here) |
| `.worktrees/w1p3-live-sync` | `feat/conversation-live-sync` | live-timeline bridge fix (merged to dev) |
| `.worktrees/codex/memory-workgraph-perf` | `optimize/claxedo-sub60-under500` | memory/workgraph perf (codex-driven) |
| └ `.worktrees/integrate/claxedo-memory-buckets` | `integrate/claxedo-memory-buckets` | memory-buckets integration |
| `~/.codex/worktrees/7f36/opencode` | `codex/unified-usage-dashboard` | usage dashboard |
| `~/.codex/worktrees/b01d/opencode` | `codex/single-tenant-multiplayer-ready` | multiplayer-ready refactor |
| `.claude/worktrees/*` (3 detached) | review/CI throwaways | reviews — treat as disposable |
| `/private/tmp/claxedo-ci-repro.*` | detached | CI repro scratch |

`backup/*-pre-rebase-*` branches are frozen snapshots of campaign states
taken before risky rebases — they preserve exact pre-rebase experiment trees.

## 3. How to mine the commit record

Commit messages are the primary durable narrative for most experiments
(each fix/feat commit on the perf branches describes what was tried and
found). Useful queries:

```bash
# every commit that touched the perf harness, with dates
git log --oneline --date=short --pretty="%h %ad %s" -- packages/claxedo-app/perf-harness

# benchmark-comparison commits specifically
git log --all --oneline --grep="benchmark\|warm-switch\|corpus\|graded"

# memory campaign across all branches
git log --all --oneline --grep="memory\|rss\|heap" -- packages/claxedo-app

# what a given optimize/* branch tried (diff against its merge-base with dev)
git log --oneline dev..optimize/claxedo-idle-memory
```

## 4. What is NOT recoverable from the repo

- Narratives of experiments whose runs happened in agent sessions without a
  committed artifact (probe scripts, one-off CDP traces, bisects) — those
  live only in session transcripts and the agent's memory notes.
- Crabbox/Hetzner CI shard outputs (ephemeral boxes).
- Superseded packaged-app builds (each experiment repackaged over the last).

When an experiment matters going forward, the convention is: land its
record in `compare/EXPERIMENTS.md` (benchmark family), a plan doc with
evidence (feature campaigns), or a commit message thorough enough to stand
alone — in that order of preference.
