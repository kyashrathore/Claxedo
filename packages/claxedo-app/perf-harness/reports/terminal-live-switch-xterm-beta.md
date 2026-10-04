# Claxedo Performance Report

Generated: 2026-05-27T02:42:51.672Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms | 5.50 | 5.50 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | pty_attach_ms | 6.42 | 6.42 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms | 65 | 65 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_reconnect_latency_ms | 23.24 | 23.24 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | ansi_render_latency_ms | 1.17 | 1.17 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms p95 65 > 50 | reports/videos/claxedo-live-terminal-switch-1.webm |
