# Claxedo Performance Report

Generated: 2026-06-06T05:38:19.408Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 41.94 | 44.53 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 272.46 | 283.44 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 535.20 | 540.10 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 10.80 | 10.80 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 522.60 | 524.30 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 6.60 | 13.40 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 0.10 | 0.10 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 1.77 | 5.06 | ms | fail | reports/videos/claxedo-workspace-switch-3.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms p95 44.5267500000009 > 32 | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 540.0999999642372 > 31 | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms p95 524.3000000119209 > 236 | reports/videos/claxedo-workspace-switch-3.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms p95 13.399999976158142 > 7 | reports/videos/claxedo-workspace-switch-3.webm |
