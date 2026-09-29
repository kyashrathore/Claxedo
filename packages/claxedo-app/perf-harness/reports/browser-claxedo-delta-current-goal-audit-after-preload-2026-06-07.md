# Claxedo Performance Delta Report

Generated: 2026-06-07T09:51:34.333Z
Input: browser-claxedo-all-current-goal-audit-after-preload-2026-06-07.json
Status: fail

Improved: 0
Same: 0
Regressed: 0
Missing baselines: 75
Scenario failures: 0

| Adapter | Target | Scenario | Metric | Direction | Before p95 | After p95 | Delta | Status |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| browser | claxedo | agent-control-navigation | agent_action_dispatch_ms | lower |  | 20.09 |  | missing-baseline |
| browser | claxedo | agent-control-navigation | agent_state_verify_ms | lower |  | 0.54 |  | missing-baseline |
| browser | claxedo | agent-control-navigation | command_execution_overhead_ms | lower |  | 0.53 |  | missing-baseline |
| browser | claxedo | agent-control-navigation | event_backlog | lower |  | 250 |  | missing-baseline |
| browser | claxedo | agent-control-navigation | surface_switch_latency_ms | lower |  | 2.16 |  | missing-baseline |
| browser | claxedo | bootstrap-pending-storm | bootstrap_drain_ms | lower |  | 12 |  | missing-baseline |
| browser | claxedo | bootstrap-pending-storm | bootstrap_pending_requests | lower |  | 0 |  | missing-baseline |
| browser | claxedo | bootstrap-pending-storm | bootstrap_throttle_inflight_after | lower |  | 0 |  | missing-baseline |
| browser | claxedo | bootstrap-pending-storm | bootstrap_throttle_queued_after | lower |  | 0 |  | missing-baseline |
| browser | claxedo | burst-authed-fetches | burst_failures | lower |  | 0 |  | missing-baseline |
| browser | claxedo | burst-authed-fetches | burst_per_request_p95_ms | lower |  | 10 |  | missing-baseline |
| browser | claxedo | burst-authed-fetches | burst_throttle_queued_peak | lower |  | 0 |  | missing-baseline |
| browser | claxedo | burst-authed-fetches | burst_total_drain_ms | lower |  | 11 |  | missing-baseline |
| browser | claxedo | command-palette-large-project | command_execution_overhead_ms | lower |  | 112.70 |  | missing-baseline |
| browser | claxedo | command-palette-large-project | command_palette_index_ms | lower |  | 22.34 |  | missing-baseline |
| browser | claxedo | command-palette-large-project | command_palette_open_ms | lower |  | 8.60 |  | missing-baseline |
| browser | claxedo | command-palette-large-project | command_palette_search_ms | lower |  | 19.30 |  | missing-baseline |
| browser | claxedo | large-diff-toggle | changed_file_navigation_ms | lower |  | 3.50 |  | missing-baseline |
| browser | claxedo | large-diff-toggle | diff_toggle_latency_ms | lower |  | 24.20 |  | missing-baseline |
| browser | claxedo | large-diff-toggle | hunk_render_ms | lower |  | 0 |  | missing-baseline |
| browser | claxedo | large-diff-toggle | line_comment_latency_ms | lower |  | 15.60 |  | missing-baseline |
| browser | claxedo | large-diff-toggle | review_panel_open_ms | lower |  | 8.40 |  | missing-baseline |
| browser | claxedo | large-diff-toggle | review_panel_reopen_baseline_frame_ms | lower |  | 7 |  | missing-baseline |
| browser | claxedo | large-diff-toggle | review_panel_reopen_click_ms | lower |  | 0.50 |  | missing-baseline |
| browser | claxedo | large-diff-toggle | review_panel_reopen_frame_ms | lower |  | 4.50 |  | missing-baseline |
| browser | claxedo | large-diff-toggle | review_panel_reopen_ms | lower |  | 8.20 |  | missing-baseline |
| browser | claxedo | large-diff-toggle | review_panel_reopen_state_ms | lower |  | 0 |  | missing-baseline |
| browser | claxedo | large-diff-toggle | vcs_load_ms | lower |  | 0 |  | missing-baseline |
| browser | claxedo | launch-empty-home | launch_first_input_ms | lower |  | 1.38 |  | missing-baseline |
| browser | claxedo | launch-empty-home | launch_first_useful_screen_ms | lower |  | 4360.76 |  | missing-baseline |
| browser | claxedo | launch-empty-home | launch_first_window_ms | lower |  | 4259.61 |  | missing-baseline |
| browser | claxedo | launch-empty-home | launch_workspace_ready_ms | lower |  | 4378.80 |  | missing-baseline |
| browser | claxedo | launch-empty-home | memory_rss_mb | lower |  | 73.05 |  | missing-baseline |
| browser | claxedo | launch-project-20-sessions | launch_first_window_ms | lower |  | 378.82 |  | missing-baseline |
| browser | claxedo | launch-project-20-sessions | launch_workspace_ready_ms | lower |  | 529.36 |  | missing-baseline |
| browser | claxedo | launch-project-20-sessions | memory_rss_mb | lower |  | 92.89 |  | missing-baseline |
| browser | claxedo | launch-project-20-sessions | transcript_render_ms | lower |  | 77.30 |  | missing-baseline |
| browser | claxedo | live-terminal-switch | ansi_render_latency_ms | lower |  | 0.91 |  | missing-baseline |
| browser | claxedo | live-terminal-switch | pty_attach_ms | lower |  | 1.04 |  | missing-baseline |
| browser | claxedo | live-terminal-switch | surface_switch_latency_ms | lower |  | 22.50 |  | missing-baseline |
| browser | claxedo | live-terminal-switch | terminal_reconnect_latency_ms | lower |  | 37.24 |  | missing-baseline |
| browser | claxedo | live-terminal-switch | terminal_resize_latency_ms | lower |  | 20.50 |  | missing-baseline |
| browser | claxedo | live-terminal-switch | terminal_throughput_lines_per_s | higher |  | 300000 |  | missing-baseline |
| browser | claxedo | long-session-switch | incremental_append_latency_ms | lower |  | 1.35 |  | missing-baseline |
| browser | claxedo | long-session-switch | memory_growth_mb | lower |  | 7.86 |  | missing-baseline |
| browser | claxedo | long-session-switch | scroll_latency_ms | lower |  | 20.67 |  | missing-baseline |
| browser | claxedo | long-session-switch | surface_switch_latency_ms | lower |  | 173.80 |  | missing-baseline |
| browser | claxedo | long-session-switch | tool_block_toggle_latency_ms | lower |  | 4.06 |  | missing-baseline |
| browser | claxedo | long-session-switch | transcript_render_ms | lower |  | 2.01 |  | missing-baseline |
| browser | claxedo | session-switch-stress | memory_growth_mb | lower |  | 12.49 |  | missing-baseline |
| browser | claxedo | session-switch-stress | session_switch_first_fold_ms | lower |  | 2.80 |  | missing-baseline |
| browser | claxedo | session-switch-stress | session_switch_hot_path_api_100ms | lower |  | 0 |  | missing-baseline |
| browser | claxedo | session-switch-stress | session_switch_hot_path_api_30ms | lower |  | 0 |  | missing-baseline |
| browser | claxedo | session-switch-stress | session_switch_loader_fraction | lower |  | 0 |  | missing-baseline |
| browser | claxedo | session-switch-stress | session_switch_max_call_stack | lower |  | 0 |  | missing-baseline |
| browser | claxedo | session-switch-stress | surface_switch_latency_ms | lower |  | 88.10 |  | missing-baseline |
| browser | claxedo | session-switch-stress | transcript_render_ms | lower |  | 53.70 |  | missing-baseline |
| browser | claxedo | theme-switch | animation_jank | lower |  | 0 |  | missing-baseline |
| browser | claxedo | theme-switch | dropped_frames | lower |  | 0 |  | missing-baseline |
| browser | claxedo | theme-switch | frame_time_ms | lower |  | 7.59 |  | missing-baseline |
| browser | claxedo | theme-switch | refresh_rate_stability | higher |  | 0.99 |  | missing-baseline |
| browser | claxedo | theme-switch | theme_switch_latency_ms | lower |  | 5.52 |  | missing-baseline |
| browser | claxedo | three-pane-resize | diff_toggle_latency_ms | lower |  | 3.73 |  | missing-baseline |
| browser | claxedo | three-pane-resize | dropped_frames | lower |  | 0 |  | missing-baseline |
| browser | claxedo | three-pane-resize | frame_time_ms | lower |  | 8 |  | missing-baseline |
| browser | claxedo | three-pane-resize | scroll_latency_ms | lower |  | 25.01 |  | missing-baseline |
| browser | claxedo | three-pane-resize | terminal_resize_latency_ms | lower |  | 128 |  | missing-baseline |
| browser | claxedo | workspace-switch | file_tree_control_ms | lower |  | 15.30 |  | missing-baseline |
| browser | claxedo | workspace-switch | file_tree_data_ms | lower |  | 9.80 |  | missing-baseline |
| browser | claxedo | workspace-switch | file_tree_first_frame_ms | lower |  | 23.90 |  | missing-baseline |
| browser | claxedo | workspace-switch | file_tree_load_ms | lower |  | 23.90 |  | missing-baseline |
| browser | claxedo | workspace-switch | file_tree_state_ms | lower |  | 8.50 |  | missing-baseline |
| browser | claxedo | workspace-switch | surface_switch_latency_ms | lower |  | 0.10 |  | missing-baseline |
| browser | claxedo | workspace-switch | workspace_bootstrap_ms | lower |  | 4.16 |  | missing-baseline |
| browser | claxedo | workspace-switch | workspace_switch_ms | lower |  | 286.56 |  | missing-baseline |

