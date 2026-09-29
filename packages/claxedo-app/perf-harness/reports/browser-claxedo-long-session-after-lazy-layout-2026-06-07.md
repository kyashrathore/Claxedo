# Claxedo Performance Report

Generated: 2026-06-06T20:31:53.167Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms | 206.31 | 206.31 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | transcript_render_ms | 1.65 | 1.65 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | scroll_latency_ms | 20.65 | 20.65 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | incremental_append_latency_ms | 0.73 | 0.73 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | tool_block_toggle_latency_ms | 1.88 | 1.88 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | memory_growth_mb | 7.00 | 7.00 | MB | fail | reports/videos/claxedo-long-session-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | long-session-switch | transcript text was not visible for long-session-switch: long-session-switch session 1 | reports/videos/claxedo-long-session-switch-1.webm |
