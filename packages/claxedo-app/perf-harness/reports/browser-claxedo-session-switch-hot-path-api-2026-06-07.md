# Claxedo Performance Report

Generated: 2026-06-06T19:34:24.220Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | session-switch-stress | surface_switch_latency_ms | 0 | 0 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | transcript_render_ms | 0 | 0 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_first_fold_ms | 0 | 0 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_30ms | 0 | 0 | requests | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_100ms | 0 | 0 | requests | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_max_call_stack | 0 | 0 | errors | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_loader_fraction | 0 | 0 | ratio | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | memory_growth_mb | 8.75 | 8.75 | MB | fail | reports/videos/claxedo-session-switch-stress-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | session-switch-stress | error boundary rendered for session-switch-stress | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | only 0 of 8 seeded sessions were visible in the session inventory | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session-switch-stress: no seeded session rows were clickable | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | transcript text was not visible for session-switch-stress: session-switch-stress session 1 | reports/videos/claxedo-session-switch-stress-1.webm |
