# Claxedo Performance Report

Generated: 2026-06-06T06:19:53.642Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 1.36 | 1.74 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 426.49 | 449.58 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 28.20 | 50.10 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 4.90 | 5.90 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 4.90 | 10.40 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 18 | 34.80 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 33.60 | 36.40 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 0.10 | 0.10 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 50.09999996423721 > 31 | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms p95 34.799999952316284 > 7 | reports/videos/claxedo-workspace-switch-5.webm |
