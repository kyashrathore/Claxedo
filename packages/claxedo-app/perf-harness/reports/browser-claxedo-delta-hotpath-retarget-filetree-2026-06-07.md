# Claxedo Performance Delta Report

Generated: 2026-06-06T20:21:46.063Z
Input: browser-claxedo-all-after-session-hotpath-2026-06-07.json -> browser-claxedo-all-after-hotpath-retarget-filetree-2026-06-07.json
Status: fail

Improved: 35
Same: 20
Regressed: 20
Missing baselines: 0
Scenario failures: 1

| Adapter | Target | Scenario | Metric | Direction | Before p95 | After p95 | Delta | Status |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| browser | claxedo | agent-control-navigation | agent_action_dispatch_ms | lower | 25.50 | 18.33 | 28.14% | improved |
| browser | claxedo | agent-control-navigation | agent_state_verify_ms | lower | 0.64 | 0.49 | 23.86% | improved |
| browser | claxedo | agent-control-navigation | command_execution_overhead_ms | lower | 0.87 | 0.28 | 67.64% | improved |
| browser | claxedo | agent-control-navigation | event_backlog | lower | 250 | 250 | 0% | same |
| browser | claxedo | agent-control-navigation | surface_switch_latency_ms | lower | 2.52 | 0.59 | 76.80% | improved |
| browser | claxedo | bootstrap-pending-storm | bootstrap_drain_ms | lower | 25 | 15 | 40% | improved |
| browser | claxedo | bootstrap-pending-storm | bootstrap_pending_requests | lower | 0 | 0 | 0% | same |
| browser | claxedo | bootstrap-pending-storm | bootstrap_throttle_inflight_after | lower | 0 | 0 | 0% | same |
| browser | claxedo | bootstrap-pending-storm | bootstrap_throttle_queued_after | lower | 0 | 0 | 0% | same |
| browser | claxedo | burst-authed-fetches | burst_failures | lower | 0 | 0 | 0% | same |
| browser | claxedo | burst-authed-fetches | burst_per_request_p95_ms | lower | 6 | 20 | -233.33% | regressed |
| browser | claxedo | burst-authed-fetches | burst_throttle_queued_peak | lower | 4 | 6 | -50% | regressed |
| browser | claxedo | burst-authed-fetches | burst_total_drain_ms | lower | 7 | 22 | -214.29% | regressed |
| browser | claxedo | command-palette-large-project | command_execution_overhead_ms | lower | 128.40 | 127.80 | 0.47% | improved |
| browser | claxedo | command-palette-large-project | command_palette_index_ms | lower | 2.51 | 1.92 | 23.83% | improved |
| browser | claxedo | command-palette-large-project | command_palette_open_ms | lower | 13.70 | 26.90 | -96.35% | regressed |
| browser | claxedo | command-palette-large-project | command_palette_search_ms | lower | 46.20 | 10.20 | 77.92% | improved |
| browser | claxedo | large-diff-toggle | changed_file_navigation_ms | lower | 3.70 | 3.20 | 13.51% | improved |
| browser | claxedo | large-diff-toggle | diff_toggle_latency_ms | lower | 24.20 | 23.90 | 1.24% | improved |
| browser | claxedo | large-diff-toggle | hunk_render_ms | lower | 0 | 0 | 0% | same |
| browser | claxedo | large-diff-toggle | line_comment_latency_ms | lower | 15.20 | 15 | 1.32% | improved |
| browser | claxedo | large-diff-toggle | review_panel_open_ms | lower | 13.90 | 10.80 | 22.30% | improved |
| browser | claxedo | large-diff-toggle | review_panel_reopen_baseline_frame_ms | lower | 6.40 | 7 | -9.37% | regressed |
| browser | claxedo | large-diff-toggle | review_panel_reopen_click_ms | lower | 0.30 | 0.30 | 0% | same |
| browser | claxedo | large-diff-toggle | review_panel_reopen_frame_ms | lower | 4.90 | 23.60 | -381.63% | regressed |
| browser | claxedo | large-diff-toggle | review_panel_reopen_ms | lower | 8.20 | 27 | -229.27% | regressed |
| browser | claxedo | large-diff-toggle | review_panel_reopen_state_ms | lower | 0 | 0 | 0% | same |
| browser | claxedo | large-diff-toggle | vcs_load_ms | lower | 33.80 | 14.30 | 57.69% | improved |
| browser | claxedo | launch-empty-home | launch_first_input_ms | lower | 3.04 | 9.49 | -212.09% | regressed |
| browser | claxedo | launch-empty-home | launch_first_useful_screen_ms | lower | 4464.49 | 6203.42 | -38.95% | regressed |
| browser | claxedo | launch-empty-home | launch_first_window_ms | lower | 4375.85 | 6113.62 | -39.71% | regressed |
| browser | claxedo | launch-empty-home | launch_workspace_ready_ms | lower | 9469.80 | 11210.26 | -18.38% | regressed |
| browser | claxedo | launch-empty-home | memory_rss_mb | lower | 92.89 | 92.89 | 0% | same |
| browser | claxedo | launch-project-20-sessions | launch_first_window_ms | lower | 581.93 | 396.36 | 31.89% | improved |
| browser | claxedo | launch-project-20-sessions | launch_workspace_ready_ms | lower | 5682.32 | 5492.81 | 3.34% | improved |
| browser | claxedo | launch-project-20-sessions | memory_rss_mb | lower | 98.23 | 87.45 | 10.97% | improved |
| browser | claxedo | launch-project-20-sessions | transcript_render_ms | lower | 10005.30 | 81.80 | 99.18% | improved |
| browser | claxedo | live-terminal-switch | ansi_render_latency_ms | lower | 0.77 | 1.12 | -44.93% | regressed |
| browser | claxedo | live-terminal-switch | pty_attach_ms | lower | 3.59 | 2.15 | 40.29% | improved |
| browser | claxedo | live-terminal-switch | surface_switch_latency_ms | lower | 13.90 | 22.80 | -64.03% | regressed |
| browser | claxedo | live-terminal-switch | terminal_reconnect_latency_ms | lower | 36.10 | 32.97 | 8.68% | improved |
| browser | claxedo | live-terminal-switch | terminal_resize_latency_ms | lower | 23.30 | 28.70 | -23.18% | regressed |
| browser | claxedo | live-terminal-switch | terminal_throughput_lines_per_s | higher | 300000 | 300000 | 0% | same |
| browser | claxedo | long-session-switch | incremental_append_latency_ms | lower | 0.73 | 0.71 | 2.29% | improved |
| browser | claxedo | long-session-switch | memory_growth_mb | lower | 6.59 | 7.00 | -6.13% | regressed |
| browser | claxedo | long-session-switch | scroll_latency_ms | lower | 19.64 | 22.22 | -13.14% | regressed |
| browser | claxedo | long-session-switch | surface_switch_latency_ms | lower | 143.80 | 137.72 | 4.23% | improved |
| browser | claxedo | long-session-switch | tool_block_toggle_latency_ms | lower | 2.18 | 2.01 | 7.93% | improved |
| browser | claxedo | long-session-switch | transcript_render_ms | lower | 1.15 | 1.18 | -2.57% | regressed |
| browser | claxedo | session-switch-stress | memory_growth_mb | lower | 10.40 | 8.75 | 15.87% | improved |
| browser | claxedo | session-switch-stress | session_switch_first_fold_ms | lower | 15.30 | 14 | 8.50% | improved |
| browser | claxedo | session-switch-stress | session_switch_hot_path_api_100ms | lower | 0 | 0 | 0% | same |
| browser | claxedo | session-switch-stress | session_switch_hot_path_api_30ms | lower | 0 | 0 | 0% | same |
| browser | claxedo | session-switch-stress | session_switch_loader_fraction | lower | 0 | 0 | 0% | same |
| browser | claxedo | session-switch-stress | session_switch_max_call_stack | lower | 0 | 0 | 0% | same |
| browser | claxedo | session-switch-stress | surface_switch_latency_ms | lower | 54.60 | 52.60 | 3.66% | improved |
| browser | claxedo | session-switch-stress | transcript_render_ms | lower | 40.60 | 39.10 | 3.69% | improved |
| browser | claxedo | theme-switch | animation_jank | lower | 0 | 0 | 0% | same |
| browser | claxedo | theme-switch | dropped_frames | lower | 0 | 0 | 0% | same |
| browser | claxedo | theme-switch | frame_time_ms | lower | 5.66 | 5.94 | -4.85% | regressed |
| browser | claxedo | theme-switch | refresh_rate_stability | higher | 0.99 | 0.99 | 0% | same |
| browser | claxedo | theme-switch | theme_switch_latency_ms | lower | 1.46 | 0.82 | 44% | improved |
| browser | claxedo | three-pane-resize | diff_toggle_latency_ms | lower | 3.03 | 2.91 | 4.12% | improved |
| browser | claxedo | three-pane-resize | dropped_frames | lower | 0 | 0 | 0% | same |
| browser | claxedo | three-pane-resize | frame_time_ms | lower | 8.40 | 8.40 | 0% | same |
| browser | claxedo | three-pane-resize | scroll_latency_ms | lower | 24.88 | 24.96 | -0.32% | regressed |
| browser | claxedo | three-pane-resize | terminal_resize_latency_ms | lower | 128.50 | 151.10 | -17.59% | regressed |
| browser | claxedo | workspace-switch | file_tree_control_ms | lower | 13.80 | 13.60 | 1.45% | improved |
| browser | claxedo | workspace-switch | file_tree_data_ms | lower | 1936.70 | 8.90 | 99.54% | improved |
| browser | claxedo | workspace-switch | file_tree_first_frame_ms | lower | 21.80 | 21.40 | 1.83% | improved |
| browser | claxedo | workspace-switch | file_tree_load_ms | lower | 21.80 | 21.40 | 1.83% | improved |
| browser | claxedo | workspace-switch | file_tree_state_ms | lower | 7.90 | 7.80 | 1.27% | improved |
| browser | claxedo | workspace-switch | surface_switch_latency_ms | lower | 0 | 0 | 0% | same |
| browser | claxedo | workspace-switch | workspace_bootstrap_ms | lower | 3.93 | 1.38 | 64.79% | improved |
| browser | claxedo | workspace-switch | workspace_switch_ms | lower | 336.10 | 312.06 | 7.15% | improved |

