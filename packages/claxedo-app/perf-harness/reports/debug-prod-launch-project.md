# Claxedo Performance Report

Generated: 2026-06-08T09:03:05.513Z
Target: 120hz (frame <= 8.33ms). Floor: 60hz (frame <= 16.67ms).
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| launch-project | 🔴 <60hz | 116.30 | 116.30 | 18 | 279.60 | fail | reports/videos/claxedo-launch-project-1.webm |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| launch-project | error boundary rendered for launch-project | reports/videos/claxedo-launch-project-1.webm |
| launch-project | session messages were not requested for launch-project | reports/videos/claxedo-launch-project-1.webm |
| launch-project | only 0 of 20 seeded sessions were visible in the session inventory | reports/videos/claxedo-launch-project-1.webm |
| launch-project | transcript text was not visible for launch-project: launch-project session 1 | reports/videos/claxedo-launch-project-1.webm |
| launch-project | p95 frame 116.30ms > 16.67ms — sustained below 60hz | reports/videos/claxedo-launch-project-1.webm |
| launch-project | 18 frames dropped below 60hz (allowance 2) | reports/videos/claxedo-launch-project-1.webm |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| launch-project | launch_first_window_ms | 240.10 | 240.10 | ms |
| launch-project | launch_workspace_ready_ms | 279.60 | 279.60 | ms |
| launch-project | transcript_render_ms | 10000 | 10000 | ms |
