# Claxedo Performance Report

Generated: 2026-05-23T10:17:26.963Z

Adapters: browser
Targets: Claxedo app, Upstream OpenCode app
Scenario runs: 20
Failures: 12

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| browser | Claxedo app | launch-empty-home | launch_first_window_ms | 3201.63 | 3201.63 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_useful_screen_ms | 3247.67 | 3247.67 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_workspace_ready_ms | 8251.18 | 8251.18 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | launch_first_input_ms | 24.92 | 24.92 | ms | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-empty-home | memory_rss_mb | 61.04 | 61.04 | MB | pass | reports/videos/claxedo-launch-empty-home-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_first_window_ms | 304.70 | 304.70 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | launch_workspace_ready_ms | 5350.38 | 5350.38 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms | 635.28 | 635.28 | ms | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | launch-project-20-sessions | memory_rss_mb | 73.05 | 73.05 | MB | fail | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms | 666.76 | 666.76 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | transcript_render_ms | 2.88 | 2.88 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | scroll_latency_ms | 20.84 | 20.84 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | incremental_append_latency_ms | 0.54 | 0.54 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | tool_block_toggle_latency_ms | 1.75 | 1.75 | ms | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | long-session-switch | memory_growth_mb | 5.84 | 5.84 | MB | fail | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms | 65.82 | 65.82 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | pty_attach_ms | 1.61 | 1.61 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms | 15.25 | 15.25 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_reconnect_latency_ms | 52.75 | 52.75 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | ansi_render_latency_ms | 0.97 | 0.97 | ms | fail | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms | 1127.06 | 1127.06 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms | 285.56 | 285.56 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms | 953.66 | 953.66 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms | 381.01 | 381.01 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms | 278.82 | 278.82 | ms | fail | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms | 272.84 | 272.84 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms | 1293.69 | 1293.69 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms | 1365.57 | 1365.57 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms | 324.12 | 324.12 | ms | fail | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_index_ms | 1.54 | 1.54 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms | 289.90 | 289.90 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms | 275.74 | 275.74 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms | 267.82 | 267.82 | ms | fail | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | theme-switch | theme_switch_latency_ms | 0.84 | 0.84 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | frame_time_ms | 9.14 | 9.14 | ms | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | dropped_frames | 0 | 0 | frames | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | refresh_rate_stability | 0.99 | 0.99 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | theme-switch | animation_jank | 0 | 0 | ratio | pass | reports/videos/claxedo-theme-switch-1.webm |
| browser | Claxedo app | three-pane-resize | frame_time_ms | 9.42 | 9.42 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | dropped_frames | 0 | 0 | frames | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | scroll_latency_ms | 25.16 | 25.16 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms | 52.40 | 52.40 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | diff_toggle_latency_ms | 1.02 | 1.02 | ms | fail | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_action_dispatch_ms | 14.59 | 14.59 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | agent_state_verify_ms | 0.58 | 0.58 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | surface_switch_latency_ms | 0.79 | 0.79 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | command_execution_overhead_ms | 0.47 | 0.47 | ms | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Claxedo app | agent-control-navigation | event_backlog | 250 | 250 | events | pass | reports/videos/claxedo-agent-control-navigation-1.webm |
| browser | Upstream OpenCode app | launch-empty-home | launch_first_window_ms | 2071.49 | 2071.49 | ms | pass | reports/videos/upstream-launch-empty-home-1.webm |
| browser | Upstream OpenCode app | launch-empty-home | launch_first_useful_screen_ms | 2995.18 | 2995.18 | ms | pass | reports/videos/upstream-launch-empty-home-1.webm |
| browser | Upstream OpenCode app | launch-empty-home | launch_workspace_ready_ms | 7995.88 | 7995.88 | ms | pass | reports/videos/upstream-launch-empty-home-1.webm |
| browser | Upstream OpenCode app | launch-empty-home | launch_first_input_ms | 12.52 | 12.52 | ms | pass | reports/videos/upstream-launch-empty-home-1.webm |
| browser | Upstream OpenCode app | launch-empty-home | memory_rss_mb | 48.07 | 48.07 | MB | pass | reports/videos/upstream-launch-empty-home-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | launch_first_window_ms | 211.65 | 211.65 | ms | pass | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | launch_workspace_ready_ms | 5394.60 | 5394.60 | ms | pass | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | transcript_render_ms | 635.16 | 635.16 | ms | pass | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | launch-project-20-sessions | memory_rss_mb | 51.02 | 51.02 | MB | pass | reports/videos/upstream-launch-project-20-sessions-1.webm |
| browser | Upstream OpenCode app | long-session-switch | surface_switch_latency_ms | 652.34 | 652.34 | ms | fail | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | transcript_render_ms | 2.36 | 2.36 | ms | fail | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | scroll_latency_ms | 23.93 | 23.93 | ms | fail | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | incremental_append_latency_ms | 0.63 | 0.63 | ms | fail | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | tool_block_toggle_latency_ms | 1.34 | 1.34 | ms | fail | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | long-session-switch | memory_growth_mb | 3.85 | 3.85 | MB | fail | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | surface_switch_latency_ms | 45.95 | 45.95 | ms | fail | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | pty_attach_ms | 0.92 | 0.92 | ms | fail | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | terminal_throughput_lines_per_s | 300000 | 300000 | lines/s | fail | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | terminal_resize_latency_ms | 1.51 | 1.51 | ms | fail | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | terminal_reconnect_latency_ms | 24.39 | 24.39 | ms | fail | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | ansi_render_latency_ms | 0.82 | 0.82 | ms | fail | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | vcs_load_ms | 362.64 | 362.64 | ms | fail | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | hunk_render_ms | 71.63 | 71.63 | ms | fail | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | diff_toggle_latency_ms | 287.14 | 287.14 | ms | fail | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | line_comment_latency_ms | 819.80 | 819.80 | ms | fail | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | changed_file_navigation_ms | 291.22 | 291.22 | ms | fail | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace_bootstrap_ms | 279.50 | 279.50 | ms | fail | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace_switch_ms | 947.70 | 947.70 | ms | fail | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | file_tree_load_ms | 901.40 | 901.40 | ms | fail | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | surface_switch_latency_ms | 342.77 | 342.77 | ms | fail | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_palette_index_ms | 2.22 | 2.22 | ms | fail | reports/videos/upstream-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_palette_open_ms | 1284.99 | 1284.99 | ms | fail | reports/videos/upstream-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_palette_search_ms | 278.26 | 278.26 | ms | fail | reports/videos/upstream-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_execution_overhead_ms | 12.89 | 12.89 | ms | fail | reports/videos/upstream-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | theme-switch | theme_switch_latency_ms | 0.75 | 0.75 | ms | pass | reports/videos/upstream-theme-switch-1.webm |
| browser | Upstream OpenCode app | theme-switch | frame_time_ms | 1.86 | 1.86 | ms | pass | reports/videos/upstream-theme-switch-1.webm |
| browser | Upstream OpenCode app | theme-switch | dropped_frames | 0 | 0 | frames | pass | reports/videos/upstream-theme-switch-1.webm |
| browser | Upstream OpenCode app | theme-switch | refresh_rate_stability | 0.99 | 0.99 | ratio | pass | reports/videos/upstream-theme-switch-1.webm |
| browser | Upstream OpenCode app | theme-switch | animation_jank | 0 | 0 | ratio | pass | reports/videos/upstream-theme-switch-1.webm |
| browser | Upstream OpenCode app | three-pane-resize | frame_time_ms | 8.95 | 8.95 | ms | pass | reports/videos/upstream-three-pane-resize-1.webm |
| browser | Upstream OpenCode app | three-pane-resize | dropped_frames | 0 | 0 | frames | pass | reports/videos/upstream-three-pane-resize-1.webm |
| browser | Upstream OpenCode app | three-pane-resize | scroll_latency_ms | 33.21 | 33.21 | ms | pass | reports/videos/upstream-three-pane-resize-1.webm |
| browser | Upstream OpenCode app | three-pane-resize | terminal_resize_latency_ms | 16.08 | 16.08 | ms | pass | reports/videos/upstream-three-pane-resize-1.webm |
| browser | Upstream OpenCode app | three-pane-resize | diff_toggle_latency_ms | 4.10 | 4.10 | ms | pass | reports/videos/upstream-three-pane-resize-1.webm |
| browser | Upstream OpenCode app | agent-control-navigation | agent_action_dispatch_ms | 37.97 | 37.97 | ms | pass | reports/videos/upstream-agent-control-navigation-1.webm |
| browser | Upstream OpenCode app | agent-control-navigation | agent_state_verify_ms | 0.54 | 0.54 | ms | pass | reports/videos/upstream-agent-control-navigation-1.webm |
| browser | Upstream OpenCode app | agent-control-navigation | surface_switch_latency_ms | 3.76 | 3.76 | ms | pass | reports/videos/upstream-agent-control-navigation-1.webm |
| browser | Upstream OpenCode app | agent-control-navigation | command_execution_overhead_ms | 0.73 | 0.73 | ms | pass | reports/videos/upstream-agent-control-navigation-1.webm |
| browser | Upstream OpenCode app | agent-control-navigation | event_backlog | 250 | 250 | events | pass | reports/videos/upstream-agent-control-navigation-1.webm |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Claxedo app | launch-project-20-sessions | transcript_render_ms p95 635.2823750000007 > 45 | reports/videos/claxedo-launch-project-20-sessions-1.webm |
| browser | Claxedo app | long-session-switch | surface_switch_latency_ms p95 666.7608749999999 > 523 | reports/videos/claxedo-long-session-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | surface_switch_latency_ms p95 65.82087500000125 > 32 | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | live-terminal-switch | terminal_resize_latency_ms p95 15.245500000000902 > 9 | reports/videos/claxedo-live-terminal-switch-1.webm |
| browser | Claxedo app | large-diff-toggle | vcs_load_ms p95 1127.0609160000022 > 36 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | hunk_render_ms p95 285.56429200000275 > 41 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | diff_toggle_latency_ms p95 953.6597499999989 > 37 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | line_comment_latency_ms p95 381.00529200000165 > 33 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | large-diff-toggle | changed_file_navigation_ms p95 278.8226250000007 > 7 | reports/videos/claxedo-large-diff-toggle-1.webm |
| browser | Claxedo app | workspace-switch | workspace_bootstrap_ms p95 272.8429580000011 > 32 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | workspace_switch_ms p95 1293.6859590000022 > 709 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | file_tree_load_ms p95 1365.5715419999979 > 31 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | workspace-switch | surface_switch_latency_ms p95 324.1190409999981 > 7 | reports/videos/claxedo-workspace-switch-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_open_ms p95 289.8954589999994 > 8 | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_palette_search_ms p95 275.74025000000256 > 43 | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | command-palette-large-project | command_execution_overhead_ms p95 267.8197080000027 > 7 | reports/videos/claxedo-command-palette-large-project-1.webm |
| browser | Claxedo app | three-pane-resize | frame_time_ms p95 9.422875000003842 > 9 | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Claxedo app | three-pane-resize | terminal_resize_latency_ms p95 52.40254099998856 > 45 | reports/videos/claxedo-three-pane-resize-1.webm |
| browser | Upstream OpenCode app | long-session-switch | surface_switch_latency_ms p95 652.3402499999938 > 300 | reports/videos/upstream-long-session-switch-1.webm |
| browser | Upstream OpenCode app | live-terminal-switch | surface_switch_latency_ms p95 45.94999999999709 > 31 | reports/videos/upstream-live-terminal-switch-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | vcs_load_ms p95 362.6431250000023 > 9 | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | hunk_render_ms p95 71.62720800000534 > 48 | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | diff_toggle_latency_ms p95 287.1445839999942 > 8 | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | line_comment_latency_ms p95 819.7962090000074 > 56 | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | large-diff-toggle | changed_file_navigation_ms p95 291.2171249999956 > 70 | reports/videos/upstream-large-diff-toggle-1.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace_bootstrap_ms p95 279.50362499999756 > 7 | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | workspace_switch_ms p95 947.6953749999957 > 510 | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | file_tree_load_ms p95 901.3982079999987 > 256 | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | workspace-switch | surface_switch_latency_ms p95 342.7743749999936 > 7 | reports/videos/upstream-workspace-switch-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_palette_open_ms p95 1284.9860830000107 > 7 | reports/videos/upstream-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_palette_search_ms p95 278.25687499999185 > 33 | reports/videos/upstream-command-palette-large-project-1.webm |
| browser | Upstream OpenCode app | command-palette-large-project | command_execution_overhead_ms p95 12.893874999994296 > 6 | reports/videos/upstream-command-palette-large-project-1.webm |

