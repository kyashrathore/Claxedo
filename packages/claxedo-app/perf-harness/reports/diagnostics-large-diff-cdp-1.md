# Claxedo Performance Report

Generated: 2026-07-24T00:44:13.403Z
Target: 120hz (frame <= 8.33ms). Floor: 60hz (frame <= 16.67ms).
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| large-diff-toggle | 🔴 <60hz | 0 | 0 | 0 | 0 | fail |  |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| large-diff-toggle | browser scenario crashed: Diagnostics flow profiler evidence was incomplete |  |
