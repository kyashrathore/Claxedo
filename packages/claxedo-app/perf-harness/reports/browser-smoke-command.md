# Claxedo Performance Report

Generated: 2026-05-23T10:10:35.836Z

Adapters: browser
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 2
Failures: 2

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | command-palette-large-project | command_palette_index_ms | 1.88 | 1.88 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms | 289.68 | 289.68 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms | 277.06 | 277.06 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms | 257.17 | 257.17 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_palette_index_ms | 1.56 | 1.56 | ms | fail | reports/videos/upstream-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_palette_open_ms | 1280.55 | 1280.55 | ms | fail | reports/videos/upstream-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_palette_search_ms | 276.81 | 276.81 | ms | fail | reports/videos/upstream-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_execution_overhead_ms | 13.49 | 13.49 | ms | fail | reports/videos/upstream-command-palette-large-project-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms p95 289.67520799999875 > 8 | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms p95 277.06316700000025 > 43 | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms p95 257.16970799999945 > 7 | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_palette_open_ms p95 1280.5537909999985 > 7 | reports/videos/upstream-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_palette_search_ms p95 276.8067919999994 > 33 | reports/videos/upstream-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_execution_overhead_ms p95 13.492707999997947 > 6 | reports/videos/upstream-command-palette-large-project-1.webm |

## Target Comparison

| Adapter | Scenario | Metric | Faster target | Claxedo p95 | Upstream p95 | Faster by |
| --- | --- | --- | --- | ---: | ---: | ---: |
| browser | command-palette-large-project | command_palette_index_ms | Upstream OpenCode app | 1.88 | 1.56 | 16.96% |
| browser | command-palette-large-project | command_palette_open_ms | Claxedo app | 289.68 | 1280.55 | 77.38% |
| browser | command-palette-large-project | command_palette_search_ms | Upstream OpenCode app | 277.06 | 276.81 | 0.09% |
| browser | command-palette-large-project | command_execution_overhead_ms | Upstream OpenCode app | 257.17 | 13.49 | 94.75% |
