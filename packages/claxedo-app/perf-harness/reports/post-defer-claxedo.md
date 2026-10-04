# Claxedo Performance Report

Generated: 2026-05-25T05:47:08.627Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_window_ms | 313.68 | 3488.83 | ms | fail | reports/videos/claxedo-launch-empty-home-3.webm |
| browser | Claxedo app | launch-empty-home | launch_first_useful_screen_ms | 354.99 | 3563.71 | ms | fail | reports/videos/claxedo-launch-empty-home-3.webm |
| browser | Claxedo app | launch-empty-home | launch_workspace_ready_ms | 5356.10 | 8566.56 | ms | fail | reports/videos/claxedo-launch-empty-home-3.webm |
| browser | Claxedo app | launch-empty-home | launch_first_input_ms | 15.48 | 68.09 | ms | fail | reports/videos/claxedo-launch-empty-home-3.webm |
| browser | Claxedo app | launch-empty-home | memory_rss_mb | 61.04 | 61.04 | MB | fail | reports/videos/claxedo-launch-empty-home-3.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_input_ms p95 68.08816600000137 > 62 | reports/videos/claxedo-launch-empty-home-3.webm |
