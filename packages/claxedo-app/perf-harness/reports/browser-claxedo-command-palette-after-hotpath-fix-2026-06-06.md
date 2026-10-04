# Claxedo Performance Report

Generated: 2026-06-06T18:28:02.448Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | command-palette-large-project | command_palette_index_ms | 2.43 | 2.43 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms | 5037.41 | 5037.41 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms | 5025.70 | 5025.70 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms | 17.13 | 17.13 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms p95 5037.406708999999 > 8 | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms p95 5025.6963749999995 > 43 | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms p95 17.131375000000844 > 7 | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | error boundary rendered for command-palette-large-project | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | session messages were not requested for command-palette-large-project | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command palette search input did not visibly open | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command palette did not visibly show search results for: theme | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | transcript text was not visible for command-palette-large-project: command-palette-large-project session 1 | reports/videos/claxedo-command-palette-large-project-1.webm |
