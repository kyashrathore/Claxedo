# Claxedo Performance Report

Generated: 2026-06-08T08:57:54.157Z
Target: 120hz (frame <= 8.33ms). Floor: 60hz (frame <= 16.67ms).
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| launch-project | 🔴 <60hz | 83.70 | 83.70 | 18 | 227.66 | fail | reports/videos/claxedo-launch-project-1.webm |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| launch-project | error boundary rendered for launch-project | reports/videos/claxedo-launch-project-1.webm |
| launch-project | session messages were not requested for launch-project | reports/videos/claxedo-launch-project-1.webm |
| launch-project | only 0 of 20 seeded sessions were visible in the session inventory | reports/videos/claxedo-launch-project-1.webm |
| launch-project | transcript text was not visible for launch-project: launch-project session 1 | reports/videos/claxedo-launch-project-1.webm |
| launch-project | p95 frame 83.70ms > 16.67ms — sustained below 60hz | reports/videos/claxedo-launch-project-1.webm |
| launch-project | 18 frames dropped below 60hz (allowance 2) | reports/videos/claxedo-launch-project-1.webm |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| launch-project | launch_first_window_ms | 203.69 | 203.69 | ms |
| launch-project | launch_workspace_ready_ms | 227.66 | 227.66 | ms |
| launch-project | transcript_render_ms | 10000 | 10000 | ms |
