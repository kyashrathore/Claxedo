# Claxedo Performance Delta Report

Generated: 2026-06-06T22:24:35.731Z
Input: browser-claxedo-all-after-session-hotpath-2026-06-07.json -> browser-claxedo-all-explicit-ready-preload-throttle-command-final-2026-06-07.json
Status: fail

Improved: 37
Same: 18
Regressed: 20
Missing baselines: 0
Scenario failures: 0

| Adapter | Target | Scenario | Metric | Direction | Before p95 | After p95 | Delta | Status |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| browser | claxedo | agent-control-navigation | agent_action_dispatch_ms | lower | 25.50 | 21.63 | 15.19% | improved |
| browser | claxedo | agent-control-navigation | agent_state_verify_ms | lower | 0.64 | 0.61 | 4.30% | improved |
| browser | claxedo | agent-control-navigation | command_execution_overhead_ms | lower | 0.87 | 0.77 | 11.66% | improved |
| browser | claxedo | agent-control-navigation | event_backlog | lower | 250 | 250 | 0% | same |
| browser | claxedo | agent-control-navigation | surface_switch_latency_ms | lower | 2.52 | 0.56 | 77.97% | improved |
| browser | claxedo | bootstrap-pending-storm | bootstrap_drain_ms | lower | 25 | 11 | 56% | improved |
| browser | claxedo | bootstrap-pending-storm | bootstrap_pending_requests | lower | 0 | 0 | 0% | same |
| browser | claxedo | bootstrap-pending-storm | bootstrap_throttle_inflight_after | lower | 0 | 0 | 0% | same |
| browser | claxedo | bootstrap-pending-storm | bootstrap_throttle_queued_after | lower | 0 | 0 | 0% | same |
| browser | claxedo | burst-authed-fetches | burst_failures | lower | 0 | 0 | 0% | same |
| browser | claxedo | burst-authed-fetches | burst_per_request_p95_ms | lower | 6 | 11 | -83.33% | regressed |
| browser | claxedo | burst-authed-fetches | burst_throttle_queued_peak | lower | 4 | 0 | 100% | improved |
| browser | claxedo | burst-authed-fetches | burst_total_drain_ms | lower | 7 | 11 | -57.14% | regressed |
| browser | claxedo | command-palette-large-project | command_execution_overhead_ms | lower | 128.40 | 112.40 | 12.46% | improved |
| browser | claxedo | command-palette-large-project | command_palette_index_ms | lower | 2.51 | 14.78 | -487.76% | regressed |
| browser | claxedo | command-palette-large-project | command_palette_open_ms | lower | 13.70 | 8.80 | 35.77% | improved |
| browser | claxedo | command-palette-large-project | command_palette_search_ms | lower | 46.20 | 7 | 84.85% | improved |
| browser | claxedo | large-diff-toggle | changed_file_navigation_ms | lower | 3.70 | 3.40 | 8.11% | improved |
| browser | claxedo | large-diff-toggle | diff_toggle_latency_ms | lower | 24.20 | 23.80 | 1.65% | improved |
| browser | claxedo | large-diff-toggle | hunk_render_ms | lower | 0 | 0 | 0% | same |
| browser | claxedo | large-diff-toggle | line_comment_latency_ms | lower | 15.20 | 15.50 | -1.97% | regressed |
| browser | claxedo | large-diff-toggle | review_panel_open_ms | lower | 13.90 | 8.40 | 39.57% | improved |
| browser | claxedo | large-diff-toggle | review_panel_reopen_baseline_frame_ms | lower | 6.40 | 7.40 | -15.62% | regressed |
| browser | claxedo | large-diff-toggle | review_panel_reopen_click_ms | lower | 0.30 | 0.50 | -66.67% | regressed |
| browser | claxedo | large-diff-toggle | review_panel_reopen_frame_ms | lower | 4.90 | 4.80 | 2.04% | improved |
| browser | claxedo | large-diff-toggle | review_panel_reopen_ms | lower | 8.20 | 8.30 | -1.22% | regressed |
| browser | claxedo | large-diff-toggle | review_panel_reopen_state_ms | lower | 0 | 0 | 0% | same |
| browser | claxedo | large-diff-toggle | vcs_load_ms | lower | 33.80 | 50.80 | -50.30% | regressed |
| browser | claxedo | launch-empty-home | launch_first_input_ms | lower | 3.04 | 2.24 | 26.37% | improved |
| browser | claxedo | launch-empty-home | launch_first_useful_screen_ms | lower | 4464.49 | 4510.46 | -1.03% | regressed |
| browser | claxedo | launch-empty-home | launch_first_window_ms | lower | 4375.85 | 4429.91 | -1.24% | regressed |
| browser | claxedo | launch-empty-home | launch_workspace_ready_ms | lower | 9469.80 | 4532.56 | 52.14% | improved |
| browser | claxedo | launch-empty-home | memory_rss_mb | lower | 92.89 | 68.86 | 25.87% | improved |
| browser | claxedo | launch-project-20-sessions | launch_first_window_ms | lower | 581.93 | 361.15 | 37.94% | improved |
| browser | claxedo | launch-project-20-sessions | launch_workspace_ready_ms | lower | 5682.32 | 494.13 | 91.30% | improved |
| browser | claxedo | launch-project-20-sessions | memory_rss_mb | lower | 98.23 | 98.23 | 0% | same |
| browser | claxedo | launch-project-20-sessions | transcript_render_ms | lower | 10005.30 | 92.20 | 99.08% | improved |
| browser | claxedo | live-terminal-switch | ansi_render_latency_ms | lower | 0.77 | 0.77 | 0.42% | improved |
| browser | claxedo | live-terminal-switch | pty_attach_ms | lower | 3.59 | 1.02 | 71.51% | improved |
| browser | claxedo | live-terminal-switch | surface_switch_latency_ms | lower | 13.90 | 6.30 | 54.68% | improved |
| browser | claxedo | live-terminal-switch | terminal_reconnect_latency_ms | lower | 36.10 | 30.22 | 16.30% | improved |
| browser | claxedo | live-terminal-switch | terminal_resize_latency_ms | lower | 23.30 | 38.20 | -63.95% | regressed |
| browser | claxedo | live-terminal-switch | terminal_throughput_lines_per_s | higher | 300000 | 300000 | 0% | same |
| browser | claxedo | long-session-switch | incremental_append_latency_ms | lower | 0.73 | 0.44 | 39.48% | improved |
| browser | claxedo | long-session-switch | memory_growth_mb | lower | 6.59 | 7.43 | -12.73% | regressed |
| browser | claxedo | long-session-switch | scroll_latency_ms | lower | 19.64 | 23.37 | -19% | regressed |
| browser | claxedo | long-session-switch | surface_switch_latency_ms | lower | 143.80 | 120.54 | 16.17% | improved |
| browser | claxedo | long-session-switch | tool_block_toggle_latency_ms | lower | 2.18 | 4.44 | -103.78% | regressed |
| browser | claxedo | long-session-switch | transcript_render_ms | lower | 1.15 | 56.64 | -4839.51% | regressed |
| browser | claxedo | session-switch-stress | memory_growth_mb | lower | 10.40 | 9.82 | 5.50% | improved |
| browser | claxedo | session-switch-stress | session_switch_first_fold_ms | lower | 15.30 | 2.20 | 85.62% | improved |
| browser | claxedo | session-switch-stress | session_switch_hot_path_api_100ms | lower | 0 | 0 | 0% | same |
| browser | claxedo | session-switch-stress | session_switch_hot_path_api_30ms | lower | 0 | 0 | 0% | same |
| browser | claxedo | session-switch-stress | session_switch_loader_fraction | lower | 0 | 0 | 0% | same |
| browser | claxedo | session-switch-stress | session_switch_max_call_stack | lower | 0 | 0 | 0% | same |
| browser | claxedo | session-switch-stress | surface_switch_latency_ms | lower | 54.60 | 40.50 | 25.82% | improved |
| browser | claxedo | session-switch-stress | transcript_render_ms | lower | 40.60 | 13 | 67.98% | improved |
| browser | claxedo | theme-switch | animation_jank | lower | 0 | 0 | 0% | same |
| browser | claxedo | theme-switch | dropped_frames | lower | 0 | 0 | 0% | same |
| browser | claxedo | theme-switch | frame_time_ms | lower | 5.66 | 5.08 | 10.35% | improved |
| browser | claxedo | theme-switch | refresh_rate_stability | higher | 0.99 | 0.99 | 0% | same |
| browser | claxedo | theme-switch | theme_switch_latency_ms | lower | 1.46 | 3.92 | -167.92% | regressed |
| browser | claxedo | three-pane-resize | diff_toggle_latency_ms | lower | 3.03 | 4.87 | -60.31% | regressed |
| browser | claxedo | three-pane-resize | dropped_frames | lower | 0 | 0 | 0% | same |
| browser | claxedo | three-pane-resize | frame_time_ms | lower | 8.40 | 8.20 | 2.38% | improved |
| browser | claxedo | three-pane-resize | scroll_latency_ms | lower | 24.88 | 24.95 | -0.28% | regressed |
| browser | claxedo | three-pane-resize | terminal_resize_latency_ms | lower | 128.50 | 125 | 2.72% | improved |
| browser | claxedo | workspace-switch | file_tree_control_ms | lower | 13.80 | 8.40 | 39.13% | improved |
| browser | claxedo | workspace-switch | file_tree_data_ms | lower | 1936.70 | 9.40 | 99.51% | improved |
| browser | claxedo | workspace-switch | file_tree_first_frame_ms | lower | 21.80 | 15.40 | 29.36% | improved |
| browser | claxedo | workspace-switch | file_tree_load_ms | lower | 21.80 | 15.40 | 29.36% | improved |
| browser | claxedo | workspace-switch | file_tree_state_ms | lower | 7.90 | 6.90 | 12.66% | improved |
| browser | claxedo | workspace-switch | surface_switch_latency_ms | lower | 0 | 0 | 0% | same |
| browser | claxedo | workspace-switch | workspace_bootstrap_ms | lower | 3.93 | 9.14 | -132.38% | regressed |
| browser | claxedo | workspace-switch | workspace_switch_ms | lower | 336.10 | 598.78 | -78.15% | regressed |

