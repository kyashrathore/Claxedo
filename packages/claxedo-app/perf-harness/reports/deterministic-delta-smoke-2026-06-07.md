# Claxedo Performance Delta Report

Generated: 2026-06-06T20:20:33.534Z
Input: deterministic-compare-2026-06-06.json
Status: fail

Improved: 0
Same: 49
Regressed: 0
Missing baselines: 75
Scenario failures: 0

| Adapter | Target | Scenario | Metric | Direction | Before p95 | After p95 | Delta | Status |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| deterministic | claxedo | agent-control-navigation | agent_action_dispatch_ms | lower | 18.08 | 18.08 | 0% | same |
| deterministic | claxedo | agent-control-navigation | agent_state_verify_ms | lower | 31.12 | 31.12 | 0% | same |
| deterministic | claxedo | agent-control-navigation | command_execution_overhead_ms | lower | 21.66 | 21.66 | 0% | same |
| deterministic | claxedo | agent-control-navigation | event_backlog | lower | 4.04 | 4.04 | 0% | same |
| deterministic | claxedo | agent-control-navigation | surface_switch_latency_ms | lower | 99.65 | 99.65 | 0% | same |
| deterministic | claxedo | bootstrap-pending-storm | bootstrap_drain_ms | lower |  | 1624.66 |  | missing-baseline |
| deterministic | claxedo | bootstrap-pending-storm | bootstrap_pending_requests | lower |  | 0 |  | missing-baseline |
| deterministic | claxedo | bootstrap-pending-storm | bootstrap_throttle_inflight_after | lower |  | 0 |  | missing-baseline |
| deterministic | claxedo | bootstrap-pending-storm | bootstrap_throttle_queued_after | lower |  | 0 |  | missing-baseline |
| deterministic | claxedo | burst-authed-fetches | burst_failures | lower |  | 0 |  | missing-baseline |
| deterministic | claxedo | burst-authed-fetches | burst_per_request_p95_ms | lower |  | 270.78 |  | missing-baseline |
| deterministic | claxedo | burst-authed-fetches | burst_throttle_queued_peak | lower |  | 32.49 |  | missing-baseline |
| deterministic | claxedo | burst-authed-fetches | burst_total_drain_ms | lower |  | 1624.66 |  | missing-baseline |
| deterministic | claxedo | command-palette-large-project | command_execution_overhead_ms | lower | 19.70 | 19.70 | 0% | same |
| deterministic | claxedo | command-palette-large-project | command_palette_index_ms | lower | 569.00 | 569.00 | 0% | same |
| deterministic | claxedo | command-palette-large-project | command_palette_open_ms | lower | 52.52 | 52.52 | 0% | same |
| deterministic | claxedo | command-palette-large-project | command_palette_search_ms | lower | 24.07 | 24.07 | 0% | same |
| deterministic | claxedo | large-diff-toggle | changed_file_navigation_ms | lower | 71.58 | 71.58 | 0% | same |
| deterministic | claxedo | large-diff-toggle | diff_toggle_latency_ms | lower | 126.64 | 126.64 | 0% | same |
| deterministic | claxedo | large-diff-toggle | hunk_render_ms | lower | 286.32 | 286.32 | 0% | same |
| deterministic | claxedo | large-diff-toggle | line_comment_latency_ms | lower | 44.05 | 44.05 | 0% | same |
| deterministic | claxedo | large-diff-toggle | vcs_load_ms | lower | 858.97 | 858.97 | 0% | same |
| deterministic | claxedo | launch-empty-home | launch_first_input_ms | lower | 836.32 | 836.32 | 0% | same |
| deterministic | claxedo | launch-empty-home | launch_first_useful_screen_ms | lower | 671.25 | 671.25 | 0% | same |
| deterministic | claxedo | launch-empty-home | launch_first_window_ms | lower | 462.17 | 462.17 | 0% | same |
| deterministic | claxedo | launch-empty-home | launch_workspace_ready_ms | lower | 781.29 | 781.29 | 0% | same |
| deterministic | claxedo | launch-empty-home | memory_rss_mb | lower | 253.10 | 253.10 | 0% | same |
| deterministic | claxedo | launch-project-20-sessions | launch_first_window_ms | lower | 540.76 | 540.76 | 0% | same |
| deterministic | claxedo | launch-project-20-sessions | launch_workspace_ready_ms | lower | 1379.50 | 1379.50 | 0% | same |
| deterministic | claxedo | launch-project-20-sessions | memory_rss_mb | lower | 342.11 | 342.11 | 0% | same |
| deterministic | claxedo | launch-project-20-sessions | transcript_render_ms | lower | 353.15 | 353.15 | 0% | same |
| deterministic | claxedo | live-terminal-switch | ansi_render_latency_ms | lower | 60.67 | 60.67 | 0% | same |
| deterministic | claxedo | live-terminal-switch | pty_attach_ms | lower | 82.73 | 82.73 | 0% | same |
| deterministic | claxedo | live-terminal-switch | surface_switch_latency_ms | lower | 132.37 | 132.37 | 0% | same |
| deterministic | claxedo | live-terminal-switch | terminal_reconnect_latency_ms | lower | 104.79 | 104.79 | 0% | same |
| deterministic | claxedo | live-terminal-switch | terminal_resize_latency_ms | lower | 44.12 | 44.12 | 0% | same |
| deterministic | claxedo | live-terminal-switch | terminal_throughput_lines_per_s | higher | 19391.79 | 19391.79 | 0% | same |
| deterministic | claxedo | long-session-switch | incremental_append_latency_ms | lower | 18.95 | 18.95 | 0% | same |
| deterministic | claxedo | long-session-switch | memory_growth_mb | lower | 29.47 | 29.47 | 0% | same |
| deterministic | claxedo | long-session-switch | scroll_latency_ms | lower | 35.79 | 35.79 | 0% | same |
| deterministic | claxedo | long-session-switch | surface_switch_latency_ms | lower | 152.63 | 152.63 | 0% | same |
| deterministic | claxedo | long-session-switch | tool_block_toggle_latency_ms | lower | 44.21 | 44.21 | 0% | same |
| deterministic | claxedo | long-session-switch | transcript_render_ms | lower | 410.53 | 410.53 | 0% | same |
| deterministic | claxedo | session-switch-stress | memory_growth_mb | lower |  | 86.65 |  | missing-baseline |
| deterministic | claxedo | session-switch-stress | session_switch_loader_fraction | lower |  | 0.43 |  | missing-baseline |
| deterministic | claxedo | session-switch-stress | session_switch_max_call_stack | lower |  | 0 |  | missing-baseline |
| deterministic | claxedo | session-switch-stress | surface_switch_latency_ms | lower |  | 129.97 |  | missing-baseline |
| deterministic | claxedo | session-switch-stress | transcript_render_ms | lower |  | 422.41 |  | missing-baseline |
| deterministic | claxedo | theme-switch | animation_jank | lower | 0.05 | 0.05 | 0% | same |
| deterministic | claxedo | theme-switch | dropped_frames | lower | 3.02 | 3.02 | 0% | same |
| deterministic | claxedo | theme-switch | frame_time_ms | lower | 19.04 | 19.04 | 0% | same |
| deterministic | claxedo | theme-switch | refresh_rate_stability | higher | 0.99 | 0.99 | 0% | same |
| deterministic | claxedo | theme-switch | theme_switch_latency_ms | lower | 97.01 | 97.01 | 0% | same |
| deterministic | claxedo | three-pane-resize | diff_toggle_latency_ms | lower | 109.16 | 109.16 | 0% | same |
| deterministic | claxedo | three-pane-resize | dropped_frames | lower | 4.50 | 4.50 | 0% | same |
| deterministic | claxedo | three-pane-resize | frame_time_ms | lower | 18.89 | 18.89 | 0% | same |
| deterministic | claxedo | three-pane-resize | scroll_latency_ms | lower | 39.51 | 39.51 | 0% | same |
| deterministic | claxedo | three-pane-resize | terminal_resize_latency_ms | lower | 54.06 | 54.06 | 0% | same |
| deterministic | claxedo | workspace-switch | file_tree_load_ms | lower | 231.50 | 231.50 | 0% | same |
| deterministic | claxedo | workspace-switch | surface_switch_latency_ms | lower | 165.36 | 165.36 | 0% | same |
| deterministic | claxedo | workspace-switch | workspace_bootstrap_ms | lower | 1212.64 | 1212.64 | 0% | same |
| deterministic | claxedo | workspace-switch | workspace_switch_ms | lower | 209.46 | 209.46 | 0% | same |
| deterministic | upstream | agent-control-navigation | agent_action_dispatch_ms | lower |  | 21.69 |  | missing-baseline |
| deterministic | upstream | agent-control-navigation | agent_state_verify_ms | lower |  | 37.34 |  | missing-baseline |
| deterministic | upstream | agent-control-navigation | command_execution_overhead_ms | lower |  | 21.66 |  | missing-baseline |
| deterministic | upstream | agent-control-navigation | event_backlog | lower |  | 4.85 |  | missing-baseline |
| deterministic | upstream | agent-control-navigation | surface_switch_latency_ms | lower |  | 115.59 |  | missing-baseline |
| deterministic | upstream | bootstrap-pending-storm | bootstrap_drain_ms | lower |  | 1624.66 |  | missing-baseline |
| deterministic | upstream | bootstrap-pending-storm | bootstrap_pending_requests | lower |  | 0 |  | missing-baseline |
| deterministic | upstream | bootstrap-pending-storm | bootstrap_throttle_inflight_after | lower |  | 0 |  | missing-baseline |
| deterministic | upstream | bootstrap-pending-storm | bootstrap_throttle_queued_after | lower |  | 0 |  | missing-baseline |
| deterministic | upstream | burst-authed-fetches | burst_failures | lower |  | 0 |  | missing-baseline |
| deterministic | upstream | burst-authed-fetches | burst_per_request_p95_ms | lower |  | 270.78 |  | missing-baseline |
| deterministic | upstream | burst-authed-fetches | burst_throttle_queued_peak | lower |  | 32.49 |  | missing-baseline |
| deterministic | upstream | burst-authed-fetches | burst_total_drain_ms | lower |  | 1624.66 |  | missing-baseline |
| deterministic | upstream | command-palette-large-project | command_execution_overhead_ms | lower |  | 19.70 |  | missing-baseline |
| deterministic | upstream | command-palette-large-project | command_palette_index_ms | lower |  | 512.10 |  | missing-baseline |
| deterministic | upstream | command-palette-large-project | command_palette_open_ms | lower |  | 47.27 |  | missing-baseline |
| deterministic | upstream | command-palette-large-project | command_palette_search_ms | lower |  | 21.67 |  | missing-baseline |
| deterministic | upstream | large-diff-toggle | changed_file_navigation_ms | lower |  | 71.58 |  | missing-baseline |
| deterministic | upstream | large-diff-toggle | diff_toggle_latency_ms | lower |  | 126.64 |  | missing-baseline |
| deterministic | upstream | large-diff-toggle | hunk_render_ms | lower |  | 286.32 |  | missing-baseline |
| deterministic | upstream | large-diff-toggle | line_comment_latency_ms | lower |  | 44.05 |  | missing-baseline |
| deterministic | upstream | large-diff-toggle | vcs_load_ms | lower |  | 858.97 |  | missing-baseline |
| deterministic | upstream | launch-empty-home | launch_first_input_ms | lower |  | 735.96 |  | missing-baseline |
| deterministic | upstream | launch-empty-home | launch_first_useful_screen_ms | lower |  | 590.70 |  | missing-baseline |
| deterministic | upstream | launch-empty-home | launch_first_window_ms | lower |  | 406.71 |  | missing-baseline |
| deterministic | upstream | launch-empty-home | launch_workspace_ready_ms | lower |  | 687.54 |  | missing-baseline |
| deterministic | upstream | launch-empty-home | memory_rss_mb | lower |  | 207.54 |  | missing-baseline |
| deterministic | upstream | launch-project-20-sessions | launch_first_window_ms | lower |  | 475.87 |  | missing-baseline |
| deterministic | upstream | launch-project-20-sessions | launch_workspace_ready_ms | lower |  | 1213.96 |  | missing-baseline |
| deterministic | upstream | launch-project-20-sessions | memory_rss_mb | lower |  | 280.53 |  | missing-baseline |
| deterministic | upstream | launch-project-20-sessions | transcript_render_ms | lower |  | 324.90 |  | missing-baseline |
| deterministic | upstream | live-terminal-switch | ansi_render_latency_ms | lower |  | 71.59 |  | missing-baseline |
| deterministic | upstream | live-terminal-switch | pty_attach_ms | lower |  | 100.93 |  | missing-baseline |
| deterministic | upstream | live-terminal-switch | surface_switch_latency_ms | lower |  | 153.55 |  | missing-baseline |
| deterministic | upstream | live-terminal-switch | terminal_reconnect_latency_ms | lower |  | 127.85 |  | missing-baseline |
| deterministic | upstream | live-terminal-switch | terminal_resize_latency_ms | lower |  | 53.83 |  | missing-baseline |
| deterministic | upstream | live-terminal-switch | terminal_throughput_lines_per_s | higher |  | 15125.60 |  | missing-baseline |
| deterministic | upstream | long-session-switch | incremental_append_latency_ms | lower |  | 18.95 |  | missing-baseline |
| deterministic | upstream | long-session-switch | memory_growth_mb | lower |  | 24.17 |  | missing-baseline |
| deterministic | upstream | long-session-switch | scroll_latency_ms | lower |  | 32.93 |  | missing-baseline |
| deterministic | upstream | long-session-switch | surface_switch_latency_ms | lower |  | 177.05 |  | missing-baseline |
| deterministic | upstream | long-session-switch | tool_block_toggle_latency_ms | lower |  | 40.67 |  | missing-baseline |
| deterministic | upstream | long-session-switch | transcript_render_ms | lower |  | 377.69 |  | missing-baseline |
| deterministic | upstream | session-switch-stress | memory_growth_mb | lower |  | 71.05 |  | missing-baseline |
| deterministic | upstream | session-switch-stress | session_switch_loader_fraction | lower |  | 0.43 |  | missing-baseline |
| deterministic | upstream | session-switch-stress | session_switch_max_call_stack | lower |  | 0 |  | missing-baseline |
| deterministic | upstream | session-switch-stress | surface_switch_latency_ms | lower |  | 150.77 |  | missing-baseline |
| deterministic | upstream | session-switch-stress | transcript_render_ms | lower |  | 388.62 |  | missing-baseline |
| deterministic | upstream | theme-switch | animation_jank | lower |  | 0.05 |  | missing-baseline |
| deterministic | upstream | theme-switch | dropped_frames | lower |  | 2.90 |  | missing-baseline |
| deterministic | upstream | theme-switch | frame_time_ms | lower |  | 18.27 |  | missing-baseline |
| deterministic | upstream | theme-switch | refresh_rate_stability | higher |  | 0.99 |  | missing-baseline |
| deterministic | upstream | theme-switch | theme_switch_latency_ms | lower |  | 93.13 |  | missing-baseline |
| deterministic | upstream | three-pane-resize | diff_toggle_latency_ms | lower |  | 109.16 |  | missing-baseline |
| deterministic | upstream | three-pane-resize | dropped_frames | lower |  | 4.32 |  | missing-baseline |
| deterministic | upstream | three-pane-resize | frame_time_ms | lower |  | 18.14 |  | missing-baseline |
| deterministic | upstream | three-pane-resize | scroll_latency_ms | lower |  | 36.35 |  | missing-baseline |
| deterministic | upstream | three-pane-resize | terminal_resize_latency_ms | lower |  | 65.95 |  | missing-baseline |
| deterministic | upstream | workspace-switch | file_tree_load_ms | lower |  | 219.93 |  | missing-baseline |
| deterministic | upstream | workspace-switch | surface_switch_latency_ms | lower |  | 191.82 |  | missing-baseline |
| deterministic | upstream | workspace-switch | workspace_bootstrap_ms | lower |  | 1152.01 |  | missing-baseline |
| deterministic | upstream | workspace-switch | workspace_switch_ms | lower |  | 198.98 |  | missing-baseline |

