# Claxedo Performance Report

Generated: 2026-06-06T22:15:38.705Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | command-palette-large-project | command_palette_index_ms | 9.05 | 9.05 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms | 19.20 | 19.20 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms | 14.20 | 14.20 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms | 135.40 | 135.40 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms p95 135.39999997615814 > 130 | reports/videos/claxedo-command-palette-large-project-1.webm |
