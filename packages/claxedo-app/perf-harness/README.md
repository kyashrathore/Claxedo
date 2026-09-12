# Claxedo performance tools

Start with `bun run catalog` in this directory. It lists browser flows, packaged drivers,
package-owned regression suites, infrastructure benchmarks, and attribution probes.
`bun run catalog --json` emits the same registry for tooling. Package-local tests remain
with their production owners; the catalog makes them discoverable without coupling
relay or runtime measurements to Electron.

## Install and verify

From the repository root, install with `bun install --frozen-lockfile` and build the
workspace dependencies with `bun run build:packages`. This shared build
recipe prepares the complete diagnostics lane in both GitHub and Crabbox.

This nested harness has its own manifest and lockfile; the root workspace install does
not install it:

```sh
cd packages/claxedo-app/perf-harness
bun install --frozen-lockfile
bun run verify
bunx playwright install chromium
```

`verify` typechecks core source, tests, probes, comparison analysis and scripts, then
runs both `test/` and colocated `src/` tests. Browser automation is a separate check.
GitHub release CI and Crabbox use the same `bun run ci:diagnostics` command after
building the app and desktop diagnostics helper.

## Choose the measurement

| Command in this directory | What runs | Acceptance |
| --- | --- | --- |
| `bun run run` | Production renderer, launch-project | Absolute renderer deadline and semantic readiness |
| `bun run run:all` | All cataloged renderer flows | Same renderer policy |
| `bun run run:diagnostics` | Disabled/enabled/enabled/disabled pairs | Fixed diagnostics overhead policy plus real process samples |
| `bun src/cli.ts run --scenario session-switch --suite attribution --no-trend` | One instrumented experiment | Raw report; no baseline or durable comparison |
| `bun src/cli.ts run --scenario transcript-flick --suite attribution --no-trend --iterations 3` | Blank viewport area under a fast flick | Raw per-speed table; no baseline |
| `bun src/cli.ts memory --iterations 5` | Repeated session visits and forced GC | Settlement, cache ceiling, source stability and verified process exit |
| `bun run list` | Browser flow names | Discovery only |
| `bun run catalog` | All performance owners and entrypoints | Discovery only |

`--profile` selects `unthrottled`, `laptop-broadband`, or `lighthouse-mobile` emulation.
It is separate from `--suite`, which selects measurement policy. `--stack` accepts only
`solid-1`, the implementation with a real driver. Adding a label does not create a port.
Use `--iterations N` for whole-flow repetitions, `--headed` to view the browser, and
`--debug` to print detailed submetrics. Headed/headless mode is part of comparison identity.

Renderer and diagnostics runs always build and serve the production app. Required causal
observers are configured before startup. Optional CPU profiling, video, trace dumps,
request instrumentation, workload overrides, dev serving and skipped builds require
`--suite attribution`. Attribution cannot accept a baseline. Memory rejects those
ambient overrides too; its optional `--snapshot` is recorded explicitly.

For example:

```sh
CLAXEDO_PERF_CPU_PROFILE=1 bun src/cli.ts run \
  --scenario session-switch --suite attribution --no-trend

CLAXEDO_PERF_DIAGNOSTIC=1 CLAXEDO_PERF_SEED_MESSAGES=1 \
  bun src/cli.ts run --scenario workspace-switch --suite attribution --no-trend
```

Independent exploratory scripts live under `probes/`. The catalog discovers that directory.
Their timings do not promote baselines. Packaged probes require an explicit corpus and
an existing app bundle; see each script's usage. Public comparative research remains in
`compare/`, with its own runbook and framework-owned acceptance.

## What a number means

`src/perf-record.ts` defines metric units and meanings. Every comparable record carries
a definition version, method, host, environment, workload and instrumentation context.

- `renderer_task_worst_ms` and `renderer_task_p95_ms` measure traced Chromium renderer
  tasks. `renderer_interval_*` measures the rAF/LoAF population attributed by the heartbeat.
  These are distinct instruments. A mixed or empty repetition is invalid evidence.
- `flow_complete_ms` measures the scenario's readiness predicate. Portable samples are
  complete flow repetitions, not the thousands of tasks or nested clicks within them.
- `largest_content_ms` uses LCP frozen at trusted input. Its percentile and element are
  selected from the frozen observations, independently of later paint candidates.
- `interaction_latency_ms` requires trusted input. Unsupported values remain absent.
- `observed_js_heap_bytes` is an uncollected heap gauge. `retained_heap_bytes` and
  `retained_heap_bytes_per_visit` belong to the forced-GC memory lane.
- Internal process-family CPU can exceed 100% because it counts CPU cores. The desktop
  diagnostics normalized CPU value, native physical footprint and summed RSS retain
  their separate definitions; they are not interchangeable measurements.

The browser uses the real compiled renderer and synthetic API fixtures. It measures
renderer work and readiness; it cannot establish physical display FPS, packaged Electron
presentation, live server latency or authenticated multiplayer behavior. Package-owned
and packaged acceptance remain necessary for those claims.

