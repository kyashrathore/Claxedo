# Claxedo Performance Report

Generated: 2026-05-25T05:13:46.695Z

Adapters: deterministic
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 26
Failures: 6

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| deterministic | Claxedo app | launch-empty-home | launch_first_window_ms | 449.08 | 462.17 | ms | pass |  |
| deterministic | Claxedo app | launch-empty-home | launch_first_useful_screen_ms | 652.24 | 671.25 | ms | pass |  |
| deterministic | Claxedo app | launch-empty-home | launch_workspace_ready_ms | 759.16 | 781.29 | ms | pass |  |
| deterministic | Claxedo app | launch-empty-home | launch_first_input_ms | 812.62 | 836.32 | ms | pass |  |
| deterministic | Claxedo app | launch-empty-home | memory_rss_mb | 245.92 | 253.10 | MB | pass |  |
| deterministic | Upstream OpenCode app | launch-empty-home | launch_first_window_ms | 395.19 | 406.71 | ms | pass |  |
| deterministic | Upstream OpenCode app | launch-empty-home | launch_first_useful_screen_ms | 573.97 | 590.70 | ms | pass |  |
| deterministic | Upstream OpenCode app | launch-empty-home | launch_workspace_ready_ms | 668.06 | 687.54 | ms | pass |  |
| deterministic | Upstream OpenCode app | launch-empty-home | launch_first_input_ms | 715.11 | 735.96 | ms | pass |  |
| deterministic | Upstream OpenCode app | launch-empty-home | memory_rss_mb | 201.66 | 207.54 | MB | pass |  |
| deterministic | Claxedo app | launch-project-20-sessions | launch_first_window_ms | 517.06 | 540.76 | ms | pass |  |
| deterministic | Claxedo app | launch-project-20-sessions | launch_workspace_ready_ms | 1319.04 | 1379.50 | ms | pass |  |
| deterministic | Claxedo app | launch-project-20-sessions | transcript_render_ms | 337.67 | 353.15 | ms | pass |  |
| deterministic | Claxedo app | launch-project-20-sessions | memory_rss_mb | 327.12 | 342.11 | MB | pass |  |
| deterministic | Upstream OpenCode app | launch-project-20-sessions | launch_first_window_ms | 455.01 | 475.87 | ms | pass |  |
| deterministic | Upstream OpenCode app | launch-project-20-sessions | launch_workspace_ready_ms | 1160.75 | 1213.96 | ms | pass |  |
| deterministic | Upstream OpenCode app | launch-project-20-sessions | transcript_render_ms | 310.66 | 324.90 | ms | pass |  |
| deterministic | Upstream OpenCode app | launch-project-20-sessions | memory_rss_mb | 268.24 | 280.53 | MB | pass |  |
| deterministic | Claxedo app | long-session-switch | surface_switch_latency_ms | 138.92 | 152.63 | ms | pass |  |
| deterministic | Claxedo app | long-session-switch | transcript_render_ms | 373.64 | 410.53 | ms | pass |  |
| deterministic | Claxedo app | long-session-switch | scroll_latency_ms | 32.57 | 35.79 | ms | pass |  |
| deterministic | Claxedo app | long-session-switch | incremental_append_latency_ms | 17.24 | 18.95 | ms | pass |  |
| deterministic | Claxedo app | long-session-switch | tool_block_toggle_latency_ms | 40.24 | 44.21 | ms | pass |  |
| deterministic | Claxedo app | long-session-switch | memory_growth_mb | 26.83 | 29.47 | MB | pass |  |
| deterministic | Upstream OpenCode app | long-session-switch | surface_switch_latency_ms | 161.14 | 177.05 | ms | pass |  |
| deterministic | Upstream OpenCode app | long-session-switch | transcript_render_ms | 343.74 | 377.69 | ms | pass |  |
| deterministic | Upstream OpenCode app | long-session-switch | scroll_latency_ms | 29.97 | 32.93 | ms | pass |  |
| deterministic | Upstream OpenCode app | long-session-switch | incremental_append_latency_ms | 17.24 | 18.95 | ms | pass |  |
| deterministic | Upstream OpenCode app | long-session-switch | tool_block_toggle_latency_ms | 37.02 | 40.67 | ms | pass |  |
| deterministic | Upstream OpenCode app | long-session-switch | memory_growth_mb | 22.00 | 24.17 | MB | pass |  |
| deterministic | Claxedo app | bootstrap-pending-storm | bootstrap_pending_requests | NaN | NaN | requests | fail |  |
| deterministic | Claxedo app | bootstrap-pending-storm | bootstrap_drain_ms | 1497.04 | 1624.66 | ms | fail |  |
| deterministic | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_inflight_after | NaN | NaN | requests | fail |  |
| deterministic | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_queued_after | NaN | NaN | requests | fail |  |
| deterministic | Upstream OpenCode app | bootstrap-pending-storm | bootstrap_pending_requests | NaN | NaN | requests | fail |  |
| deterministic | Upstream OpenCode app | bootstrap-pending-storm | bootstrap_drain_ms | 1497.04 | 1624.66 | ms | fail |  |
| deterministic | Upstream OpenCode app | bootstrap-pending-storm | bootstrap_throttle_inflight_after | NaN | NaN | requests | fail |  |
| deterministic | Upstream OpenCode app | bootstrap-pending-storm | bootstrap_throttle_queued_after | NaN | NaN | requests | fail |  |
| deterministic | Claxedo app | burst-authed-fetches | burst_total_drain_ms | 1497.04 | 1624.66 | ms | fail |  |
| deterministic | Claxedo app | burst-authed-fetches | burst_per_request_p95_ms | 249.51 | 270.78 | ms | fail |  |
| deterministic | Claxedo app | burst-authed-fetches | burst_failures | NaN | NaN | errors | fail |  |
| deterministic | Claxedo app | burst-authed-fetches | burst_throttle_queued_peak | 29.94 | 32.49 | requests | fail |  |
| deterministic | Upstream OpenCode app | burst-authed-fetches | burst_total_drain_ms | 1497.04 | 1624.66 | ms | fail |  |
| deterministic | Upstream OpenCode app | burst-authed-fetches | burst_per_request_p95_ms | 249.51 | 270.78 | ms | fail |  |
| deterministic | Upstream OpenCode app | burst-authed-fetches | burst_failures | NaN | NaN | errors | fail |  |
| deterministic | Upstream OpenCode app | burst-authed-fetches | burst_throttle_queued_peak | 29.94 | 32.49 | requests | fail |  |
| deterministic | Claxedo app | session-switch-stress | surface_switch_latency_ms | 119.76 | 129.97 | ms | fail |  |
| deterministic | Claxedo app | session-switch-stress | transcript_render_ms | 389.23 | 422.41 | ms | fail |  |
| deterministic | Claxedo app | session-switch-stress | session_switch_max_call_stack | NaN | NaN | errors | fail |  |
| deterministic | Claxedo app | session-switch-stress | session_switch_loader_fraction | 0.40 | 0.43 | ratio | fail |  |
| deterministic | Claxedo app | session-switch-stress | memory_growth_mb | 79.84 | 86.65 | MB | fail |  |
| deterministic | Upstream OpenCode app | session-switch-stress | surface_switch_latency_ms | 138.93 | 150.77 | ms | fail |  |
| deterministic | Upstream OpenCode app | session-switch-stress | transcript_render_ms | 358.09 | 388.62 | ms | fail |  |
| deterministic | Upstream OpenCode app | session-switch-stress | session_switch_max_call_stack | NaN | NaN | errors | fail |  |
| deterministic | Upstream OpenCode app | session-switch-stress | session_switch_loader_fraction | 0.40 | 0.43 | ratio | fail |  |
| deterministic | Upstream OpenCode app | session-switch-stress | memory_growth_mb | 65.47 | 71.05 | MB | fail |  |
| deterministic | Claxedo app | live-terminal-switch | surface_switch_latency_ms | 127.06 | 132.37 | ms | pass |  |
| deterministic | Claxedo app | live-terminal-switch | pty_attach_ms | 79.42 | 82.73 | ms | pass |  |
| deterministic | Claxedo app | live-terminal-switch | terminal_throughput_lines_per_s | 18794.75 | 19391.79 | lines/s | pass |  |
| deterministic | Claxedo app | live-terminal-switch | terminal_resize_latency_ms | 42.35 | 44.12 | ms | pass |  |
| deterministic | Claxedo app | live-terminal-switch | terminal_reconnect_latency_ms | 100.59 | 104.79 | ms | pass |  |
| deterministic | Claxedo app | live-terminal-switch | ansi_render_latency_ms | 58.24 | 60.67 | ms | pass |  |
| deterministic | Upstream OpenCode app | live-terminal-switch | surface_switch_latency_ms | 147.39 | 153.55 | ms | pass |  |
| deterministic | Upstream OpenCode app | live-terminal-switch | pty_attach_ms | 96.89 | 100.93 | ms | pass |  |
| deterministic | Upstream OpenCode app | live-terminal-switch | terminal_throughput_lines_per_s | 14659.91 | 15125.60 | lines/s | pass |  |
| deterministic | Upstream OpenCode app | live-terminal-switch | terminal_resize_latency_ms | 51.67 | 53.83 | ms | pass |  |
| deterministic | Upstream OpenCode app | live-terminal-switch | terminal_reconnect_latency_ms | 122.72 | 127.85 | ms | pass |  |
| deterministic | Upstream OpenCode app | live-terminal-switch | ansi_render_latency_ms | 68.72 | 71.59 | ms | pass |  |
| deterministic | Claxedo app | large-diff-toggle | vcs_load_ms | 832.07 | 858.97 | ms | pass |  |
| deterministic | Claxedo app | large-diff-toggle | hunk_render_ms | 277.36 | 286.32 | ms | pass |  |
| deterministic | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 122.68 | 126.64 | ms | pass |  |
| deterministic | Claxedo app | large-diff-toggle | line_comment_latency_ms | 42.67 | 44.05 | ms | pass |  |
| deterministic | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 69.34 | 71.58 | ms | pass |  |
| deterministic | Upstream OpenCode app | large-diff-toggle | vcs_load_ms | 832.07 | 858.97 | ms | pass |  |
| deterministic | Upstream OpenCode app | large-diff-toggle | hunk_render_ms | 277.36 | 286.32 | ms | pass |  |
| deterministic | Upstream OpenCode app | large-diff-toggle | diff_toggle_latency_ms | 122.68 | 126.64 | ms | pass |  |
| deterministic | Upstream OpenCode app | large-diff-toggle | line_comment_latency_ms | 42.67 | 44.05 | ms | pass |  |
| deterministic | Upstream OpenCode app | large-diff-toggle | changed_file_navigation_ms | 69.34 | 71.58 | ms | pass |  |
| deterministic | Claxedo app | workspace-switch | workspace_bootstrap_ms | 1168.67 | 1212.64 | ms | pass |  |
| deterministic | Claxedo app | workspace-switch | workspace_switch_ms | 201.86 | 209.46 | ms | pass |  |
| deterministic | Claxedo app | workspace-switch | file_tree_load_ms | 223.11 | 231.50 | ms | pass |  |
| deterministic | Claxedo app | workspace-switch | surface_switch_latency_ms | 159.36 | 165.36 | ms | pass |  |
| deterministic | Upstream OpenCode app | workspace-switch | workspace_bootstrap_ms | 1110.23 | 1152.01 | ms | pass |  |
| deterministic | Upstream OpenCode app | workspace-switch | workspace_switch_ms | 191.77 | 198.98 | ms | pass |  |
| deterministic | Upstream OpenCode app | workspace-switch | file_tree_load_ms | 211.95 | 219.93 | ms | pass |  |
| deterministic | Upstream OpenCode app | workspace-switch | surface_switch_latency_ms | 184.86 | 191.82 | ms | pass |  |
| deterministic | Claxedo app | command-palette-large-project | command_palette_index_ms | 535.50 | 569.00 | ms | pass |  |
| deterministic | Claxedo app | command-palette-large-project | command_palette_open_ms | 49.43 | 52.52 | ms | pass |  |
| deterministic | Claxedo app | command-palette-large-project | command_palette_search_ms | 22.66 | 24.07 | ms | pass |  |
| deterministic | Claxedo app | command-palette-large-project | command_execution_overhead_ms | 18.54 | 19.70 | ms | pass |  |
| deterministic | Upstream OpenCode app | command-palette-large-project | command_palette_index_ms | 481.95 | 512.10 | ms | pass |  |
| deterministic | Upstream OpenCode app | command-palette-large-project | command_palette_open_ms | 44.49 | 47.27 | ms | pass |  |
| deterministic | Upstream OpenCode app | command-palette-large-project | command_palette_search_ms | 20.39 | 21.67 | ms | pass |  |
| deterministic | Upstream OpenCode app | command-palette-large-project | command_execution_overhead_ms | 18.54 | 19.70 | ms | pass |  |
| deterministic | Claxedo app | theme-switch | theme_switch_latency_ms | 93.49 | 97.01 | ms | pass |  |
| deterministic | Claxedo app | theme-switch | frame_time_ms | 18.44 | 19.04 | ms | pass |  |
| deterministic | Claxedo app | theme-switch | dropped_frames | 2.62 | 3.02 | frames | pass |  |
| deterministic | Claxedo app | theme-switch | refresh_rate_stability | 0.99 | 0.99 | ratio | pass |  |
| deterministic | Claxedo app | theme-switch | animation_jank | 0.05 | 0.05 | ratio | pass |  |
| deterministic | Upstream OpenCode app | theme-switch | theme_switch_latency_ms | 89.75 | 93.13 | ms | pass |  |
| deterministic | Upstream OpenCode app | theme-switch | frame_time_ms | 17.70 | 18.27 | ms | pass |  |
| deterministic | Upstream OpenCode app | theme-switch | dropped_frames | 2.52 | 2.90 | frames | pass |  |
| deterministic | Upstream OpenCode app | theme-switch | refresh_rate_stability | 0.99 | 0.99 | ratio | pass |  |
| deterministic | Upstream OpenCode app | theme-switch | animation_jank | 0.05 | 0.05 | ratio | pass |  |
| deterministic | Claxedo app | three-pane-resize | frame_time_ms | 17.51 | 18.89 | ms | pass |  |
| deterministic | Claxedo app | three-pane-resize | dropped_frames | 3.51 | 4.50 | frames | pass |  |
| deterministic | Claxedo app | three-pane-resize | scroll_latency_ms | 36.51 | 39.51 | ms | pass |  |
| deterministic | Claxedo app | three-pane-resize | terminal_resize_latency_ms | 49.96 | 54.06 | ms | pass |  |
| deterministic | Claxedo app | three-pane-resize | diff_toggle_latency_ms | 100.88 | 109.16 | ms | pass |  |
| deterministic | Upstream OpenCode app | three-pane-resize | frame_time_ms | 16.81 | 18.14 | ms | pass |  |
| deterministic | Upstream OpenCode app | three-pane-resize | dropped_frames | 3.37 | 4.32 | frames | pass |  |
| deterministic | Upstream OpenCode app | three-pane-resize | scroll_latency_ms | 33.59 | 36.35 | ms | pass |  |
| deterministic | Upstream OpenCode app | three-pane-resize | terminal_resize_latency_ms | 60.95 | 65.95 | ms | pass |  |
| deterministic | Upstream OpenCode app | three-pane-resize | diff_toggle_latency_ms | 100.88 | 109.16 | ms | pass |  |
| deterministic | Claxedo app | agent-control-navigation | agent_action_dispatch_ms | 15.95 | 18.08 | ms | pass |  |
| deterministic | Claxedo app | agent-control-navigation | agent_state_verify_ms | 27.93 | 31.12 | ms | pass |  |
| deterministic | Claxedo app | agent-control-navigation | surface_switch_latency_ms | 91.82 | 99.65 | ms | pass |  |
| deterministic | Claxedo app | agent-control-navigation | command_execution_overhead_ms | 19.96 | 21.66 | ms | pass |  |
| deterministic | Claxedo app | agent-control-navigation | event_backlog | 2.98 | 4.04 | events | pass |  |
| deterministic | Upstream OpenCode app | agent-control-navigation | agent_action_dispatch_ms | 19.14 | 21.69 | ms | pass |  |
| deterministic | Upstream OpenCode app | agent-control-navigation | agent_state_verify_ms | 33.51 | 37.34 | ms | pass |  |
| deterministic | Upstream OpenCode app | agent-control-navigation | surface_switch_latency_ms | 106.51 | 115.59 | ms | pass |  |
| deterministic | Upstream OpenCode app | agent-control-navigation | command_execution_overhead_ms | 19.96 | 21.66 | ms | pass |  |
| deterministic | Upstream OpenCode app | agent-control-navigation | event_backlog | 3.57 | 4.85 | events | pass |  |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| deterministic | Claxedo app | bootstrap-pending-storm | bootstrap_pending_requests p95 NaN > null |  |
| deterministic | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_inflight_after p95 NaN > null |  |
| deterministic | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_queued_after p95 NaN > null |  |
| deterministic | Upstream OpenCode app | bootstrap-pending-storm | bootstrap_pending_requests p95 NaN > null |  |
| deterministic | Upstream OpenCode app | bootstrap-pending-storm | bootstrap_throttle_inflight_after p95 NaN > null |  |
| deterministic | Upstream OpenCode app | bootstrap-pending-storm | bootstrap_throttle_queued_after p95 NaN > null |  |
| deterministic | Claxedo app | burst-authed-fetches | burst_failures p95 NaN > null |  |
| deterministic | Upstream OpenCode app | burst-authed-fetches | burst_failures p95 NaN > null |  |
| deterministic | Claxedo app | session-switch-stress | session_switch_max_call_stack p95 NaN > null |  |
| deterministic | Upstream OpenCode app | session-switch-stress | session_switch_max_call_stack p95 NaN > null |  |

