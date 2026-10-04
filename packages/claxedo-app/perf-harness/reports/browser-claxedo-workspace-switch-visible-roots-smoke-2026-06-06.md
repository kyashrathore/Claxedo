# Claxedo Performance Report

Generated: 2026-06-06T08:57:05.113Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 2.11 | 2.11 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 338.15 | 338.15 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 129.20 | 129.20 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 112.30 | 112.30 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 16.70 | 16.70 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 15.50 | 15.50 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 31.80 | 31.80 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 0 | 0 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 129.19999998807907 > 31 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace files direct control unavailable: [{"label":"Maximize workspace panel","pressed":null,"testId":null,"visible":false,"context":"workspace-panel-floating-chrome","rect":{"x":1377,"y":-9.5,"width":28,"height":28,"top":-9.5,"right":1405,"bottom":18.5,"left":1377}},{"label":"Open workspace panel","pressed":"false","testId":"workspace-panel-toggle","visible":true,"context":"workspace-panel-toggle","rect":{"x":1407,"y":-9.5,"width":28,"height":28,"top":-9.5,"right":1435,"bottom":18.5,"left":1407}},{"label":"New Session","pressed":null,"testId":null,"visible":true,"context":"workbench-column","rect":{"x":1241,"y":2.5,"width":32,"height":32,"top":2.5,"right":1273,"bottom":34.5,"left":1241}},{"label":"New Claude Terminal","pressed":null,"testId":null,"visible":true,"context":"workbench-column","rect":{"x":1273,"y":2.5,"width":32,"height":32,"top":2.5,"right":1305,"bottom":34.5,"left":1273}},{"label":"New Codex Terminal","pressed": | reports/videos/claxedo-workspace-switch-1.webm |
