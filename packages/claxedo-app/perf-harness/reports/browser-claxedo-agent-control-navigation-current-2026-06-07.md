# Claxedo Performance Report

Generated: 2026-06-06T19:13:03.156Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | agent-control-navigation | agent_action_dispatch_ms | 12.21 | 12.21 | ms | fail | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_state_verify_ms | 0.44 | 0.44 | ms | fail | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | surface_switch_latency_ms | 0.52 | 0.52 | ms | fail | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | command_execution_overhead_ms | 0.35 | 0.35 | ms | fail | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | event_backlog | 250 | 250 | events | fail | reports/videos/claxedo-agent-control-navigation-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | agent-control-navigation | transcript text was not visible for agent-control-navigation: agent-control-navigation session 1 | reports/videos/claxedo-agent-control-navigation-1.webm |
