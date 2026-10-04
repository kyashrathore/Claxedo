# Claxedo Performance Report

Generated: 2026-05-23T10:14:49.770Z

Adapters: browser
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 2
Failures: 0

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | agent-control-navigation | agent_action_dispatch_ms | 29.10 | 29.10 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_state_verify_ms | 0.52 | 0.52 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | surface_switch_latency_ms | 0.81 | 0.81 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | command_execution_overhead_ms | 0.46 | 0.46 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | event_backlog | 250 | 250 | events | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Upstream OpenCode app | agent-control-navigation | agent_action_dispatch_ms | 43.49 | 43.49 | ms | pass | reports/videos/upstream-agent-control-navigation-1.webm |
| browser | Upstream OpenCode app | agent-control-navigation | agent_state_verify_ms | 1.00 | 1.00 | ms | pass | reports/videos/upstream-agent-control-navigation-1.webm |
| browser | Upstream OpenCode app | agent-control-navigation | surface_switch_latency_ms | 0.87 | 0.87 | ms | pass | reports/videos/upstream-agent-control-navigation-1.webm |
| browser | Upstream OpenCode app | agent-control-navigation | command_execution_overhead_ms | 0.51 | 0.51 | ms | pass | reports/videos/upstream-agent-control-navigation-1.webm |
| browser | Upstream OpenCode app | agent-control-navigation | event_backlog | 250 | 250 | events | pass | reports/videos/upstream-agent-control-navigation-1.webm |

## Target Comparison

| Adapter | Scenario | Metric | Faster target | Claxedo p95 | Upstream p95 | Faster by |
| --- | --- | --- | --- | ---: | ---: | ---: |
| browser | agent-control-navigation | agent_action_dispatch_ms | Claxedo app | 29.10 | 43.49 | 33.08% |
| browser | agent-control-navigation | agent_state_verify_ms | Claxedo app | 0.52 | 1.00 | 47.71% |
| browser | agent-control-navigation | surface_switch_latency_ms | Claxedo app | 0.81 | 0.87 | 6.81% |
| browser | agent-control-navigation | command_execution_overhead_ms | Claxedo app | 0.46 | 0.51 | 9.22% |
| browser | agent-control-navigation | event_backlog | tie | 250 | 250 | 0% |
