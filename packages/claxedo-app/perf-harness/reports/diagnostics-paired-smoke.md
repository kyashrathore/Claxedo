# Claxedo Performance Report

Generated: 2026-07-23T23:27:50.512Z
Target: 120hz (frame <= 8.33ms). Floor: 60hz (frame <= 16.67ms).
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| launch-project | 🔴 <60hz | 93.60 | 93.60 | 19 | 621.24 | fail | reports/videos/claxedo-launch-project-2.webm |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| launch-project | session messages were not requested for launch-project | reports/videos/claxedo-launch-project-2.webm |
| launch-project | only 0 of 20 seeded sessions were visible in the session inventory | reports/videos/claxedo-launch-project-2.webm |
| launch-project | transcript text was not visible for launch-project: launch-project session 1 | reports/videos/claxedo-launch-project-2.webm |
| launch-project | disabled control: session messages were not requested for launch-project | reports/videos/claxedo-launch-project-2.webm |
| launch-project | disabled control: only 0 of 20 seeded sessions were visible in the session inventory | reports/videos/claxedo-launch-project-2.webm |
| launch-project | disabled control: transcript text was not visible for launch-project: launch-project session 1 | reports/videos/claxedo-launch-project-2.webm |
| launch-project | disabled control: worst frame 356.80ms regressed past budget 142ms | reports/videos/claxedo-launch-project-2.webm |
| launch-project | p95 frame 93.60ms > 16.67ms — sustained below 60hz | reports/videos/claxedo-launch-project-2.webm |
| launch-project | 19 frames dropped below 60hz (allowance 2) | reports/videos/claxedo-launch-project-2.webm |
