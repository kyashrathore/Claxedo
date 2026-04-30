---
name: process-config
description: Configure dev servers and long-running processes in .claxedo/processes.jsonc — port assignment, dependencies, restart policies, and cross-service port references.
---

# Process Configuration

Configure dev servers, watchers, and other long-running processes in `.claxedo/processes.jsonc`.

## File Location

```
.claxedo/processes.jsonc
```

## Schema

Each entry in the `processes` array:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | **yes** | — | Stable unique process ID (e.g. `proc_api`). Required so start/stop/restart references survive reloads. |
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

### When to add a `port` block

**Add it for every process that binds to a network port** — vite, next, rails, express, hono, fastapi, anything that listens. The `port` block is what makes Claxedo:

- detect that the command is a port-binding service
- offer port-conflict resolution (`pick-new`, `kill-existing`) with actually-working buttons
- substitute `CLAXEDO_PORT` and the configured env/flag at launch time
- expose the chosen port via `{{port:name}}` to dependent processes
- surface a stable named URL (e.g. `web.myproject.localhost`) when Portless is installed

Skip the block only for processes that don't bind a port — file watchers, background jobs, build tasks.

### Common pitfall: missing `port.inject`

If a port-binding process has **no `port` block** (or has one without `inject`), the dev server will pick its own hardcoded default port (e.g. Vite → 4444, Next → 3000). When that port is occupied, Claxedo can detect the conflict from log output, but **cannot reassign** — clicking "Use another port" re-runs the same command, which picks the same port, which fails again. The UI now shows an explanation in this case, but the right fix is always to add the missing `port.inject`.

For each command, find what variable / flag it accepts:

| Tool | Inject |
|---|---|
| Vite | `"PORT"` (env) |
| Next.js | `"--port"` (flag) |
| Rails | `"--port"` (flag) |
| Hono / Bun.serve | usually `"PORT"` (env), check the script |
| Custom Node server | whatever your code reads from `process.env` |

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
      "id": "proc_api_server",
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
