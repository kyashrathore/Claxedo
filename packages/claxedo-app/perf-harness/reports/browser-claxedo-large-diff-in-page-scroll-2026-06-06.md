# Claxedo Performance Report

Generated: 2026-06-06T09:32:21.429Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | review_panel_open_ms | 4.40 | 4.50 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 38.13 | 54.76 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 1006 | 1009.50 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 26.20 | 27.70 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_ms | 9.20 | 10.60 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_baseline_frame_ms | 1.30 | 7.60 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_click_ms | 0.40 | 0.40 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_state_ms | 0 | 0 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_frame_ms | 7.10 | 8.80 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 16 | 16.60 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 3.60 | 3.80 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms p95 54.76008400000137 > 36 | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms p95 1009.5 > 41 | reports/videos/claxedo-large-diff-toggle-3.webm |