## Source Report

# Claxedo Performance Report

Generated: 2026-06-06T20:20:33.535Z

Adapters: deterministic
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 26
Failures: 0

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
| deterministic | Claxedo app | bootstrap-pending-storm | bootstrap_pending_requests | 0 | 0 | requests | pass |  |
| deterministic | Claxedo app | bootstrap-pending-storm | bootstrap_drain_ms | 1497.04 | 1624.66 | ms | pass |  |
| deterministic | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_inflight_after | 0 | 0 | requests | pass |  |
| deterministic | Claxedo app | bootstrap-pending-storm | bootstrap_throttle_queued_after | 0 | 0 | requests | pass |  |
| deterministic | Upstream OpenCode app | bootstrap-pending-storm | bootstrap_pending_requests | 0 | 0 | requests | pass |  |
| deterministic | Upstream OpenCode app | bootstrap-pending-storm | bootstrap_drain_ms | 1497.04 | 1624.66 | ms | pass |  |
| deterministic | Upstream OpenCode app | bootstrap-pending-storm | bootstrap_throttle_inflight_after | 0 | 0 | requests | pass |  |
| deterministic | Upstream OpenCode app | bootstrap-pending-storm | bootstrap_throttle_queued_after | 0 | 0 | requests | pass |  |
| deterministic | Claxedo app | burst-authed-fetches | burst_total_drain_ms | 1497.04 | 1624.66 | ms | pass |  |
| deterministic | Claxedo app | burst-authed-fetches | burst_per_request_p95_ms | 249.51 | 270.78 | ms | pass |  |
| deterministic | Claxedo app | burst-authed-fetches | burst_failures | 0 | 0 | errors | pass |  |
| deterministic | Claxedo app | burst-authed-fetches | burst_throttle_queued_peak | 29.94 | 32.49 | requests | pass |  |
| deterministic | Upstream OpenCode app | burst-authed-fetches | burst_total_drain_ms | 1497.04 | 1624.66 | ms | pass |  |
| deterministic | Upstream OpenCode app | burst-authed-fetches | burst_per_request_p95_ms | 249.51 | 270.78 | ms | pass |  |
| deterministic | Upstream OpenCode app | burst-authed-fetches | burst_failures | 0 | 0 | errors | pass |  |
| deterministic | Upstream OpenCode app | burst-authed-fetches | burst_throttle_queued_peak | 29.94 | 32.49 | requests | pass |  |
| deterministic | Claxedo app | session-switch-stress | surface_switch_latency_ms | 119.76 | 129.97 | ms | pass |  |
| deterministic | Claxedo app | session-switch-stress | transcript_render_ms | 389.23 | 422.41 | ms | pass |  |
| deterministic | Claxedo app | session-switch-stress | session_switch_max_call_stack | 0 | 0 | errors | pass |  |
| deterministic | Claxedo app | session-switch-stress | session_switch_loader_fraction | 0.40 | 0.43 | ratio | pass |  |
| deterministic | Claxedo app | session-switch-stress | memory_growth_mb | 79.84 | 86.65 | MB | pass |  |
| deterministic | Upstream OpenCode app | session-switch-stress | surface_switch_latency_ms | 138.93 | 150.77 | ms | pass |  |
| deterministic | Upstream OpenCode app | session-switch-stress | transcript_render_ms | 358.09 | 388.62 | ms | pass |  |
| deterministic | Upstream OpenCode app | session-switch-stress | session_switch_max_call_stack | 0 | 0 | errors | pass |  |
| deterministic | Upstream OpenCode app | session-switch-stress | session_switch_loader_fraction | 0.40 | 0.43 | ratio | pass |  |
| deterministic | Upstream OpenCode app | session-switch-stress | memory_growth_mb | 65.47 | 71.05 | MB | pass |  |
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
| deterministic | bootstrap-pending-storm | bootstrap_pending_requests | tie | 0 | 0 | 0% |
| deterministic | bootstrap-pending-storm | bootstrap_drain_ms | tie | 1624.66 | 1624.66 | 0% |
| deterministic | bootstrap-pending-storm | bootstrap_throttle_inflight_after | tie | 0 | 0 | 0% |
| deterministic | bootstrap-pending-storm | bootstrap_throttle_queued_after | tie | 0 | 0 | 0% |
| deterministic | burst-authed-fetches | burst_total_drain_ms | tie | 1624.66 | 1624.66 | 0% |
| deterministic | burst-authed-fetches | burst_per_request_p95_ms | tie | 270.78 | 270.78 | 0% |
| deterministic | burst-authed-fetches | burst_failures | tie | 0 | 0 | 0% |
| deterministic | burst-authed-fetches | burst_throttle_queued_peak | tie | 32.49 | 32.49 | 0% |
| deterministic | session-switch-stress | surface_switch_latency_ms | Claxedo app | 129.97 | 150.77 | 13.79% |
| deterministic | session-switch-stress | transcript_render_ms | Upstream OpenCode app | 422.41 | 388.62 | 8.00% |
| deterministic | session-switch-stress | session_switch_max_call_stack | tie | 0 | 0 | 0% |
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
