# Claxedo Performance Report

Generated: 2026-06-06T19:14:15.143Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | three-pane-resize | frame_time_ms | 9.10 | 9.10 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | dropped_frames | 0 | 0 | frames | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | scroll_latency_ms | 25.13 | 25.13 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms | 137.20 | 137.20 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | diff_toggle_latency_ms | 3.92 | 3.92 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | three-pane-resize | frame_time_ms p95 9.099999999998545 > 9 | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms p95 137.19999998807907 > 45 | reports/videos/claxedo-three-pane-resize-1.webm |