## Source Report

# Claxedo Performance Report

Generated: 2026-06-07T09:51:34.333Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 13
Failures: 0

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_window_ms | 4259.61 | 4259.61 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_useful_screen_ms | 4360.76 | 4360.76 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_workspace_ready_ms | 4378.80 | 4378.80 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_input_ms | 1.38 | 1.38 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | memory_rss_mb | 73.05 | 73.05 | MB | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_first_window_ms | 378.82 | 378.82 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_workspace_ready_ms | 529.36 | 529.36 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms | 77.30 | 77.30 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | memory_rss_mb | 92.89 | 92.89 | MB | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms | 173.80 | 173.80 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | transcript_render_ms | 2.01 | 2.01 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | scroll_latency_ms | 20.67 | 20.67 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | incremental_append_latency_ms | 1.35 | 1.35 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | tool_block_toggle_latency_ms | 4.06 | 4.06 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | memory_growth_mb | 7.86 | 7.86 | MB | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_pending_requests | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_drain_ms | 12 | 12 | ms | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_inflight_after | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_queued_after | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_total_drain_ms | 11 | 11 | ms | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_per_request_p95_ms | 10 | 10 | ms | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_failures | 0 | 0 | errors | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_throttle_queued_peak | 0 | 0 | requests | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | session-switch-stress | surface_switch_latency_ms | 88.10 | 88.10 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | transcript_render_ms | 53.70 | 53.70 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_first_fold_ms | 2.80 | 2.80 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_30ms | 0 | 0 | requests | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_100ms | 0 | 0 | requests | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_max_call_stack | 0 | 0 | errors | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_loader_fraction | 0 | 0 | ratio | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | memory_growth_mb | 12.49 | 12.49 | MB | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms | 22.50 | 22.50 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | pty_attach_ms | 1.04 | 1.04 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms | 20.50 | 20.50 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_reconnect_latency_ms | 37.24 | 37.24 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | ansi_render_latency_ms | 0.91 | 0.91 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_open_ms | 8.40 | 8.40 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 0 | 0 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 0 | 0 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 24.20 | 24.20 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_ms | 8.20 | 8.20 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_baseline_frame_ms | 7 | 7 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_click_ms | 0.50 | 0.50 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_state_ms | 0 | 0 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_frame_ms | 4.50 | 4.50 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 15.60 | 15.60 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 3.50 | 3.50 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 4.16 | 4.16 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 286.56 | 286.56 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 23.90 | 23.90 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 15.30 | 15.30 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 8.50 | 8.50 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 23.90 | 23.90 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 9.80 | 9.80 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 0.10 | 0.10 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_index_ms | 22.34 | 22.34 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms | 8.60 | 8.60 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms | 19.30 | 19.30 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms | 112.70 | 112.70 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | theme-switch | theme_switch_latency_ms | 5.52 | 5.52 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | frame_time_ms | 7.59 | 7.59 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | refresh_rate_stability | 0.99 | 0.99 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | animation_jank | 0 | 0 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | three-pane-resize | frame_time_ms | 8 | 8 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | scroll_latency_ms | 25.01 | 25.01 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms | 128 | 128 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | diff_toggle_latency_ms | 3.73 | 3.73 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_action_dispatch_ms | 20.09 | 20.09 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_state_verify_ms | 0.54 | 0.54 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | surface_switch_latency_ms | 2.16 | 2.16 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | command_execution_overhead_ms | 0.53 | 0.53 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | event_backlog | 250 | 250 | events | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
