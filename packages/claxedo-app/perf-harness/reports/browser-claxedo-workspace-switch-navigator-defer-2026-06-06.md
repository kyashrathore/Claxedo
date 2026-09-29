# Claxedo Performance Report

Generated: 2026-06-06T06:09:22.052Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 39.24 | 48.55 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 421.25 | 424.57 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 100.20 | 115.90 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 7 | 7.40 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 67.20 | 79 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 19.40 | 41.20 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 19.30 | 21.50 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 3.03 | 4.61 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms p95 48.55437499999971 > 32 | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 115.89999997615814 > 31 | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms p95 41.19999998807907 > 7 | reports/videos/claxedo-workspace-switch-5.webm |
