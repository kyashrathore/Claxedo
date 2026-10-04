# Claxedo Performance Report

Generated: 2026-06-05T21:28:05.013Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 18.94 | 18.94 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 290.63 | 290.63 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 93 | 93 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 31.40 | 31.40 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 37.20 | 37.20 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 24.40 | 24.40 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 32.08 | 32.08 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 93 > 31 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms p95 24.399999976158142 > 7 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms p95 32.079916999999114 > 7 | reports/videos/claxedo-workspace-switch-1.webm |
