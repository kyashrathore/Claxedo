# Claxedo Performance Report

Generated: 2026-06-06T19:42:16.963Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | session-switch-stress | surface_switch_latency_ms | 64.90 | 64.90 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | transcript_render_ms | 56.20 | 56.20 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_first_fold_ms | 507.20 | 507.20 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_30ms | 0 | 0 | requests | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_100ms | 3 | 3 | requests | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_max_call_stack | 0 | 0 | errors | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_loader_fraction | 0 | 0 | ratio | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | memory_growth_mb | 8.75 | 8.75 | MB | fail | reports/videos/claxedo-session-switch-stress-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | session-switch-stress | session_switch_first_fold_ms p95 507.19999998807907 > 30 | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_100ms p95 3 > 0 | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session-switch-stress hot-path api calls: http://127.0.0.1:60073/api/workspace/resolve?directory=%2Ftmp%2Fclaxedo-perf%2Fsession-switch-stress, http://127.0.0.1:60073/session/ses_perf_session_switch_stress_2/message?directory=%2Ftmp%2Fclaxedo-perf%2Fsession-switch-stress&limit=80, http://127.0.0.1:60073/api/claxedo/runtime-events?directory=%2Ftmp%2Fclaxedo-perf%2Fsession-switch-stress | reports/videos/claxedo-session-switch-stress-1.webm |
