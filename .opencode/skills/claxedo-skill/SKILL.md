---
name: claxedo-skill
description: Use Claxedo context, session, logs, page, process, and WorkGraph APIs without asking for MCP setup. Prefer the built-in Claxedo tool surface and direct file edits for process config.
---

# Claxedo Skill

Use this skill when you are working inside a Claxedo-managed workspace and need app context, session state, logs, page updates, or WorkGraph orchestration.

## Default approach

- Prefer the existing Claxedo tool surface over asking the user to configure MCP manually.
- Prefer direct edits to `.claxedo/processes.jsonc` for process and port config.
- Use the `process-config` skill as a companion when editing `.claxedo/processes.jsonc`.
- Do not expect `portpick_*` tools to exist.

## Preferred tools

- `tab_context`: read the current tab, pane, session, page, and terminal context
- `get_current_session`: resolve the tracked agent session for the current terminal
- `session_messages`: inspect structured session history before inferring agent state
- `get_logs`: fetch logs from a managed process or PTY
- `summarize_logs`: compress noisy logs into a short summary
- `process`: list, add, update, start, stop, restart, or remove managed processes
- `update_page_markdown`: update a Claxedo page by markdown import
- `council`: run page-scoped multi-agent analysis
- `batch_issues`: spawn parallel issue work across worktrees
- `agent_hooks_status`: inspect wrapper readiness
- `configure_agent_wrappers`: register extra wrappers for lifecycle tracking

## WorkGraph tools

Use only the prefixed WorkGraph names:

- `workgraph_create_node`
- `workgraph_add_edge`
- `workgraph_remove_edge`
- `workgraph_validate_graph`
- `workgraph_finish_planning`
- `workgraph_update_status`
- `workgraph_write_scratchpad`
- `workgraph_read_scratchpads`
- `workgraph_create_artifact`
- `workgraph_get_graph`
- `workgraph_get_run_status`
- `workgraph_get_run_source`

Do not use the bare WorkGraph names such as `create_node` or `update_status`.

## Process config rules

When a task is about dev servers, ports, or dependencies:

- edit `.claxedo/processes.jsonc` directly
- keep names short and stable
- **for any process that binds to a network port, always include a `port` block with `name` and `inject`**. Without `port.inject`, port-conflict resolution can't reassign — the "Use another port" button silently re-runs the same command. See the `process-config` skill for `inject` values per dev tool (Vite → `"PORT"`, Next → `"--port"`, etc.).
- use `{{port:name}}` references in env values when one process needs to reach another's port
- use the `process` tool to inspect or run configs after editing

## Recommended flow

1. Call `tab_context` if UI or pane state matters.
2. Call `get_current_session` or `session_messages` if the active agent session matters.
3. Call `get_logs` before changing a failing process.
4. Edit `.claxedo/processes.jsonc` directly for process topology changes.
5. Use `process` to start or restart the relevant process after config changes.
6. Use `update_page_markdown` instead of editing page mirror files directly.
