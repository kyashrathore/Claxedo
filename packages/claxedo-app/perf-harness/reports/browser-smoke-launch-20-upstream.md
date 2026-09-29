# Claxedo Performance Report

Generated: 2026-05-23T09:40:02.080Z

Adapters: browser
Targets: Upstream OpenCode app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Upstream OpenCode app | launch-project-20-sessions | launch_first_window_ms | 2326.94 | 2326.94 | ms | fail | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | launch_workspace_ready_ms | 8456.40 | 8456.40 | ms | fail | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | transcript_render_ms | 628.50 | 628.50 | ms | fail | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | memory_rss_mb | 51.02 | 51.02 | MB | fail | reports/videos/upstream-launch-project-20-sessions-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Upstream OpenCode app | launch-project-20-sessions | launch_first_window_ms p95 2326.9398340000002 > 331 | reports/videos/upstream-launch-project-20-sessions-1.webm |