## Re-measuring the timeline's render band

`transcript-flick` pages a transcript in, flicks down it with a compositor
gesture at each `CLAXEDO_PERF_FLICK_PX_PER_FRAME` speed (default
`700,1400,2800,5600`), and prints one row per speed: viewport pixels left with
no mounted row under them, how far the scroller travelled past the mounted rows
while the renderer missed frames, and what those frames cost.

The band itself is a constant in the app (`renderOverscan`,
`features/session/ui/message-timeline.tsx`), so a band sweep is one build per
value; `forward rows` in the table is the band the run observed, so each report
names its own band. Blank area is reported two ways, and they answer different
questions: `blank px` is what a frame the renderer produced was missing, and
`worst exposed px` is what the frames it missed showed instead, derived from the
gap between rendered frames and the travel in it.

## Evidence and baselines

Raw attempts are saved to `reports/latest.json`, `reports/latest.md`, and `--output`.
Reports include repetition evidence and source/build provenance even when acceptance fails.
Source is checked before building and again during measurement; source or artifact changes
invalidate publication. Dev attribution explicitly reports that no built artifact was measured.

There is one baseline writer, `baseline-store.ts`, and one durable run log, `run-log.ts`:

```text
data/baselines/<profile>/<stack>/<lane>/<suite>/<flow>.json
data/runs/<lane>.jsonl
```

`--accept-baseline` promotes an eligible run. Invalid, failed, attribution or unsound-control
runs cannot promote. Browser `--no-trend` suppresses durable logging. Diagnostics and renderer
baselines have different paths. Comparison refuses unknown or mismatched definitions,
methods, hosts, workloads, browser modes, instrumentation or environment settings.

Old `data/baselines/<flow>.json`, `data/budgets/`, and `data/trends/` are historical evidence.
No active code writes or calibrates them. Old values are not converted into the new metric
semantics; capture new comparable baselines explicitly. `--update-baseline` was removed.

Tolerance uses repeated baseline samples: two relative standard deviations with a 5%
floor, or a provisional 15% band for one sample. It is not a significance test. A current
result can be incompatible with a baseline without either result being a regression.

## Ownership

| Responsibility | Owner |
| --- | --- |
| Browser flow identifiers and discovery | `src/flows.ts`, `src/catalog.ts` |
| Scheduling, aggregation and result assembly | `src/browser-runner.ts` |
| Browser lifecycle and package build/serve entrypoints | `src/browser/environment.ts` |
| Synthetic corpus and browser persistence | `src/browser/fixtures.ts`, `src/browser/state.ts` |
| Route contracts and transport | `src/browser/mock-api.ts` |
| Persistent fixture event streams and page lifetimes | `src/browser/mock-streams.ts` |
| User interactions and scenario acceptance | `src/browser/actions/`, `src/browser/scenarios/` |
| Diagnostics process lifecycle | `src/browser/diagnostics.ts` |
| Measurement vocabulary and comparison identity | `src/perf-record.ts`, `src/measurement-context.ts` |
| Source and artifact authority | `src/measurement-provenance.ts` |
| Browser publication policy | `src/browser-publication.ts` |
| Durable SDK transcript import | `src/opencode-corpus.ts` through workspace-runtime's testing port |
| Disposable Git fixtures and runtime inventory registration | `src/workspace-fixture.ts`, `src/fixture-registration.ts` |

To add a browser flow, add one `FLOWS` entry (the ID type derives from it), a seed,
and a scenario driver registered by `flowDrivers`. Keep the scenario's acceptance
contract and tests beside it. Reuse the action owners instead of importing the runner.

The app's production session recorder stays under `src/platform/performance/` in the
app package. It retains at most 400 events and 400 opens, cleans its own User Timing
entries on eviction/reset, and requires the session UI to produce the authoritative
start before phase events. It does not import the benchmark harness.

## Packaged drivers and the public framework

The internal `src/agent-app-benchmark.ts` runs selected packaged profiles and scores only
their required metrics. Missing selected evidence still fails; unselected profiles are
not failures. Its typed samples retain exact/bounded/unsupported/invalid states.

`src/public-agent-app-driver.ts` implements the public framework contract pinned in
`package.json` and `bun.lock`. Conformance tests expand the installed framework's actual
cases across every advertised scenario. Framework ordering, resource monitoring,
aggregation and scoring remain independent of Claxedo's driver.

All three materializers use the same Git fixture preparation and runtime registration.
SDK transcript import is verified by durable readback; session titles, timestamps and
workspace kinds come from those canonical records. Each run uses disposable isolated state.

After building and packaging the app, run the public framework as documented by its
installed CLI and `compare/README.md`. Unit conformance does not prove a live packaged
run or framework resource scoring.

For previous performance findings and rejected approaches, read
[the performance overview](../../../docs/perf/README.md) and
[the attempt ledger](../../../docs/perf/AGENTS.md). Do not reconstruct retired experiment logs.
