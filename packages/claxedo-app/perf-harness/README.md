# Claxedo Performance Harness

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

`CLAXEDO_PERF_STYLE_DUMP=<path>` writes `<path>.<flow>.jsonl` with Blink's raw
style/layout invalidation trace — `ScheduleStyleInvalidationTracking` (the node
and the changed attribute/class/pseudo that scheduled an invalidation, plus the
JS stack that wrote it), `StyleInvalidatorInvalidationTracking` (every element
the resulting set swept, with the selector part that matched), and
`UpdateLayoutTree` element counts. Join the two tracking events on their shared
`invalidationSet` id to turn a large `recalcStyleMs` into a named cause. It is
attribution-only: the tracking category emits one event per invalidated element,
so its own overhead inflates the run's timings — read the counts, not the clock.
Off (and zero-cost) unless set.

`CLAXEDO_PERF_REQUEST_LOG=<path>` appends one JSONL row per mocked API request
(ms since page setup, method, path+query, status, plus a `boot` marker per
page), for diffing the boot/interaction request graph across runs — serial
waterfalls, duplicate fetches, 404 storms. `CLAXEDO_PERF_FETCH_STACKS=1`
additionally records the in-page `fetch` initiator stack for
resolve/provider/session-shaped requests into the same log, attributing each
duplicate to its call site. Both are off (and zero-cost) unless set; neither
changes a normal release or CI run.

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

| Claim | Supported by this lane? | Reason |
| --- | --- | --- |
| Production renderer code avoids >16.67ms main-thread unavailability in these flows | Yes | Production bundle, semantic readiness, 8ms heartbeat, Long Animation Frames, raw rAF intervals, and strict worst-interval gate |
| Synthetic data scale mounts and updates the intended UI | Yes | Fixture request counts plus transcript, review-hunk, terminal, and navigator readiness checks |
| A packaged desktop presents 60 FPS | No | Headless Chromium does not expose Electron compositor or physical-display presentation |
| GPU raster and compositing stay within budget | No | Vsync and the frame-rate cap are disabled; no presentation trace is collected |
| Real server, filesystem, sandbox, relay, or network latency is fast | No | Deterministic fixtures are fulfilled through Playwright route interception over loopback; their routing time is included, but production infrastructure is absent |
| Native click-to-photon latency is fast | No | The measured action starts with an in-page DOM click |
| Diagnostics do not materially disturb the renderer proxy | Partly | Enabled/control ABBA runs compare profiler overhead against the same synthetic flow |

For each flow, `measureInteraction()` records every frame produced while the real
interaction runs, then reports:

| Field | Meaning |
| --- | --- |
| `observedFrameIntervalsMs` | every raw rAF interval, including browser-scheduler cadence |
| `p95FrameMs` | p95 of all retained rAF intervals across the merged repetitions |
| `worstFrameMs` | the worst rAF or Long Animation Frame duration |
| `framesOver1667` | count of renderer intervals over the 16.67ms deadline |
| `sampleCount` | total retained rAF intervals used by the merged result |
| `longAnimationFrameMs` | Chromium-attributed main-thread animation frames at or above 50ms |
| `unattributedSchedulingGapsMs` | rAF pauses excluded from the app gate because neither the heartbeat nor Chromium LoAF evidence attributes them to main-thread work |
| `completionMs` | how long the interaction took end-to-end |

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

| Flow | Headline interaction |
| --- | --- |
| `launch-project` | launch into a 20-session project |
| `session-switch` | rapid cold/warm switching between two 80-message first folds; the fixture's 10k history length exercises pagination metadata, not 10k mounted rows |
| `live-terminal-switch` | switch between three attached, already-open terminal surfaces after one seeded websocket line; continuous-output stress is not part of this flow |
| `large-diff-toggle` | toggle split/unified with a 500-file model; the first 20 file headers and visible diff body mount initially, then headers render progressively |
| `workspace-switch` | switch to another workspace and into a session |

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

## Core Web Vitals and the reference machine

`--profile <id>` selects the hardware and network the flows are measured ON.
Every timing here is a property of the machine as much as of the code, so the
profile travels with the result (`environment` in the JSON, and the header of
the Core Web Vitals table).

| profile | CPU | network | notes |
| --- | --- | --- | --- |
| `unthrottled` (default) | host | host | What the stored worst-frame budgets were captured on. Keeps existing baselines comparable. |
| `laptop-broadband` | 4x slowdown | 10/3 Mbps, 40ms | The reference profile: a mid-range developer laptop on ordinary broadband. |
| `lighthouse-mobile` | 4x slowdown | 1.6/0.75 Mbps, 150ms | Comparable to public Lighthouse/CWV numbers. Models a phone this app never runs on — compare against the industry with it, do not gate on it. |

Alongside the renderer-scheduling proxy, runs now collect **Core Web Vitals**:
LCP, INP, CLS, FCP and TTFB, using the platform's own definitions (LCP from the
last `largest-contentful-paint` entry, CLS as the heaviest session window, INP
as the p98-style worst interaction). Across iterations they merge at p75, which
is how CWV is scored in the field.

Three limits worth knowing before reading the numbers:

- **INP needs trusted input.** Flows that click through Playwright
  (`locator.click`, `page.mouse.click`) produce interactions; flows that click
  synthetically inside `page.evaluate` do not, because a synthetic event carries
  no `interactionId`. Those flows report `n/a` and an interaction count of 0
  rather than a misleadingly good INP.
- **TTFB is a local-server artifact.** Throughput emulation demonstrably
  applies (see `environment-profile.ts` for the measured evidence), but the
  `latency` term never landed on the loopback document: TTFB stayed at 4-13ms
  under every profile. Read it as noise, not as a vital.
- **API latency is simulated, not real.** Every API/SSE response is fulfilled
  in-process from fixtures, which CDP emulation cannot slow, so the profile's
  `mockLatencyMs` is added by hand. Asset delivery is genuinely throttled.
