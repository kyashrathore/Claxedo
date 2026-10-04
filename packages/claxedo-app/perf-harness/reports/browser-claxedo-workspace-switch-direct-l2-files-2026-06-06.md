# Claxedo Performance Report

Generated: 2026-06-06T08:31:29.174Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 2.37 | 2.88 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 333.72 | 377.75 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 133.10 | 141 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 114.20 | 123.60 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 17.70 | 18.90 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 6.70 | 13.40 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 9.50 | 25.20 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 0 | 0.10 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 141 > 31 | reports/videos/claxedo-workspace-switch-5.webm |
