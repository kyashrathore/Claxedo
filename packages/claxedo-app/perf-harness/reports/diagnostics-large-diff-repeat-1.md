# Claxedo Performance Report

Generated: 2026-07-24T00:36:47.659Z
Gate: profiler-enabled run must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of its fresh disabled control and under the stored worst-frame budget.
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| large-diff-toggle | 🟢 120hz | 1 | 405.40 | 2 | 550.72 | fail |  |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| large-diff-toggle | diagnostics moved worst frame from 333.60ms to 405.40ms |  |
| large-diff-toggle | worst frame 405.40ms regressed past budget 165ms |  |