## Source Report

# Claxedo Performance Report

Generated: 2026-06-06T22:24:35.732Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 13
Failures: 0

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_window_ms | 4429.91 | 4429.91 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_useful_screen_ms | 4510.46 | 4510.46 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_workspace_ready_ms | 4532.56 | 4532.56 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_input_ms | 2.24 | 2.24 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | memory_rss_mb | 68.86 | 68.86 | MB | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_first_window_ms | 361.15 | 361.15 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_workspace_ready_ms | 494.13 | 494.13 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms | 92.20 | 92.20 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | memory_rss_mb | 98.23 | 98.23 | MB | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms | 120.54 | 120.54 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | transcript_render_ms | 56.64 | 56.64 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | scroll_latency_ms | 23.37 | 23.37 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | incremental_append_latency_ms | 0.44 | 0.44 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | tool_block_toggle_latency_ms | 4.44 | 4.44 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | memory_growth_mb | 7.43 | 7.43 | MB | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_pending_requests | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_drain_ms | 11 | 11 | ms | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_inflight_after | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_queued_after | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_total_drain_ms | 11 | 11 | ms | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_per_request_p95_ms | 11 | 11 | ms | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_failures | 0 | 0 | errors | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_throttle_queued_peak | 0 | 0 | requests | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | session-switch-stress | surface_switch_latency_ms | 40.50 | 40.50 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | transcript_render_ms | 13 | 13 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_first_fold_ms | 2.20 | 2.20 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_30ms | 0 | 0 | requests | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_100ms | 0 | 0 | requests | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_max_call_stack | 0 | 0 | errors | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_loader_fraction | 0 | 0 | ratio | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | memory_growth_mb | 9.82 | 9.82 | MB | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms | 6.30 | 6.30 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | pty_attach_ms | 1.02 | 1.02 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms | 38.20 | 38.20 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_reconnect_latency_ms | 30.22 | 30.22 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | ansi_render_latency_ms | 0.77 | 0.77 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_open_ms | 8.40 | 8.40 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 50.80 | 50.80 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 0 | 0 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 23.80 | 23.80 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_ms | 8.30 | 8.30 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_baseline_frame_ms | 7.40 | 7.40 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_click_ms | 0.50 | 0.50 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_state_ms | 0 | 0 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_frame_ms | 4.80 | 4.80 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 15.50 | 15.50 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 3.40 | 3.40 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 9.14 | 9.14 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 598.78 | 598.78 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 15.40 | 15.40 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 8.40 | 8.40 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 6.90 | 6.90 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 15.40 | 15.40 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 9.40 | 9.40 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 0 | 0 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_index_ms | 14.78 | 14.78 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms | 8.80 | 8.80 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms | 7 | 7 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms | 112.40 | 112.40 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | theme-switch | theme_switch_latency_ms | 3.92 | 3.92 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | frame_time_ms | 5.08 | 5.08 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | refresh_rate_stability | 0.99 | 0.99 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | animation_jank | 0 | 0 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | three-pane-resize | frame_time_ms | 8.20 | 8.20 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | scroll_latency_ms | 24.95 | 24.95 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms | 125 | 125 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | diff_toggle_latency_ms | 4.87 | 4.87 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_action_dispatch_ms | 21.63 | 21.63 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_state_verify_ms | 0.61 | 0.61 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | surface_switch_latency_ms | 0.56 | 0.56 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | command_execution_overhead_ms | 0.77 | 0.77 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | event_backlog | 250 | 250 | events | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
