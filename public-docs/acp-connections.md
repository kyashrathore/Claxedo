# Agent Connections

Claxedo registers external agents through provider-owned connections. ACP is one
possible provider; it is not a special route, identity format, or browser
configuration shape.

Connections are trusted operator configuration. The browser receives only a
sanitized discovery record and never receives provider keys, commands,
endpoints, environment variables, headers, secret references, or resolved
credentials.

## Trusted v3 configuration

Connections live in `~/.claxedo/user-agent-config.json` under the required v3
`connections` map. Each map key must exactly match its descriptor's immutable
`connectionId`.

```jsonc
{
  "version": 3,
  "mcp": {},
  "connections": {
    "team-agent": {
      "connectionId": "team-agent",
      "providerKey": "acp",
      "configRevision": 1,
      "enabled": true,
      "config": {
        "label": "Team agent",
        "connection": {
          "kind": "process",
          "command": "/opt/agents/team-agent",
          "args": ["--acp"]
        },
        "secretBindings": {
          "env": { "TEAM_AGENT_TOKEN": "token" }
        },
        "modelSelection": { "status": "optional" }
      },
      "secretRefs": {
        "token": "credentials/team-agent-token"
      }
    }
  },
  "defaultConnectionId": "team-agent"
}
```

`defaultConnectionId` is optional. Omitting it leaves agent selection
unresolved; file order never selects a connection. Changing trusted settings
requires a higher `configRevision`. A different provider or endpoint identity
requires a new `connectionId`.

ACP `secretBindings.env` (process connections) and
`secretBindings.headers` (HTTP/WebSocket connections) map a target variable or
header name to a provider secret name. That name must have a matching
`secretRefs` entry. The host resolves it immediately before adapter creation;
the descriptor and browser projection never contain the resolved value.

There is no v1/v2 decoder, ACP map importer, built-in OpenCode row, or fallback
connection.

### Where the file lives

The desktop app keeps one data directory per release channel, so the file a
`dev` build reads is not the one a `prod` build reads:

| Channel | Data directory |
| --- | --- |
| `prod` | `~/.claxedo/` |
| `beta` | `~/.claxedo-beta/` |
| `dev` | `~/.claxedo-dev/` |

`CLAXEDO_DATA_DIR` overrides the directory for every channel. The server
watches the directory: a connection written by hand, or by a script, reaches
the running workspace runtimes within a second, the same as one saved through
the API. A file that no longer parses is left alone until it does.

### Process connections

A `process` connection is spawned directly, with no shell; the one exception
is a Windows `.cmd` or `.bat` shim, which `cmd.exe` has to run. `command` is
resolved the way `execvp` resolves it: an absolute path is used as written, and
a bare name is looked up on the server's `PATH`. Because an app started from
the Dock or a launcher inherits none of the login shell's additions, the
desktop app prepends the usual install directories to that `PATH` at launch:
`~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin` on macOS;
`~/.local/bin`, `/usr/local/bin` and `/usr/bin` on Linux; nothing on Windows.
A binary anywhere else needs an absolute `command`. Shell syntax in `command`
or `args` is passed to the agent literally.

The agent's stdout is the protocol stream; its stderr is logged by the server,
and its last stderr line is attached to a failed handshake so a binary that
refuses to start says why.

### Turn timeouts

A turn has no wall-clock limit. The only bound is the agent going quiet: a
turn fails when the agent has sent no `session/update` for
`CLAXEDO_ACP_PROMPT_TIMEOUT_MS` (default 300000) while nothing is waiting on
the human. A permission request the user has not answered holds that countdown
open, and a long tool call keeps it alive by streaming. When the countdown
fires, the agent's session is cancelled and the process is replaced; a turn
queued on the same process fails with the same reason.

| Variable | Default | Bounds |
| --- | --- | --- |
| `CLAXEDO_ACP_PROMPT_TIMEOUT_MS` | 300000 | Silence inside a turn |
| `CLAXEDO_ACP_IDLE_TIMEOUT_MS` | 300000 | A process with no turn running |
| `CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS` | 10000 | `session/new`, `session/load`, mode changes |
| `CLAXEDO_ACP_INITIALIZE_TIMEOUT_MS` | same as new-session | The `initialize` handshake |
| `CLAXEDO_ACP_PROBE_TIMEOUT_MS` | same as new-session | Config-option discovery |

### What an ACP connection cannot do

The adapter advertises the capabilities the protocol gives it and nothing
more. Compared with the native harnesses, an ACP connection has:

- no reconnect: a process that exits mid-turn fails the turn and is replaced
  on the next one;
- no questions, todos, slash commands, revert, or subagents;
- one turn at a time per process: sessions that share a workspace share the
  process and queue behind each other;
- instructions delivered as a prefix of the prompt, not as a system channel;
- model selection marked `optional`, with whatever `session/new` returns as
  the model list.

### Permissions

Every `session/request_permission` is shown as a permission prompt. The
protocol carries no command or path patterns, only the agent's `title`, so
that title is what the prompt shows and what an "always" answer remembers: the
next request with the same tool kind and the same title is answered with the
agent's allow option without asking. Agents that keep their own allowlist
still receive `allow_always` when they offer it. A compound shell command is a
new title each time it changes, so a per-program allowlist has to come from the
agent.

