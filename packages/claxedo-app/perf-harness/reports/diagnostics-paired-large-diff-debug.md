# Claxedo Performance Report

Generated: 2026-07-24T00:33:47.715Z
Gate: profiler-enabled run must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of its fresh disabled control and under the stored worst-frame budget.
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| large-diff-toggle | 🟢 120hz | 0.20 | 82.10 | 2 | 539.70 | fail |  |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| large-diff-toggle | diff/review surface did not visibly open with changed files |  |
| large-diff-toggle | disabled control: diff/review surface did not visibly open with changed files |  |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| large-diff-toggle | review_panel_open_ms | 10.70 | 10.70 | ms |
| large-diff-toggle | vcs_load_ms | 2000.10 | 2000.10 | ms |
| large-diff-toggle | hunk_render_ms | 5000 | 5000 | ms |
| large-diff-toggle | line_comment_ms | 0.90 | 0.90 | ms |
| large-diff-toggle | changed_file_navigation_ms | 5000 | 5000 | ms |

## Diagnostics overhead

| Flow | Retained bytes | Processes | Dropped ticks | Max source (ms) | Max reconciliation (ms) | Control p95 (ms) | Enabled p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| large-diff-toggle | 19458 | 4 | 0 | 3 | 68.16 | 0.20 | 0.20 |
