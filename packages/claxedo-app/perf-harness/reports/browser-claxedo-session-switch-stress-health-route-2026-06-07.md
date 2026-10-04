# Claxedo Performance Report

Generated: 2026-06-06T19:09:18.190Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | session-switch-stress | surface_switch_latency_ms | 28.80 | 28.80 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | transcript_render_ms | 15.50 | 15.50 | ms | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_max_call_stack | 0 | 0 | errors | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_loader_fraction | 0 | 0 | ratio | fail | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | memory_growth_mb | 13.26 | 13.26 | MB | fail | reports/videos/claxedo-session-switch-stress-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | session-switch-stress | transcript text was not visible for session-switch-stress: session-switch-stress session 1 | reports/videos/claxedo-session-switch-stress-1.webm |
