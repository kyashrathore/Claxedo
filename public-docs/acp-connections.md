# Agent Connections

Claxedo registers external agents through provider-owned connections. ACP is one
possible provider; it is not a special route, identity format, or browser
configuration shape. This page is the reference for the descriptor, the routes
and the runtime's rules; [Using an ACP Agent](./using-agent-connections.md) is
the walkthrough.

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

A v1 or v2 file is migrated to v3 once, with the original kept beside it as
`user-agent-config.legacy-vN.json`; a legacy ACP identity in that file is
dropped, not translated. There is no built-in OpenCode row and no fallback
connection.

`config.connection.supportsMcpServers: false` stops Claxedo from handing its
configured MCP servers and its own per-session server to the agent on
`session/new`, `session/fork` and `session/resume`; by default they are all
forwarded.

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

The process is started in the server's own working directory; the workspace or
worktree path reaches the agent as the `cwd` of every `session/new`,
`session/resume`, `session/load` and `session/fork` request, and one process
serves one directory (the process key includes it).

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
| `CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS` | 10000 | `session/new`, `session/resume`, `session/load`, mode changes, the per-turn session sync |
| `CLAXEDO_ACP_INITIALIZE_TIMEOUT_MS` | same as new-session | The `initialize` handshake |
| `CLAXEDO_ACP_PROBE_TIMEOUT_MS` | same as new-session | Config-option discovery |
| `CLAXEDO_ACP_RPC_STALL_LOG_MS` | 5000 | Log-only: a warning when one request has waited this long |

`CLAXEDO_ACP_IDLE_TIMEOUT_MS` is read once when the server starts; the others
are read per adapter.

After a server restart the first turn on a session asks the agent for
`session/resume`, or `session/load` when only that is advertised. An agent that
advertises neither fails that turn; only a "Resource not found" answer makes
Claxedo create a fresh agent session and rebind. Claxedo's own transcript is
never replayed into the agent on resume; the only transcript replay is the
harness handoff.

### What an ACP connection cannot do

The adapter advertises the capabilities the protocol gives it and nothing
more. Compared with the native harnesses, an ACP connection has:

- no reconnect: a process that exits mid-turn fails the turn with the agent's
  last stderr line, marks every session bound to that process as recovering,
  and is replaced on the next turn;
- no questions, slash commands, revert, or subagents as controls; the
  transcript still renders a `plan` update as a todo list and shows an
  `available_commands_update`;
- fork only when the agent advertises `sessionCapabilities.fork` (the browser
  projection reports `fork: false` regardless; the runtime reports the live
  value);
- one turn at a time per process: sessions that share a workspace share the
  process and queue behind each other;
- instructions delivered as the first content block of the prompt, annotated
  for the assistant, not as a system channel;
- the runtime treats model selection as optional; the browser projection
  carries whatever `config.modelSelection` the operator wrote, and omits the
  field when unset. The model list is the agent's `model` config option or its
  `availableModels` channel, cached per process, and selecting a model restarts
  the connection's processes;
- attachments are written to `<workspace>/.claxedo/attachments/` and named in
  the prompt; images go inline when the agent negotiated inline images,
  other files inline when it negotiated embedded context, otherwise as a
  resource link. An agent that negotiated neither and shares no filesystem
  makes the turn fail rather than dropping the attachment;
- Goal mode only when the agent negotiates the Goal extension on
  `session/new` (`_meta.goal`, version 1, at least get/start/stop).

### Permissions

A `session/request_permission` is shown as a permission prompt carrying the
agent's `title`, the command for an `execute` request or the reason otherwise,
and the `locations` the agent named as path patterns. An "always" answer is
remembered per session, keyed by tool kind and the exact title, on the
session's stored permission state, so it survives a process or app restart and
is cleared when the session changes harness; the next matching request is
answered without a prompt and recorded only as replied. A request with no
title is never remembered. Agents that keep their own allowlist still receive
`allow_always` when they offer it. A compound shell command is a new title each
time it changes, so a per-program allowlist has to come from the agent.

Two answers never reach the user: a remembered "always", and the app's own
"Approve for me" allowlist, which auto-approves `search`, `think` and `edit`
requests and asks for everything else.

Permission modes come from the agent, either a `mode` config option or ACP
session modes, and apply from the next turn; a turn fails when the agent keeps
a different mode than the one selected. Cancelling a turn answers every
outstanding request as cancelled.

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
operator action rather than a raw-secret browser form. Both shipped providers
report `readiness: "ready"` for an enabled descriptor and `"disabled"` for a
disabled one; `"unavailable"` is in the type and reachable by no provider
today.

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

The composer lists every enabled connection beside the native harnesses.
Session creation takes `connectionId=` or `nativeHarness=` (never both, never
a legacy `harness` string), and `PATCH /session/:id/config?connectionId=` hands
an idle session to another harness, replaying the transcript so far as a
system block. `POST /api/claxedo/agent-config/harness` writes the global
default (`defaultConnectionId` or `defaultHarness`) and ignores `directory`;
the per-workspace choice for new drafts is the browser's own memory.

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
