# Claxedo Performance Report

Generated: 2026-06-06T05:34:34.083Z

Adapters: browser
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 2
Failures: 2

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 35.68 | 42.19 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 301.92 | 304.60 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 532 | 534.90 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 11.60 | 12 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 519.90 | 520.50 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 3 | 4.70 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 0.10 | 0.30 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 2.17 | 3.74 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace_bootstrap_ms | 27.68 | 30.96 | ms | fail | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace_switch_ms | 10261.37 | 10284.06 | ms | fail | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | file_tree_load_ms | 9013.70 | 9015.50 | ms | fail | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | file_tree_control_ms | 4005.90 | 4013.20 | ms | fail | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | file_tree_state_ms | 5000.70 | 5001.60 | ms | fail | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | file_tree_first_frame_ms | 1.10 | 7 | ms | fail | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | file_tree_data_ms | NaN | NaN | ms | fail | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | surface_switch_latency_ms | 10007.35 | 10007.53 | ms | fail | reports/videos/upstream-workspace-switch-3.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms p95 42.193624999999884 > 32 | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 534.8999999761581 > 31 | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms p95 520.5 > 236 | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace_bootstrap_ms p95 30.95837500000198 > 7 | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace_switch_ms p95 10284.059999999998 > 510 | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | file_tree_load_ms p95 9015.5 > 256 | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | file_tree_data_ms p95 NaN > NaN | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | surface_switch_latency_ms p95 10007.52575 > 7 | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace files navigator did not visibly render | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | only 0 of 2 seeded sessions were visible in the session inventory | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | transcript text was not visible for workspace-switch: workspace-switch session 1 | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | transcript text was not visible for workspace-switch: workspace-switch session 2 | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace files navigator did not visibly render | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | only 0 of 2 seeded sessions were visible in the session inventory | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | transcript text was not visible for workspace-switch: workspace-switch session 1 | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | transcript text was not visible for workspace-switch: workspace-switch session 2 | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace files navigator did not visibly render | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | only 0 of 2 seeded sessions were visible in the session inventory | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | transcript text was not visible for workspace-switch: workspace-switch session 1 | reports/videos/upstream-workspace-switch-3.webm |
| browser | Upstream OpenCode app | workspace-switch | transcript text was not visible for workspace-switch: workspace-switch session 2 | reports/videos/upstream-workspace-switch-3.webm |

## Target Comparison

| Adapter | Scenario | Metric | Faster target | Claxedo p95 | Upstream p95 | Faster by |
| --- | --- | --- | --- | ---: | ---: | ---: |
| browser | workspace-switch | workspace_bootstrap_ms | Upstream OpenCode app | 42.19 | 30.96 | 26.63% |
| browser | workspace-switch | workspace_switch_ms | Claxedo app | 304.60 | 10284.06 | 97.04% |
| browser | workspace-switch | file_tree_load_ms | Claxedo app | 534.90 | 9015.50 | 94.07% |
| browser | workspace-switch | file_tree_control_ms | Claxedo app | 12 | 4013.20 | 99.70% |
| browser | workspace-switch | file_tree_state_ms | Claxedo app | 520.50 | 5001.60 | 89.59% |
| browser | workspace-switch | file_tree_first_frame_ms | Claxedo app | 4.70 | 7 | 32.86% |
| browser | workspace-switch | file_tree_data_ms | Upstream OpenCode app | 0.30 | NaN | NaN% |
| browser | workspace-switch | surface_switch_latency_ms | Claxedo app | 3.74 | 10007.53 | 99.96% |
