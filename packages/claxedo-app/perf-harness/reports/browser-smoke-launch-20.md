# Claxedo Performance Report

Generated: 2026-05-23T09:37:53.270Z

Adapters: browser
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 2
Failures: 2

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | launch-project-20-sessions | launch_first_window_ms | 3404.74 | 3404.74 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_workspace_ready_ms | 8476.24 | 8476.24 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms | 661.47 | 661.47 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | memory_rss_mb | 77.63 | 77.63 | MB | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | launch_first_window_ms | 2103.20 | 2103.20 | ms | fail | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | launch_workspace_ready_ms | 8047.57 | 8047.57 | ms | fail | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | transcript_render_ms | 467.75 | 467.75 | ms | fail | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | memory_rss_mb | 45.20 | 45.20 | MB | fail | reports/videos/upstream-launch-project-20-sessions-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | launch-project-20-sessions | launch_first_window_ms p95 3404.739541 > 570 | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms p95 661.4706249999999 > 45 | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | launch_first_window_ms p95 2103.195667 > 331 | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | only 0 of 20 seeded sessions were visible in the session inventory | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | session row was not clickable in the visible UI: launch-project-20-sessions session 2 | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | transcript text was not visible for launch-project-20-sessions: launch-project-20-sessions session 1 | reports/videos/upstream-launch-project-20-sessions-1.webm |

## Target Comparison

| Adapter | Scenario | Metric | Faster target | Claxedo p95 | Upstream p95 | Faster by |
| --- | --- | --- | --- | ---: | ---: | ---: |
| browser | launch-project-20-sessions | launch_first_window_ms | Upstream OpenCode app | 3404.74 | 2103.20 | 38.23% |
| browser | launch-project-20-sessions | launch_workspace_ready_ms | Upstream OpenCode app | 8476.24 | 8047.57 | 5.06% |
| browser | launch-project-20-sessions | transcript_render_ms | Upstream OpenCode app | 661.47 | 467.75 | 29.29% |
| browser | launch-project-20-sessions | memory_rss_mb | Upstream OpenCode app | 77.63 | 45.20 | 41.77% |
