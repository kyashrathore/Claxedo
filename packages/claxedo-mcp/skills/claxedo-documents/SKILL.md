---
name: claxedo-documents
description: Find, open, read, and edit documents managed by Claxedo. Use when a prompt contains a claxedo://document/... reference, asks for a Claxedo document by name, or requires discovering documents available to the current project or session.
---

# Claxedo Documents

Resolve document references through the Claxedo document index. Keep prompts compact and use the returned canonical file path for ordinary file operations.

## Workflow

1. Pass a `claxedo://document/<id>` reference directly to `documents_open` as `id_or_name`.
2. Use `documents_list` first when the user supplies only a name or asks what documents exist. The tool returns metadata, not document bodies.
3. Omit `directory` when the Claxedo MCP has a project default. Otherwise pass the current project directory. Use one scope only: `directory` or `project_id`.
4. Omit `session_id` when the runtime supplies the current session default. Otherwise pass the current Claxedo session ID.
5. Read or edit only the absolute canonical path returned by `documents_open`. Let the session document bridge synchronize changes.

Never infer a managed path, scan `.claxedo` for a substitute, or treat a display name as unique after the tool reports ambiguity.

## CLI fallback

Use the CLI when MCP tool invocation is unavailable:

```sh
claxedo-mcp documents list
claxedo-mcp documents open 'claxedo://document/<id>' --session '<session-id>'
```

`OPENCODE_API_DIR` supplies the default directory and `CLAXEDO_SESSION_ID` supplies the default session. Use `--directory`, `--project`, or `--session` to override them explicitly.
