# Claxedo Performance Report

Generated: 2026-07-24T00:33:00.320Z
Gate: profiler-enabled run must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of its fresh disabled control and under the stored worst-frame budget.
Flows: 5  ·  pass: 1  ·  warn: 0  ·  fail: 4

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| launch-project | 🟢 120hz | 0.20 | 52.80 | 1 | 244.40 | fail |  |
| session-switch | 🔴 <60hz | 0 | 0 | 0 | 0 | fail |  |
| live-terminal-switch | 🔴 <60hz | 18.80 | 18.80 | 9 | 182.94 | pass |  |
| large-diff-toggle | 🟢 120hz | 0.20 | 84.40 | 2 | 540.61 | fail |  |
| workspace-switch | 🔴 <60hz | 0 | 0 | 0 | 0 | fail |  |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| launch-project | diagnostics moved worst frame from 10.40ms to 52.80ms |  |
| session-switch | browser scenario crashed: Timed out closing browser for session-switch |  |
| large-diff-toggle | diff/review surface did not visibly open with changed files |  |
| large-diff-toggle | disabled control: diff/review surface did not visibly open with changed files |  |
| workspace-switch | browser scenario crashed: Timed out closing browser for workspace-switch |  |
