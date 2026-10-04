# Claxedo Performance Report

Generated: 2026-06-06T08:55:09.505Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 2.30 | 2.30 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 358.02 | 358.02 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 113.70 | 113.70 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 105.90 | 105.90 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 7.60 | 7.60 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 31.70 | 31.70 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 21.90 | 21.90 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 0.10 | 0.10 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 113.69999998807907 > 31 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms p95 31.700000047683716 > 25 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace files direct control unavailable: [{"label":"Open Files","pressed":"false","testId":null,"visible":false,"context":"workbench-l2-header","rect":{"x":2405,"y":38.5,"width":32,"height":32,"top":38.5,"right":2437,"bottom":70.5,"left":2405}},{"label":"Maximize workspace panel","pressed":null,"testId":null,"visible":false,"context":"workspace-panel-floating-chrome","rect":{"x":1377,"y":-9.5,"width":28,"height":28,"top":-9.5,"right":1405,"bottom":18.5,"left":1377}},{"label":"Open workspace panel","pressed":"false","testId":"workspace-panel-toggle","visible":true,"context":"workspace-panel-toggle","rect":{"x":1407,"y":-9.5,"width":28,"height":28,"top":-9.5,"right":1435,"bottom":18.5,"left":1407}},{"label":"New Session","pressed":null,"testId":null,"visible":true,"context":"workbench-column","rect":{"x":1241,"y":2.5,"width":32,"height":32,"top":2.5,"right":1273,"bottom":34.5,"left":1241}},{"label":"New Claude Terminal","pressed" | reports/videos/claxedo-workspace-switch-1.webm |
