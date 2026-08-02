# Claxedo Performance Harness

Frame-first performance harness for the Claxedo app. It launches the **real** app
in Chromium, drives a small set of user-observable flows, and measures the only
thing that matters to how the app feels: **are we holding the frame rate?**

- Target: **120hz** — every frame produced in ≤ 8.33ms.
- Floor: **60hz** — no flow may sustain frames slower than 16.67ms.

There is no deterministic/fabricated mode and no upstream comparison. Every number
comes from a real browser driving the real app. Set `CLAXEDO_PERF_RECORD_VIDEO=1`
for non-gating visual recordings; release measurements leave capture off so video
encoding cannot distort frame evidence.

## Quick start

```sh
bun run list            # list the measured flows
bun run run             # run the default flow (launch-project), headless
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
browser's real process tree. The gate compares conservative merged
p95/worst-frame evidence and also requires real retained process samples from
both profiler runs.

Run a single flow:

```sh
bun src/cli.ts run --scenario workspace-switch --headed
```

## How it measures frame rate

The harness launches Chromium with vsync and the frame-rate cap disabled
(`--disable-gpu-vsync --disable-frame-rate-limit`). `requestAnimationFrame` then
fires as fast as the main thread allows, so each frame interval reflects the time
spent **producing** that frame (script + layout + paint) rather than the display's
refresh period. That is what makes 8.33ms / 16.67ms physically meaningful in
headless. A `PerformanceObserver('long-animation-frame')` folds in any main-thread
blocking as additional worst-case samples.

For each flow, `measureInteraction()` records every frame produced while the real
interaction runs, then reports:

| Field | Meaning |
| --- | --- |
| `p95FrameMs` | the headline — "in most cases" frame time → the Hz badge |
| `worstFrameMs` | the single worst frame → the regression budget |
| `framesOver1667` | how many frames dropped below 60hz |
| `completionMs` | how long the interaction took end-to-end |

### Gate

- 🟢 **120hz** — `p95 ≤ 8.33ms`
- 🟡 **60hz** (warn) — `8.33ms < p95 ≤ 16.67ms`
- 🔴 **<60hz** (fail) — `p95 > 16.67ms`, or more than 2 frames below 60hz, or the
  worst frame regressed past the stored budget.

A `warn` does not fail CI; a `fail` does. In the paired diagnostics gate, a stored
budget fails only when the disabled control satisfies it and diagnostics causes
the enabled run to cross it. A control that already exceeds the stored budget is
reported as a base-app warning with both measurements, rather than attributed to
diagnostics. The 8.33/16.67 thresholds are physical and fixed — only the per-flow
worst-frame regression budget is stored (`data/budgets/<flow>.json`,
auto-calibrated from the first accepted run).

## Flows

Five user-observable flows, each frame-gated:

| Flow | Headline interaction |
| --- | --- |
| `launch-project` | launch into a 20-session project |
| `session-switch` | rapid back-and-forth between two 10k-message sessions |
| `live-terminal-switch` | switch between three live terminals |
| `large-diff-toggle` | toggle split/unified on a 500-file diff |
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
