# T3 vs Claxedo agent-app benchmark — rerun runbook

This directory is the complete kit for reproducing the cross-app comparison.
Both repos implement the SAME contract (9 primary metrics, 4 profiles, shared
corpus digests), so numbers are comparable only when both arms run the same
corpus on the same quiet host.

## The contract (state as of 2026-08-21)

- **Corpus**: `graded-v1`, sha256 `0357c2497a28228f3cf5bbbaadaa6b78b09b885f12c7f396fb3ed95d6438a9a2`.
  ONE corpus, 20 sessions, turn counts ramp geometrically 12 → 400 (part
  weight 1 → 3), sessions assigned round-robin across THREE workspaces —
  per-session samples read as a trend over session weight, and warm switching
  crosses real workspace/project boundaries.
- **Metrics** (9): `app.cold_ready_ms`, `work_item.cold_open_ms`,
  `work_item.warm_switch_p95_ms`, `stream.interaction_p95_ms`,
  `stream.blocked_frame_ratio_pct`, `terminal.input_to_paint_p95_ms`,
  `terminal.output_mib_s`, `resource.peak_process_family_rss_mib`,
  `resource.quiescent_cpu_p95_pct`. `history.navigate_p95_ms` was REMOVED
  from the contract on 2026-08-21.
- **Memory split**: Claxedo's runner writes per-tick
  `appRssBytes`/`harnessRssBytes` buckets into `resource-ticks-*.ndjson`
  (app-owned = family process whose command runs from inside the app bundle;
  harness-owned = everything the app spawned). T3's split is computed
  post-hoc from its per-process snapshots in `resources.ndjson`
  (app-owned = command contains `/.electron-runtime/`). Replay corpora run no
  live agents, so harness-owned ≈ 0 today — the split matters once
  live-agent scenarios exist.

## Prerequisites

1. **Repos**: Claxedo perf worktree at
   `/Users/yashvardhansingh/test/opencode/.worktrees/perf-lcp`
   (branch `claude/claxedo-perf-optimization-1yzgej`) and T3 at
   `/Users/yashvardhansingh/test/t3code`. Override with `CLX_ROOT` / `T3_ROOT`.
2. **Claxedo packaged app**: `packages/claxedo-desktop/dist/mac-arm64/Claxedo Dev.app`.
   Rebuild after ANY app-side change (`bun run package:mac` in
   `packages/claxedo-desktop`) — the harness drives the PACKAGED app, and a
   stale package silently measures old code.
3. **T3 build**: its driver builds/uses the app via its own scripts; the
   resource monitor binary must exist at
   `native/resource-monitor/target/release/t3-resource-monitor`
   (`cargo build --release` in `native/resource-monitor`).
4. **Corpus artifacts**: the generated corpus JSON must exist in BOTH repos'
   artifact dirs (gitignored, ~70 MB). Regenerate deterministically from the
   T3 repo if missing:

   ```bash
   cd "$T3_ROOT" && node --experimental-strip-types -e "
   import('./scripts/lib/agent-app-benchmark/corpus.ts').then(async (m) => {
     const fs = await import('node:fs/promises');
     const config = JSON.parse(await fs.readFile('benchmarks/agent-app/corpora/graded-v1.json', 'utf8'));
     const corpus = m.generatePublicCorpus(config);
     const sha = corpus.manifest.hashes.corpusSha256;
     const name = 'corpus-agent-app-graded-v1-' + sha.slice(0, 12) + '.json';
     const body = JSON.stringify(corpus);
     await fs.writeFile('artifacts/agent-app-benchmark/' + name, body);
     await fs.writeFile(process.env.CLX_ROOT + '/.artifacts/agent-app-benchmark/' + name, body);
     console.log(name, sha);
   })"
   ```

   The sha MUST equal the contract sha above; anything else means the
   generator changed and the corpus config's `expectedManifest` must be
   re-embedded (and both targets manifests updated).

## Measurement discipline (non-negotiable)

The runner scripts enforce all of these; do not bypass them:

- **Quiet host**: load-1m < 3.5 before EVERY invocation (Claxedo's preflight
  refuses > 4; the previous app boot is itself a load spike).
