# Claxedo MCP

Give any MCP-capable agent direct access to a running Claxedo server's WorkGraph, documents, processes, logs, sessions, and browser tools over stdio.

## Quickstart

Run it straight from npm — no local checkout, no build step:

```sh
npx -y @claxedo/mcp
```

Point a stdio MCP client at it with a config block like:

```json
{
  "mcpServers": {
    "claxedo": {
      "command": "npx",
      "args": ["-y", "@claxedo/mcp"],
      "env": {
        "CLAXEDO_SERVER_URL": "http://127.0.0.1:3001"
      }
    }
  }
}
```

`command`/`args`/`env` are the same three fields the Claxedo marketplace config below installs under its own `servers` key (see `mcp.json` in this package) — reshape them to whatever top-level key your MCP client expects.

Standalone MCP server for Claxedo runtime tools. Install it from the Claxedo marketplace under MCP Servers instead of relying on an app-managed sidecar.

The default marketplace config launches the published package with `npx -y @claxedo/mcp` and points it at the local Claxedo server with `CLAXEDO_SERVER_URL`.

The standalone process is a northbound operator client, so every WorkGraph tool
uses the authenticated WorkGraph HTTP contract. Local Claxedo agent Sessions use
the same tool schemas through the embedded OpenCode application-tool registry;
those calls stay inside Claxedo Server and invoke its WorkGraph service and
query ports directly. The embedded registration is enabled for the local-only
owner composition. Hosted in-process registration remains fail-closed until a
durable Session supplies verified organization-and-user provenance. Signed
remote stdio clients authenticate to the HTTP boundary with
`CLAXEDO_AUTH_TOKEN`.

## Trust Model

This MCP is a local operator tool. It is meant to run on the same machine as the
Claxedo desktop/server loopback endpoint or against an intentionally configured
signed remote Claxedo server. Do not expose it as a shared remote MCP endpoint.

Local Claxedo uses the app's loopback trust boundary. The curated marketplace
install does not receive a Claxedo user token, JIT token, or broker token.
Configure `CLAXEDO_AUTH_TOKEN` only when intentionally
pointing this MCP at a signed remote Claxedo server.

`CLAXEDO_SERVER_URL` should be a loopback URL such as
`http://127.0.0.1:3001` for local use. Treat remote URLs as privileged: the MCP
will send log, process, session, and browser-control requests to that origin,
plus any configured bearer token.

## Modes

Full-control mode is the default for backwards compatibility. It registers all
tools, including process mutation, log summarization through a temporary agent
session, browser navigation, and browser JavaScript evaluation.

Read-only mode is available with either:

```sh
CLAXEDO_MCP_MODE=read-only
# or
CLAXEDO_MCP_READ_ONLY=1
```

Read-only mode registers:

- `get_logs`
- `session_messages`
- `browser_list_tabs`
- `browser_screenshot`
- `browser_get_console_logs`
- `workgraph_get_defaults`
- `workgraph_execution_capabilities`
- `workgraph_attention`
- `workgraph_list`
- `workgraph_get`
- `workgraph_source_revision`
- `workgraph_source_views` when the embedded/HTTP host supports it
- `workgraph_intake` when the embedded/HTTP host supports it
- `workgraph_get_candidate` when the embedded/HTTP host supports it
- `workgraph_evidence` when the embedded/HTTP host supports it
- `workgraph_runs` when the embedded/HTTP host supports it
- `workgraph_recap`

Read-only mode omits:

- `process`
- `summarize_logs`
- `browser_evaluate_js`
- `browser_navigate`

## Full-Control Risks

The `process` tool can create/update/remove `.claxedo/processes.jsonc` entries
and start, stop, restart, or bulk-control long-running commands. A malicious or
mistaken MCP client can alter developer workflow state or run commands that
bind ports and access local files through those commands.

`summarize_logs` creates a temporary Claxedo session and sends log text to the
configured runtime/model. Logs can contain secrets or customer data; review MCP
client prompts and model routing before enabling it for sensitive workspaces.

Browser tools call the Claxedo desktop bridge. `browser_evaluate_js` only runs
when the user has explicitly enabled agent JavaScript for that browser tab, and
the bridge returns a denial otherwise. `browser_navigate` changes the page in a
browser pane. Treat both as active browser-control permissions.

## Audit Expectations

Run the MCP through a client that shows tool calls before execution when
possible. For hosted/remote use, pair `CLAXEDO_AUTH_TOKEN` with server-side
audit logging. Browser bridge mutations are logged by the desktop bridge; read
tools are best-effort observability and should not be treated as a complete
security audit trail.

Supported environment:

- `CLAXEDO_SERVER_URL`: Claxedo server URL. Defaults to `http://127.0.0.1:3001`.
- `OPENCODE_API_DIR`: default local project directory.
- `CLAXEDO_WORKSPACE_ID`: default Docker/cloud workspace id.
- `CLAXEDO_SESSION_ID`: optional current session id for document path grants.
- `CLAXEDO_AUTH_TOKEN`: optional signed remote server bearer token.
- `CLAXEDO_MCP_MODE=read-only` or `CLAXEDO_MCP_READ_ONLY=1`: omit mutating tools.

Current tool surface:

- `documents_list`
- `documents_open`, which accepts `claxedo://document/<id>`, an exact id, or an unambiguous display name

- `process`
- `get_logs`
- `session_messages`
- `summarize_logs`
- `browser_list_tabs`
- `browser_screenshot`
- `browser_get_console_logs`
- `browser_evaluate_js`
- `browser_navigate`
- owner-scoped `workgraph_*` inspection, source admission, organization,
  live execution capability, Attention, execution, Decision, evidence, lifecycle,
  Source View, candidate, and exact source-revision tools. WorkGraph
  calls use authenticated owner scope independently of process workspace
  selection. Local embedded tools receive that scope from the local composition;
  standalone stdio tools receive it from the server's authenticated HTTP boundary.
  Intake staging returns the immutable source and admission proposal
  for review, and confirmation uses the same `workgraph_admit` command as the app. See
  `skills/workgraph/SKILL.md` for the current vocabulary.

## Documents CLI and skill

The same document contract is available without an MCP client:

```sh
claxedo-mcp documents list
claxedo-mcp documents open 'claxedo://document/<id>' --session '<session-id>'
```

`OPENCODE_API_DIR` and `CLAXEDO_SESSION_ID` provide the default project and
session. The published package includes `skills/claxedo-documents/SKILL.md` so
agent-extension installation can teach supported harnesses to resolve compact
document references instead of copying absolute paths into prompts.
