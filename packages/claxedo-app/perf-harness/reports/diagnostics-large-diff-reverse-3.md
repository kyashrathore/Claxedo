# Claxedo Performance Report

Generated: 2026-07-24T00:48:06.142Z
Gate: profiler-enabled run must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of its fresh disabled control and under the stored worst-frame budget.
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| large-diff-toggle | 🔴 <60hz | 1 | 343.30 | 3 | 557.47 | fail |  |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| large-diff-toggle | worst frame 343.30ms regressed past budget 165ms |  |
