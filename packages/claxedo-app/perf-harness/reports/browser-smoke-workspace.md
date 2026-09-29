# Claxedo Performance Report

Generated: 2026-05-23T10:13:24.850Z

Adapters: browser
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 2
Failures: 2

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 279.33 | 279.33 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 1285.55 | 1285.55 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 1364.46 | 1364.46 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 324.84 | 324.84 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace_bootstrap_ms | 280.67 | 280.67 | ms | fail | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace_switch_ms | 946.34 | 946.34 | ms | fail | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | file_tree_load_ms | 902.73 | 902.73 | ms | fail | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | surface_switch_latency_ms | 334.27 | 334.27 | ms | fail | reports/videos/upstream-workspace-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms p95 279.3288329999996 > 32 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms p95 1285.5529999999999 > 709 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 1364.457833999999 > 31 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms p95 324.8429580000011 > 7 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace_bootstrap_ms p95 280.6697920000006 > 7 | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace_switch_ms p95 946.3353750000024 > 510 | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | file_tree_load_ms p95 902.729457999998 > 256 | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | surface_switch_latency_ms p95 334.27187499999854 > 7 | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | session row was not clickable in the visible UI: workspace-switch session 2 | reports/videos/upstream-workspace-switch-1.webm |

## Target Comparison

| Adapter | Scenario | Metric | Faster target | Claxedo p95 | Upstream p95 | Faster by |
| --- | --- | --- | --- | ---: | ---: | ---: |
| browser | workspace-switch | workspace_bootstrap_ms | Claxedo app | 279.33 | 280.67 | 0.48% |
| browser | workspace-switch | workspace_switch_ms | Upstream OpenCode app | 1285.55 | 946.34 | 26.39% |
| browser | workspace-switch | file_tree_load_ms | Upstream OpenCode app | 1364.46 | 902.73 | 33.84% |
| browser | workspace-switch | surface_switch_latency_ms | Claxedo app | 324.84 | 334.27 | 2.82% |
