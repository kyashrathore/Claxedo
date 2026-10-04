# Claxedo Performance Report

Generated: 2026-06-07T11:54:51.035Z

Adapters: deterministic
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 2
Failures: 0

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| deterministic | Claxedo app | launch-empty-home | launch_first_window_ms | 449.08 | 462.17 | ms | pass |  |
| deterministic | Claxedo app | launch-empty-home | launch_first_useful_screen_ms | 652.24 | 671.25 | ms | pass |  |
| deterministic | Claxedo app | launch-empty-home | launch_workspace_ready_ms | 759.16 | 781.29 | ms | pass |  |
| deterministic | Claxedo app | launch-empty-home | launch_first_input_ms | 812.62 | 836.32 | ms | pass |  |
| deterministic | Claxedo app | launch-empty-home | memory_rss_mb | 245.92 | 253.10 | MB | pass |  |
| deterministic | Upstream OpenCode app | launch-empty-home | launch_first_window_ms | 395.19 | 406.71 | ms | pass |  |
| deterministic | Upstream OpenCode app | launch-empty-home | launch_first_useful_screen_ms | 573.97 | 590.70 | ms | pass |  |
| deterministic | Upstream OpenCode app | launch-empty-home | launch_workspace_ready_ms | 668.06 | 687.54 | ms | pass |  |
| deterministic | Upstream OpenCode app | launch-empty-home | launch_first_input_ms | 715.11 | 735.96 | ms | pass |  |
| deterministic | Upstream OpenCode app | launch-empty-home | memory_rss_mb | 201.66 | 207.54 | MB | pass |  |

## Target Comparison

| Adapter | Scenario | Metric | Faster target | Claxedo p95 | Upstream p95 | Faster by |
| --- | --- | --- | --- | ---: | ---: | ---: |
| deterministic | launch-empty-home | launch_first_window_ms | Upstream OpenCode app | 462.17 | 406.71 | 12.00% |
| deterministic | launch-empty-home | launch_first_useful_screen_ms | Upstream OpenCode app | 671.25 | 590.70 | 12.00% |
| deterministic | launch-empty-home | launch_workspace_ready_ms | Upstream OpenCode app | 781.29 | 687.54 | 12.00% |
| deterministic | launch-empty-home | launch_first_input_ms | Upstream OpenCode app | 836.32 | 735.96 | 12% |
| deterministic | launch-empty-home | memory_rss_mb | Upstream OpenCode app | 253.10 | 207.54 | 18.00% |
