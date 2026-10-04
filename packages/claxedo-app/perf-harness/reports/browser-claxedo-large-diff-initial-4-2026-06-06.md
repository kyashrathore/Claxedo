# Claxedo Performance Report

Generated: 2026-06-06T09:19:26.182Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | review_panel_open_ms | 5 | 5.20 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 53.55 | 70.33 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 58.13 | 81.90 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 23.90 | 24.20 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_ms | 11.50 | 12.60 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_baseline_frame_ms | 7.30 | 8.60 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_click_ms | 0.30 | 0.40 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_state_ms | 0 | 0 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_frame_ms | 8.20 | 8.40 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 14.50 | 17.50 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 23.33 | 24.86 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms p95 70.33066600000166 > 36 | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms p95 81.89604099999997 > 41 | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms p95 24.85516699999971 > 7 | reports/videos/claxedo-large-diff-toggle-3.webm |
