# Claxedo Performance Report

Generated: 2026-08-23T13:35:52.284Z
Measurement: production web bundle in headless Chromium with synthetic route-level fixtures fulfilled over loopback. This is a renderer main-thread scheduling proxy, not actual FPS or packaged Electron compositor/GPU presentation.
Gate: two profiler-enabled and two disabled context-isolated runs execute in ABBA order across two benchmark browsers. Enabled evidence must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of control and must not cross a stored worst-frame budget that control satisfies.
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Renderer proxy | pooled p95 task (ms) | worst task (ms) | tasks >16.67ms | completion (ms) | Diagnostics status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| session-switch | 🔴 missed-60hz | 0.41 | 40.63 | 11/4149 | 143.90 | fail |  |

## Core Web Vitals

Reference machine: host machine, no emulation. These are what a user perceives — when content appeared, whether it moved, how fast the UI answered input — as opposed to the renderer-scheduling proxy above.
Caveat: API and SSE responses are fulfilled in-process from fixtures, so their latency is the profile's simulated round trip rather than a real server. Asset delivery IS really throttled, so the load metrics (LCP/FCP/TTFB) carry the bundle's true cost at this bandwidth.

| Flow | LCP (ms) | INP (ms) | CLS | FCP (ms) | TTFB (ms) | interactions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Switch between two 80-message first folds (rapid cold/warm stress) | 1120 🟢 | 56 🟢 | 0.000 🟢 | 104 🟢 | 4 🟢 | 12 |

### LCP attribution

`LCP frozen` is what the platform would actually report: the largest paint before the first TRUSTED input. Where it reads "never froze", the flow delivered only synthetic input, LCP kept being revised for the flow's whole duration, and the LCP column above is a flow-duration proxy — not a load metric, and not comparable to the 2500/4000 ms bands.

| Flow | LCP revisions | LCP frozen (ms) | first trusted input (ms) | first synthetic input (ms) | last LCP element |
| --- | ---: | ---: | ---: | ---: | --- |
| Switch between two 80-message first folds (rapid cold/warm stress) | 2 | 1120 | 1441 | n/a | `p "sample output sample output sample output sample output samp"` |

### Layout-shift attribution

`CLS under real input` rescores the same shifts with the platform's own rule applied to the flow's synthetic clicks: a shift within 500ms after an input is the user's doing, not instability. The gap between the two columns is shift the flow charged itself for and a real user would not have seen as instability.

| Flow | CLS observed | CLS under real input | excused | shifts |
| --- | ---: | ---: | ---: | ---: |
| Switch between two 80-message first folds (rapid cold/warm stress) | 0.000 | 0.000 | 0% | 1 |

## Against baseline

Comparing this run to the tracked baseline for the same profile and stack (host machine, no emulation). Tolerance is two standard deviations of the baseline's own samples, floored at 5% — a move inside it is reported as unchanged rather than as a win, because this machine's run-to-run spread is wide enough to manufacture one.

| Flow | Metric | Baseline | Current | Delta | Tolerance | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Switch between two 80-message first folds (rapid cold/warm stress) | time_to_first_content_ms | absent | 104 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | largest_content_ms | absent | 1120 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | flow_complete_ms | absent | 144 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | interaction_latency_ms | absent | 56 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | visual_stability | absent | 0.000 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | worst_frame_ms | absent | 41 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | frame_p95_ms | absent | 0.410 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | retained_heap_bytes | absent | 37669756 | — | ±15% | 🆕 new |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| session-switch | disabled control base-app gate: worst renderer task 39.30ms > 16.67ms — exceeded one 60hz main-thread budget |  |
| session-switch | disabled control base-app gate: 10 of 4504 renderer tasks exceeded the 60hz budget (allowance 0) |  |
| session-switch | diagnostics-enabled base-app gate: worst renderer task 40.63ms > 16.67ms — exceeded one 60hz main-thread budget |  |
| session-switch | diagnostics-enabled base-app gate: 11 of 4149 renderer tasks exceeded the 60hz budget (allowance 0) |  |
| session-switch | disabled control base-app gate: 6 host/browser scheduling gaps in rAF had no matching main-thread unavailability or Long Animation Frame attribution and were excluded from the app gate |  |
| session-switch | diagnostics-enabled base-app gate: 8 host/browser scheduling gaps in rAF had no matching main-thread unavailability or Long Animation Frame attribution and were excluded from the app gate |  |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| session-switch | single_switch_ms | 75.70 | 77.10 | ms |
| session-switch | switch_01_cold_completion_ms | 75.70 | 77.10 | ms |
| session-switch | switch_01_cold_script_ms | 18.18 | 19.28 | ms |
| session-switch | switch_01_cold_style_ms | 12.74 | 13.09 | ms |
| session-switch | switch_01_cold_layout_ms | 2.44 | 2.51 | ms |
| session-switch | switch_01_cold_task_ms | 81.06 | 83.48 | ms |
| session-switch | switch_01_cold_attribute_mutations | 88 | 88 | count |
| session-switch | switch_01_cold_nodes_added | 20 | 20 | count |
| session-switch | switch_01_cold_nodes_removed | 13 | 13 | count |
| session-switch | switch_02_warm_completion_ms | 17.70 | 20.80 | ms |
| session-switch | switch_02_warm_script_ms | 2.26 | 2.51 | ms |
| session-switch | switch_02_warm_style_ms | 9.89 | 10.90 | ms |
| session-switch | switch_02_warm_layout_ms | 0.21 | 0.25 | ms |
| session-switch | switch_02_warm_task_ms | 23.82 | 26.97 | ms |
| session-switch | switch_02_warm_attribute_mutations | 40 | 40 | count |
| session-switch | switch_02_warm_nodes_added | 0 | 0 | count |
| session-switch | switch_02_warm_nodes_removed | 0 | 0 | count |

## Diagnostics overhead

| Flow | Retained bytes | Processes | Dropped ticks | Max source (ms) | Max reconciliation (ms) | Control p95 (ms) | Enabled p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| session-switch | 0 | 7 | 0 | 0 | 0 | 0.39 | 0.41 |
