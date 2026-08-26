# Claxedo Performance Harness

## Authoritative U1 packaged benchmark

Build the packaged app, materialize the canonical corpus at the path declared by
`targets/five-times.json`, then run Claxedo's single-app orchestrator:

```sh
bun run --cwd packages/claxedo-app/perf-harness benchmark:agent-app -- \
  --app packages/claxedo-desktop/dist/mac-arm64/Claxedo\ Dev.app \
  --profiles all \
  --run-profile iteration \
  --seed 1729 \
  --targets packages/claxedo-app/perf-harness/targets/five-times.json \
  --output artifacts/agent-app-benchmark/claxedo-iteration
```

`--profiles all` runs the four profile owners and reports exactly the ten metrics
in `src/agent-metrics.ts`. The command refuses publication mode and any T3
executable or owned-process lineage: T3 execution belongs to U11. It validates
AC power, nominal thermal state, a stable display configuration, foreground
visibility/focus, the fixed 1440 by 900 app window and its declared platform content viewport, keep-awake ownership, process-family sampling
coverage, and zero survivors. A failure is retained as a typed invalid sample
and never contributes to an aggregate.

The output directory must be empty. It receives `attempt.json` (all raw evidence
and process ownership), `provenance.json` (executable, driver closure, source,
lock, corpus, targets, host, and environment digests), and `summary.json` /
`summary.md` (absolute gates). `evidence/t3-smoke-context.json` is explicitly
non-gating. `evidence/prior-evidence.json` imports F1-F6, 1-14, and V1-V22;
missing historical provenance is explicit and is never silently inherited.
Before rerunning a related causal experiment, use:

```sh
bun run check:agent-experiment -- \
  --question "..." --prior-evidence-id V14 \
  --invalidated-boundary "..."
```

## Cross-app agent benchmark driver

`src/agent-claxedo-driver.ts` is the Claxedo companion driver for the version 1
agent-app benchmark protocol. It reads NDJSON requests on stdin and writes only
NDJSON responses on stdout. It launches a packaged Claxedo build with an
isolated application profile and data directory, imports the supplied corpus
through the production OpenCode database schema, and measures the ten shared
workflow metrics.

Build/package Claxedo first, then point the neutral benchmark runner at:

```sh
CLAXEDO_BENCHMARK_EXECUTABLE=/absolute/path/to/Claxedo \
  bun packages/claxedo-app/perf-harness/src/agent-claxedo-driver.ts
```

The application hook is observation-only. In normal use it is absent. When the
driver installs it, terminal writes report their existing client-acceptance and
xterm parsed-model boundaries for one concrete visible xterm mount; retained or
superseded mounts with the same PTY id cannot contaminate its byte stream. The
hook does not defer or reorder terminal `write`, `fit`, resize, parser, or render
work. The workload waits for its start marker before arming trusted input and
keeps the PTY alive until the active mount drains the final parsed receipt.

Cold-open and warm-switch timing cannot finish on a route, title, composer,
loading surface, skeleton, or shimmer. Corpus materialization records the
canonical user-message ID for each session's latest turn. After the trusted
click, the driver requires that exact turn to have visible non-empty content, a
first fold without a blank virtualization gap, and the same semantic/geometry
snapshot on two consecutive animation frames. The second stable frame is the
reported endpoint. Warm-switch runs first open all 20 items through that public
UI path without recording those opens, then measure one seeded switch to each;
the first measured target differs from the final warm-up target.

The shared runner remains authoritative for process-family RSS and CPU. The
driver declares the exact application root process and holds the active-sweep
and 15-second-settle plus 60-second-quiescent windows open; it does not sample
or synthesize resource values itself.

## Packaged warm-then-idle qualification

`packages/claxedo-desktop/scripts/measure-idle-memory.ts` is the local packaged
qualification lane, separate from the neutral shared runner. It warms the real
core routes and three retained PTYs, forces renderer GC before settling, then
samples the complete root process family. Process ownership is identity-based
(PID plus start time), expands to arbitrary descendant depth, and survives OS
reparenting. The result includes the raw sampling window, process-family peak
and p95 RSS, one-core-capacity family CPU p95, and a post-shutdown survivor gate.

