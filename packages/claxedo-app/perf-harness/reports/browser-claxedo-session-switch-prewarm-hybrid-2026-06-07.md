# Claxedo Performance Report

Generated: 2026-06-06T21:14:16.943Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | session-switch-stress | surface_switch_latency_ms | 40.70 | 40.70 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | transcript_render_ms | 15.90 | 15.90 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_first_fold_ms | 34.40 | 34.40 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_30ms | 0 | 0 | requests | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_100ms | 0 | 0 | requests | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_max_call_stack | 0 | 0 | errors | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_loader_fraction | 0 | 0 | ratio | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | memory_growth_mb | 12.49 | 12.49 | MB | fail | reports/videos/claxedo-session-switch-stress-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | session-switch-stress | session_switch_first_fold_ms p95 34.40000003576279 > 30 | reports/videos/claxedo-session-switch-stress-1.webm |
