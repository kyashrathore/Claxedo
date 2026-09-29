# Claxedo Performance Report

Generated: 2026-06-05T19:47:11.397Z

Adapters: browser
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 2
Failures: 2

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 671.74 | 671.74 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 49.62 | 49.62 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 118.30 | 118.30 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 40.50 | 40.50 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 124.71 | 124.71 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | vcs_load_ms | 23.84 | 23.84 | ms | fail | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | hunk_render_ms | 52.07 | 52.07 | ms | fail | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | diff_toggle_latency_ms | 2022.57 | 2022.57 | ms | fail | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | line_comment_latency_ms | 14.50 | 14.50 | ms | fail | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | changed_file_navigation_ms | 18.45 | 18.45 | ms | fail | reports/videos/upstream-large-diff-toggle-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms p95 671.7364170000001 > 36 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms p95 49.62420799999927 > 41 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms p95 118.30379100000027 > 37 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms p95 40.5 > 33 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms p95 124.70650000000023 > 7 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | vcs_load_ms p95 23.83787499999744 > 9 | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | hunk_render_ms p95 52.06620800000019 > 48 | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | diff_toggle_latency_ms p95 2022.56725 > 8 | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | transcript text was not visible for large-diff-toggle: large-diff-toggle session 1 | reports/videos/upstream-large-diff-toggle-1.webm |

## Target Comparison

| Adapter | Scenario | Metric | Faster target | Claxedo p95 | Upstream p95 | Faster by |
| --- | --- | --- | --- | ---: | ---: | ---: |
| browser | large-diff-toggle | vcs_load_ms | Upstream OpenCode app | 671.74 | 23.84 | 96.45% |
| browser | large-diff-toggle | hunk_render_ms | Claxedo app | 49.62 | 52.07 | 4.69% |
| browser | large-diff-toggle | diff_toggle_latency_ms | Claxedo app | 118.30 | 2022.57 | 94.15% |
| browser | large-diff-toggle | line_comment_latency_ms | Upstream OpenCode app | 40.50 | 14.50 | 64.20% |
| browser | large-diff-toggle | changed_file_navigation_ms | Upstream OpenCode app | 124.71 | 18.45 | 85.21% |
