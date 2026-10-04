# Claxedo Performance Report

Generated: 2026-08-23T13:07:35.961Z
Measurement: production web bundle in headless Chromium with synthetic route-level fixtures fulfilled over loopback. This is a renderer main-thread scheduling proxy, not actual FPS or packaged Electron compositor/GPU presentation.
Gate: two profiler-enabled and two disabled context-isolated runs execute in ABBA order across two benchmark browsers. Enabled evidence must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of control and must not cross a stored worst-frame budget that control satisfies.
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Renderer proxy | pooled p95 task (ms) | worst task (ms) | tasks >16.67ms | completion (ms) | Diagnostics status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| session-switch | 🔴 missed-60hz | 3.18 | 74.71 | 56/40833 | 1866.28 | fail |  |

## Core Web Vitals

Reference machine: host machine, no emulation. These are what a user perceives — when content appeared, whether it moved, how fast the UI answered input — as opposed to the renderer-scheduling proxy above.
Caveat: API and SSE responses are fulfilled in-process from fixtures, so their latency is the profile's simulated round trip rather than a real server. Asset delivery IS really throttled, so the load metrics (LCP/FCP/TTFB) carry the bundle's true cost at this bandwidth.

| Flow | LCP (ms) | INP (ms) | CLS | FCP (ms) | TTFB (ms) | interactions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Switch between two 80-message first folds (rapid cold/warm stress) | 3172 🟡 | 112 🟢 | 0.016 🟢 | 152 🟢 | 3 🟢 | 24 |

### LCP attribution

`LCP frozen` is what the platform would actually report: the largest paint before the first TRUSTED input. Where it reads "never froze", the flow delivered only synthetic input, LCP kept being revised for the flow's whole duration, and the LCP column above is a flow-duration proxy — not a load metric, and not comparable to the 2500/4000 ms bands.

| Flow | LCP revisions | LCP frozen (ms) | first trusted input (ms) | first synthetic input (ms) | last LCP element |
| --- | ---: | ---: | ---: | ---: | --- |
| Switch between two 80-message first folds (rapid cold/warm stress) | 3 | 3172 | 3703 | n/a | `div[data-slot=user-message-text] "user message 19998 for session-switch session 1 sample outpu"` |

### Layout-shift attribution

`CLS under real input` rescores the same shifts with the platform's own rule applied to the flow's synthetic clicks: a shift within 500ms after an input is the user's doing, not instability. The gap between the two columns is shift the flow charged itself for and a real user would not have seen as instability.

| Flow | CLS observed | CLS under real input | excused | shifts |
| --- | ---: | ---: | ---: | ---: |
| Switch between two 80-message first folds (rapid cold/warm stress) | 0.016 | 0.016 | 0% | 3 |

## Against baseline

Comparing this run to the tracked baseline for the same profile and stack (host machine, no emulation). Tolerance is two standard deviations of the baseline's own samples, floored at 5% — a move inside it is reported as unchanged rather than as a win, because this machine's run-to-run spread is wide enough to manufacture one.

| Flow | Metric | Baseline | Current | Delta | Tolerance | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Switch between two 80-message first folds (rapid cold/warm stress) | time_to_first_content_ms | absent | 152 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | largest_content_ms | absent | 3172 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | flow_complete_ms | absent | 1866 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | interaction_latency_ms | absent | 112 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | visual_stability | absent | 0.016 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | worst_frame_ms | absent | 75 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | frame_p95_ms | absent | 3.180 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | retained_heap_bytes | absent | 25664164 | — | ±15% | 🆕 new |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| session-switch | disabled control base-app gate: worst renderer task 88.64ms > 16.67ms — exceeded one 60hz main-thread budget |  |
| session-switch | disabled control base-app gate: 54 of 51848 renderer tasks exceeded the 60hz budget (allowance 0) |  |
| session-switch | diagnostics-enabled base-app gate: worst renderer task 74.71ms > 16.67ms — exceeded one 60hz main-thread budget |  |
| session-switch | diagnostics-enabled base-app gate: 56 of 40833 renderer tasks exceeded the 60hz budget (allowance 0) |  |
| session-switch | disabled control base-app gate: 102 host/browser scheduling gaps in rAF had no matching main-thread unavailability or Long Animation Frame attribution and were excluded from the app gate |  |
| session-switch | diagnostics-enabled base-app gate: 137 host/browser scheduling gaps in rAF had no matching main-thread unavailability or Long Animation Frame attribution and were excluded from the app gate |  |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| session-switch | single_switch_ms | 1002.20 | 3472.60 | ms |
| session-switch | switch_01_cold_completion_ms | 1002.20 | 3472.60 | ms |
| session-switch | switch_01_cold_script_ms | 200.90 | 471.46 | ms |
| session-switch | switch_01_cold_style_ms | 339.47 | 1627.56 | ms |
| session-switch | switch_01_cold_layout_ms | 101.85 | 317 | ms |
| session-switch | switch_01_cold_task_ms | 1007.95 | 3468.88 | ms |
| session-switch | switch_01_cold_attribute_mutations | 599 | 1197 | count |
| session-switch | switch_01_cold_nodes_added | 824 | 1980 | count |
| session-switch | switch_01_cold_nodes_removed | 799 | 1961 | count |
| session-switch | switch_02_warm_completion_ms | 40 | 43.80 | ms |
| session-switch | switch_02_warm_script_ms | 5.59 | 6.40 | ms |
| session-switch | switch_02_warm_style_ms | 19.51 | 21.38 | ms |
| session-switch | switch_02_warm_layout_ms | 3.47 | 3.98 | ms |
| session-switch | switch_02_warm_task_ms | 46.40 | 50.19 | ms |
| session-switch | switch_02_warm_attribute_mutations | 41 | 41 | count |
| session-switch | switch_02_warm_nodes_added | 4 | 4 | count |
| session-switch | switch_02_warm_nodes_removed | 4 | 4 | count |

## Diagnostics overhead

| Flow | Retained bytes | Processes | Dropped ticks | Max source (ms) | Max reconciliation (ms) | Control p95 (ms) | Enabled p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| session-switch | 0 | 10 | 0 | 1 | 0 | 3.49 | 3.18 |
