# Claxedo Performance Report

Generated: 2026-06-06T06:22:58.739Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 1.31 | 3.77 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 435.50 | 449.19 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 8.40 | 21.80 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 5.30 | 5.40 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 3 | 17.10 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 9.40 | 24.40 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 26.10 | 35.50 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 0.10 | 0.10 | ms | fail | reports/videos/claxedo-workspace-switch-5.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms p95 24.399999976158142 > 7 | reports/videos/claxedo-workspace-switch-5.webm |
