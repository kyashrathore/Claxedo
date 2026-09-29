# Claxedo Performance Report

Generated: 2026-05-25T05:34:45.735Z

Adapters: browser
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 2
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_window_ms | 308.13 | 4695.80 | ms | fail | reports/videos/claxedo-launch-empty-home-3.webm |
| browser | Claxedo app | launch-empty-home | launch_first_useful_screen_ms | 354.98 | 4783.84 | ms | fail | reports/videos/claxedo-launch-empty-home-3.webm |
| browser | Claxedo app | launch-empty-home | launch_workspace_ready_ms | 5356.45 | 9786.46 | ms | fail | reports/videos/claxedo-launch-empty-home-3.webm |
| browser | Claxedo app | launch-empty-home | launch_first_input_ms | 14.97 | 68.99 | ms | fail | reports/videos/claxedo-launch-empty-home-3.webm |
| browser | Claxedo app | launch-empty-home | memory_rss_mb | 61.04 | 61.04 | MB | fail | reports/videos/claxedo-launch-empty-home-3.webm |
| browser | Upstream OpenCode app | launch-empty-home | launch_first_window_ms | 327.52 | 2178.58 | ms | pass | reports/videos/upstream-launch-empty-home-3.webm |
| browser | Upstream OpenCode app | launch-empty-home | launch_first_useful_screen_ms | 479.04 | 3303.98 | ms | pass | reports/videos/upstream-launch-empty-home-3.webm |
| browser | Upstream OpenCode app | launch-empty-home | launch_workspace_ready_ms | 5479.56 | 8306.58 | ms | pass | reports/videos/upstream-launch-empty-home-3.webm |
| browser | Upstream OpenCode app | launch-empty-home | launch_first_input_ms | 11.78 | 17.90 | ms | pass | reports/videos/upstream-launch-empty-home-3.webm |
| browser | Upstream OpenCode app | launch-empty-home | memory_rss_mb | 48.07 | 48.07 | MB | pass | reports/videos/upstream-launch-empty-home-3.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_input_ms p95 68.98870800000077 > 62 | reports/videos/claxedo-launch-empty-home-3.webm |

## Target Comparison

| Adapter | Scenario | Metric | Faster target | Claxedo p95 | Upstream p95 | Faster by |
| --- | --- | --- | --- | ---: | ---: | ---: |
| browser | launch-empty-home | launch_first_window_ms | Upstream OpenCode app | 4695.80 | 2178.58 | 53.61% |
| browser | launch-empty-home | launch_first_useful_screen_ms | Upstream OpenCode app | 4783.84 | 3303.98 | 30.93% |
| browser | launch-empty-home | launch_workspace_ready_ms | Upstream OpenCode app | 9786.46 | 8306.58 | 15.12% |
| browser | launch-empty-home | launch_first_input_ms | Upstream OpenCode app | 68.99 | 17.90 | 74.06% |
| browser | launch-empty-home | memory_rss_mb | Upstream OpenCode app | 61.04 | 48.07 | 21.25% |
