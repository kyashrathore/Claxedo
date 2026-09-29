# Claxedo Performance Report

Generated: 2026-06-07T09:54:44.329Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | command-palette-large-project | command_palette_index_ms | 21.38 | 22.18 | ms | fail | reports/videos/claxedo-command-palette-large-project-3.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms | 16.10 | 47.10 | ms | fail | reports/videos/claxedo-command-palette-large-project-3.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms | 43.30 | 78.70 | ms | fail | reports/videos/claxedo-command-palette-large-project-3.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms | 111.20 | 127.70 | ms | fail | reports/videos/claxedo-command-palette-large-project-3.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms p95 47.09999999962747 > 32 | reports/videos/claxedo-command-palette-large-project-3.webm |
