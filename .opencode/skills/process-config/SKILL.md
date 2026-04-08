---
name: process-config
description: Configure dev servers and long-running processes in .opencode/processes.jsonc — port assignment, dependencies, restart policies, and cross-service port references.
---

# Process Configuration

Configure dev servers, watchers, and other long-running processes in `.opencode/processes.jsonc`.

## File Location

```
.opencode/processes.jsonc
```

## Schema

Each entry in the `processes` array:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | no | auto-generated | Unique process ID (e.g. `proc_...`). Omit to auto-generate. |
| `name` | string | **yes** | — | Process name. Must match `/^[a-z0-9._-]+$/` (lowercase, no spaces). |
| `command` | string | **yes** | — | Shell command to run (e.g. `"bun run dev"`). |
| `args` | string[] | no | `[]` | Extra arguments appended to command. |
| `cwd` | string | no | project root | Working directory (relative to project root). |
| `env` | object | no | — | Extra environment variables. Supports `{{port:name}}` templates. |
| `autoStart` | boolean | no | `false` | Start automatically when the workspace opens. |
| `restartPolicy` | enum | no | `"never"` | `"never"`, `"on-failure"`, or `"always"`. |
| `maxRestarts` | integer | no | `3` | Max restart attempts before giving up. |
| `color` | string | no | — | Display color in the UI. |
| `dependsOn` | string[] | no | — | Process names that must be running first. Auto-started as dependencies. |
| `port` | object | no | — | Port assignment config (see below). |

### Port Configuration (`port` object)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | **yes** | Unique port name (e.g. `"api"`, `"frontend"`). Referenced by `{{port:name}}` in other processes. |
| `inject` | string | **yes** | How to pass the port. CLI flag (e.g. `"--port"`) or env var name (e.g. `"PORT"`). |
| `preferred` | integer | no | Preferred port number. Tries this first, falls back to random if occupied. |
| `onConflict` | enum | no | What to do when preferred port is occupied: `"pick-new"` or `"kill-existing"`. If omitted, prompts the user interactively. |

## Cross-Service Port References

Use `{{port:name}}` in `env` values to reference another process's assigned port:

```jsonc
{
  "name": "frontend",
  "command": "bun run dev",
  "env": {
    "VITE_API_URL": "http://localhost:{{port:api}}"
  }
}
```

This creates an implicit dependency — the referenced process starts first automatically.

## Dependencies

Explicit dependencies via `dependsOn` (by process name):

```jsonc
{
  "name": "frontend",
  "command": "bun run dev",
  "dependsOn": ["api-server"]
}
```

Both explicit `dependsOn` and implicit `{{port:name}}` references are resolved. Circular dependencies are detected and rejected.

## Full Example

```jsonc
{
  "$schema": "./processes.schema.json",
  "processes": [
    {
      "name": "api-server",
      "command": "bun run server",
      "cwd": "./packages/api",
      "autoStart": true,
      "restartPolicy": "on-failure",
      "port": {
        "name": "api",
        "inject": "--port",
        "preferred": 4000
      }
    },
    {
      "name": "frontend",
      "command": "bun run dev",
      "cwd": "./packages/web",
      "autoStart": true,
      "dependsOn": ["api-server"],
      "env": {
        "VITE_API_URL": "http://localhost:{{port:api}}"
      },
      "port": {
        "name": "frontend",
        "inject": "PORT"
      }
    }
  ]
}
```
