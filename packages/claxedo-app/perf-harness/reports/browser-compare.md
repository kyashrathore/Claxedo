# Claxedo Performance Report

Generated: 2026-05-23T09:16:14.894Z

Adapters: browser
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 20
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_window_ms | 3163.69 | 3163.69 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_useful_screen_ms | 3219.24 | 3219.24 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_workspace_ready_ms | 8222.83 | 8222.83 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_input_ms | 35.22 | 35.22 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | memory_rss_mb | 61.04 | 61.04 | MB | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_first_window_ms | 325.27 | 325.27 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_workspace_ready_ms | 5373.01 | 5373.01 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms | 19.64 | 19.64 | ms | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | memory_rss_mb | 73.05 | 73.05 | MB | pass | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms | 298.34 | 298.34 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | transcript_render_ms | 117.88 | 117.88 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | scroll_latency_ms | 29.77 | 29.77 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | incremental_append_latency_ms | 0.70 | 0.70 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | tool_block_toggle_latency_ms | 3.39 | 3.39 | ms | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | memory_growth_mb | 5.19 | 5.19 | MB | pass | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms | 6.93 | 6.93 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | pty_attach_ms | 10.68 | 10.68 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms | 3.24 | 3.24 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_reconnect_latency_ms | 33.39 | 33.39 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | ansi_render_latency_ms | 0.76 | 0.76 | ms | pass | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 10.38 | 10.38 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 15.94 | 15.94 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 11.17 | 11.17 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 7.17 | 7.17 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 1.85 | 1.85 | ms | pass | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 6.64 | 6.64 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 404.63 | 404.63 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 6.00 | 6.00 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 1.60 | 1.60 | ms | pass | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_index_ms | 6.11 | 6.11 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms | 2.82 | 2.82 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms | 17.73 | 17.73 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms | 1.07 | 1.07 | ms | pass | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | theme-switch | theme_switch_latency_ms | 4.16 | 4.16 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | frame_time_ms | 5.04 | 5.04 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | refresh_rate_stability | 0.99 | 0.99 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | animation_jank | 0 | 0 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | three-pane-resize | frame_time_ms | 3.40 | 3.40 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | scroll_latency_ms | 23.95 | 23.95 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms | 19.27 | 19.27 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | diff_toggle_latency_ms | 4.35 | 4.35 | ms | pass | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_action_dispatch_ms | 28.87 | 28.87 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_state_verify_ms | 2.05 | 2.05 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | surface_switch_latency_ms | 0.82 | 0.82 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | command_execution_overhead_ms | 0.57 | 0.57 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | event_backlog | 250 | 250 | events | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Upstream OpenCode app | launch-empty-home | launch_first_window_ms | 1910.57 | 1910.57 | ms | pass | reports/videos/upstream-launch-empty-home-1.webm |
| browser | Upstream OpenCode app | launch-empty-home | launch_first_useful_screen_ms | 2037.49 | 2037.49 | ms | pass | reports/videos/upstream-launch-empty-home-1.webm |
| browser | Upstream OpenCode app | launch-empty-home | launch_workspace_ready_ms | 7039.99 | 7039.99 | ms | pass | reports/videos/upstream-launch-empty-home-1.webm |
| browser | Upstream OpenCode app | launch-empty-home | launch_first_input_ms | 24.00 | 24.00 | ms | pass | reports/videos/upstream-launch-empty-home-1.webm |
| browser | Upstream OpenCode app | launch-empty-home | memory_rss_mb | 33.47 | 33.47 | MB | pass | reports/videos/upstream-launch-empty-home-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | launch_first_window_ms | 180.16 | 180.16 | ms | fail | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | launch_workspace_ready_ms | 5953.39 | 5953.39 | ms | fail | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | transcript_render_ms | 10008.88 | 10008.88 | ms | fail | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | memory_rss_mb | 45.20 | 45.20 | MB | fail | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | long-session-switch | surface_switch_latency_ms | 149.10 | 149.10 | ms | pass | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | transcript_render_ms | 126.48 | 126.48 | ms | pass | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | scroll_latency_ms | 32.79 | 32.79 | ms | pass | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | incremental_append_latency_ms | 0.37 | 0.37 | ms | pass | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | tool_block_toggle_latency_ms | 0.88 | 0.88 | ms | pass | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | memory_growth_mb | 3.62 | 3.62 | MB | pass | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | surface_switch_latency_ms | 5.61 | 5.61 | ms | pass | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | pty_attach_ms | 15.63 | 15.63 | ms | pass | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | pass | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | terminal_resize_latency_ms | 4.00 | 4.00 | ms | pass | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | terminal_reconnect_latency_ms | 20.17 | 20.17 | ms | pass | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | ansi_render_latency_ms | 0.95 | 0.95 | ms | pass | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | vcs_load_ms | 3.43 | 3.43 | ms | pass | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | hunk_render_ms | 22.48 | 22.48 | ms | pass | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | diff_toggle_latency_ms | 2.95 | 2.95 | ms | pass | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | line_comment_latency_ms | 30.26 | 30.26 | ms | pass | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | changed_file_navigation_ms | 39.56 | 39.56 | ms | pass | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace_bootstrap_ms | 1.87 | 1.87 | ms | pass | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace_switch_ms | 291.28 | 291.28 | ms | pass | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | file_tree_load_ms | 105.69 | 105.69 | ms | pass | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | surface_switch_latency_ms | 1.35 | 1.35 | ms | pass | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_palette_index_ms | 2.24 | 2.24 | ms | pass | reports/videos/upstream-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_palette_open_ms | 1.90 | 1.90 | ms | pass | reports/videos/upstream-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_palette_search_ms | 7.45 | 7.45 | ms | pass | reports/videos/upstream-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_execution_overhead_ms | 0.47 | 0.47 | ms | pass | reports/videos/upstream-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | theme-switch | theme_switch_latency_ms | 1.84 | 1.84 | ms | pass | reports/videos/upstream-theme-switch-1.webm |
| browser | Upstream OpenCode app | theme-switch | frame_time_ms | 1.71 | 1.71 | ms | pass | reports/videos/upstream-theme-switch-1.webm |
| browser | Upstream OpenCode app | theme-switch | dropped_frames | 0 | 0 | frames | pass | reports/videos/upstream-theme-switch-1.webm |
| browser | Upstream OpenCode app | theme-switch | refresh_rate_stability | 0.99 | 0.99 | ratio | pass | reports/videos/upstream-theme-switch-1.webm |
| browser | Upstream OpenCode app | theme-switch | animation_jank | 0 | 0 | ratio | pass | reports/videos/upstream-theme-switch-1.webm |
| browser | Upstream OpenCode app | three-pane-resize | frame_time_ms | 3.54 | 3.54 | ms | pass | reports/videos/upstream-three-pane-resize-1.webm |
| browser | Upstream OpenCode app | three-pane-resize | dropped_frames | 0 | 0 | frames | pass | reports/videos/upstream-three-pane-resize-1.webm |
| browser | Upstream OpenCode app | three-pane-resize | scroll_latency_ms | 24.58 | 24.58 | ms | pass | reports/videos/upstream-three-pane-resize-1.webm |
| browser | Upstream OpenCode app | three-pane-resize | terminal_resize_latency_ms | 46.91 | 46.91 | ms | pass | reports/videos/upstream-three-pane-resize-1.webm |
| browser | Upstream OpenCode app | three-pane-resize | diff_toggle_latency_ms | 5.85 | 5.85 | ms | pass | reports/videos/upstream-three-pane-resize-1.webm |
| browser | Upstream OpenCode app | agent-control-navigation | agent_action_dispatch_ms | 37.89 | 37.89 | ms | pass | reports/videos/upstream-agent-control-navigation-1.webm |
| browser | Upstream OpenCode app | agent-control-navigation | agent_state_verify_ms | 0.82 | 0.82 | ms | pass | reports/videos/upstream-agent-control-navigation-1.webm |
| browser | Upstream OpenCode app | agent-control-navigation | surface_switch_latency_ms | 0.47 | 0.47 | ms | pass | reports/videos/upstream-agent-control-navigation-1.webm |
| browser | Upstream OpenCode app | agent-control-navigation | command_execution_overhead_ms | 0.30 | 0.30 | ms | pass | reports/videos/upstream-agent-control-navigation-1.webm |
| browser | Upstream OpenCode app | agent-control-navigation | event_backlog | 250 | 250 | events | pass | reports/videos/upstream-agent-control-navigation-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Upstream OpenCode app | launch-project-20-sessions | transcript text was not visible for launch-project-20-sessions: launch-project-20-sessions session 1 | reports/videos/upstream-launch-project-20-sessions-1.webm |

