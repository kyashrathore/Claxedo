# Claxedo Performance Report

Generated: 2026-07-23T22:28:00.645Z
Target: 120hz (frame <= 8.33ms). Floor: 60hz (frame <= 16.67ms).
Flows: 5  ·  pass: 0  ·  warn: 0  ·  fail: 5

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| launch-project | 🔴 <60hz | 75 | 95 | 20 | 3617.24 | fail | reports/videos/claxedo-launch-project-1.webm |
| session-switch | 🟢 120hz | 0 | 0 | 0 | 4625.95 | fail | reports/videos/claxedo-session-switch-1.webm |
| live-terminal-switch | 🟢 120hz | 0.20 | 93.30 | 1 | 20020.29 | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| large-diff-toggle | 🟢 120hz | 0.20 | 98.20 | 2 | 536.80 | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| workspace-switch | 🟢 120hz | 0 | 0 | 0 | 746.63 | fail | reports/videos/claxedo-workspace-switch-1.webm |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| launch-project | session messages were not requested for launch-project | reports/videos/claxedo-launch-project-1.webm |
| launch-project | only 0 of 20 seeded sessions were visible in the session inventory | reports/videos/claxedo-launch-project-1.webm |
| launch-project | transcript text was not visible for launch-project: launch-project session 1 | reports/videos/claxedo-launch-project-1.webm |
| launch-project | p95 frame 75ms > 16.67ms — sustained below 60hz | reports/videos/claxedo-launch-project-1.webm |
| launch-project | 20 frames dropped below 60hz (allowance 2) | reports/videos/claxedo-launch-project-1.webm |
| session-switch | only 1 of 2 seeded sessions were visible in the session inventory | reports/videos/claxedo-session-switch-1.webm |
| live-terminal-switch | terminal surface did not visibly open | reports/videos/claxedo-live-terminal-switch-1.webm |
| live-terminal-switch | terminal switch did not settle before timeout | reports/videos/claxedo-live-terminal-switch-1.webm |
| large-diff-toggle | diff/review surface did not visibly open with changed files | reports/videos/claxedo-large-diff-toggle-1.webm |
| workspace-switch | workspace was not visible in the sidebar: main | reports/videos/claxedo-workspace-switch-1.webm |
| workspace-switch | workspace was not visible in the sidebar: workspace 2 | reports/videos/claxedo-workspace-switch-1.webm |
| workspace-switch | workspace was not visible in the sidebar: workspace 3 | reports/videos/claxedo-workspace-switch-1.webm |
| workspace-switch | workspace was not visible in the sidebar: workspace 4 | reports/videos/claxedo-workspace-switch-1.webm |
| workspace-switch | workspace was not visible in the sidebar: workspace 5 | reports/videos/claxedo-workspace-switch-1.webm |
| workspace-switch | workspace was not clickable in the visible UI: workspace 2 | reports/videos/claxedo-workspace-switch-1.webm |
