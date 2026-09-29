# Claxedo Performance Report

Generated: 2026-06-05T19:37:03.943Z

Adapters: browser
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 2
Failures: 2

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms | 34 | 34 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | pty_attach_ms | 1.64 | 1.64 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms | 39 | 39 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_reconnect_latency_ms | 31.82 | 31.82 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | ansi_render_latency_ms | 0.93 | 0.93 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms p95 34 > 32 | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | browser scenario crashed: forFunction: Timeout 30000ms exceeded. |  |
