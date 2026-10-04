# Claxedo Performance Report

Generated: 2026-05-23T09:55:46.513Z

Adapters: browser
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 2
Failures: 2

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms | 1170.51 | 1170.51 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | pty_attach_ms | 2.11 | 2.11 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms | 1.73 | 1.73 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_reconnect_latency_ms | 51.53 | 51.53 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | ansi_render_latency_ms | 273.63 | 273.63 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | surface_switch_latency_ms | 310.55 | 310.55 | ms | fail | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | pty_attach_ms | 2.02 | 2.02 | ms | fail | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | fail | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | terminal_resize_latency_ms | 1.65 | 1.65 | ms | fail | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | terminal_reconnect_latency_ms | 29.90 | 29.90 | ms | fail | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | ansi_render_latency_ms | 268.30 | 268.30 | ms | fail | reports/videos/upstream-live-terminal-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms p95 1170.510166 > 32 | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | ansi_render_latency_ms p95 273.6251250000005 > 6 | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | surface_switch_latency_ms p95 310.5505830000002 > 31 | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | ansi_render_latency_ms p95 268.29575000000114 > 6 | reports/videos/upstream-live-terminal-switch-1.webm |

## Target Comparison

| Adapter | Scenario | Metric | Faster target | Claxedo p95 | Upstream p95 | Faster by |
| --- | --- | --- | --- | ---: | ---: | ---: |
| browser | live-terminal-switch | surface_switch_latency_ms | Upstream OpenCode app | 1170.51 | 310.55 | 73.47% |
| browser | live-terminal-switch | pty_attach_ms | Upstream OpenCode app | 2.11 | 2.02 | 4.08% |
| browser | live-terminal-switch | terminal_throughput_lines_per_s | tie | 300000 | 300000 | 0% |
| browser | live-terminal-switch | terminal_resize_latency_ms | Upstream OpenCode app | 1.73 | 1.65 | 5.03% |
| browser | live-terminal-switch | terminal_reconnect_latency_ms | Upstream OpenCode app | 51.53 | 29.90 | 41.98% |
| browser | live-terminal-switch | ansi_render_latency_ms | Upstream OpenCode app | 273.63 | 268.30 | 1.95% |
