# Claxedo MCP

`@claxedo/mcp` is a small bridge between an MCP client and a Claxedo
runtime/server. It lets an agent running inside any MCP-compatible client call
Claxedo runtime APIs as tools.

It does not run the workspace, start the agent harness, or replace
`workspace-runtime`. The workspace still lives behind a Claxedo runtime/server
URL. `@claxedo/mcp` only translates MCP tool calls into HTTP requests to that
URL.

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

Where it is used:

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

For example, if the agent calls:

```json
{ "tool": "process", "args": { "action": "list" } }
```

`@claxedo/mcp` turns that into an HTTP request to the configured Claxedo
server/runtime and returns the process list as the MCP tool result.

## Environment Variables

Local use needs none of these — the server URL defaults to loopback
(`http://127.0.0.1:3001`). These knobs exist for non-default directories,
workspaces, and signed remote servers.

| Env var | Purpose |
| --- | --- |
| `CLAXEDO_SERVER_URL` | Base URL for the Claxedo server. Defaults to `http://127.0.0.1:3001`. |
| `OPENCODE_API_DIR` | Default local project directory for requests. |
| `CLAXEDO_WORKSPACE_ID` | Default workspace id for Docker/cloud workspace requests. |
| `CLAXEDO_AUTH_TOKEN` | Optional signed remote server bearer token. |

Local Claxedo usage relies on the app's loopback trust boundary. Set
`CLAXEDO_AUTH_TOKEN` only when intentionally pointing the MCP server at a
signed remote Claxedo server.

## Current Tool Surface

The current MCP server registers tools for:

- process config and process lifecycle
- process and terminal log retrieval
- session message retrieval
- log summarization
- browser tab listing
- browser screenshots
- browser console logs
- browser JavaScript evaluation
- browser navigation

The README names these current tools:

- `process`
- `get_logs`
- `session_messages`
- `summarize_logs`
- `browser_list_tabs`
- `browser_screenshot`
- `browser_get_console_logs`
- `browser_evaluate_js`
- `browser_navigate`

## What The Tools Call

| MCP tool | What it does | Runtime/server routes |
| --- | --- | --- |
| `process` | Manage dev servers, watchers, and long-running workspace processes. Supports list, add, update, remove, start, stop, restart, start_all, and stop_all. | `/api/wr/process/*` |
| `get_logs` | Fetch terminal or process output by `process_id`, process `name`, `pty_id`, or `terminal_id`. | `/api/wr/process/logs` |
| `session_messages` | Fetch structured messages for a chat/agent session, or resolve the current terminal/tab agent session. | `/session/:id/message`, `/api/wr/hook/terminal-session` |
| `summarize_logs` | Fetch logs or accept raw text, create a temporary agent session, and summarize the output with the configured harness. | `/api/wr/process/logs`, `/session`, `/session/:id/message` |
| Browser tools | List tabs, screenshot, read console logs, evaluate JavaScript, and navigate browser panes. | Browser bridge routes exposed by the Claxedo server/runtime integration. |

Example MCP tool-call payloads:

```json
{ "tool": "process", "args": { "action": "list" } }
```

```json
{
  "tool": "process",
  "args": {
    "action": "add",
    "name": "web",
    "command": "bun",
    "args": ["run", "dev"],
    "port": { "name": "web", "inject": "PORT", "preferred": 3000 }
  }
}
```

```json
{ "tool": "get_logs", "args": { "name": "web", "lines": 200 } }
```

## Grounding

Implemented in:

- `packages/claxedo-mcp/src/server.ts`
- `packages/claxedo-mcp/src/process-handler.ts`
- `packages/claxedo-mcp/src/browser-tools.ts`
- `packages/claxedo-mcp/README.md`
