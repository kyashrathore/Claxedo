# Claxedo Performance Report

Generated: 2026-06-06T09:17:34.834Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | review_panel_open_ms | 9 | 9.20 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 77.74 | 91.59 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 57.50 | 79.17 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 25.50 | 25.90 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_ms | 9.70 | 9.90 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_baseline_frame_ms | 8.60 | 8.70 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_click_ms | 0.40 | 0.40 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_state_ms | 0 | 0 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_frame_ms | 5.60 | 5.60 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 18.40 | 18.60 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 22.66 | 23.34 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms p95 91.59379199999967 > 36 | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms p95 79.16712499999994 > 41 | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms p95 23.337790999999925 > 7 | reports/videos/claxedo-large-diff-toggle-3.webm |
