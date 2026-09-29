# Claxedo Performance Report

Generated: 2026-05-23T10:14:18.934Z

Adapters: browser
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 2
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | three-pane-resize | frame_time_ms | 37.94 | 37.94 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | dropped_frames | 0 | 0 | frames | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | scroll_latency_ms | 25.04 | 25.04 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms | 51.49 | 51.49 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | diff_toggle_latency_ms | 0.84 | 0.84 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Upstream OpenCode app | three-pane-resize | frame_time_ms | 6.93 | 6.93 | ms | pass | reports/videos/upstream-three-pane-resize-1.webm |
| browser | Upstream OpenCode app | three-pane-resize | dropped_frames | 0 | 0 | frames | pass | reports/videos/upstream-three-pane-resize-1.webm |
| browser | Upstream OpenCode app | three-pane-resize | scroll_latency_ms | 33.20 | 33.20 | ms | pass | reports/videos/upstream-three-pane-resize-1.webm |
| browser | Upstream OpenCode app | three-pane-resize | terminal_resize_latency_ms | 24.05 | 24.05 | ms | pass | reports/videos/upstream-three-pane-resize-1.webm |
| browser | Upstream OpenCode app | three-pane-resize | diff_toggle_latency_ms | 4.91 | 4.91 | ms | pass | reports/videos/upstream-three-pane-resize-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | three-pane-resize | frame_time_ms p95 37.94258300000001 > 9 | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms p95 51.48754199999894 > 45 | reports/videos/claxedo-three-pane-resize-1.webm |

## Target Comparison

| Adapter | Scenario | Metric | Faster target | Claxedo p95 | Upstream p95 | Faster by |
| --- | --- | --- | --- | ---: | ---: | ---: |
| browser | three-pane-resize | frame_time_ms | Upstream OpenCode app | 37.94 | 6.93 | 81.75% |
| browser | three-pane-resize | dropped_frames | tie | 0 | 0 | 0% |
| browser | three-pane-resize | scroll_latency_ms | Claxedo app | 25.04 | 33.20 | 24.57% |
| browser | three-pane-resize | terminal_resize_latency_ms | Upstream OpenCode app | 51.49 | 24.05 | 53.28% |
| browser | three-pane-resize | diff_toggle_latency_ms | Claxedo app | 0.84 | 4.91 | 82.85% |
