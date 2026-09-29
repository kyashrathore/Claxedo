# Claxedo Performance Delta Report

Generated: 2026-06-07T10:01:48.331Z
Input: browser-claxedo-all-current-goal-audit-baseline-2026-06-07.json
Status: pass

Improved: 0
Same: 75
Regressed: 0
Missing baselines: 0
Scenario failures: 0

| Adapter | Target | Scenario | Metric | Direction | Before p95 | After p95 | Delta | Status |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| browser | claxedo | agent-control-navigation | agent_action_dispatch_ms | lower | 20.70 | 20.70 | 0% | same |
| browser | claxedo | agent-control-navigation | agent_state_verify_ms | lower | 0.60 | 0.60 | 0% | same |
| browser | claxedo | agent-control-navigation | command_execution_overhead_ms | lower | 0.39 | 0.39 | 0% | same |
| browser | claxedo | agent-control-navigation | event_backlog | lower | 250 | 250 | 0% | same |
| browser | claxedo | agent-control-navigation | surface_switch_latency_ms | lower | 0.79 | 0.79 | 0% | same |
| browser | claxedo | bootstrap-pending-storm | bootstrap_drain_ms | lower | 15 | 15 | 0% | same |
| browser | claxedo | bootstrap-pending-storm | bootstrap_pending_requests | lower | 0 | 0 | 0% | same |
| browser | claxedo | bootstrap-pending-storm | bootstrap_throttle_inflight_after | lower | 0 | 0 | 0% | same |
| browser | claxedo | bootstrap-pending-storm | bootstrap_throttle_queued_after | lower | 0 | 0 | 0% | same |
| browser | claxedo | burst-authed-fetches | burst_failures | lower | 0 | 0 | 0% | same |
| browser | claxedo | burst-authed-fetches | burst_per_request_p95_ms | lower | 9 | 9 | 0% | same |
| browser | claxedo | burst-authed-fetches | burst_throttle_queued_peak | lower | 0 | 0 | 0% | same |
| browser | claxedo | burst-authed-fetches | burst_total_drain_ms | lower | 10 | 10 | 0% | same |
| browser | claxedo | command-palette-large-project | command_execution_overhead_ms | lower | 110.60 | 110.60 | 0% | same |
| browser | claxedo | command-palette-large-project | command_palette_index_ms | lower | 18.51 | 18.51 | 0% | same |
| browser | claxedo | command-palette-large-project | command_palette_open_ms | lower | 9.90 | 9.90 | 0% | same |
| browser | claxedo | command-palette-large-project | command_palette_search_ms | lower | 38.90 | 38.90 | 0% | same |
| browser | claxedo | large-diff-toggle | changed_file_navigation_ms | lower | 3.50 | 3.50 | 0% | same |
| browser | claxedo | large-diff-toggle | diff_toggle_latency_ms | lower | 24 | 24 | 0% | same |
| browser | claxedo | large-diff-toggle | hunk_render_ms | lower | 0 | 0 | 0% | same |
| browser | claxedo | large-diff-toggle | line_comment_latency_ms | lower | 14.60 | 14.60 | 0% | same |
| browser | claxedo | large-diff-toggle | review_panel_open_ms | lower | 8.60 | 8.60 | 0% | same |
| browser | claxedo | large-diff-toggle | review_panel_reopen_baseline_frame_ms | lower | 1.20 | 1.20 | 0% | same |
| browser | claxedo | large-diff-toggle | review_panel_reopen_click_ms | lower | 0.50 | 0.50 | 0% | same |
| browser | claxedo | large-diff-toggle | review_panel_reopen_frame_ms | lower | 1.80 | 1.80 | 0% | same |
| browser | claxedo | large-diff-toggle | review_panel_reopen_ms | lower | 5.20 | 5.20 | 0% | same |
| browser | claxedo | large-diff-toggle | review_panel_reopen_state_ms | lower | 0 | 0 | 0% | same |
| browser | claxedo | large-diff-toggle | vcs_load_ms | lower | 21.10 | 21.10 | 0% | same |
| browser | claxedo | launch-empty-home | launch_first_input_ms | lower | 1.52 | 1.52 | 0% | same |
| browser | claxedo | launch-empty-home | launch_first_useful_screen_ms | lower | 4348.49 | 4348.49 | 0% | same |
| browser | claxedo | launch-empty-home | launch_first_window_ms | lower | 4246.90 | 4246.90 | 0% | same |
| browser | claxedo | launch-empty-home | launch_workspace_ready_ms | lower | 4367.10 | 4367.10 | 0% | same |
| browser | claxedo | launch-empty-home | memory_rss_mb | lower | 73.05 | 73.05 | 0% | same |
| browser | claxedo | launch-project-20-sessions | launch_first_window_ms | lower | 381.88 | 381.88 | 0% | same |
| browser | claxedo | launch-project-20-sessions | launch_workspace_ready_ms | lower | 531.96 | 531.96 | 0% | same |
| browser | claxedo | launch-project-20-sessions | memory_rss_mb | lower | 92.89 | 92.89 | 0% | same |
| browser | claxedo | launch-project-20-sessions | transcript_render_ms | lower | 71.90 | 71.90 | 0% | same |
| browser | claxedo | live-terminal-switch | ansi_render_latency_ms | lower | 0.75 | 0.75 | 0% | same |
| browser | claxedo | live-terminal-switch | pty_attach_ms | lower | 1.05 | 1.05 | 0% | same |
| browser | claxedo | live-terminal-switch | surface_switch_latency_ms | lower | 6.50 | 6.50 | 0% | same |
| browser | claxedo | live-terminal-switch | terminal_reconnect_latency_ms | lower | 21.98 | 21.98 | 0% | same |
| browser | claxedo | live-terminal-switch | terminal_resize_latency_ms | lower | 49.60 | 49.60 | 0% | same |
| browser | claxedo | live-terminal-switch | terminal_throughput_lines_per_s | higher | 300000 | 300000 | 0% | same |
| browser | claxedo | long-session-switch | incremental_append_latency_ms | lower | 0.49 | 0.49 | 0% | same |
| browser | claxedo | long-session-switch | memory_growth_mb | lower | 7.43 | 7.43 | 0% | same |
| browser | claxedo | long-session-switch | scroll_latency_ms | lower | 22.01 | 22.01 | 0% | same |
| browser | claxedo | long-session-switch | surface_switch_latency_ms | lower | 152.48 | 152.48 | 0% | same |
| browser | claxedo | long-session-switch | tool_block_toggle_latency_ms | lower | 1.88 | 1.88 | 0% | same |
| browser | claxedo | long-session-switch | transcript_render_ms | lower | 1.12 | 1.12 | 0% | same |
| browser | claxedo | session-switch-stress | memory_growth_mb | lower | 12.49 | 12.49 | 0% | same |
| browser | claxedo | session-switch-stress | session_switch_first_fold_ms | lower | 3 | 3 | 0% | same |
| browser | claxedo | session-switch-stress | session_switch_hot_path_api_100ms | lower | 0 | 0 | 0% | same |
| browser | claxedo | session-switch-stress | session_switch_hot_path_api_30ms | lower | 0 | 0 | 0% | same |
| browser | claxedo | session-switch-stress | session_switch_loader_fraction | lower | 0 | 0 | 0% | same |
| browser | claxedo | session-switch-stress | session_switch_max_call_stack | lower | 0 | 0 | 0% | same |
| browser | claxedo | session-switch-stress | surface_switch_latency_ms | lower | 83.90 | 83.90 | 0% | same |
| browser | claxedo | session-switch-stress | transcript_render_ms | lower | 54.40 | 54.40 | 0% | same |
| browser | claxedo | theme-switch | animation_jank | lower | 0 | 0 | 0% | same |
| browser | claxedo | theme-switch | dropped_frames | lower | 0 | 0 | 0% | same |
| browser | claxedo | theme-switch | frame_time_ms | lower | 9.09 | 9.09 | 0% | same |
| browser | claxedo | theme-switch | refresh_rate_stability | higher | 0.99 | 0.99 | 0% | same |
| browser | claxedo | theme-switch | theme_switch_latency_ms | lower | 4.68 | 4.68 | 0% | same |
| browser | claxedo | three-pane-resize | diff_toggle_latency_ms | lower | 3.91 | 3.91 | 0% | same |
| browser | claxedo | three-pane-resize | dropped_frames | lower | 0 | 0 | 0% | same |
| browser | claxedo | three-pane-resize | frame_time_ms | lower | 8.50 | 8.50 | 0% | same |
| browser | claxedo | three-pane-resize | scroll_latency_ms | lower | 25.22 | 25.22 | 0% | same |
| browser | claxedo | three-pane-resize | terminal_resize_latency_ms | lower | 128.20 | 128.20 | 0% | same |
| browser | claxedo | workspace-switch | file_tree_control_ms | lower | 16.20 | 16.20 | 0% | same |
| browser | claxedo | workspace-switch | file_tree_data_ms | lower | 9.60 | 9.60 | 0% | same |
| browser | claxedo | workspace-switch | file_tree_first_frame_ms | lower | 24.30 | 24.30 | 0% | same |
| browser | claxedo | workspace-switch | file_tree_load_ms | lower | 24.30 | 24.30 | 0% | same |
| browser | claxedo | workspace-switch | file_tree_state_ms | lower | 7.90 | 7.90 | 0% | same |
| browser | claxedo | workspace-switch | surface_switch_latency_ms | lower | 0 | 0 | 0% | same |
| browser | claxedo | workspace-switch | workspace_bootstrap_ms | lower | 4.29 | 4.29 | 0% | same |
| browser | claxedo | workspace-switch | workspace_switch_ms | lower | 291.91 | 291.91 | 0% | same |

