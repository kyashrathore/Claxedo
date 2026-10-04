# Claxedo Performance Report

Generated: 2026-05-27T02:43:56.679Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms | 10.50 | 10.50 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | pty_attach_ms | 1.67 | 1.67 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms | 73.20 | 73.20 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_reconnect_latency_ms | 11.30 | 11.30 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | ansi_render_latency_ms | 1.09 | 1.09 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms p95 73.20000004768372 > 50 | reports/videos/claxedo-live-terminal-switch-1.webm |
