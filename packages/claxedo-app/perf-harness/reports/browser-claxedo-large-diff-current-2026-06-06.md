# Claxedo Performance Report

Generated: 2026-06-05T18:47:02.124Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 13
Failures: 7

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_window_ms | 4118.57 | 4118.57 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_useful_screen_ms | 4226.80 | 4226.80 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_workspace_ready_ms | 9229.20 | 9229.20 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_input_ms | 1.59 | 1.59 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | memory_rss_mb | 68.86 | 68.86 | MB | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_first_window_ms | 337.12 | 337.12 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_workspace_ready_ms | 5433.35 | 5433.35 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms | 184.67 | 184.67 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | memory_rss_mb | 77.63 | 77.63 | MB | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms | 180.82 | 180.82 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | transcript_render_ms | 3.12 | 3.12 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | scroll_latency_ms | 16.37 | 16.37 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | incremental_append_latency_ms | 0.45 | 0.45 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | tool_block_toggle_latency_ms | 2.26 | 2.26 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | memory_growth_mb | 6.59 | 6.59 | MB | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_pending_requests | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_drain_ms | 12 | 12 | ms | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_inflight_after | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_queued_after | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_total_drain_ms | 14 | 14 | ms | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_per_request_p95_ms | 13 | 13 | ms | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_failures | 0 | 0 | errors | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_throttle_queued_peak | 22 | 22 | requests | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | session-switch-stress | surface_switch_latency_ms | 74.70 | 74.70 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | transcript_render_ms | 54.20 | 54.20 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_max_call_stack | 0 | 0 | errors | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_loader_fraction | 0.19 | 0.19 | ratio | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | memory_growth_mb | 15.93 | 15.93 | MB | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms | 44 | 44 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | pty_attach_ms | 5.56 | 5.56 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms | 44.70 | 44.70 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_reconnect_latency_ms | 35.02 | 35.02 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | ansi_render_latency_ms | 0.69 | 0.69 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 673.24 | 673.24 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 56.76 | 56.76 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 35.63 | 35.63 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 75.20 | 75.20 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 47.98 | 47.98 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 19.61 | 19.61 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 298.10 | 298.10 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 118.10 | 118.10 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 33.74 | 33.74 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_index_ms | 3.10 | 3.10 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms | 33.65 | 33.65 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms | 39.76 | 39.76 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms | 26.80 | 26.80 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | theme-switch | theme_switch_latency_ms | 3.36 | 3.36 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | frame_time_ms | 9.85 | 9.85 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | refresh_rate_stability | 0.99 | 0.99 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | animation_jank | 0 | 0 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | three-pane-resize | frame_time_ms | 9.30 | 9.30 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | dropped_frames | 0 | 0 | frames | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | scroll_latency_ms | 24.71 | 24.71 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms | 41.40 | 41.40 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | diff_toggle_latency_ms | 0.97 | 0.97 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_action_dispatch_ms | 24.94 | 24.94 | ms | fail | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_state_verify_ms | 0.58 | 0.58 | ms | fail | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | surface_switch_latency_ms | 0.75 | 0.75 | ms | fail | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | command_execution_overhead_ms | 0.45 | 0.45 | ms | fail | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | event_backlog | 250 | 250 | events | fail | reports/videos/claxedo-agent-control-navigation-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms p95 184.67054199999984 > 45 | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms p95 44 > 32 | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | session messages were not requested for live-terminal-switch | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms p95 673.2402080000029 > 36 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms p95 56.75687499999913 > 41 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms p95 75.20000004768372 > 33 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms p95 47.98250000000553 > 7 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | session messages were not requested for large-diff-toggle | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 118.10358300000371 > 31 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms p95 33.744666999999026 > 7 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms p95 33.64641700000357 > 8 | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms p95 26.79516699999658 > 7 | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | session messages were not requested for command-palette-large-project | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | three-pane-resize | frame_time_ms p95 9.300000000000182 > 9 | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | session messages were not requested for three-pane-resize | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | agent-control-navigation | session messages were not requested for agent-control-navigation | reports/videos/claxedo-agent-control-navigation-1.webm |
