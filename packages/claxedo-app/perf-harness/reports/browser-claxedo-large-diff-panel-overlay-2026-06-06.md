# Claxedo Performance Report

Generated: 2026-06-05T20:19:52.878Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | review_panel_open_ms | 555.35 | 555.35 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 22.37 | 22.37 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 42.05 | 42.05 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 23.80 | 23.80 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_ms | 537.10 | 537.10 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 14.40 | 14.40 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 25.51 | 25.51 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | review_panel_open_ms p95 555.3489169999993 > 205 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms p95 42.05095799999981 > 41 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms p95 25.511249999999563 > 7 | reports/videos/claxedo-large-diff-toggle-1.webm |
