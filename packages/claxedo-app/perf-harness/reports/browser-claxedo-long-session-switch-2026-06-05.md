# Claxedo Performance Report

Generated: 2026-06-05T16:55:27.953Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms | 669.65 | 669.65 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | transcript_render_ms | 3.33 | 3.33 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | scroll_latency_ms | 17.04 | 17.04 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | incremental_append_latency_ms | 1.69 | 1.69 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | tool_block_toggle_latency_ms | 2.10 | 2.10 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | memory_growth_mb | 7.00 | 7.00 | MB | fail | reports/videos/claxedo-long-session-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms p95 669.6471659999988 > 523 | reports/videos/claxedo-long-session-switch-1.webm |
