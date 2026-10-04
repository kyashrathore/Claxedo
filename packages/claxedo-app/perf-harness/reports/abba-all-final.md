# Claxedo Performance Report

Generated: 2026-07-24T01:27:32.114Z
Gate: two profiler-enabled and two disabled context-isolated runs execute in ABBA order across two benchmark browsers. Enabled evidence must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of control and must not cross a stored worst-frame budget that control satisfies.
Flows: 5  ·  pass: 1  ·  warn: 4  ·  fail: 0

| Flow | Enabled frame verdict | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Diagnostics status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| launch-project | 🟢 120hz | 0.20 | 8.30 | 0 | 207.85 | pass |  |
| session-switch | 🟢 120hz | 2.50 | 85.60 | 2 | 230.84 | warn |  |
| live-terminal-switch | 🔴 <60hz | 18.90 | 18.90 | 9 | 184.88 | warn |  |
| large-diff-toggle | 🟢 120hz | 0.90 | 397.10 | 2 | 549.63 | warn |  |
| workspace-switch | 🔴 <60hz | 4.60 | 86.90 | 3 | 113.21 | warn |  |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| session-switch | disabled control base-app gate: 4 frames dropped below 60hz (allowance 2) |  |
| live-terminal-switch | disabled control base-app gate: p95 frame 18.90ms > 16.67ms — sustained below 60hz |  |
| live-terminal-switch | disabled control base-app gate: 9 frames dropped below 60hz (allowance 2) |  |
| large-diff-toggle | diagnostics added 0.10ms to paired p95 frame time |  |
| large-diff-toggle | disabled control already exceeds stored worst-frame budget 165ms (control 399.30ms; enabled 397.10ms) |  |
| workspace-switch | diagnostics added 0.80ms to paired p95 frame time |  |
| workspace-switch | disabled control base-app gate: 3 frames dropped below 60hz (allowance 2) |  |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| launch-project | launch_first_window_ms | 164.17 | 166.76 | ms |
| launch-project | launch_workspace_ready_ms | 206.38 | 209.31 | ms |
| launch-project | transcript_render_ms | 10005.40 | 10009.10 | ms |
| session-switch | single_switch_ms | 87.26 | 87.71 | ms |
| live-terminal-switch | terminal_switch_ms | 18.20 | 18.80 | ms |
| live-terminal-switch | terminal_resize_ms | 30.90 | 33.70 | ms |
| large-diff-toggle | review_panel_open_ms | 9.80 | 10.40 | ms |
| large-diff-toggle | vcs_load_ms | 597.70 | 598.20 | ms |
| large-diff-toggle | hunk_render_ms | 28 | 31.40 | ms |
| large-diff-toggle | line_comment_ms | 22.20 | 27.40 | ms |
| large-diff-toggle | changed_file_navigation_ms | 5000 | 5000 | ms |
| workspace-switch | file_tree_load_ms | 13.20 | 13.30 | ms |
| workspace-switch | file_tree_control_ms | 11.70 | 11.70 | ms |
| workspace-switch | file_tree_state_ms | 1.40 | 1.50 | ms |
| workspace-switch | file_tree_first_frame_ms | 13.20 | 13.30 | ms |
| workspace-switch | file_tree_data_ms | 25.20 | 25.60 | ms |

## Diagnostics overhead

| Flow | Retained bytes | Processes | Dropped ticks | Max source (ms) | Max reconciliation (ms) | Control p95 (ms) | Enabled p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| launch-project | 27163 | 4 | 0 | 1 | 0 | 0.20 | 0.20 |
| session-switch | 7804 | 4 | 0 | 1 | 0 | 2.60 | 2.50 |
| live-terminal-switch | 7806 | 4 | 0 | 1 | 0 | 18.90 | 18.90 |
| large-diff-toggle | 7806 | 4 | 0 | 0 | 0 | 0.80 | 0.90 |
| workspace-switch | 7806 | 4 | 0 | 0 | 0 | 3.80 | 4.60 |
