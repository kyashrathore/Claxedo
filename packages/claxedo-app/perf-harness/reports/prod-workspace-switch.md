# Claxedo Performance Report

Generated: 2026-06-08T08:57:01.588Z
Target: 120hz (frame <= 8.33ms). Floor: 60hz (frame <= 16.67ms).
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| workspace-switch | 🟢 120hz | 0 | 0 | 0 | 20196.20 | fail | reports/videos/claxedo-workspace-switch-1.webm |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| workspace-switch | error boundary rendered for workspace-switch | reports/videos/claxedo-workspace-switch-1.webm |
| workspace-switch | session messages were not requested for workspace-switch | reports/videos/claxedo-workspace-switch-1.webm |
| workspace-switch | workspace was not visible in the sidebar: main | reports/videos/claxedo-workspace-switch-1.webm |
| workspace-switch | workspace was not visible in the sidebar: workspace 2 | reports/videos/claxedo-workspace-switch-1.webm |
| workspace-switch | workspace was not visible in the sidebar: workspace 3 | reports/videos/claxedo-workspace-switch-1.webm |
| workspace-switch | workspace was not visible in the sidebar: workspace 4 | reports/videos/claxedo-workspace-switch-1.webm |
| workspace-switch | workspace was not visible in the sidebar: workspace 5 | reports/videos/claxedo-workspace-switch-1.webm |
| workspace-switch | workspace was not clickable in the visible UI: workspace 2 | reports/videos/claxedo-workspace-switch-1.webm |
| workspace-switch | workspace files navigator did not visibly render | reports/videos/claxedo-workspace-switch-1.webm |
| workspace-switch | transcript text was not visible for workspace-switch: workspace-switch session 1 | reports/videos/claxedo-workspace-switch-1.webm |
| workspace-switch | transcript text was not visible for workspace-switch: workspace-switch session 2 | reports/videos/claxedo-workspace-switch-1.webm |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| workspace-switch | file_tree_load_ms | 9034.50 | 9034.50 | ms |
| workspace-switch | file_tree_control_ms | 4030.30 | 4030.30 | ms |
| workspace-switch | file_tree_state_ms | 5004.10 | 5004.10 | ms |
| workspace-switch | file_tree_first_frame_ms | 9034.50 | 9034.50 | ms |
| workspace-switch | file_tree_data_ms | NaN | NaN | ms |
