# Claxedo Performance Report

Generated: 2026-05-23T09:08:52.252Z

Adapters: browser
Targets: Upstream OpenCode app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Upstream OpenCode app | long-session-switch | surface_switch_latency_ms | 201.78 | 201.78 | ms | fail | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | transcript_render_ms | 28.76 | 28.76 | ms | fail | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | scroll_latency_ms | 25.73 | 25.73 | ms | fail | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | incremental_append_latency_ms | 0.58 | 0.58 | ms | fail | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | tool_block_toggle_latency_ms | 5.57 | 5.57 | ms | fail | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | memory_growth_mb | 3.62 | 3.62 | MB | fail | reports/videos/upstream-long-session-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Upstream OpenCode app | long-session-switch | blank page rendered for long-session-switch | reports/videos/upstream-long-session-switch-1.webm |