## Target Comparison

| Adapter | Scenario | Metric | Faster target | Claxedo p95 | Upstream p95 | Faster by |
| --- | --- | --- | --- | ---: | ---: | ---: |
| browser | launch-empty-home | launch_first_window_ms | Upstream OpenCode app | 3201.63 | 2071.49 | 35.30% |
| browser | launch-empty-home | launch_first_useful_screen_ms | Upstream OpenCode app | 3247.67 | 2995.18 | 7.77% |
| browser | launch-empty-home | launch_workspace_ready_ms | Upstream OpenCode app | 8251.18 | 7995.88 | 3.09% |
| browser | launch-empty-home | launch_first_input_ms | Upstream OpenCode app | 24.92 | 12.52 | 49.75% |
| browser | launch-empty-home | memory_rss_mb | Upstream OpenCode app | 61.04 | 48.07 | 21.25% |
| browser | launch-project-20-sessions | launch_first_window_ms | Upstream OpenCode app | 304.70 | 211.65 | 30.54% |
| browser | launch-project-20-sessions | launch_workspace_ready_ms | Claxedo app | 5350.38 | 5394.60 | 0.82% |
| browser | launch-project-20-sessions | transcript_render_ms | Upstream OpenCode app | 635.28 | 635.16 | 0.02% |
| browser | launch-project-20-sessions | memory_rss_mb | Upstream OpenCode app | 73.05 | 51.02 | 30.16% |
| browser | long-session-switch | surface_switch_latency_ms | Upstream OpenCode app | 666.76 | 652.34 | 2.16% |
| browser | long-session-switch | transcript_render_ms | Upstream OpenCode app | 2.88 | 2.36 | 18.31% |
| browser | long-session-switch | scroll_latency_ms | Claxedo app | 20.84 | 23.93 | 12.91% |
| browser | long-session-switch | incremental_append_latency_ms | Claxedo app | 0.54 | 0.63 | 15.05% |
| browser | long-session-switch | tool_block_toggle_latency_ms | Upstream OpenCode app | 1.75 | 1.34 | 23.77% |
| browser | long-session-switch | memory_growth_mb | Upstream OpenCode app | 5.84 | 3.85 | 34.20% |
| browser | live-terminal-switch | surface_switch_latency_ms | Upstream OpenCode app | 65.82 | 45.95 | 30.19% |
| browser | live-terminal-switch | pty_attach_ms | Upstream OpenCode app | 1.61 | 0.92 | 42.59% |
| browser | live-terminal-switch | terminal_throughput_lines_per_s | tie | 300000 | 300000 | 0% |
| browser | live-terminal-switch | terminal_resize_latency_ms | Upstream OpenCode app | 15.25 | 1.51 | 90.11% |
| browser | live-terminal-switch | terminal_reconnect_latency_ms | Upstream OpenCode app | 52.75 | 24.39 | 53.77% |
| browser | live-terminal-switch | ansi_render_latency_ms | Upstream OpenCode app | 0.97 | 0.82 | 15.94% |
| browser | large-diff-toggle | vcs_load_ms | Upstream OpenCode app | 1127.06 | 362.64 | 67.82% |
| browser | large-diff-toggle | hunk_render_ms | Upstream OpenCode app | 285.56 | 71.63 | 74.92% |
| browser | large-diff-toggle | diff_toggle_latency_ms | Upstream OpenCode app | 953.66 | 287.14 | 69.89% |
| browser | large-diff-toggle | line_comment_latency_ms | Claxedo app | 381.01 | 819.80 | 53.52% |
| browser | large-diff-toggle | changed_file_navigation_ms | Claxedo app | 278.82 | 291.22 | 4.26% |
| browser | workspace-switch | workspace_bootstrap_ms | Claxedo app | 272.84 | 279.50 | 2.38% |
| browser | workspace-switch | workspace_switch_ms | Upstream OpenCode app | 1293.69 | 947.70 | 26.74% |
| browser | workspace-switch | file_tree_load_ms | Upstream OpenCode app | 1365.57 | 901.40 | 33.99% |
| browser | workspace-switch | surface_switch_latency_ms | Claxedo app | 324.12 | 342.77 | 5.44% |
| browser | command-palette-large-project | command_palette_index_ms | Claxedo app | 1.54 | 2.22 | 30.66% |
| browser | command-palette-large-project | command_palette_open_ms | Claxedo app | 289.90 | 1284.99 | 77.44% |
| browser | command-palette-large-project | command_palette_search_ms | Claxedo app | 275.74 | 278.26 | 0.90% |
| browser | command-palette-large-project | command_execution_overhead_ms | Upstream OpenCode app | 267.82 | 12.89 | 95.19% |
| browser | theme-switch | theme_switch_latency_ms | Upstream OpenCode app | 0.84 | 0.75 | 10.64% |
| browser | theme-switch | frame_time_ms | Upstream OpenCode app | 9.14 | 1.86 | 79.67% |
| browser | theme-switch | dropped_frames | tie | 0 | 0 | 0% |
| browser | theme-switch | refresh_rate_stability | tie | 0.99 | 0.99 | 0% |
| browser | theme-switch | animation_jank | tie | 0 | 0 | 0% |
| browser | three-pane-resize | frame_time_ms | Upstream OpenCode app | 9.42 | 8.95 | 5.03% |
| browser | three-pane-resize | dropped_frames | tie | 0 | 0 | 0% |
| browser | three-pane-resize | scroll_latency_ms | Claxedo app | 25.16 | 33.21 | 24.24% |
| browser | three-pane-resize | terminal_resize_latency_ms | Upstream OpenCode app | 52.40 | 16.08 | 69.32% |
| browser | three-pane-resize | diff_toggle_latency_ms | Claxedo app | 1.02 | 4.10 | 75.23% |
| browser | agent-control-navigation | agent_action_dispatch_ms | Claxedo app | 14.59 | 37.97 | 61.58% |
| browser | agent-control-navigation | agent_state_verify_ms | Upstream OpenCode app | 0.58 | 0.54 | 5.66% |
| browser | agent-control-navigation | surface_switch_latency_ms | Claxedo app | 0.79 | 3.76 | 78.91% |
| browser | agent-control-navigation | command_execution_overhead_ms | Claxedo app | 0.47 | 0.73 | 34.86% |
| browser | agent-control-navigation | event_backlog | tie | 250 | 250 | 0% |
