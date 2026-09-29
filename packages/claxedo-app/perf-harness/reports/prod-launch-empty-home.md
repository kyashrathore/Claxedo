# Claxedo Performance Report

Generated: 2026-06-08T08:57:14.373Z
Target: 120hz (frame <= 8.33ms). Floor: 60hz (frame <= 16.67ms).
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| launch-empty-home | 🟢 120hz | 0.10 | 85.90 | 2 | 227.60 | fail | reports/videos/claxedo-launch-empty-home-1.webm |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| launch-empty-home | blank page rendered for launch-empty-home | reports/videos/claxedo-launch-empty-home-1.webm |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| launch-empty-home | launch_first_window_ms | 203.39 | 203.39 | ms |
| launch-empty-home | launch_first_useful_screen_ms | 224.71 | 224.71 | ms |
| launch-empty-home | launch_workspace_ready_ms | 227.60 | 227.60 | ms |
