# Claxedo Performance Report

Generated: 2026-07-24T00:57:41.903Z
Gate: two profiler-enabled and two disabled fresh-browser runs execute in ABBA order. Enabled evidence must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of control and must not cross a stored worst-frame budget that control satisfies.
Flows: 1  ·  pass: 0  ·  warn: 1  ·  fail: 0

| Flow | Enabled rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| session-switch | 🔴 <60hz | 2.30 | 82.70 | 3 | 240.96 | warn |  |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| session-switch | diagnostics added 0.10ms to paired p95 frame time |  |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| session-switch | single_switch_ms | 88.30 | 91.99 | ms |

## Diagnostics overhead

| Flow | Retained bytes | Processes | Dropped ticks | Max source (ms) | Max reconciliation (ms) | Control p95 (ms) | Enabled p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| session-switch | 7228 | 4 | 0 | 1 | 0 | 2.20 | 2.30 |