```sh
CLAXEDO_MEMORY_EXECUTABLE=/absolute/path/to/Claxedo \
CLAXEDO_MEMORY_SETTLE_MS=15000 \
CLAXEDO_MEMORY_SAMPLE_DURATION_MS=1800000 \
CLAXEDO_MEMORY_SAMPLE_INTERVAL_MS=1000 \
  bun packages/claxedo-desktop/scripts/measure-idle-memory.ts
```

Omitting `CLAXEDO_MEMORY_EXECUTABLE` launches the current production desktop
bundle and labels the output `production-bundle`; that mode is useful locally
but is not packaged-release evidence. The default sampling duration is 60
seconds. A 30-minute run uses the same explicit window without a harness timeout.
A run is invalid when the requested window is short or gapped, retained PTYs
vanish, core gates fail, or any known family process survives the shutdown grace
period. Raw samples are retained in `windows.quiescent_sampling.samples` so the
reported percentile and cadence remain auditable.

Renderer-performance harness for the Claxedo app. It launches the production web
bundle in headless Chromium, supplies deterministic synthetic API responses,
drives user-observable flows, and measures renderer main-thread scheduling plus
semantic readiness.

- Target: **120hz-capable** — pooled p95 renderer interval ≤ 8.33ms.
- Floor: **60hz-capable** — zero observed renderer intervals > 16.67ms.

The browser runs the real compiled application code. Project, session, message,
terminal, file, and diff data come from the harness's route-level fixture, with no
real Claxedo server, workspace harness, filesystem, or network latency in the
measured path. This lane is a repeatable renderer proxy, not evidence of actual FPS
or frames presented by packaged Electron on a physical display. Set
`CLAXEDO_PERF_RECORD_VIDEO=1` for non-gating visual recordings; release
measurements leave capture off so video encoding cannot distort scheduling evidence.

## Quick start

```sh
bun run list            # list the measured flows
bun run run             # production build, then run launch-project headless
bun run run:all         # run every flow
bun run run:debug       # run every flow and print the debug sub-metrics
bun run run:headed      # watch it drive the app
bun run report          # re-render the last run's markdown (add --debug for subs)
bun run test            # unit tests (pure frame/gate logic, no browser)
```

Every release flow runs in four isolated browser contexts using an ABBA order:
disabled, enabled, enabled, disabled. The suite keeps two benchmark Chromium
processes alive: one executes each flow control→enabled and the other executes
enabled→control. This gives each side one early and one late run so warm/cold
position cannot be mistaken for profiler overhead, while avoiding heavyweight
browser-process churn between flows. Finished pages are closed before the next
flow. Enabled runs start the production diagnostics profiler against that
browser's real process tree. The gate compares pooled p95 intervals, the worst
interval, and every 60hz deadline miss. It also requires real retained process
samples from both profiler runs. Raw per-run headline measurements and intervals
remain in JSON under `headline.runs` and `headline.frameIntervalsMs`. The strict
worst-interval gate keeps an isolated stall visible even when it does not move
pooled p95.

The harness builds and serves the production Vite bundle by default. Repeated
local experiments may set `CLAXEDO_PERF_SKIP_BUILD=1` only after building the
current source once. `CLAXEDO_PERF_APP_SCRIPT=dev` is an explicit diagnostic mode;
its Vite transforms and HMR traffic are not release evidence.

Run a single flow:

```sh
bun src/cli.ts run --scenario workspace-switch --headed
```

For causal size-scaling experiments, enable diagnostic seed overrides without
changing the release fixtures:

```sh
CLAXEDO_PERF_DIAGNOSTIC=1 \
CLAXEDO_PERF_SEED_MESSAGES=1 \
CLAXEDO_PERF_SEED_CHANGED_FILES=1 \
CLAXEDO_PERF_CAUSAL=1 \
bun src/cli.ts run --scenario workspace-switch --iterations 3 --no-trend
```

