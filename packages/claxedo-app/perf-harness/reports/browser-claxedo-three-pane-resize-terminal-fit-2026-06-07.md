# Claxedo Performance Report

Generated: 2026-06-06T19:17:43.002Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | three-pane-resize | frame_time_ms | 9.20 | 9.20 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | dropped_frames | 0 | 0 | frames | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | scroll_latency_ms | 28.06 | 28.06 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms | 136.70 | 136.70 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | diff_toggle_latency_ms | 3.48 | 3.48 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | three-pane-resize | frame_time_ms p95 9.199999999998909 > 9 | reports/videos/claxedo-three-pane-resize-1.webm |
