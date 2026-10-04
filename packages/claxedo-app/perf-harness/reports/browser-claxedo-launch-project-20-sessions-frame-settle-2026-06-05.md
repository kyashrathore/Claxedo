# Claxedo Performance Report

Generated: 2026-06-05T17:14:29.386Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | launch-project-20-sessions | launch_first_window_ms | 4873.55 | 4873.55 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_workspace_ready_ms | 9974.89 | 9974.89 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms | 132.82 | 132.82 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | memory_rss_mb | 87.45 | 87.45 | MB | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | launch-project-20-sessions | launch_first_window_ms p95 4873.549542 > 570 | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_workspace_ready_ms p95 9974.885375 > 9403 | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms p95 132.81537500000013 > 45 | reports/videos/claxedo-launch-project-20-sessions-1.webm |
