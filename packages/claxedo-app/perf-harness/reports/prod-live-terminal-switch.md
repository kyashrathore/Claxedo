# Claxedo Performance Report

Generated: 2026-06-08T08:59:55.689Z
Target: 120hz (frame <= 8.33ms). Floor: 60hz (frame <= 16.67ms).
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| live-terminal-switch | 🔴 <60hz | 17.80 | 85.60 | 1144 | 20039.42 | fail | reports/videos/claxedo-live-terminal-switch-1.webm |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| live-terminal-switch | p95 frame 17.80ms > 16.67ms — sustained below 60hz | reports/videos/claxedo-live-terminal-switch-1.webm |
| live-terminal-switch | 1144 frames dropped below 60hz (allowance 2) | reports/videos/claxedo-live-terminal-switch-1.webm |
| live-terminal-switch | error boundary rendered for live-terminal-switch | reports/videos/claxedo-live-terminal-switch-1.webm |
| live-terminal-switch | session messages were not requested for live-terminal-switch | reports/videos/claxedo-live-terminal-switch-1.webm |
| live-terminal-switch | terminal surface did not visibly open | reports/videos/claxedo-live-terminal-switch-1.webm |
| live-terminal-switch | terminal switch did not settle before timeout | reports/videos/claxedo-live-terminal-switch-1.webm |
| live-terminal-switch | transcript text was not visible for live-terminal-switch: live-terminal-switch session 1 | reports/videos/claxedo-live-terminal-switch-1.webm |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| live-terminal-switch | terminal_switch_ms | 5000 | 5000 | ms |
| live-terminal-switch | terminal_resize_ms | 1015.90 | 1015.90 | ms |
