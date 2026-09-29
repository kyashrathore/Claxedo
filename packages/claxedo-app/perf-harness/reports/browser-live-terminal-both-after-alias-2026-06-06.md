# Claxedo Performance Report

Generated: 2026-06-05T19:47:08.327Z

Adapters: browser
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 2
Failures: 2

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms | 51.70 | 51.70 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | pty_attach_ms | 0.88 | 0.88 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms | 49.10 | 49.10 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_reconnect_latency_ms | 30.29 | 30.29 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | ansi_render_latency_ms | 1.62 | 1.62 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | surface_switch_latency_ms | 5000 | 5000 | ms | fail | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | pty_attach_ms | 1.18 | 1.18 | ms | fail | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | fail | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | terminal_resize_latency_ms | 21 | 21 | ms | fail | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | terminal_reconnect_latency_ms | 26.63 | 26.63 | ms | fail | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | ansi_render_latency_ms | 0.85 | 0.85 | ms | fail | reports/videos/upstream-live-terminal-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms p95 51.69999998807907 > 32 | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | surface_switch_latency_ms p95 5000 > 31 | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | terminal switch did not settle before timeout | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | transcript text was not visible for live-terminal-switch: live-terminal-switch session 1 | reports/videos/upstream-live-terminal-switch-1.webm |

## Target Comparison

| Adapter | Scenario | Metric | Faster target | Claxedo p95 | Upstream p95 | Faster by |
| --- | --- | --- | --- | ---: | ---: | ---: |
| browser | live-terminal-switch | surface_switch_latency_ms | Claxedo app | 51.70 | 5000 | 98.97% |
| browser | live-terminal-switch | pty_attach_ms | Claxedo app | 0.88 | 1.18 | 25.09% |
| browser | live-terminal-switch | terminal_throughput_lines_per_s | tie | 300000 | 300000 | 0% |
| browser | live-terminal-switch | terminal_resize_latency_ms | Upstream OpenCode app | 49.10 | 21 | 57.23% |
| browser | live-terminal-switch | terminal_reconnect_latency_ms | Upstream OpenCode app | 30.29 | 26.63 | 12.06% |
| browser | live-terminal-switch | ansi_render_latency_ms | Upstream OpenCode app | 1.62 | 0.85 | 47.79% |