## Source Report

# Claxedo Performance Report

Generated: 2026-06-07T10:01:48.333Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 13
Failures: 0

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_window_ms | 4246.90 | 4246.90 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_useful_screen_ms | 4348.49 | 4348.49 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_workspace_ready_ms | 4367.10 | 4367.10 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_input_ms | 1.52 | 1.52 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | memory_rss_mb | 73.05 | 73.05 | MB | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_first_window_ms | 381.88 | 381.88 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_workspace_ready_ms | 531.96 | 531.96 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms | 71.90 | 71.90 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | memory_rss_mb | 92.89 | 92.89 | MB | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms | 152.48 | 152.48 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | transcript_render_ms | 1.12 | 1.12 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | scroll_latency_ms | 22.01 | 22.01 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | incremental_append_latency_ms | 0.49 | 0.49 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | tool_block_toggle_latency_ms | 1.88 | 1.88 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | memory_growth_mb | 7.43 | 7.43 | MB | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_pending_requests | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_drain_ms | 15 | 15 | ms | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_inflight_after | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_queued_after | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_total_drain_ms | 10 | 10 | ms | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_per_request_p95_ms | 9 | 9 | ms | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_failures | 0 | 0 | errors | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_throttle_queued_peak | 0 | 0 | requests | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | session-switch-stress | surface_switch_latency_ms | 83.90 | 83.90 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | transcript_render_ms | 54.40 | 54.40 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_first_fold_ms | 3 | 3 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_30ms | 0 | 0 | requests | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_100ms | 0 | 0 | requests | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_max_call_stack | 0 | 0 | errors | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_loader_fraction | 0 | 0 | ratio | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | memory_growth_mb | 12.49 | 12.49 | MB | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms | 6.50 | 6.50 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | pty_attach_ms | 1.05 | 1.05 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms | 49.60 | 49.60 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_reconnect_latency_ms | 21.98 | 21.98 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | ansi_render_latency_ms | 0.75 | 0.75 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_open_ms | 8.60 | 8.60 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 21.10 | 21.10 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 0 | 0 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 24 | 24 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_ms | 5.20 | 5.20 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_baseline_frame_ms | 1.20 | 1.20 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_click_ms | 0.50 | 0.50 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_state_ms | 0 | 0 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_frame_ms | 1.80 | 1.80 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 14.60 | 14.60 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 3.50 | 3.50 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 4.29 | 4.29 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 291.91 | 291.91 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 24.30 | 24.30 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 16.20 | 16.20 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 7.90 | 7.90 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 24.30 | 24.30 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 9.60 | 9.60 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 0 | 0 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_index_ms | 18.51 | 18.51 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms | 9.90 | 9.90 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms | 38.90 | 38.90 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms | 110.60 | 110.60 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | theme-switch | theme_switch_latency_ms | 4.68 | 4.68 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | frame_time_ms | 9.09 | 9.09 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | refresh_rate_stability | 0.99 | 0.99 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | animation_jank | 0 | 0 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | three-pane-resize | frame_time_ms | 8.50 | 8.50 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | scroll_latency_ms | 25.22 | 25.22 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms | 128.20 | 128.20 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | diff_toggle_latency_ms | 3.91 | 3.91 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_action_dispatch_ms | 20.70 | 20.70 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_state_verify_ms | 0.60 | 0.60 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | surface_switch_latency_ms | 0.79 | 0.79 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | command_execution_overhead_ms | 0.39 | 0.39 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | event_backlog | 250 | 250 | events | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
