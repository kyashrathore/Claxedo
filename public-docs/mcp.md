# Claxedo MCP

`@claxedo/mcp` is a bridge between an MCP client and a Claxedo runtime/server.
It lets an agent running inside any MCP-compatible client call Claxedo runtime
and control-plane APIs as tools: managed processes, logs, session messages,
background session dispatch, and documents.

It does not run the workspace, start the agent harness, or replace
`workspace-runtime`. The workspace still lives behind a Claxedo runtime/server
URL. `@claxedo/mcp` only translates MCP tool calls into HTTP requests to that
URL.

It is a local operator tool. Run it on the same machine as the Claxedo
desktop/server loopback endpoint, or against an intentionally configured signed
remote Claxedo server. Do not expose it as a shared remote MCP endpoint.

## Install In An MCP Client

> Developing from this repo? You can also run the server from source —
> `bun run --cwd packages/claxedo-mcp start` with the same environment
> variables — or point the MCP client's command at that script.

Paste config like this into an MCP client such as Claude Desktop, Codex, or any
other MCP-compatible app. This is not a terminal command and it is not
JavaScript. It goes in the MCP client's server configuration file or settings
UI:

```json
{
  "command": "npx",
  "args": ["-y", "@claxedo/mcp"],
  "env": {
    "CLAXEDO_SERVER_URL": "http://127.0.0.1:2593"
  }
}
```

This mirrors the package's bundled `mcp.json`. Where it is used:

| Place | What to do |
| --- | --- |
| MCP client config file | Add this JSON as one MCP server entry, using whatever wrapper shape that client expects. |
| MCP client settings UI | Put `npx` in the command field, `-y` and `@claxedo/mcp` in the args field, and `CLAXEDO_SERVER_URL=http://127.0.0.1:2593` in env. |
| Terminal | Do not paste the JSON. Use the debug command below instead. |

Equivalent terminal command for debugging:

```sh
CLAXEDO_SERVER_URL=http://127.0.0.1:2593 npx -y @claxedo/mcp
```

In normal usage, you do not run that terminal command yourself. The MCP client
runs it when it starts the configured MCP server.

That means:

| Field | Meaning |
| --- | --- |
| `command` | The executable the MCP client should run. |
| `args` | Arguments for that executable. Here it runs the `@claxedo/mcp` package from npm through `npx`. |
| `env.CLAXEDO_SERVER_URL` | The Claxedo runtime/server the bridge should call when a tool is used. |

After the MCP client starts this subprocess, the flow is:

```text
agent in MCP client
  -> calls MCP tool, for example process(action: "list")
  -> @claxedo/mcp receives the tool call over stdio
  -> @claxedo/mcp calls http://127.0.0.1:2593/api/wr/process
  -> Claxedo runtime/server performs the workspace action
  -> result goes back to the MCP client
```

MCP tool calls arrive as JSON-RPC `tools/call` requests. The invocation the MCP
client sends for that example is:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "process",
    "arguments": { "action": "list" }
  }
}
```

`@claxedo/mcp` turns that into an HTTP request to the configured Claxedo
server/runtime and returns the process list as the MCP tool result.

## Request Scope

Tools use one of two request scopes:

- **Workspace scope** — process, logs, session, document, and `spawn_session`
  tools resolve a project directory (from `directory`/`workspace_id` args, or the
  `OPENCODE_API_DIR` / `CLAXEDO_WORKSPACE_ID` defaults) and pass it to the server
  as an `x-opencode-directory` header plus query string.
- **Owner scope** — `cloud_workspace_*` tools address a cloud workspace by
  `workspace_id` and send no project directory. The server derives the
  organization and user from trusted request context; the MCP never sends a
  tenant selector, and these tools accept no `owner`/`org`/`user`-style
  argument.

## Environment Variables

Local use needs none of these — the server URL defaults to loopback
(`http://127.0.0.1:2593`). These knobs exist for non-default directories,
workspaces, and signed remote servers.

