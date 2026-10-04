# Claxedo Performance Report

Generated: 2026-06-06T20:02:54.288Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 13
Failures: 3

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_window_ms | 4375.85 | 4375.85 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_useful_screen_ms | 4464.49 | 4464.49 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_workspace_ready_ms | 9469.80 | 9469.80 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_input_ms | 3.04 | 3.04 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | memory_rss_mb | 92.89 | 92.89 | MB | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_first_window_ms | 581.93 | 581.93 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_workspace_ready_ms | 5682.32 | 5682.32 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms | 10005.30 | 10005.30 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | memory_rss_mb | 98.23 | 98.23 | MB | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms | 143.80 | 143.80 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | transcript_render_ms | 1.15 | 1.15 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | scroll_latency_ms | 19.64 | 19.64 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | incremental_append_latency_ms | 0.73 | 0.73 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | tool_block_toggle_latency_ms | 2.18 | 2.18 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | memory_growth_mb | 6.59 | 6.59 | MB | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_pending_requests | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_drain_ms | 25 | 25 | ms | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_inflight_after | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_queued_after | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_total_drain_ms | 7 | 7 | ms | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_per_request_p95_ms | 6 | 6 | ms | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_failures | 0 | 0 | errors | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_throttle_queued_peak | 4 | 4 | requests | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | session-switch-stress | surface_switch_latency_ms | 54.60 | 54.60 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | transcript_render_ms | 40.60 | 40.60 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_first_fold_ms | 15.30 | 15.30 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_30ms | 0 | 0 | requests | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_100ms | 0 | 0 | requests | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_max_call_stack | 0 | 0 | errors | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_loader_fraction | 0 | 0 | ratio | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | memory_growth_mb | 10.40 | 10.40 | MB | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms | 13.90 | 13.90 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | pty_attach_ms | 3.59 | 3.59 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms | 23.30 | 23.30 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_reconnect_latency_ms | 36.10 | 36.10 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | ansi_render_latency_ms | 0.77 | 0.77 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_open_ms | 13.90 | 13.90 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 33.80 | 33.80 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 0 | 0 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 24.20 | 24.20 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_ms | 8.20 | 8.20 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_baseline_frame_ms | 6.40 | 6.40 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_click_ms | 0.30 | 0.30 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_state_ms | 0 | 0 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_frame_ms | 4.90 | 4.90 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 15.20 | 15.20 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 3.70 | 3.70 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 3.93 | 3.93 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 336.10 | 336.10 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 21.80 | 21.80 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 13.80 | 13.80 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 7.90 | 7.90 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 21.80 | 21.80 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 1936.70 | 1936.70 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 0 | 0 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_index_ms | 2.51 | 2.51 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms | 13.70 | 13.70 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms | 46.20 | 46.20 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms | 128.40 | 128.40 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | theme-switch | theme_switch_latency_ms | 1.46 | 1.46 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | frame_time_ms | 5.66 | 5.66 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | refresh_rate_stability | 0.99 | 0.99 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | animation_jank | 0 | 0 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | three-pane-resize | frame_time_ms | 8.40 | 8.40 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | scroll_latency_ms | 24.88 | 24.88 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms | 128.50 | 128.50 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | diff_toggle_latency_ms | 3.03 | 3.03 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_action_dispatch_ms | 25.50 | 25.50 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_state_verify_ms | 0.64 | 0.64 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | surface_switch_latency_ms | 2.52 | 2.52 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | command_execution_overhead_ms | 0.87 | 0.87 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | event_backlog | 250 | 250 | events | pass | reports/videos/claxedo-agent-control-navigation-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms p95 10005.300000011921 > 90 | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms p95 1936.699999988079 > 201 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms p95 46.19999998807907 > 43 | reports/videos/claxedo-command-palette-large-project-1.webm |
