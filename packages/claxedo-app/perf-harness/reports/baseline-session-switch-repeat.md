# Claxedo Performance Report

Generated: 2026-08-07T11:39:27.620Z
Gate: two profiler-enabled and two disabled context-isolated runs execute in ABBA order across two benchmark browsers. Enabled evidence must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of control and must not cross a stored worst-frame budget that control satisfies.
Flows: 1  ·  pass: 0  ·  warn: 1  ·  fail: 0

| Flow | Enabled frame verdict | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Diagnostics status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| session-switch | 🔴 <60hz | 6.90 | 128.30 | 7 | 386.71 | warn |  |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| session-switch | disabled control already exceeds stored worst-frame budget 117ms (control 118.70ms; enabled 128.30ms) |  |
| session-switch | disabled control base-app gate: 7 frames dropped below 60hz (allowance 2) |  |