## Scenario Failures

| Adapter | Target | Scenario | Failure |
| --- | --- | --- | --- |
| browser | claxedo | launch-empty-home | launch_first_window_ms p95 6113.615583 > 5664 |
| browser | claxedo | launch-empty-home | launch_first_useful_screen_ms p95 6203.419833 > 5720 |

## Source Report

# Claxedo Performance Report

Generated: 2026-06-06T20:21:46.063Z

Adapters: browser
Targets: Claxedo app
Scenario runs: 13
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_window_ms | 6113.62 | 6113.62 | ms | fail | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_useful_screen_ms | 6203.42 | 6203.42 | ms | fail | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_workspace_ready_ms | 11210.26 | 11210.26 | ms | fail | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_input_ms | 9.49 | 9.49 | ms | fail | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | memory_rss_mb | 92.89 | 92.89 | MB | fail | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_first_window_ms | 396.36 | 396.36 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_workspace_ready_ms | 5492.81 | 5492.81 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms | 81.80 | 81.80 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | memory_rss_mb | 87.45 | 87.45 | MB | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms | 137.72 | 137.72 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | transcript_render_ms | 1.18 | 1.18 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | scroll_latency_ms | 22.22 | 22.22 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | incremental_append_latency_ms | 0.71 | 0.71 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | tool_block_toggle_latency_ms | 2.01 | 2.01 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | memory_growth_mb | 7.00 | 7.00 | MB | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_pending_requests | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_drain_ms | 15 | 15 | ms | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_inflight_after | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_queued_after | 0 | 0 | requests | pass | reports/videos/claxedo-bootstrap-pending-storm-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_total_drain_ms | 22 | 22 | ms | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_per_request_p95_ms | 20 | 20 | ms | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_failures | 0 | 0 | errors | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | burst-authed-fetches | burst_throttle_queued_peak | 6 | 6 | requests | pass | reports/videos/claxedo-burst-authed-fetches-1.webm |
| browser | Claxedo app | session-switch-stress | surface_switch_latency_ms | 52.60 | 52.60 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | transcript_render_ms | 39.10 | 39.10 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_first_fold_ms | 14 | 14 | ms | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_30ms | 0 | 0 | requests | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_hot_path_api_100ms | 0 | 0 | requests | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_max_call_stack | 0 | 0 | errors | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | session_switch_loader_fraction | 0 | 0 | ratio | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | session-switch-stress | memory_growth_mb | 8.75 | 8.75 | MB | pass | reports/videos/claxedo-session-switch-stress-1.webm |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms | 22.80 | 22.80 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | pty_attach_ms | 2.15 | 2.15 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms | 28.70 | 28.70 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_reconnect_latency_ms | 32.97 | 32.97 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | ansi_render_latency_ms | 1.12 | 1.12 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_open_ms | 10.80 | 10.80 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 14.30 | 14.30 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 0 | 0 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 23.90 | 23.90 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_ms | 27 | 27 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_baseline_frame_ms | 7 | 7 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_click_ms | 0.30 | 0.30 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_state_ms | 0 | 0 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | review_panel_reopen_frame_ms | 23.60 | 23.60 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 15 | 15 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 3.20 | 3.20 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 1.38 | 1.38 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 312.06 | 312.06 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 21.40 | 21.40 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_control_ms | 13.60 | 13.60 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_state_ms | 7.80 | 7.80 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_first_frame_ms | 21.40 | 21.40 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_data_ms | 8.90 | 8.90 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 0 | 0 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_index_ms | 1.92 | 1.92 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms | 26.90 | 26.90 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms | 10.20 | 10.20 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms | 127.80 | 127.80 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | theme-switch | theme_switch_latency_ms | 0.82 | 0.82 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | frame_time_ms | 5.94 | 5.94 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | refresh_rate_stability | 0.99 | 0.99 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | animation_jank | 0 | 0 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | three-pane-resize | frame_time_ms | 8.40 | 8.40 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | scroll_latency_ms | 24.96 | 24.96 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms | 151.10 | 151.10 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | diff_toggle_latency_ms | 2.91 | 2.91 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_action_dispatch_ms | 18.33 | 18.33 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_state_verify_ms | 0.49 | 0.49 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | surface_switch_latency_ms | 0.59 | 0.59 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | command_execution_overhead_ms | 0.28 | 0.28 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | event_backlog | 250 | 250 | events | pass | reports/videos/claxedo-agent-control-navigation-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_window_ms p95 6113.615583 > 5664 | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_useful_screen_ms p95 6203.419833 > 5720 | reports/videos/claxedo-launch-empty-home-1.webm |
