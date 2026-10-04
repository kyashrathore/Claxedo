# Claxedo Performance Report

Generated: 2026-06-08T08:55:55.263Z
Target: 120hz (frame <= 8.33ms). Floor: 60hz (frame <= 16.67ms).
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| large-diff-toggle | 🔴 <60hz | 18.80 | 18.90 | 67 | 1234.45 | fail | reports/videos/claxedo-large-diff-toggle-1.webm |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| large-diff-toggle | p95 frame 18.80ms > 16.67ms — sustained below 60hz | reports/videos/claxedo-large-diff-toggle-1.webm |
| large-diff-toggle | 67 frames dropped below 60hz (allowance 2) | reports/videos/claxedo-large-diff-toggle-1.webm |
| large-diff-toggle | error boundary rendered for large-diff-toggle | reports/videos/claxedo-large-diff-toggle-1.webm |
| large-diff-toggle | session messages were not requested for large-diff-toggle | reports/videos/claxedo-large-diff-toggle-1.webm |
| large-diff-toggle | workspace panel shell did not visibly open | reports/videos/claxedo-large-diff-toggle-1.webm |
| large-diff-toggle | diff/review surface did not visibly open with changed files | reports/videos/claxedo-large-diff-toggle-1.webm |
| large-diff-toggle | workspace changes navigator did not visibly render | reports/videos/claxedo-large-diff-toggle-1.webm |
| large-diff-toggle | transcript text was not visible for large-diff-toggle: large-diff-toggle session 1 | reports/videos/claxedo-large-diff-toggle-1.webm |

## Debug sub-metrics

| Flow | Sub-metric | p50 | p95 | Unit |
| --- | --- | ---: | ---: | --- |
| large-diff-toggle | review_panel_open_ms | 5000 | 5000 | ms |
| large-diff-toggle | vcs_load_ms | 2012.30 | 2012.30 | ms |
| large-diff-toggle | hunk_render_ms | 5000 | 5000 | ms |
| large-diff-toggle | line_comment_ms | 5000 | 5000 | ms |
| large-diff-toggle | changed_file_navigation_ms | 5000 | 5000 | ms |
