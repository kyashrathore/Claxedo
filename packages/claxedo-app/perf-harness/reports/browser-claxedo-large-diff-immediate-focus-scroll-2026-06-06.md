# Claxedo Performance Report

Generated: 2026-06-05T18:53:22.499Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 723.02 | 723.02 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 50.80 | 50.80 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 56.80 | 56.80 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 83.40 | 83.40 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 39.80 | 39.80 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms p95 723.0195829999993 > 36 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms p95 50.80400000000009 > 41 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms p95 56.80449999999837 > 37 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms p95 83.39999997615814 > 33 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms p95 39.80241700000079 > 7 | reports/videos/claxedo-large-diff-toggle-1.webm |
