# Claxedo Performance Report

Generated: 2026-06-05T17:10:03.604Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms | 648.10 | 648.10 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | transcript_render_ms | 2.84 | 2.84 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | scroll_latency_ms | 24.83 | 24.83 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | incremental_append_latency_ms | 1.49 | 1.49 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | tool_block_toggle_latency_ms | 2.55 | 2.55 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | memory_growth_mb | 7.00 | 7.00 | MB | fail | reports/videos/claxedo-long-session-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms p95 648.0996670000004 > 523 | reports/videos/claxedo-long-session-switch-1.webm |
