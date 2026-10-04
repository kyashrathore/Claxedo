# Claxedo Performance Report

Generated: 2026-06-05T21:55:50.517Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 31.49 | 31.49 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 301.70 | 301.70 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 37 | 37 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 18 | 18 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 7.50 | 7.50 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 11.40 | 11.40 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 27.20 | 27.20 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 29.34 | 29.34 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 37 > 31 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms p95 11.400000035762787 > 7 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms p95 29.341458000000785 > 7 | reports/videos/claxedo-workspace-switch-1.webm |
