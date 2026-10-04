# Claxedo Performance Report

Generated: 2026-06-06T19:39:10.422Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | session-switch-stress | surface_switch_latency_ms | 65.60 | 65.60 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | transcript_render_ms | 57.30 | 57.30 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_first_fold_ms | 502.90 | 502.90 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_30ms | 0 | 0 | requests | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_100ms | 4 | 4 | requests | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_max_call_stack | 0 | 0 | errors | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_loader_fraction | 0 | 0 | ratio | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | memory_growth_mb | 8.24 | 8.24 | MB | fail | reports/videos/claxedo-session-switch-stress-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | session-switch-stress | session_switch_first_fold_ms p95 502.89999997615814 > 30 | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_100ms p95 4 > 0 | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session-switch-stress hot-path api calls: http://127.0.0.1:59832/api/workspace/resolve?directory=%2Ftmp%2Fclaxedo-perf%2Fsession-switch-stress, http://127.0.0.1:59832/session/ses_perf_session_switch_stress_2/message?directory=%2Ftmp%2Fclaxedo-perf%2Fsession-switch-stress&limit=80, http://127.0.0.1:59832/api/claxedo/runtime-events?directory=%2Ftmp%2Fclaxedo-perf%2Fsession-switch-stress, http://127.0.0.1:59832/api/claxedo/events | reports/videos/claxedo-session-switch-stress-1.webm |
