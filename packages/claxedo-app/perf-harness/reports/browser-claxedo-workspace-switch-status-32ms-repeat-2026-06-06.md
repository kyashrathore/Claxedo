# Claxedo Performance Report

Generated: 2026-06-06T05:43:40.609Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 41.17 | 41.61 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 254.96 | 271.37 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 88 | 5022.20 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 10.70 | 11.80 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 68.20 | 5000.80 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 9.40 | 15.40 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 0.10 | 0.20 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 3.84 | 5.13 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms p95 41.612458999999944 > 32 | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 5022.199999988079 > 31 | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms p95 5000.800000011921 > 236 | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms p95 15.400000035762787 > 7 | reports/videos/claxedo-workspace-switch-3.webm |
