# Claxedo Performance Report

Generated: 2026-06-08T09:09:00.438Z
Target: 120hz (frame <= 8.33ms). Floor: 60hz (frame <= 16.67ms).
Flows: 1  ·  pass: 0  ·  warn: 1  ·  fail: 0

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| launch-project | 🔴 <60hz | 90 | 109.20 | 18 | 260.47 | warn | reports/videos/claxedo-launch-project-1.webm |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| launch-project | p95 frame 90ms > 16.67ms — sustained below 60hz | reports/videos/claxedo-launch-project-1.webm |
| launch-project | 18 frames dropped below 60hz (allowance 2) | reports/videos/claxedo-launch-project-1.webm |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| launch-project | launch_first_window_ms | 236.59 | 236.59 | ms |
| launch-project | launch_workspace_ready_ms | 260.47 | 260.47 | ms |
| launch-project | transcript_render_ms | 73 | 73 | ms |
