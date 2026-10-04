# Claxedo Performance Report

Generated: 2026-06-06T09:28:10.618Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | review_panel_open_ms | 3.40 | 3.60 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 37.79 | 43.73 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 80.23 | 84.23 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 23.80 | 24 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_ms | 4.20 | 11.40 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_baseline_frame_ms | 7.20 | 8.90 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_click_ms | 0.40 | 0.40 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_state_ms | 0 | 0 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_frame_ms | 1.50 | 8.50 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 15.60 | 17.40 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 5000 | 5000 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms p95 43.733250000001135 > 36 | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms p95 84.23016699999971 > 41 | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms p95 5000 > 7 | reports/videos/claxedo-large-diff-toggle-3.webm |
