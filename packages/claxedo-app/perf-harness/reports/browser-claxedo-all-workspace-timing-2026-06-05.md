# Claxedo Performance Report

Generated: 2026-06-05T17:32:12.115Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 13
Failures: 5

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_window_ms | 4448.72 | 4448.72 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_useful_screen_ms | 4548.10 | 4548.10 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_workspace_ready_ms | 9549.56 | 9549.56 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_input_ms | 1.53 | 1.53 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | memory_rss_mb | 68.86 | 68.86 | MB | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_first_window_ms | 392.77 | 392.77 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_workspace_ready_ms | 5453.81 | 5453.81 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms | 139.64 | 139.64 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | memory_rss_mb | 87.45 | 87.45 | MB | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms | 139.34 | 139.34 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | transcript_render_ms | 3.88 | 3.88 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | scroll_latency_ms | 19.05 | 19.05 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | incremental_append_latency_ms | 0.76 | 0.76 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | tool_block_toggle_latency_ms | 2.03 | 2.03 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | memory_growth_mb | 7.00 | 7.00 | MB | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_pending_requests | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_drain_ms | 13 | 13 | ms | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_inflight_after | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_queued_after | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_total_drain_ms | 14 | 14 | ms | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_per_request_p95_ms | 12 | 12 | ms | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_failures | 0 | 0 | errors | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_throttle_queued_peak | 25 | 25 | requests | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | session-switch-stress | surface_switch_latency_ms | 78.10 | 78.10 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | transcript_render_ms | 59.30 | 59.30 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_max_call_stack | 0 | 0 | errors | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_loader_fraction | 0.16 | 0.16 | ratio | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | memory_growth_mb | 25.65 | 25.65 | MB | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms | 15.30 | 15.30 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | pty_attach_ms | 1.11 | 1.11 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms | 37.40 | 37.40 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_reconnect_latency_ms | 54.63 | 54.63 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | ansi_render_latency_ms | 0.77 | 0.77 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 687.23 | 687.23 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 115.87 | 115.87 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 80.08 | 80.08 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 1075.75 | 1075.75 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 45.42 | 45.42 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 41.88 | 41.88 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 260.32 | 260.32 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 133.24 | 133.24 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 24.74 | 24.74 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_index_ms | 1.66 | 1.66 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms | 40.62 | 40.62 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms | 24.19 | 24.19 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms | 67.28 | 67.28 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | theme-switch | theme_switch_latency_ms | 1.15 | 1.15 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | frame_time_ms | 5.04 | 5.04 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | refresh_rate_stability | 0.99 | 0.99 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | animation_jank | 0 | 0 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | three-pane-resize | frame_time_ms | 18.20 | 18.20 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | dropped_frames | 0 | 0 | frames | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | scroll_latency_ms | 20.68 | 20.68 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms | 53.60 | 53.60 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | diff_toggle_latency_ms | 5.83 | 5.83 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_action_dispatch_ms | 12.66 | 12.66 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_state_verify_ms | 1.68 | 1.68 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | surface_switch_latency_ms | 0.78 | 0.78 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | command_execution_overhead_ms | 0.33 | 0.33 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | event_backlog | 250 | 250 | events | pass | reports/videos/claxedo-agent-control-navigation-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms p95 139.6447079999998 > 45 | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms p95 687.2344169999997 > 36 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms p95 115.87250000000495 > 41 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms p95 80.07679199999984 > 37 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms p95 1075.7493329999998 > 33 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms p95 45.41754199999559 > 7 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms p95 41.87825000000157 > 32 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 133.2416250000024 > 31 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms p95 24.735709000000497 > 7 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms p95 40.61633299999812 > 8 | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms p95 67.27595899999869 > 7 | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | three-pane-resize | frame_time_ms p95 18.200000000000728 > 9 | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms p95 53.59999996423721 > 45 | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | diff/review surface did not visibly open with changed files | reports/videos/claxedo-three-pane-resize-1.webm |
