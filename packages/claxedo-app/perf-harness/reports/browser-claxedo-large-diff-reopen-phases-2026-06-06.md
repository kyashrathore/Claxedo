# Claxedo Performance Report

Generated: 2026-06-05T20:49:39.548Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | review_panel_open_ms | 7.10 | 7.10 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 489.72 | 489.72 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 58.72 | 58.72 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 19.50 | 19.50 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_ms | 649.60 | 649.60 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_click_ms | 3.50 | 3.50 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_state_ms | 411.70 | 411.70 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_frame_ms | 234.40 | 234.40 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 14.20 | 14.20 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 24.79 | 24.79 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms p95 489.71716600000036 > 36 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms p95 58.723792000000685 > 41 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms p95 24.78504199999952 > 7 | reports/videos/claxedo-large-diff-toggle-1.webm |
