# Claxedo Performance Report

Generated: 2026-07-24T00:22:01.376Z
Gate: profiler-enabled run must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of its fresh disabled control and under the stored worst-frame budget.
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| live-terminal-switch | 🟢 120hz | 0.20 | 4.10 | 0 | 20022.68 | fail |  |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| live-terminal-switch | only 0 of 1 seeded sessions were visible in the session inventory |  |
| live-terminal-switch | terminal surface did not visibly open |  |
| live-terminal-switch | terminal switch did not settle before timeout |  |
| live-terminal-switch | disabled control: only 0 of 1 seeded sessions were visible in the session inventory |  |
| live-terminal-switch | disabled control: terminal surface did not visibly open |  |
| live-terminal-switch | disabled control: terminal switch did not settle before timeout |  |
