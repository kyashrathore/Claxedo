# Claxedo Performance Report

Generated: 2026-06-08T08:58:41.748Z
Target: 120hz (frame <= 8.33ms). Floor: 60hz (frame <= 16.67ms).
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| session-switch | 🔴 <60hz | 0 | 0 | 0 | 0 | fail | reports/videos/claxedo-session-switch-1.webm |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| session-switch | browser scenario crashed: for: Timeout 10000ms exceeded.
Call log:
[2m  - waiting for getByText('session-switch session 2').first() to be visible[22m
; url=http://127.0.0.1:65206/s/ses_perf_session_switch_1; title=Claxedo; body=Something went wrong An error occurred while loading the application. Error Details Restart Please report this error to the OpenCode team on Discord Version: cloud | reports/videos/claxedo-session-switch-1.webm |
