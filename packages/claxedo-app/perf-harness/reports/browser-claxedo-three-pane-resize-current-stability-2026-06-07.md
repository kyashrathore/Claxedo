# Claxedo Performance Report

Generated: 2026-06-07T10:00:09.085Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | three-pane-resize | frame_time_ms | 8.40 | 10.40 | ms | fail | reports/videos/claxedo-three-pane-resize-3.webm |
| browser | Claxedo app | three-pane-resize | dropped_frames | 0 | 0 | frames | fail | reports/videos/claxedo-three-pane-resize-3.webm |
| browser | Claxedo app | three-pane-resize | scroll_latency_ms | 25.01 | 26.25 | ms | fail | reports/videos/claxedo-three-pane-resize-3.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms | 128.20 | 129.10 | ms | fail | reports/videos/claxedo-three-pane-resize-3.webm |
| browser | Claxedo app | three-pane-resize | diff_toggle_latency_ms | 3.56 | 3.67 | ms | fail | reports/videos/claxedo-three-pane-resize-3.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | three-pane-resize | frame_time_ms p95 10.400000000000546 > 10 | reports/videos/claxedo-three-pane-resize-3.webm |
