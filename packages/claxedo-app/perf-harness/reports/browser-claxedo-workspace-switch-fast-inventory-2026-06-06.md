# Claxedo Performance Report

Generated: 2026-06-06T06:17:49.641Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 1.51 | 1.83 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 468.72 | 515.60 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 35 | 71.40 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 5.80 | 6.80 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 14.50 | 17.80 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 18.40 | 46.60 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 28.60 | 32.40 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 1.52 | 10.47 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 71.39999997615814 > 31 | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms p95 46.60000002384186 > 7 | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms p95 10.465749999999389 > 7 | reports/videos/claxedo-workspace-switch-5.webm |
