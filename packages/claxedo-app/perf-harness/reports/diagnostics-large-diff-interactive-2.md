# Claxedo Performance Report

Generated: 2026-07-24T00:47:02.859Z
Gate: profiler-enabled run must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of its fresh disabled control and under the stored worst-frame budget.
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| large-diff-toggle | 🟢 120hz | 0.80 | 399.30 | 2 | 551.09 | fail |  |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| large-diff-toggle | diagnostics moved worst frame from 334.90ms to 399.30ms |  |
| large-diff-toggle | worst frame 399.30ms regressed past budget 165ms |  |
