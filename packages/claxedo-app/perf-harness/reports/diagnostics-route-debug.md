# Claxedo Performance Report

Generated: 2026-07-23T23:38:58.217Z
Target: 120hz (frame <= 8.33ms). Floor: 60hz (frame <= 16.67ms).
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| launch-project | 🔴 <60hz | 81.10 | 81.10 | 19 | 202.01 | fail |  |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| launch-project | session messages were not requested for launch-project |  |
| launch-project | transcript text was not visible for launch-project: launch-project session 1 |  |
| launch-project | disabled control: session messages were not requested for launch-project |  |
| launch-project | disabled control: transcript text was not visible for launch-project: launch-project session 1 |  |
| launch-project | p95 frame 81.10ms > 16.67ms — sustained below 60hz |  |
| launch-project | 19 frames dropped below 60hz (allowance 2) |  |
