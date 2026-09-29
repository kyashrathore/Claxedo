# Claxedo Performance Report

Generated: 2026-05-23T10:06:19.108Z

Adapters: browser
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 2
Failures: 2

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 1057.01 | 1057.01 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 937.56 | 937.56 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 727.72 | 727.72 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 392.14 | 392.14 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 281.92 | 281.92 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | vcs_load_ms | 367.32 | 367.32 | ms | fail | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | hunk_render_ms | 66.28 | 66.28 | ms | fail | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | diff_toggle_latency_ms | 276.96 | 276.96 | ms | fail | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | line_comment_latency_ms | 791.78 | 791.78 | ms | fail | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | changed_file_navigation_ms | 291.19 | 291.19 | ms | fail | reports/videos/upstream-large-diff-toggle-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms p95 1057.0116669999989 > 36 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms p95 937.5577079999985 > 41 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms p95 727.7215419999993 > 37 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms p95 392.13929199999984 > 33 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms p95 281.9229579999992 > 7 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | vcs_load_ms p95 367.32395800000086 > 9 | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | hunk_render_ms p95 66.28399999999965 > 48 | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | diff_toggle_latency_ms p95 276.95887500000026 > 8 | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | line_comment_latency_ms p95 791.7815420000006 > 56 | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | changed_file_navigation_ms p95 291.1937079999989 > 70 | reports/videos/upstream-large-diff-toggle-1.webm |

## Target Comparison

| Adapter | Scenario | Metric | Faster target | Claxedo p95 | Upstream p95 | Faster by |
| --- | --- | --- | --- | ---: | ---: | ---: |
| browser | large-diff-toggle | vcs_load_ms | Upstream OpenCode app | 1057.01 | 367.32 | 65.25% |
| browser | large-diff-toggle | hunk_render_ms | Upstream OpenCode app | 937.56 | 66.28 | 92.93% |
| browser | large-diff-toggle | diff_toggle_latency_ms | Upstream OpenCode app | 727.72 | 276.96 | 61.94% |
| browser | large-diff-toggle | line_comment_latency_ms | Claxedo app | 392.14 | 791.78 | 50.47% |
| browser | large-diff-toggle | changed_file_navigation_ms | Claxedo app | 281.92 | 291.19 | 3.18% |