| Env var | Purpose |
| --- | --- |
| `CLAXEDO_SERVER_URL` | Base URL for the Claxedo server. Defaults to `http://127.0.0.1:2593`. |
| `CLAXEDO_AUTH_TOKEN` | Optional bearer token sent as `Authorization: Bearer …` on every server request. Set only when pointing the MCP at a signed remote Claxedo server. |
| `CLAXEDO_API_DIR` | Default local project directory for workspace-scoped requests. |
| `CLAXEDO_WORKSPACE_ID` | Default workspace id for Docker/cloud workspace requests. |
| `CLAXEDO_SESSION_ID` | Optional current session id used by `documents_open` and the documents CLI for the per-project local file grant. |
| `CLAXEDO_TERMINAL_ID` | Default terminal id for `get_logs`, `session_messages`, and `summarize_logs` when no id is passed. Set automatically inside a Claxedo terminal. |
| `CLAXEDO_TAB_ID` | Fallback tab id for `session_messages` when a terminal id is unavailable. |
| `CLAXEDO_MCP_MODE` / `CLAXEDO_MCP_READ_ONLY` | Select read-only mode (see [Modes](#modes)). |

Local Claxedo usage relies on the app's loopback trust boundary. The curated
marketplace install does not receive a Claxedo user token, JIT token, or broker
token. Set `CLAXEDO_AUTH_TOKEN` only when intentionally pointing the MCP server
at a signed remote Claxedo server, and treat remote `CLAXEDO_SERVER_URL` values
as privileged: the MCP sends log, process, session, and document requests to
that origin, plus any configured bearer token.

## Modes

Full-control mode is the default. It registers every tool, including process
mutation, background session dispatch, and log summarization through a
temporary agent session.

Read-only mode is selected with either of:

```sh
CLAXEDO_MCP_MODE=read-only
# or
CLAXEDO_MCP_READ_ONLY=1
```

`CLAXEDO_MCP_READ_ONLY` accepts `1`, `true`, or `yes` (case-insensitive).
Read-only mode omits every mutating tool:

- `process`
- `spawn_session`
- `summarize_logs`

Read-only mode keeps the non-mutating surface:

- `get_logs`
- `session_messages`
- `documents_list`
- `documents_open`

Note that `documents_open` stays available in read-only mode even though it
performs a single side effect on the server (granting a session-scoped file
path); it is an observation tool, not a workspace mutation.

## Tool Surface

The server registers the following tools (mutating tools omitted in read-only
mode).

### Runtime and control-plane tools

| MCP tool | What it does | Routes it calls |
| --- | --- | --- |
| `process` | Manage dev servers, watchers, and long-running processes. Actions: `list`, `start`, `stop`, `restart`, `add`, `update`, `remove`, `start_all`, `stop_all`. `add`/`update`/`remove` edit `.claxedo/processes.jsonc`. | Lifecycle via `GET /api/wr/process`, `POST /api/wr/process/{id}/{start,stop,restart}`, `POST /api/wr/process/{start-all,stop-all}`; config edits via `POST /process`, `PUT /process/{id}`, `DELETE /process/{id}` |
| `get_logs` | Fetch terminal or process output by `process_id`, `name`, `pty_id`, or `terminal_id`; `lines` returns only the tail. With no id, lists managed processes and PTYs. | `GET /api/wr/process/logs`, `GET /api/wr/pty` |
| `session_messages` | Fetch structured messages for a chat/agent session, or resolve the currently running terminal/tab agent's session first. Falls back to a recorded transcript file. | `GET /api/wr/hook/terminal-session`, `GET /session/{id}/message` |
| `spawn_session` | Dispatch a background hybrid Claxedo session on the control plane and optionally fire an initial prompt (fire-and-forget). Returns the new session id and `/s/{id}` app URL. | `POST /api/control/sessions`, `POST /api/control/session/{id}/message` |
| `summarize_logs` | Fetch logs (or accept raw `text`), create a temporary agent session, summarize with the configured harness, and delete the temporary session. | `GET /api/wr/process/logs`, `POST /session`, `POST /session/{id}/message`, `DELETE /session/{id}` |

### Document tools

| MCP tool | What it does | Routes it calls |
| --- | --- | --- |
| `documents_list` | List Claxedo document index metadata for a project. Returns metadata only, never document bodies. | `GET /documents?…&archived=active` |
| `documents_open` | Resolve a `claxedo://document/<id>` reference, an exact id, or an unambiguous display name into an honest canonical absolute file path granted to the current session. | `GET /documents?…&archived=all`, `POST /documents/{id}/agent-open` |

`documents_open` requires a session id — from the `session_id` argument or the
`CLAXEDO_SESSION_ID` default — because it grants a session-owned path.

## Full-Control Risks

`process` can create, update, or remove `.claxedo/processes.jsonc` entries and
start, stop, restart, or bulk-control long-running commands. `spawn_session`
creates a background control-plane session and can dispatch an initial prompt.
`summarize_logs` creates a temporary Claxedo session and sends log text to the
configured runtime/model — logs can contain secrets or customer data.
Treat all of these as active permissions:
prefer an MCP client that shows tool calls before execution, and pair
`CLAXEDO_AUTH_TOKEN` with server-side audit logging for hosted/remote use.

## Documents CLI And Skill

The same document contract is available without an MCP client. The published
binary is `claxedo-mcp`:

```sh
claxedo-mcp documents list
claxedo-mcp documents open 'claxedo://document/<id>' --session '<session-id>'
```

`CLAXEDO_API_DIR` and `CLAXEDO_SESSION_ID` (or `--directory`/`--project` and
`--session`) provide the default project and session. The published package
includes `skills/claxedo-documents/SKILL.md` so an Agent Plugins collection can
teach supported harnesses to resolve compact document references instead of
copying absolute paths.

## Example Payloads

These use the real MCP `tools/call` JSON-RPC shape — `params.name` and
`params.arguments`.

List configured processes:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "process",
    "arguments": { "action": "list" }
  }
}
```

Add a dev-server process:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "process",
    "arguments": {
      "action": "add",
      "name": "web",
      "command": "bun",
      "args": ["run", "dev"],
      "port": { "name": "web", "inject": "PORT", "preferred": 3000 }
    }
  }
}
```

Tail process logs:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "get_logs",
    "arguments": { "name": "web", "lines": 200 }
  }
}
```

## Grounding

Implemented in:

- `packages/claxedo-mcp/src/server.ts`
- `packages/claxedo-mcp/src/documents-tools.ts`
- `packages/claxedo-mcp/src/documents-cli.ts`
- `packages/claxedo-mcp/src/cloud-workspace-tools.ts`
- `packages/claxedo-mcp/src/process-handler.ts`
- `packages/claxedo-mcp/src/tool-policy.ts`
- `packages/claxedo-mcp/src/request-scope.ts`
- `packages/claxedo-mcp/src/http-error.ts`
- `packages/claxedo-mcp/README.md`
