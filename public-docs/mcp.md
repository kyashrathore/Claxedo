# Claxedo MCP

`@claxedo/mcp` is a bridge between an MCP client and a Claxedo runtime/server.
It lets an agent running inside any MCP-compatible client call Claxedo runtime
and control-plane APIs as tools: managed processes, logs, session messages,
background session dispatch, documents, WorkGraph, and — when hosted inside the
Claxedo desktop app — browser panes.

It does not run the workspace, start the agent harness, or replace
`workspace-runtime`. The workspace still lives behind a Claxedo runtime/server
URL. `@claxedo/mcp` only translates MCP tool calls into HTTP requests to that
URL (and, for browser tools, to the desktop app's local bridge).

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
    "CLAXEDO_SERVER_URL": "http://127.0.0.1:3001"
  }
}
```

This mirrors the package's bundled `mcp.json`. Where it is used:

| Place | What to do |
| --- | --- |
| MCP client config file | Add this JSON as one MCP server entry, using whatever wrapper shape that client expects. |
| MCP client settings UI | Put `npx` in the command field, `-y` and `@claxedo/mcp` in the args field, and `CLAXEDO_SERVER_URL=http://127.0.0.1:3001` in env. |
| Terminal | Do not paste the JSON. Use the debug command below instead. |

Equivalent terminal command for debugging:

```sh
CLAXEDO_SERVER_URL=http://127.0.0.1:3001 npx -y @claxedo/mcp
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
  -> @claxedo/mcp calls http://127.0.0.1:3001/api/wr/process
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
- **Owner scope** — `workgraph_*` tools call the authenticated northbound
  WorkGraph HTTP contract with no directory selector. The server derives the
  organization and user from trusted request context; the MCP never sends a
  tenant selector, and the WorkGraph tools reject any `owner`/`org`/`user`-style
  argument.

## Environment Variables

Local use needs none of these — the server URL defaults to loopback
(`http://127.0.0.1:3001`). These knobs exist for non-default directories,
workspaces, signed remote servers, and desktop-hosted browser tools.

