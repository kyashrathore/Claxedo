# Claxedo Performance Report

Generated: 2026-06-06T05:36:31.789Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 37.73 | 44.85 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 335.08 | 348.47 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 535.50 | 538.20 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 11 | 14.10 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 520.20 | 521.20 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 3.30 | 4.40 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 0 | 0.10 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 2.05 | 3.69 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms p95 44.84558300000026 > 32 | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 538.1999999880791 > 31 | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms p95 521.1999999880791 > 236 | reports/videos/claxedo-workspace-switch-3.webm |
