# Claxedo Performance Report

Generated: 2026-07-24T01:24:42.703Z
Gate: two profiler-enabled and two disabled context-isolated runs execute in ABBA order across two benchmark browsers. Enabled evidence must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of control and must not cross a stored worst-frame budget that control satisfies.
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Enabled frame verdict | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Diagnostics status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| workspace-switch | 🔴 <60hz | 5.30 | 83.20 | 3 | 115.69 | fail |  |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| workspace-switch | diagnostics crossed the physical frame gate: 3 frames dropped below 60hz (allowance 2) |  |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| workspace-switch | file_tree_load_ms | 13 | 13.80 | ms |
| workspace-switch | file_tree_control_ms | 11.60 | 11.80 | ms |
| workspace-switch | file_tree_state_ms | 1.40 | 2 | ms |
| workspace-switch | file_tree_first_frame_ms | 13 | 13.80 | ms |
| workspace-switch | file_tree_data_ms | 23.50 | 24.60 | ms |

## Diagnostics overhead

| Flow | Retained bytes | Processes | Dropped ticks | Max source (ms) | Max reconciliation (ms) | Control p95 (ms) | Enabled p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| workspace-switch | 7809 | 4 | 0 | 1 | 0 | 3.80 | 5.30 |
