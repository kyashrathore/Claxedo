# Claxedo MCP

Standalone MCP server for Claxedo runtime tools. Install it from the Claxedo marketplace under MCP Servers instead of relying on an app-managed sidecar.

The default marketplace config launches the published package with `npx -y @claxedo/mcp` and points it at the local Claxedo server with `CLAXEDO_SERVER_URL`.

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
- `CLAXEDO_AUTH_TOKEN`: optional signed remote server bearer token.
- `CLAXEDO_MCP_MODE=read-only` or `CLAXEDO_MCP_READ_ONLY=1`: omit mutating tools.

Current tool surface:

- `process`
- `get_logs`
- `session_messages`
- `summarize_logs`
- `browser_list_tabs`
- `browser_screenshot`
- `browser_get_console_logs`
- `browser_evaluate_js`
- `browser_navigate`
