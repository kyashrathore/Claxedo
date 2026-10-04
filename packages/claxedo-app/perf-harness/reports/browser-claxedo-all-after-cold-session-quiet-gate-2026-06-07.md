# Claxedo Performance Report

Generated: 2026-06-06T22:09:33.256Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 13
Failures: 0

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_window_ms | 4383.38 | 4383.38 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_useful_screen_ms | 4463.84 | 4463.84 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_workspace_ready_ms | 9467.60 | 9467.60 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_input_ms | 2.24 | 2.24 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | memory_rss_mb | 92.89 | 92.89 | MB | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_first_window_ms | 417.72 | 417.72 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_workspace_ready_ms | 5510.23 | 5510.23 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms | 85.60 | 85.60 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | memory_rss_mb | 98.23 | 98.23 | MB | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms | 103.90 | 103.90 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | transcript_render_ms | 58.99 | 58.99 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | scroll_latency_ms | 26.07 | 26.07 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | incremental_append_latency_ms | 0.54 | 0.54 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | tool_block_toggle_latency_ms | 3.38 | 3.38 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | memory_growth_mb | 7.00 | 7.00 | MB | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_pending_requests | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_drain_ms | 12 | 12 | ms | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_inflight_after | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_queued_after | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_total_drain_ms | 7 | 7 | ms | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_per_request_p95_ms | 6 | 6 | ms | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_failures | 0 | 0 | errors | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_throttle_queued_peak | 3 | 3 | requests | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | session-switch-stress | surface_switch_latency_ms | 44.10 | 44.10 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | transcript_render_ms | 16 | 16 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_first_fold_ms | 2.30 | 2.30 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_30ms | 0 | 0 | requests | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_100ms | 0 | 0 | requests | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_max_call_stack | 0 | 0 | errors | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_loader_fraction | 0 | 0 | ratio | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | memory_growth_mb | 9.29 | 9.29 | MB | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms | 6.30 | 6.30 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | pty_attach_ms | 1.25 | 1.25 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms | 29.70 | 29.70 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_reconnect_latency_ms | 50.89 | 50.89 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | ansi_render_latency_ms | 0.81 | 0.81 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_open_ms | 12.60 | 12.60 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 31.60 | 31.60 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 0 | 0 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 24.10 | 24.10 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_ms | 4.90 | 4.90 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_baseline_frame_ms | 0.60 | 0.60 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_click_ms | 0.40 | 0.40 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_state_ms | 0 | 0 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_frame_ms | 1.50 | 1.50 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 15.50 | 15.50 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 3.60 | 3.60 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 6.74 | 6.74 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 619.19 | 619.19 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 16 | 16 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 10.90 | 10.90 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 5 | 5 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 16 | 16 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 6.80 | 6.80 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 0.10 | 0.10 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_index_ms | 5.63 | 5.63 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms | 17 | 17 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms | 30.50 | 30.50 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms | 108.70 | 108.70 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | theme-switch | theme_switch_latency_ms | 2.95 | 2.95 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | frame_time_ms | 4.82 | 4.82 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | refresh_rate_stability | 0.99 | 0.99 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | animation_jank | 0 | 0 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | three-pane-resize | frame_time_ms | 8.30 | 8.30 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | scroll_latency_ms | 24.05 | 24.05 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms | 129.40 | 129.40 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | diff_toggle_latency_ms | 5.08 | 5.08 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_action_dispatch_ms | 21.55 | 21.55 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_state_verify_ms | 0.48 | 0.48 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | surface_switch_latency_ms | 0.55 | 0.55 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | command_execution_overhead_ms | 0.28 | 0.28 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | event_backlog | 250 | 250 | events | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