### Already-running OpenCode server

An OpenCode HTTP server uses the same descriptor slot with provider key
`opencode-server`; Claxedo never starts, discovers, or bundles that process.
`workspacePaths` is required because the local Claxedo workspace path and the
path understood by a remote VM may differ.

```jsonc
{
  "connectionId": "team-opencode",
  "providerKey": "opencode-server",
  "configRevision": 1,
  "enabled": true,
  "config": {
    "label": "Team OpenCode",
    "baseUrl": "https://agents.example.com",
    "workspacePaths": [
      {
        "sourceDirectory": "/Users/me/projects/app",
        "targetDirectory": "/srv/workspaces/app"
      }
    ],
    "auth": {
      "type": "header",
      "name": "X-API-Key",
      "valueSecret": "apiKey"
    },
    "trustedHeaders": { "X-Agent-Gateway": "gatewayToken" },
    "tenant": { "header": "X-Tenant", "value": "team-1" },
    "reconnect": { "maxAttempts": 2, "delayMs": 100 },
    "deadlines": { "requestMs": 15000, "streamIdleMs": 30000 }
  },
  "secretRefs": {
    "apiKey": "credentials/team-opencode-api-key",
    "gatewayToken": "credentials/agent-gateway-token"
  }
}
```

Basic authentication is also supported with
`{ "type": "basic", "username": "opencode", "passwordSecret": "password" }`.
Every secret name used by `auth` or `trustedHeaders` must have exactly one
matching `secretRefs` entry. OpenCode owns model selection, so the connection
advertises `modelSelection: { status: "unsupported" }`; the composer does not
invent a model or call a config-options endpoint for it.

## Authenticated local API

The local server exposes one generic route family under
`/api/claxedo/agent-config/connections`:

| Method + path | Effect |
| --- | --- |
| `GET /connections` | Returns `{ connections: HarnessConnectionRef[] }`. |
| `PUT /connections/:connectionId` | Atomically validates and stores one complete trusted descriptor. |
| `DELETE /connections/:connectionId` | Removes one connection and clears it as the explicit default, if selected. |

The removed `/harness/acp-connections` path has no alias.

The public `HarnessConnectionRef` contains only:

```ts
type HarnessConnectionRef = {
  connectionId: string
  label: string
  enabled: boolean
  readiness: "ready" | "unavailable" | "disabled"
  capabilities: {
    abort: boolean
    reconnect: boolean
    replay: boolean
    permissions: boolean
    questions: boolean
    todos: boolean
    commands: boolean
    fork: boolean
    revert: boolean
    unrevert: boolean
    configOptions: boolean
    subagents: boolean
  }
  modelSelection?:
    | { status: "required"; models: AgentModel[] }
    | { status: "optional"; models?: AgentModel[] }
    | { status: "unsupported" }
}
```

The Connections settings screen lists this projection and can remove a
connection. Provider-specific add/edit payloads remain an authenticated
operator action rather than a raw-secret browser form.

## Selection and model policy

Connection IDs are opaque. A client must not prefix, parse, or turn them into a
legacy ACP string. Runtime selection uses the discriminated target
`{ kind: "connection", connectionId }`; native selection uses
`{ kind: "native", harnessId }`.

The picker follows the advertised `modelSelection` policy:

- `required`: a model must be selected before submission.
- `optional`: model selection may be offered, but an empty model list does not
  block submission.
- `unsupported`: the agent owns model selection and the UI does not fabricate a
  model row.

Until a runtime endpoint accepts the discriminated target, the app must leave a
connection unselectable. It must not install a compatibility string encoding.

## Secret and lifecycle rules

- Secret references resolve on the host immediately before adapter creation.
- Public responses and logs expose only redacted typed failures.
- Disabled, unknown, unavailable, expired, revoked, or uninstalled connections
  fail closed without falling back to another agent.
- Config and secret-generation changes invalidate the prior adapter generation.
- Removing a connection prevents new execution while canonical session history
  remains readable.

## Server logs

The desktop app writes the embedded server's stdout and stderr, which carry
every ACP adapter line including the agent's stderr, to `server.log` next to
`main.log` in the app's log directory (`~/Library/Logs/<app name>/` on macOS).
One previous generation is kept as `server.old.log`.

## Grounding

- Trusted descriptor and provider-owned public projection:
  `packages/agent-sdk-runtime/src/connection-provider.ts`
- Turn quiet countdown and permission hold:
  `packages/agent-sdk-runtime/src/harnesses/acp/process.ts`
- Remembered "always" answers:
  `packages/agent-sdk-runtime/src/harnesses/acp/permission-grants.ts`
- Config file watch:
  `packages/claxedo-server-core/src/agent-config/index.ts`
- Strict v3 persistence/map validation:
  `packages/claxedo-server-core/src/agent-config/connections.ts`
- Secret boundary:
  `packages/claxedo-server-core/src/agent-config/connection-secrets.ts`
- Generic CRUD route:
  `packages/claxedo-local-server/src/agent-config/routes/connection-routes.ts`
- Browser decoder/store:
  `packages/claxedo-app/src/platform/query/connection-catalog.ts`
- External OpenCode descriptor and adapter:
  `packages/opencode-server-adapter/src/config.ts` and
  `packages/opencode-server-adapter/src/adapter.ts`