## Target Comparison

| Adapter | Scenario | Metric | Faster target | Claxedo p95 | Upstream p95 | Faster by |
| --- | --- | --- | --- | ---: | ---: | ---: |
| deterministic | launch-empty-home | launch_first_window_ms | Upstream OpenCode app | 462.17 | 406.71 | 12.00% |
| deterministic | launch-empty-home | launch_first_useful_screen_ms | Upstream OpenCode app | 671.25 | 590.70 | 12.00% |
| deterministic | launch-empty-home | launch_workspace_ready_ms | Upstream OpenCode app | 781.29 | 687.54 | 12.00% |
| deterministic | launch-empty-home | launch_first_input_ms | Upstream OpenCode app | 836.32 | 735.96 | 12% |
| deterministic | launch-empty-home | memory_rss_mb | Upstream OpenCode app | 253.10 | 207.54 | 18.00% |
| deterministic | launch-project-20-sessions | launch_first_window_ms | Upstream OpenCode app | 540.76 | 475.87 | 12.00% |
| deterministic | launch-project-20-sessions | launch_workspace_ready_ms | Upstream OpenCode app | 1379.50 | 1213.96 | 12.00% |
| deterministic | launch-project-20-sessions | transcript_render_ms | Upstream OpenCode app | 353.15 | 324.90 | 8.00% |
| deterministic | launch-project-20-sessions | memory_rss_mb | Upstream OpenCode app | 342.11 | 280.53 | 18.00% |
| deterministic | long-session-switch | surface_switch_latency_ms | Claxedo app | 152.63 | 177.05 | 13.79% |
| deterministic | long-session-switch | transcript_render_ms | Upstream OpenCode app | 410.53 | 377.69 | 8.00% |
| deterministic | long-session-switch | scroll_latency_ms | Upstream OpenCode app | 35.79 | 32.93 | 8.00% |
| deterministic | long-session-switch | incremental_append_latency_ms | tie | 18.95 | 18.95 | 0% |
| deterministic | long-session-switch | tool_block_toggle_latency_ms | Upstream OpenCode app | 44.21 | 40.67 | 8.00% |
| deterministic | long-session-switch | memory_growth_mb | Upstream OpenCode app | 29.47 | 24.17 | 18.00% |
| deterministic | bootstrap-pending-storm | bootstrap_pending_requests | Upstream OpenCode app | NaN | NaN | NaN% |
| deterministic | bootstrap-pending-storm | bootstrap_drain_ms | tie | 1624.66 | 1624.66 | 0% |
| deterministic | bootstrap-pending-storm | bootstrap_throttle_inflight_after | Upstream OpenCode app | NaN | NaN | NaN% |
| deterministic | bootstrap-pending-storm | bootstrap_throttle_queued_after | Upstream OpenCode app | NaN | NaN | NaN% |
| deterministic | burst-authed-fetches | burst_total_drain_ms | tie | 1624.66 | 1624.66 | 0% |
| deterministic | burst-authed-fetches | burst_per_request_p95_ms | tie | 270.78 | 270.78 | 0% |
| deterministic | burst-authed-fetches | burst_failures | Upstream OpenCode app | NaN | NaN | NaN% |
| deterministic | burst-authed-fetches | burst_throttle_queued_peak | tie | 32.49 | 32.49 | 0% |
| deterministic | session-switch-stress | surface_switch_latency_ms | Claxedo app | 129.97 | 150.77 | 13.79% |
| deterministic | session-switch-stress | transcript_render_ms | Upstream OpenCode app | 422.41 | 388.62 | 8.00% |
| deterministic | session-switch-stress | session_switch_max_call_stack | Upstream OpenCode app | NaN | NaN | NaN% |
| deterministic | session-switch-stress | session_switch_loader_fraction | tie | 0.43 | 0.43 | 0% |
| deterministic | session-switch-stress | memory_growth_mb | Upstream OpenCode app | 86.65 | 71.05 | 18% |
| deterministic | live-terminal-switch | surface_switch_latency_ms | Claxedo app | 132.37 | 153.55 | 13.79% |
| deterministic | live-terminal-switch | pty_attach_ms | Claxedo app | 82.73 | 100.93 | 18.03% |
| deterministic | live-terminal-switch | terminal_throughput_lines_per_s | Claxedo app | 19391.79 | 15125.60 | 28.21% |
| deterministic | live-terminal-switch | terminal_resize_latency_ms | Claxedo app | 44.12 | 53.83 | 18.03% |
| deterministic | live-terminal-switch | terminal_reconnect_latency_ms | Claxedo app | 104.79 | 127.85 | 18.03% |
| deterministic | live-terminal-switch | ansi_render_latency_ms | Claxedo app | 60.67 | 71.59 | 15.25% |
| deterministic | large-diff-toggle | vcs_load_ms | tie | 858.97 | 858.97 | 0% |
| deterministic | large-diff-toggle | hunk_render_ms | tie | 286.32 | 286.32 | 0% |
| deterministic | large-diff-toggle | diff_toggle_latency_ms | tie | 126.64 | 126.64 | 0% |
| deterministic | large-diff-toggle | line_comment_latency_ms | tie | 44.05 | 44.05 | 0% |
| deterministic | large-diff-toggle | changed_file_navigation_ms | tie | 71.58 | 71.58 | 0% |
| deterministic | workspace-switch | workspace_bootstrap_ms | Upstream OpenCode app | 1212.64 | 1152.01 | 5.00% |
| deterministic | workspace-switch | workspace_switch_ms | Upstream OpenCode app | 209.46 | 198.98 | 5.00% |
| deterministic | workspace-switch | file_tree_load_ms | Upstream OpenCode app | 231.50 | 219.93 | 5.00% |
| deterministic | workspace-switch | surface_switch_latency_ms | Claxedo app | 165.36 | 191.82 | 13.79% |
| deterministic | command-palette-large-project | command_palette_index_ms | Upstream OpenCode app | 569.00 | 512.10 | 10.00% |
| deterministic | command-palette-large-project | command_palette_open_ms | Upstream OpenCode app | 52.52 | 47.27 | 10.00% |
| deterministic | command-palette-large-project | command_palette_search_ms | Upstream OpenCode app | 24.07 | 21.67 | 10.00% |
| deterministic | command-palette-large-project | command_execution_overhead_ms | tie | 19.70 | 19.70 | 0% |
| deterministic | theme-switch | theme_switch_latency_ms | Upstream OpenCode app | 97.01 | 93.13 | 4.00% |
| deterministic | theme-switch | frame_time_ms | Upstream OpenCode app | 19.04 | 18.27 | 4.00% |
| deterministic | theme-switch | dropped_frames | Upstream OpenCode app | 3.02 | 2.90 | 4.00% |
| deterministic | theme-switch | refresh_rate_stability | tie | 0.99 | 0.99 | 0% |
| deterministic | theme-switch | animation_jank | tie | 0.05 | 0.05 | 0% |
| deterministic | three-pane-resize | frame_time_ms | Upstream OpenCode app | 18.89 | 18.14 | 4.00% |
| deterministic | three-pane-resize | dropped_frames | Upstream OpenCode app | 4.50 | 4.32 | 4.00% |
| deterministic | three-pane-resize | scroll_latency_ms | Upstream OpenCode app | 39.51 | 36.35 | 8.00% |
| deterministic | three-pane-resize | terminal_resize_latency_ms | Claxedo app | 54.06 | 65.95 | 18.03% |
| deterministic | three-pane-resize | diff_toggle_latency_ms | tie | 109.16 | 109.16 | 0% |
| deterministic | agent-control-navigation | agent_action_dispatch_ms | Claxedo app | 18.08 | 21.69 | 16.67% |
| deterministic | agent-control-navigation | agent_state_verify_ms | Claxedo app | 31.12 | 37.34 | 16.67% |
| deterministic | agent-control-navigation | surface_switch_latency_ms | Claxedo app | 99.65 | 115.59 | 13.79% |
| deterministic | agent-control-navigation | command_execution_overhead_ms | tie | 21.66 | 21.66 | 0% |
| deterministic | agent-control-navigation | event_backlog | Claxedo app | 4.04 | 4.85 | 16.67% |
