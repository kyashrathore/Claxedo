# Claxedo Performance Report

Generated: 2026-05-23T09:40:53.284Z

Adapters: browser
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 2
Failures: 2

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms | 658.39 | 658.39 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | transcript_render_ms | 3.22 | 3.22 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | scroll_latency_ms | 18.98 | 18.98 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | incremental_append_latency_ms | 1.12 | 1.12 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | tool_block_toggle_latency_ms | 3.19 | 3.19 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | memory_growth_mb | 5.84 | 5.84 | MB | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | surface_switch_latency_ms | 665.30 | 665.30 | ms | fail | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | transcript_render_ms | 2.39 | 2.39 | ms | fail | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | scroll_latency_ms | 23.29 | 23.29 | ms | fail | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | incremental_append_latency_ms | 0.55 | 0.55 | ms | fail | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | tool_block_toggle_latency_ms | 1.08 | 1.08 | ms | fail | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | memory_growth_mb | 3.85 | 3.85 | MB | fail | reports/videos/upstream-long-session-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms p95 658.3878750000003 > 523 | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | surface_switch_latency_ms p95 665.302083999999 > 300 | reports/videos/upstream-long-session-switch-1.webm |

## Target Comparison

| Adapter | Scenario | Metric | Faster target | Claxedo p95 | Upstream p95 | Faster by |
| --- | --- | --- | --- | ---: | ---: | ---: |
| browser | long-session-switch | surface_switch_latency_ms | Claxedo app | 658.39 | 665.30 | 1.04% |
| browser | long-session-switch | transcript_render_ms | Upstream OpenCode app | 3.22 | 2.39 | 25.74% |
| browser | long-session-switch | scroll_latency_ms | Claxedo app | 18.98 | 23.29 | 18.50% |
| browser | long-session-switch | incremental_append_latency_ms | Upstream OpenCode app | 1.12 | 0.55 | 50.97% |
| browser | long-session-switch | tool_block_toggle_latency_ms | Upstream OpenCode app | 3.19 | 1.08 | 66.09% |
| browser | long-session-switch | memory_growth_mb | Upstream OpenCode app | 5.84 | 3.85 | 34.20% |
