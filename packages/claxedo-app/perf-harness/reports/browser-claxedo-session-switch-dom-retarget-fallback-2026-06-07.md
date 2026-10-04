# Claxedo Performance Report

Generated: 2026-06-06T21:23:44.566Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | session-switch-stress | surface_switch_latency_ms | 36.50 | 36.50 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | transcript_render_ms | 15.70 | 15.70 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_first_fold_ms | 34.50 | 34.50 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_30ms | 0 | 0 | requests | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_100ms | 1 | 1 | requests | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_max_call_stack | 0 | 0 | errors | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_loader_fraction | 0 | 0 | ratio | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | memory_growth_mb | 11.06 | 11.06 | MB | fail | reports/videos/claxedo-session-switch-stress-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | session-switch-stress | session_switch_first_fold_ms p95 34.5 > 30 | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_100ms p95 1 > 0 | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session-switch-stress hot-path api calls: http://127.0.0.1:54493/api/workspace/resolve?directory=%2Ftmp%2Fclaxedo-perf%2Fsession-switch-stress | reports/videos/claxedo-session-switch-stress-1.webm |
