# Claxedo Performance Report

Generated: 2026-06-06T18:32:25.162Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | command-palette-large-project | command_palette_index_ms | 5.00 | 5.00 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms | 45.64 | 45.64 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms | 70.61 | 70.61 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms | 32.33 | 32.33 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms p95 45.64245799999844 > 8 | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms p95 70.61183300000266 > 43 | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms p95 32.32758400000239 > 7 | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | transcript text was not visible for command-palette-large-project: command-palette-large-project session 1 | reports/videos/claxedo-command-palette-large-project-1.webm |
