# Claxedo Performance Report

Generated: 2026-06-06T05:40:40.922Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 33.52 | 40.63 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 272.10 | 281.57 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 534.60 | 540.50 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 11.90 | 13.80 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 520.50 | 523.80 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 3.10 | 4.60 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 0 | 0.20 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 1.74 | 2.78 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms p95 40.63125000000218 > 32 | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 540.5 > 31 | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms p95 523.8000000119209 > 236 | reports/videos/claxedo-workspace-switch-3.webm |
