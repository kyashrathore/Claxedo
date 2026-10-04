# Claxedo Performance Report

Generated: 2026-07-24T00:46:54.403Z
Gate: profiler-enabled run must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of its fresh disabled control and under the stored worst-frame budget.
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| large-diff-toggle | 🟢 120hz | 0.70 | 396.20 | 2 | 560.40 | fail |  |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| large-diff-toggle | diagnostics moved worst frame from 336ms to 396.20ms |  |
| large-diff-toggle | worst frame 396.20ms regressed past budget 165ms |  |
