# Claxedo Performance Report

Generated: 2026-05-23T09:08:52.532Z

Adapters: browser
Targets: Upstream OpenCode app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Upstream OpenCode app | workspace-switch | workspace_bootstrap_ms | 4.09 | 4.09 | ms | fail | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace_switch_ms | 367.21 | 367.21 | ms | fail | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | file_tree_load_ms | 35.21 | 35.21 | ms | fail | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | surface_switch_latency_ms | 27.64 | 27.64 | ms | fail | reports/videos/upstream-workspace-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Upstream OpenCode app | workspace-switch | workspace_switch_ms p95 367.20991700000013 > 292 | reports/videos/upstream-workspace-switch-1.webm |