The diagnostic seed accepts `SESSIONS`, `MESSAGES`, `TERMINALS`,
`CHANGED_FILES`, and `PROJECTS` using the same `CLAXEDO_PERF_SEED_` prefix.
`CLAXEDO_PERF_CAUSAL=1` adds action-scoped long-frame attribution, long tasks,
event/resource timing, DOM mutation counts, and an 8ms event-loop heartbeat
correlated with each rAF deadline miss. The heartbeat
distinguishes main-thread unavailability from headless frame-scheduler gaps.
Neither flag changes a normal release or CI run.

`CLAXEDO_PERF_CPU_PROFILE=1` adds the sampled CPU profile. It is deliberately
separate because Chrome's sampler perturbs short frame measurements; profile
runs provide attribution and never provide gating timing evidence.

The 8ms event-loop heartbeat runs in every release and diagnostic measurement.
It distinguishes application main-thread unavailability from the headless
browser's own rAF cadence without enabling mutation observers or CPU sampling.

`CLAXEDO_PERF_WARM_SESSION_SWITCH=1` pre-activates both session surfaces before
the measured stress loop. It is a diagnostic comparison for retained-pane layout
cost; the normal release flow deliberately includes the first cold mount.
`CLAXEDO_PERF_SESSION_PREFETCH_SETTLE_MS=<ms>` adds an unmeasured delay before
that loop to distinguish incomplete adjacent-session data prefetch from DOM mount
and layout cost.

`CLAXEDO_PERF_SESSION_SWITCH_ROUNDS=<count>` changes the default three
back-and-forth rounds for causal isolation. Release gates keep the default.

`CLAXEDO_PERF_SESSION_RENDERER=plain|markdown|code|mermaid|diff` selects one
semantically verified rich row in the session-switch fixture. Markdown waits
for its table, code waits for completed highlighting, Mermaid explicitly starts
the diagram and waits for its SVG, and diff expands the edit tool and waits for
its file viewer. This is a causal profiling control; the release fixture uses
`diff`.

## How it measures frame rate

The harness launches Chromium with vsync and the frame-rate cap disabled
(`--disable-gpu-vsync --disable-frame-rate-limit`) and records both rAF cadence
and an 8ms event-loop heartbeat. Headless Chromium can still emit 17.8ms rAF
intervals on `about:blank` while the heartbeat remains at 8ms, so rAF cadence
alone is not treated as application work. A sub-50ms rAF deadline miss enters the
application gate only when it overlaps an event-loop interval above 16.67ms. A
`PerformanceObserver('long-animation-frame')` attributes animation work at or
above 50ms. Timestamp overlap identifies which rAF gap each entry replaces rather
than duplicating it. Unattributed gaps remain in raw evidence and produce a
measurement-quality warning.

This catches renderer event-loop stalls from JavaScript, style, and layout that
can make a 60/120Hz presentation deadline impossible. It does not observe
Electron's compositor, GPU raster/presentation, monitor vsync, OS input delivery,
or input-to-photon latency. Interactions use DOM `click()` inside the page so the
measured window includes application handlers and rendering, but excludes native
mouse dispatch and Playwright's locator/actionability overhead. A packaged-desktop
trace lane is required before the project can claim displayed 60Hz.

| Claim                                                                              | Supported by this lane? | Reason                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production renderer code avoids >16.67ms main-thread unavailability in these flows | Yes                     | Production bundle, semantic readiness, 8ms heartbeat, Long Animation Frames, raw rAF intervals, and strict worst-interval gate                                    |
| Synthetic data scale mounts and updates the intended UI                            | Yes                     | Fixture request counts plus transcript, review-hunk, terminal, and navigator readiness checks                                                                     |
| A packaged desktop presents 60 FPS                                                 | No                      | Headless Chromium does not expose Electron compositor or physical-display presentation                                                                            |
| GPU raster and compositing stay within budget                                      | No                      | Vsync and the frame-rate cap are disabled; no presentation trace is collected                                                                                     |
| Real server, filesystem, sandbox, relay, or network latency is fast                | No                      | Deterministic fixtures are fulfilled through Playwright route interception over loopback; their routing time is included, but production infrastructure is absent |
| Native click-to-photon latency is fast                                             | No                      | The measured action starts with an in-page DOM click                                                                                                              |
| Diagnostics do not materially disturb the renderer proxy                           | Partly                  | Enabled/control ABBA runs compare profiler overhead against the same synthetic flow                                                                               |

