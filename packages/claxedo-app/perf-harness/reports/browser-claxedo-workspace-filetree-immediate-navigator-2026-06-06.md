# Claxedo Performance Report

Generated: 2026-06-05T21:12:25.450Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 25.96 | 25.96 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 265.89 | 265.89 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 124.50 | 124.50 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 31.20 | 31.20 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 71 | 71 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 22.20 | 22.20 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 31.29 | 31.29 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 124.5 > 31 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms p95 22.200000047683716 > 7 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms p95 31.292499999999563 > 7 | reports/videos/claxedo-workspace-switch-1.webm |
