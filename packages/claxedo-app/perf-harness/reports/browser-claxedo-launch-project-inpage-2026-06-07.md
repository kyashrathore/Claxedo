# Claxedo Performance Report

Generated: 2026-06-06T19:01:17.419Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | launch-project-20-sessions | launch_first_window_ms | 4569.08 | 4569.08 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_workspace_ready_ms | 9592.32 | 9592.32 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms | 2007.10 | 2007.10 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | memory_rss_mb | 92.89 | 92.89 | MB | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | launch-project-20-sessions | launch_first_window_ms p95 4569.078708 > 570 | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_workspace_ready_ms p95 9592.319915999999 > 9403 | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms p95 2007.1000000238419 > 45 | reports/videos/claxedo-launch-project-20-sessions-1.webm |