| Env var | Purpose |
| --- | --- |
| `CLAXEDO_SERVER_URL` | Base URL for the Claxedo server. Defaults to `http://127.0.0.1:3001`. |
| `CLAXEDO_AUTH_TOKEN` | Optional bearer token sent as `Authorization: Bearer …` on every server request. Set only when pointing the MCP at a signed remote Claxedo server. |
| `OPENCODE_API_DIR` | Default local project directory for workspace-scoped requests. |
| `CLAXEDO_WORKSPACE_ID` | Default workspace id for Docker/cloud workspace requests. |
| `CLAXEDO_REPOSITORY_URL` | Optional repository URL override used when `spawn_session`/WorkGraph creation resolves a hosted workspace's Git remote. |
| `CLAXEDO_SESSION_ID` | Optional current session id used by `documents_open` and the documents CLI for the per-project local file grant. |
| `CLAXEDO_TERMINAL_ID` | Default terminal id for `get_logs`, `session_messages`, and `summarize_logs` when no id is passed. Set automatically inside a Claxedo terminal. |
| `CLAXEDO_TAB_ID` | Fallback tab id for `session_messages` when a terminal id is unavailable. |
| `CLAXEDO_MCP_MODE` / `CLAXEDO_MCP_READ_ONLY` | Select read-only mode (see [Modes](#modes)). |
| `CLAXEDO_DESKTOP_URL` | Loopback URL of the Claxedo desktop app's local bridge. **Injected by the desktop app** at subprocess spawn time — do not set it by hand. |
| `CLAXEDO_DESKTOP_TOKEN` | Per-launch shared secret for the desktop bridge. **Injected by the desktop app** — do not set it by hand. |

Local Claxedo usage relies on the app's loopback trust boundary. The curated
marketplace install does not receive a Claxedo user token, JIT token, or broker
token. Set `CLAXEDO_AUTH_TOKEN` only when intentionally pointing the MCP server
at a signed remote Claxedo server, and treat remote `CLAXEDO_SERVER_URL` values
as privileged: the MCP sends log, process, session, document, WorkGraph, and
browser-control requests to that origin, plus any configured bearer token.

### Browser tools require the desktop app

The `browser_*` tools do not go through `CLAXEDO_SERVER_URL`. They call the
Claxedo desktop app's own local HTTP bridge, addressed by `CLAXEDO_DESKTOP_URL`
and authenticated with `CLAXEDO_DESKTOP_TOKEN`.

The Electron main process binds that bridge to `127.0.0.1` on an ephemeral
port, mints the per-launch secret, and pushes both values into this MCP
subprocess's environment **at spawn time** — but only when the desktop app is
launched with `CLAXEDO_ENABLE_BROWSER_TAB=1`. A standalone MCP client (Claude
Desktop, Codex, a terminal) cannot supply these values, so its browser tools
have no bridge to reach. When the pair is absent, every browser tool returns a
legible message:

> Browser tabs require the Claxedo desktop app with `CLAXEDO_ENABLE_BROWSER_TAB=1`.

In short: `browser_*` tools work only when the MCP subprocess is spawned by the
Claxedo desktop app. Everywhere else they are present in the tool list but
always report the desktop bridge as unavailable.

## Modes

Full-control mode is the default. It registers every tool, including process
mutation, background session dispatch, log summarization through a temporary
agent session, WorkGraph mutations, browser navigation, and browser JavaScript
evaluation.

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
- `browser_evaluate_js`
- `browser_navigate`
- every mutating `workgraph_*` tool (creation, execution, admission, decision,
  lifecycle, source-view configuration, intake staging, session binding, and so
  on)

Read-only mode keeps the non-mutating surface:

- `get_logs`
- `session_messages`
- `documents_list`
- `documents_open`
- `browser_list_tabs`
- `browser_screenshot`
- `browser_get_console_logs`
- the read-only `workgraph_*` tools: `workgraph_get_defaults`,
  `workgraph_execution_capabilities`, `workgraph_attention`, `workgraph_list`,
  `workgraph_get`, `workgraph_source_revision`, `workgraph_source_views`,
  `workgraph_intake`, `workgraph_get_candidate`, `workgraph_evidence`,
  `workgraph_attempts`, and `workgraph_activity`

Note that `documents_open` and the WorkGraph read tools stay available in
read-only mode even though they perform a single side effect on the server
(granting a session-scoped file path, or reading owner-scoped records); they are
observation tools, not workspace or WorkGraph mutations.

## Tool Surface

The server registers the following tools (mutating tools omitted in read-only
mode, browser tools functional only under the desktop app).

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

### WorkGraph tools

The `workgraph_*` family is the owner-scoped surface for organizing and
executing the authenticated user's AI work: personal defaults, live execution
capabilities, Attention, Streams/Outcomes/Work Items/Attempts, Work Sources and
exact revisions, admission proposals, Decisions, evidence, issue Source Views,
and intake candidates. WorkGraph calls use authenticated owner scope
independently of the process workspace selection.

Read tools map to dedicated GET routes; most mutations post to the single
WorkGraph command bus:

| Kind | MCP tools | Routes they call |
| --- | --- | --- |
| Read defaults / capabilities | `workgraph_get_defaults`, `workgraph_execution_capabilities` | `GET /api/workgraph/defaults`, `GET /api/workgraph/execution-capabilities` |
| Read work | `workgraph_attention`, `workgraph_list`, `workgraph_get`, `workgraph_source_revision`, `workgraph_attempts`, `workgraph_activity`, `workgraph_evidence` | `GET /api/workgraph/attention`, `GET /api/workgraph/snapshot`, `GET /api/workgraph/sources[/{id}[/revisions/{rev}]]`, `GET /api/workgraph/streams|work-items|attempts|proposals|decisions/{id}`, `GET /api/workgraph/work-items/{id}/{attempts,activity}`, `GET /api/workgraph/evidence[/{id}]` |
| Issue Source Views | `workgraph_source_views`, `workgraph_configure_source_view`, `workgraph_update_source_view`, `workgraph_delete_source_view`, `workgraph_refresh_source_view` | `GET/POST/PUT/DELETE /api/workgraph/source-views[/{id}[/refresh]]` |
| Intake candidates | `workgraph_intake`, `workgraph_get_candidate`, `workgraph_stage_candidate`, `workgraph_update_candidate`, `workgraph_sync_candidate` | `GET /api/workgraph/intake[/{id}]`, `POST /api/workgraph/intake/{id}/{stage,dismiss,restore,sync}` |
| Refresh capabilities | `workgraph_refresh_execution_capabilities` | `POST /api/workgraph/execution-capabilities/refresh` |
| Everything else (create, update, execute, admit, retry, cancel, lifecycle, findings, decisions, evidence, close, delete, update defaults) | `workgraph_create_*`, `workgraph_update`, `workgraph_execute`, `workgraph_admit`, `workgraph_propose_admission`, `workgraph_review_proposal`, `workgraph_retry`, `workgraph_cancel_work`, `workgraph_cancel`, `workgraph_pause`, `workgraph_stream_lifecycle`, `workgraph_record_finding`, `workgraph_record_evidence`, `workgraph_decision`, `workgraph_close`, `workgraph_delete`, `workgraph_update_defaults`, `workgraph_update_execution`, `workgraph_create_followup`, `workgraph_source` | `POST /api/workgraph/commands` |

Session-context tools — `workgraph_bind_session`, `workgraph_current_work`,
`workgraph_select_work`, `workgraph_record_progress`,
`workgraph_refresh_context`, `workgraph_complete_current_work`, and
`workgraph_release_session` — require a trusted embedded Session context. A
standalone stdio client has no such context, so these tools return a
`session_attachment_denied` error there; they are exercised by local Claxedo
agent Sessions that register the same schemas through the embedded application-
tool registry. Never supply an owner identity, workspace selector, or
credentials to any WorkGraph tool. See `skills/workgraph/SKILL.md` for the
current vocabulary.

### Browser tools (desktop-hosted only)

All five route through the desktop bridge (see
[Browser tools require the desktop app](#browser-tools-require-the-desktop-app)).
Bridge paths are relative to `CLAXEDO_DESKTOP_URL`.

| MCP tool | What it does | Bridge route |
| --- | --- | --- |
| `browser_list_tabs` | List open browser panes with `paneId`, title, URL, group, and the per-tab `agentAllowed` JS gate. | `GET /browser/tabs` |
| `browser_screenshot` | Capture a PNG (JPEG if oversized) of a pane, returned as an inline image content part, capped at ~1 MB. | `POST /browser/{paneId}/screenshot` |
| `browser_get_console_logs` | Pull console, exception, and log entries from a pane's ring buffer with `since`/`level`/`limit` filters. Read-only. | `GET /browser/{paneId}/console` |
| `browser_evaluate_js` | Evaluate a JavaScript expression in a pane's top frame. Runs only when the user has opted the pane into agent JS; otherwise returns a legible denial. Omitted in read-only mode. | `POST /browser/{paneId}/evaluate` |
| `browser_navigate` | Load an `http://`/`https://` URL in a pane. Agent-initiated; logged to the bound session's audit trail. Omitted in read-only mode. | `POST /browser/{paneId}/navigate` |

## Full-Control Risks

`process` can create, update, or remove `.claxedo/processes.jsonc` entries and
start, stop, restart, or bulk-control long-running commands. `spawn_session`
creates a background control-plane session and can dispatch an initial prompt.
`summarize_logs` creates a temporary Claxedo session and sends log text to the
configured runtime/model — logs can contain secrets or customer data. WorkGraph
mutations reorganize and execute the owner's work. `browser_navigate` changes
the page in a browser pane, and `browser_evaluate_js` runs arbitrary JS in a
pane the user explicitly opted in. Treat all of these as active permissions:
prefer an MCP client that shows tool calls before execution, and pair
`CLAXEDO_AUTH_TOKEN` with server-side audit logging for hosted/remote use.

## Documents CLI And Skill

The same document contract is available without an MCP client. The published
binary is `claxedo-mcp`:

```sh
claxedo-mcp documents list
claxedo-mcp documents open 'claxedo://document/<id>' --session '<session-id>'
```

`OPENCODE_API_DIR` and `CLAXEDO_SESSION_ID` (or `--directory`/`--project` and
`--session`) provide the default project and session. The published package
includes `skills/claxedo-documents/SKILL.md` and `skills/workgraph/SKILL.md` so
agent-extension installation can teach supported harnesses to resolve compact
document references and use the WorkGraph vocabulary instead of copying absolute
paths or inventing owner identities.

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

Read work needing owner attention:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "workgraph_attention",
    "arguments": { "limit": 20 }
  }
}
```

## Grounding

Implemented in:

- `packages/claxedo-mcp/src/server.ts`
- `packages/claxedo-mcp/src/workgraph-tools.ts`
- `packages/claxedo-mcp/src/documents-tools.ts`
- `packages/claxedo-mcp/src/documents-cli.ts`
- `packages/claxedo-mcp/src/desktop-request.ts`
- `packages/claxedo-mcp/src/browser-tools.ts`
- `packages/claxedo-mcp/src/process-handler.ts`
- `packages/claxedo-mcp/src/tool-policy.ts`
- `packages/claxedo-mcp/src/request-scope.ts`
- `packages/claxedo-mcp/src/http-error.ts`
- `packages/claxedo-mcp/README.md`
