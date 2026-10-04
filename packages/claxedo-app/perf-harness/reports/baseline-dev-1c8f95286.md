# Claxedo Performance Report

Generated: 2026-08-07T11:18:48.614Z
Gate: two profiler-enabled and two disabled context-isolated runs execute in ABBA order across two benchmark browsers. Enabled evidence must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of control and must not cross a stored worst-frame budget that control satisfies.
Flows: 5  ·  pass: 0  ·  warn: 5  ·  fail: 0

| Flow | Enabled frame verdict | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Diagnostics status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| launch-project | 🔴 <60hz | 0.60 | 171.90 | 9 | 379.88 | warn |  |
| session-switch | 🔴 <60hz | 11 | 167.30 | 7 | 393.24 | warn |  |
| live-terminal-switch | 🔴 <60hz | 49.40 | 819.10 | 24 | 736.93 | warn |  |
| large-diff-toggle | 🔴 <60hz | 0.80 | 497.90 | 4 | 557.71 | warn |  |
| workspace-switch | 🔴 <60hz | 33.20 | 94 | 5 | 166.35 | warn |  |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| launch-project | disabled control already exceeds stored worst-frame budget 142ms (control 1619.10ms; enabled 171.90ms) |  |
| launch-project | disabled control base-app gate: 8 frames dropped below 60hz (allowance 2) |  |
| session-switch | paired delta unmeasurable (control fails base-app gate): diagnostics moved p95 frame from 7.20ms to 11ms |  |
| session-switch | disabled control already exceeds stored worst-frame budget 117ms (control 153.40ms; enabled 167.30ms) |  |
| session-switch | disabled control base-app gate: 8 frames dropped below 60hz (allowance 2) |  |
| live-terminal-switch | paired delta unmeasurable (control fails base-app gate): diagnostics moved p95 frame from 17.70ms to 49.40ms |  |
| live-terminal-switch | paired delta unmeasurable (control fails base-app gate): diagnostics moved worst frame from 207.70ms to 819.10ms |  |
| live-terminal-switch | disabled control already exceeds stored worst-frame budget 120ms (control 207.70ms; enabled 819.10ms) |  |
| live-terminal-switch | disabled control base-app gate: p95 frame 17.70ms > 16.67ms — sustained below 60hz |  |
| live-terminal-switch | disabled control base-app gate: 7 frames dropped below 60hz (allowance 2) |  |
| large-diff-toggle | disabled control already exceeds stored worst-frame budget 165ms (control 1039.10ms; enabled 497.90ms) |  |
| large-diff-toggle | disabled control base-app gate: 32 frames dropped below 60hz (allowance 2) |  |
| workspace-switch | disabled control base-app gate: p95 frame 33.60ms > 16.67ms — sustained below 60hz |  |
| workspace-switch | disabled control base-app gate: 5 frames dropped below 60hz (allowance 2) |  |