For each flow, `measureInteraction()` records every frame produced while the real
interaction runs, then reports:

| Field                          | Meaning                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `observedFrameIntervalsMs`     | every raw rAF interval, including browser-scheduler cadence                                                                        |
| `p95FrameMs`                   | p95 of all retained rAF intervals across the merged repetitions                                                                    |
| `worstFrameMs`                 | the worst rAF or Long Animation Frame duration                                                                                     |
| `framesOver1667`               | count of renderer intervals over the 16.67ms deadline                                                                              |
| `sampleCount`                  | total retained rAF intervals used by the merged result                                                                             |
| `longAnimationFrameMs`         | Chromium-attributed main-thread animation frames at or above 50ms                                                                  |
| `unattributedSchedulingGapsMs` | rAF pauses excluded from the app gate because neither the heartbeat nor Chromium LoAF evidence attributes them to main-thread work |
| `completionMs`                 | how long the interaction took end-to-end                                                                                           |

Short interactions can produce only a few dozen intervals. The JSON retains each
raw interval so percentile rank and isolated misses are auditable. The report does
not call an interval a displayed frame and does not derive an FPS number from these
uncapped samples.

### Gate

- 🟢 **120hz-capable** — `p95 ≤ 8.33ms` and no interval misses 16.67ms.
- 🟡 **60hz-capable** (warn) — `8.33ms < p95 ≤ 16.67ms` and no interval misses 16.67ms.
- 🔴 **missed-60hz** (fail) — `p95 > 16.67ms`, any interval over 16.67ms, or the
  worst interval regressed past the stored budget.

A `warn` does not fail CI; a `fail` does. In the paired diagnostics gate, a stored
budget fails only when the disabled control satisfies it and diagnostics causes
the enabled run to cross it. A control that already exceeds the stored budget is
reported as a base-app warning with both measurements, rather than attributed to
diagnostics. The 8.33/16.67 renderer-proxy thresholds are fixed — only the per-flow
worst-interval regression budget is stored (`data/budgets/<flow>.json`,
auto-calibrated from the first accepted run).

## Flows

Five user-observable flows, each frame-gated:

| Flow                   | Headline interaction                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch-project`       | launch into a 20-session project                                                                                                                   |
| `session-switch`       | rapid cold/warm switching between two 80-message first folds; the fixture's 10k history length exercises pagination metadata, not 10k mounted rows |
| `live-terminal-switch` | switch between three attached, already-open terminal surfaces after one seeded websocket line; continuous-output stress is not part of this flow   |
| `large-diff-toggle`    | toggle split/unified with a 500-file model; the first 20 file headers and visible diff body mount initially, then headers render progressively     |
| `workspace-switch`     | switch to another workspace and into a session                                                                                                     |

Headline = the frame timing of the flow's primary interaction. Each flow also
captures debug sub-metrics (panel-open ms, file-tree load ms, …) that are stored
but only printed with `--debug`.

## Adding a flow

The framework keeps flows cheap to add. To add one:

1. Add its id to `ScenarioId` in `src/types.ts`.
2. Add a metadata entry to `FLOWS` in `src/flows.ts`.
3. Add a seed in `src/seed.ts`.
4. Add a driver in `src/browser-runner.ts`'s `flowDrivers`, returning a
   `FlowResult` whose `headline` comes from `measureInteraction(page, id, action)`
   wrapping the real interaction (reuse the existing navigation/wait helpers).

No engine, report, or budget changes are needed.

## Outputs

- `reports/latest.json` / `latest.md` — the last run.
- `reports/videos/<flow>-<n>.webm` — one video per flow run.
- `data/budgets/<flow>.json` — regression budget on the worst frame.
- `data/baselines/<flow>.json`, `data/trends/<flow>.jsonl` — with
  `--update-baseline` / trend appends.
