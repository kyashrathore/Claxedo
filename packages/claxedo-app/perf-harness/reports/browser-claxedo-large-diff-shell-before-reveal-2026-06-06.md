# Claxedo Performance Report

Generated: 2026-06-05T20:51:25.936Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | review_panel_open_ms | 6.50 | 6.50 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 515.37 | 515.37 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 64.21 | 64.21 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 24.50 | 24.50 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_ms | 533.20 | 533.20 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_click_ms | 3 | 3 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_state_ms | 0 | 0 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_frame_ms | 529.50 | 529.50 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 14.90 | 14.90 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 45.59 | 45.59 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms p95 515.3719999999994 > 36 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms p95 64.21025000000009 > 41 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_frame_ms p95 529.5 > 411 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms p95 45.585916 > 7 | reports/videos/claxedo-large-diff-toggle-1.webm |
