# Claxedo Performance Report

Generated: 2026-08-23T12:51:45.258Z
Measurement: production web bundle in headless Chromium with synthetic route-level fixtures fulfilled over loopback. This is a renderer main-thread scheduling proxy, not actual FPS or packaged Electron compositor/GPU presentation.
Gate: two profiler-enabled and two disabled context-isolated runs execute in ABBA order across two benchmark browsers. Enabled evidence must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of control and must not cross a stored worst-frame budget that control satisfies.
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Renderer proxy | pooled p95 task (ms) | worst task (ms) | tasks >16.67ms | completion (ms) | Diagnostics status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| session-switch | 🔴 missed-60hz | 2.92 | 18.33 | 1/5084 | 1215.99 | fail |  |

## Core Web Vitals

Reference machine: host machine, no emulation. These are what a user perceives — when content appeared, whether it moved, how fast the UI answered input — as opposed to the renderer-scheduling proxy above.
Caveat: API and SSE responses are fulfilled in-process from fixtures, so their latency is the profile's simulated round trip rather than a real server. Asset delivery IS really throttled, so the load metrics (LCP/FCP/TTFB) carry the bundle's true cost at this bandwidth.

| Flow | LCP (ms) | INP (ms) | CLS | FCP (ms) | TTFB (ms) | interactions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Switch between two 80-message first folds (rapid cold/warm stress) | 2708 🟡 | n/a | 0.021 🟢 | 100 🟢 | 3 🟢 | 0 |

### LCP attribution

`LCP frozen` is what the platform would actually report: the largest paint before the first TRUSTED input. Where it reads "never froze", the flow delivered only synthetic input, LCP kept being revised for the flow's whole duration, and the LCP column above is a flow-duration proxy — not a load metric, and not comparable to the 2500/4000 ms bands.

| Flow | LCP revisions | LCP frozen (ms) | first trusted input (ms) | first synthetic input (ms) | last LCP element |
| --- | ---: | ---: | ---: | ---: | --- |
| Switch between two 80-message first folds (rapid cold/warm stress) | 2 | never froze (no trusted input) | n/a | 3014 | `div[data-slot=user-message-text] "user message 19998 for session-switch session 1 sample outpu"` |

### Layout-shift attribution

`CLS under real input` rescores the same shifts with the platform's own rule applied to the flow's synthetic clicks: a shift within 500ms after an input is the user's doing, not instability. The gap between the two columns is shift the flow charged itself for and a real user would not have seen as instability.

| Flow | CLS observed | CLS under real input | excused | shifts |
| --- | ---: | ---: | ---: | ---: |
| Switch between two 80-message first folds (rapid cold/warm stress) | 0.021 | 0.018 | 14% | 4 |

## Against baseline

Comparing this run to the tracked baseline for the same profile and stack (host machine, no emulation). Tolerance is two standard deviations of the baseline's own samples, floored at 5% — a move inside it is reported as unchanged rather than as a win, because this machine's run-to-run spread is wide enough to manufacture one.

| Flow | Metric | Baseline | Current | Delta | Tolerance | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Switch between two 80-message first folds (rapid cold/warm stress) | time_to_first_content_ms | absent | 100 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | flow_complete_ms | absent | 1216 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | visual_stability | absent | 0.018 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | worst_frame_ms | absent | 18 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | frame_p95_ms | absent | 2.920 | — | ±15% | 🆕 new |
| Switch between two 80-message first folds (rapid cold/warm stress) | retained_heap_bytes | absent | 22235792 | — | ±15% | 🆕 new |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| session-switch | disabled control base-app gate: worst renderer task 17.54ms > 16.67ms — exceeded one 60hz main-thread budget |  |
| session-switch | disabled control base-app gate: 1 of 5095 renderer tasks exceeded the 60hz budget (allowance 0) |  |
| session-switch | diagnostics-enabled base-app gate: worst renderer task 18.33ms > 16.67ms — exceeded one 60hz main-thread budget |  |
| session-switch | diagnostics-enabled base-app gate: 1 of 5084 renderer tasks exceeded the 60hz budget (allowance 0) |  |
| session-switch | disabled control base-app gate: 4 host/browser scheduling gaps in rAF had no matching main-thread unavailability or Long Animation Frame attribution and were excluded from the app gate |  |
| session-switch | diagnostics-enabled base-app gate: 3 host/browser scheduling gaps in rAF had no matching main-thread unavailability or Long Animation Frame attribution and were excluded from the app gate |  |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| session-switch | single_switch_ms | 89.80 | 2265.50 | ms |
| session-switch | switch_01_cold_completion_ms | 89.80 | 2265.50 | ms |
| session-switch | switch_01_cold_script_ms | 38.41 | 287.52 | ms |
| session-switch | switch_01_cold_style_ms | 17.24 | 1194.90 | ms |
| session-switch | switch_01_cold_layout_ms | 5.62 | 188.91 | ms |
| session-switch | switch_01_cold_task_ms | 90.13 | 2259.99 | ms |
| session-switch | switch_01_cold_attribute_mutations | 228 | 1130 | count |
| session-switch | switch_01_cold_nodes_added | 77 | 1846 | count |
| session-switch | switch_01_cold_nodes_removed | 57 | 1827 | count |
| session-switch | switch_02_warm_completion_ms | 9 | 20.50 | ms |
| session-switch | switch_02_warm_script_ms | 2.82 | 3.15 | ms |
| session-switch | switch_02_warm_style_ms | 7.51 | 8.95 | ms |
| session-switch | switch_02_warm_layout_ms | 1.37 | 2.28 | ms |
| session-switch | switch_02_warm_task_ms | 17.65 | 21.46 | ms |
| session-switch | switch_02_warm_attribute_mutations | 40 | 40 | count |
| session-switch | switch_02_warm_nodes_added | 4 | 4 | count |
| session-switch | switch_02_warm_nodes_removed | 4 | 4 | count |

## Diagnostics overhead

| Flow | Retained bytes | Processes | Dropped ticks | Max source (ms) | Max reconciliation (ms) | Control p95 (ms) | Enabled p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| session-switch | 0 | 5 | 0 | 1 | 0 | 2.78 | 2.92 |
