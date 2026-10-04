# Claxedo Performance Report

Generated: 2026-06-06T05:24:18.944Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 49.21 | 49.21 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 271.97 | 271.97 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 11.90 | 11.90 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 10.70 | 10.70 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 0.30 | 0.30 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 0.90 | 0.90 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 10.20 | 10.20 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 27.70 | 27.70 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms p95 49.213291999998546 > 32 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms p95 27.704999999999927 > 7 | reports/videos/claxedo-workspace-switch-1.webm |
