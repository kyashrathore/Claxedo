# Claxedo Performance Report

Generated: 2026-06-06T20:22:42.780Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_window_ms | 14010.46 | 14010.46 | ms | fail | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_useful_screen_ms | 14126.38 | 14126.38 | ms | fail | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_workspace_ready_ms | 19128.23 | 19128.23 | ms | fail | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_input_ms | 1.42 | 1.42 | ms | fail | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | memory_rss_mb | 82.40 | 82.40 | MB | fail | reports/videos/claxedo-launch-empty-home-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_window_ms p95 14010.459292 > 5664 | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_useful_screen_ms p95 14126.378792 > 5720 | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_workspace_ready_ms p95 19128.225334000002 > 14390 | reports/videos/claxedo-launch-empty-home-1.webm |
