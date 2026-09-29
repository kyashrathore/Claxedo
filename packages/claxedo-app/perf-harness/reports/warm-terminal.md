# Claxedo Performance Report

Generated: 2026-07-24T01:24:19.887Z
Gate: two profiler-enabled and two disabled context-isolated runs execute in ABBA order across two benchmark browsers. Enabled evidence must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of control and must not cross a stored worst-frame budget that control satisfies.
Flows: 1  ·  pass: 0  ·  warn: 1  ·  fail: 0

| Flow | Enabled frame verdict | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Diagnostics status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| live-terminal-switch | 🔴 <60hz | 18.90 | 18.90 | 11 | 197.88 | warn |  |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| live-terminal-switch | disabled control base-app gate: p95 frame 18.90ms > 16.67ms — sustained below 60hz |  |
| live-terminal-switch | disabled control base-app gate: 9 frames dropped below 60hz (allowance 2) |  |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| live-terminal-switch | terminal_switch_ms | 17 | 35.20 | ms |
| live-terminal-switch | terminal_resize_ms | 25.60 | 35.10 | ms |

## Diagnostics overhead

| Flow | Retained bytes | Processes | Dropped ticks | Max source (ms) | Max reconciliation (ms) | Control p95 (ms) | Enabled p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| live-terminal-switch | 7806 | 4 | 0 | 0 | 0 | 18.90 | 18.90 |
