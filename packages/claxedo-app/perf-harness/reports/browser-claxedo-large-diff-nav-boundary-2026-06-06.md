# Claxedo Performance Report

Generated: 2026-06-06T09:25:22.795Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | review_panel_open_ms | 3.10 | 4.90 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 27.59 | 40.81 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 61.47 | 70.68 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 22.10 | 24.30 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_ms | 11.40 | 30 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_baseline_frame_ms | 9.30 | 20.80 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_click_ms | 0.40 | 0.40 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_state_ms | 0 | 0 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_frame_ms | 8.70 | 27.60 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 16.80 | 21.10 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 5000 | 5000 | ms | fail | reports/videos/claxedo-large-diff-toggle-3.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms p95 40.81395800000064 > 36 | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms p95 70.68237500000032 > 41 | reports/videos/claxedo-large-diff-toggle-3.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms p95 5000 > 7 | reports/videos/claxedo-large-diff-toggle-3.webm |