- **AC power**: Claxedo's preflight refuses battery; running only the T3 arm
  on battery burns a window on numbers the other side can never match.
- **App singletons**: NO other instance of either app may run — including
  T3 dev instances whose binary is `t3code/apps/desktop/.electron-runtime/...
  /Electron` and the user's own T3 Nightly. A running sibling makes the
  benchmark instance's backend unreachable and every scenario times out.
- **One arm at a time**, benchmarks are LOCAL-ONLY (never CI, by design).

## Run

```bash
bash packages/claxedo-app/perf-harness/compare/run-claxedo.sh   # workspace + resource arms
bash packages/claxedo-app/perf-harness/compare/run-t3.sh        # workspace + resource arms
```

Outputs:
- Claxedo: `.artifacts/agent-app-benchmark/graded-<stamp>-<profile>/`
  (`attempt.json`, `summary.md`, `resource-ticks-*.ndjson` with memory buckets).
- T3: `artifacts/agent-app-benchmark/attempt-<iso>-<hash>/`
  (`result.json`, `resources.ndjson` with per-process snapshots).

Exit code 1 with `"validity": "valid"` in the manifest means only
budget-target misses — the measurements are good. `"validity": "invalid"`
means a sample failed its integrity checks: read the `reason` strings before
trusting ANYTHING from that run.

## Analyze

```bash
bun packages/claxedo-app/perf-harness/compare/graded-analysis.ts \
  --clx-workspace <clx workspace attempt dir> \
  --clx-resource  <clx resource attempt dir> \
  --t3-workspace  <t3 workspace attempt dir> \
  --t3-resource   <t3 resource attempt dir>
```

Prints:
- per-session-weight warm-switch trend for both apps (the switch plans are
  deterministic; the script replicates both repos' seeded orders to map each
  measured duration back to its session's turn count);
- memory rows (whole family / app-owned / harness-owned, peak + avg) for both;
- CPU peak/avg for active (sweep) and idle (quiescence) windows.

Headline numbers (cold-ready / cold-open / warm-switch p95 / peak RSS /
idle CPU p95) come straight from each arm's own manifest summary.

## Reference results (2026-08-21, M-series mac, single run per arm)

| Metric | T3 | Claxedo |
|---|---|---|
| cold_ready_ms | 3210–3250 | 1942 |
| cold_open_ms | 102–170 | 109 |
| warm_switch_p95_ms | 79.9 | 145.4 |
| switch avg light/mid/heavy | 64/61/56 (flat) | 102/107/127 (climbs) |
| RSS whole peak/avg (active) MiB | 1742/1480 | 1744/1345 |
| RSS whole peak/avg (idle) MiB | 1761/1423 | 1614/1360 |
| CPU peak/avg (active) % | 195/143 | 274–282/245 |
| idle CPU p95 % | 16–21 | 7.0 |

## Known gaps / next work

- `stream.*` and `terminal.*` metrics: T3's driver scenarios are implemented
  but never live-validated; matching Claxedo arms not yet run. Finish these
  to complete the 9-metric grid.
- Single run per arm — add repetitions before calling close races.
- Harness-owned memory ≈ 0 until live-agent scenarios exist.

## Traps the last agent hit (read before debugging)

- Claxedo rail lists sessions from `claxedo_session_meta` via a
  PROJECT-scoped query — seeded meta rows without `ws.project_id` render as
  "No sessions match the current filter". The materializer seeds this
  correctly now; if sidebar groups come up empty, check that first.
- Closed rail project groups do not mount their session-list queries;
  `revealSessionRows` opens them via their headers. The rail has NO live
  doorbell for inventory imports — a row that "should" appear won't until
  the group's query refetches.
- Claxedo targets manifests validate `program: "claxedo-five-times-u1"`
  BYTE-IDENTICAL and require exactly the primary metric set.
- `bun test` in claxedo-app needs the package script's flags
  (`--conditions=browser --preload ./happydom.ts`) or unrelated suites fail.
- T3's driver tests are vitest files; run them with the pnpm-store vitest,
  not `node --test`.
