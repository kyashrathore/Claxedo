# Claxedo Performance Report

Generated: 2026-06-08T08:57:04.215Z
Target: 120hz (frame <= 8.33ms). Floor: 60hz (frame <= 16.67ms).
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| three-pane-resize | 🔴 <60hz | 50.40 | 50.40 | 2 | 36.31 | fail | reports/videos/claxedo-three-pane-resize-1.webm |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| three-pane-resize | p95 frame 50.40ms > 16.67ms — sustained below 60hz | reports/videos/claxedo-three-pane-resize-1.webm |
| three-pane-resize | error boundary rendered for three-pane-resize | reports/videos/claxedo-three-pane-resize-1.webm |
| three-pane-resize | session messages were not requested for three-pane-resize | reports/videos/claxedo-three-pane-resize-1.webm |
| three-pane-resize | terminal surface did not visibly open | reports/videos/claxedo-three-pane-resize-1.webm |
| three-pane-resize | workspace panel shell did not visibly open | reports/videos/claxedo-three-pane-resize-1.webm |
| three-pane-resize | diff/review surface did not visibly open | reports/videos/claxedo-three-pane-resize-1.webm |
| three-pane-resize | diff/review surface did not visibly open with changed files | reports/videos/claxedo-three-pane-resize-1.webm |
| three-pane-resize | no pane divider was visible to resize | reports/videos/claxedo-three-pane-resize-1.webm |
| three-pane-resize | transcript text was not visible for three-pane-resize: three-pane-resize session 1 | reports/videos/claxedo-three-pane-resize-1.webm |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| three-pane-resize | divider_drag_ms | 0 | 0 | ms |
| three-pane-resize | divider_moved_px | 0 | 0 | px |