## Target Comparison

| Adapter | Scenario | Metric | Faster target | Claxedo p95 | Upstream p95 | Faster by |
| --- | --- | --- | --- | ---: | ---: | ---: |
| browser | launch-empty-home | launch_first_window_ms | Upstream OpenCode app | 3163.69 | 1910.57 | 39.61% |
| browser | launch-empty-home | launch_first_useful_screen_ms | Upstream OpenCode app | 3219.24 | 2037.49 | 36.71% |
| browser | launch-empty-home | launch_workspace_ready_ms | Upstream OpenCode app | 8222.83 | 7039.99 | 14.38% |
| browser | launch-empty-home | launch_first_input_ms | Upstream OpenCode app | 35.22 | 24.00 | 31.85% |
| browser | launch-empty-home | memory_rss_mb | Upstream OpenCode app | 61.04 | 33.47 | 45.16% |
| browser | launch-project-20-sessions | launch_first_window_ms | Upstream OpenCode app | 325.27 | 180.16 | 44.61% |
| browser | launch-project-20-sessions | launch_workspace_ready_ms | Claxedo app | 5373.01 | 5953.39 | 9.75% |
| browser | launch-project-20-sessions | transcript_render_ms | Claxedo app | 19.64 | 10008.88 | 99.80% |
| browser | launch-project-20-sessions | memory_rss_mb | Upstream OpenCode app | 73.05 | 45.20 | 38.12% |
| browser | long-session-switch | surface_switch_latency_ms | Upstream OpenCode app | 298.34 | 149.10 | 50.02% |
| browser | long-session-switch | transcript_render_ms | Claxedo app | 117.88 | 126.48 | 6.81% |
| browser | long-session-switch | scroll_latency_ms | Claxedo app | 29.77 | 32.79 | 9.22% |
| browser | long-session-switch | incremental_append_latency_ms | Upstream OpenCode app | 0.70 | 0.37 | 47.54% |
| browser | long-session-switch | tool_block_toggle_latency_ms | Upstream OpenCode app | 3.39 | 0.88 | 73.96% |
| browser | long-session-switch | memory_growth_mb | Upstream OpenCode app | 5.19 | 3.62 | 30.29% |
| browser | live-terminal-switch | surface_switch_latency_ms | Upstream OpenCode app | 6.93 | 5.61 | 19.02% |
| browser | live-terminal-switch | pty_attach_ms | Claxedo app | 10.68 | 15.63 | 31.64% |
| browser | live-terminal-switch | terminal_throughput_lines_per_s | tie | 300000 | 300000 | 0% |
| browser | live-terminal-switch | terminal_resize_latency_ms | Claxedo app | 3.24 | 4.00 | 18.90% |
| browser | live-terminal-switch | terminal_reconnect_latency_ms | Upstream OpenCode app | 33.39 | 20.17 | 39.58% |
| browser | live-terminal-switch | ansi_render_latency_ms | Claxedo app | 0.76 | 0.95 | 20.27% |
| browser | large-diff-toggle | vcs_load_ms | Upstream OpenCode app | 10.38 | 3.43 | 66.99% |
| browser | large-diff-toggle | hunk_render_ms | Claxedo app | 15.94 | 22.48 | 29.07% |
| browser | large-diff-toggle | diff_toggle_latency_ms | Upstream OpenCode app | 11.17 | 2.95 | 73.55% |
| browser | large-diff-toggle | line_comment_latency_ms | Claxedo app | 7.17 | 30.26 | 76.30% |
| browser | large-diff-toggle | changed_file_navigation_ms | Claxedo app | 1.85 | 39.56 | 95.32% |
| browser | workspace-switch | workspace_bootstrap_ms | Upstream OpenCode app | 6.64 | 1.87 | 71.91% |
| browser | workspace-switch | workspace_switch_ms | Upstream OpenCode app | 404.63 | 291.28 | 28.01% |
| browser | workspace-switch | file_tree_load_ms | Claxedo app | 6.00 | 105.69 | 94.33% |
| browser | workspace-switch | surface_switch_latency_ms | Upstream OpenCode app | 1.60 | 1.35 | 16.03% |
| browser | command-palette-large-project | command_palette_index_ms | Upstream OpenCode app | 6.11 | 2.24 | 63.35% |
| browser | command-palette-large-project | command_palette_open_ms | Upstream OpenCode app | 2.82 | 1.90 | 32.88% |
| browser | command-palette-large-project | command_palette_search_ms | Upstream OpenCode app | 17.73 | 7.45 | 57.97% |
| browser | command-palette-large-project | command_execution_overhead_ms | Upstream OpenCode app | 1.07 | 0.47 | 56.05% |
| browser | theme-switch | theme_switch_latency_ms | Upstream OpenCode app | 4.16 | 1.84 | 55.80% |
| browser | theme-switch | frame_time_ms | Upstream OpenCode app | 5.04 | 1.71 | 66.18% |
| browser | theme-switch | dropped_frames | tie | 0 | 0 | 0% |
| browser | theme-switch | refresh_rate_stability | tie | 0.99 | 0.99 | 0% |
| browser | theme-switch | animation_jank | tie | 0 | 0 | 0% |
| browser | three-pane-resize | frame_time_ms | Claxedo app | 3.40 | 3.54 | 3.96% |
| browser | three-pane-resize | dropped_frames | tie | 0 | 0 | 0% |
| browser | three-pane-resize | scroll_latency_ms | Claxedo app | 23.95 | 24.58 | 2.60% |
| browser | three-pane-resize | terminal_resize_latency_ms | Claxedo app | 19.27 | 46.91 | 58.93% |
| browser | three-pane-resize | diff_toggle_latency_ms | Claxedo app | 4.35 | 5.85 | 25.51% |
| browser | agent-control-navigation | agent_action_dispatch_ms | Claxedo app | 28.87 | 37.89 | 23.81% |
| browser | agent-control-navigation | agent_state_verify_ms | Upstream OpenCode app | 2.05 | 0.82 | 60.16% |
| browser | agent-control-navigation | surface_switch_latency_ms | Upstream OpenCode app | 0.82 | 0.47 | 43.30% |
| browser | agent-control-navigation | command_execution_overhead_ms | Upstream OpenCode app | 0.57 | 0.30 | 47.51% |
| browser | agent-control-navigation | event_backlog | tie | 250 | 250 | 0% |
