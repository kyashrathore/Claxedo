# Claxedo Performance Report

Generated: 2026-07-24T00:52:12.818Z
Gate: two profiler-enabled and two disabled fresh-browser runs execute in ABBA order. Enabled evidence must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of control and must not cross a stored worst-frame budget that control satisfies.
Flows: 1  ·  pass: 0  ·  warn: 1  ·  fail: 0

| Flow | Enabled rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| large-diff-toggle | 🟢 120hz | 0.90 | 349.70 | 2 | 547.88 | warn |  |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| large-diff-toggle | diagnostics added 0.10ms to paired p95 frame time |  |
| large-diff-toggle | disabled control already exceeds stored worst-frame budget 165ms (control 398.70ms; enabled 349.70ms) |  |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| large-diff-toggle | review_panel_open_ms | 9.90 | 10 | ms |
| large-diff-toggle | vcs_load_ms | 383.30 | 405.70 | ms |
| large-diff-toggle | hunk_render_ms | 29.70 | 31.30 | ms |
| large-diff-toggle | line_comment_ms | 20 | 20.80 | ms |
| large-diff-toggle | changed_file_navigation_ms | 5000 | 5000 | ms |

## Diagnostics overhead

| Flow | Retained bytes | Processes | Dropped ticks | Max source (ms) | Max reconciliation (ms) | Control p95 (ms) | Enabled p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| large-diff-toggle | 7228 | 4 | 0 | 1 | 0 | 0.80 | 0.90 |
