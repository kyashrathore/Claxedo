# Architecture

This package ships two things that share one tool implementation: a standalone
stdio MCP server (`src/server.ts`, published as the `claxedo-mcp` bin) and a
set of registration functions (`registerDocumentTools`)
that a host process can import directly to register the same tools in-process.
Everything downstream of tool registration — schemas, handlers, error mapping —
is shared code; only how a call reaches Claxedo Server differs.

## stdio server vs. embedded registration

**Stdio server** (`src/server.ts`): a `node --import tsx` / compiled `dist/server.js`
subprocess. It builds a `McpServer` from `@modelcontextprotocol/sdk`, calls
`registerDocumentTools` with an HTTP-backed
transport (`httpRequest`, built on `fetch`), registers the process/logs/session
tools inline, calls `registerBrowserTools` for the desktop-bridge tools, and
connects a `StdioServerTransport`. Every call this process makes crosses an
HTTP boundary to `CLAXEDO_SERVER_URL` (default `http://127.0.0.1:3001`); there
is no in-process access to Claxedo Server's services. `server.ts` also doubles
as the `claxedo-mcp documents ...` CLI entry point: when `process.argv[2] ===
"documents"`, it runs `runDocumentsCli` instead of connecting the MCP
transport (see `src/documents-cli.ts`).

`registerDocumentTools` is the only registration function in this package:
the documents tools only run over the stdio server's HTTP transport
today.

## Desktop-bridge HTTP client and the `CLAXEDO_AUTH_TOKEN` trust boundary

Two distinct HTTP clients live in this package, with two distinct trust
boundaries:

- **`httpRequest`** (`src/server.ts`) talks to Claxedo Server itself
  (`CLAXEDO_SERVER_URL`, default `http://127.0.0.1:3001`). It attaches
  `Authorization: Bearer ${CLAXEDO_AUTH_TOKEN}` when that env var is set, plus
  scope headers from `claxedoRequestScope` (`src/request-scope.ts`): a
  `directory`/`workspaceId` query string and `x-opencode-directory` /
  `x-workspace-id` headers for workspace-scoped calls, or no scope headers at
  all for `scope: "owner"` calls (used by the `cloud_workspace_*` tools and the
  workspace-resolve lookup). `CLAXEDO_AUTH_TOKEN` is optional for local
  loopback use — the local Claxedo app trusts loopback origin instead — and
  required in practice once this MCP points at a signed remote Claxedo server,
  per the README's Trust Model section.

- **`desktopRequest`** (`src/desktop-request.ts`) talks to a *different*
  server: the Claxedo desktop app's local HTTP bridge, reached via
  `CLAXEDO_DESKTOP_URL` with a per-launch shared secret in
  `CLAXEDO_DESKTOP_TOKEN`. Both are pushed into this MCP subprocess's
  environment by the Electron main process at spawn time; they are not
  user-configured like `CLAXEDO_SERVER_URL`/`CLAXEDO_AUTH_TOKEN`. Every
  request sets the `x-claxedo-desktop-token` header to the secret and a fixed
  synthetic `Origin: claxedo-agent-tools://local`, which the bridge checks as
  a CSRF defense — a request missing either is rejected. If
  `CLAXEDO_DESKTOP_URL`/`CLAXEDO_DESKTOP_TOKEN` are absent (no desktop app, or
  the browser capability was explicitly disabled), `desktopRequest` short-circuits to a
  legible `DESKTOP_UNAVAILABLE_MESSAGE` rather than attempting a request. All
  five `browser_*` tools registered by `registerBrowserTools`
  (`src/browser-tools.ts`) go through `desktopRequest`.

So a single MCP process holds two independent trust contexts at once: an
optional bearer token for the Claxedo Server API, and a bridge secret for the
desktop app's browser-control surface.

## Read-only vs. full-control tool-policy gating

`src/tool-policy.ts` exports `claxedoMcpMode`/`claxedoMcpReadOnly`, which read
`CLAXEDO_MCP_READ_ONLY` (truthy: `1`/`true`/`yes`) or `CLAXEDO_MCP_MODE=read-only`
from the environment. `server.ts` computes `READ_ONLY` once at module load and
threads it into every registration call:

- `registerCloudWorkspaceTools(register, transport, readOnly)` registers the
  read-only `cloud_workspace_status` tool unconditionally and returns early on
  `readOnly` before registering the mutating cloud-workspace tools, so those
  simply never get a `register(...)` call in read-only mode — the client never
  sees them, rather than seeing them and getting a permission error.
- `registerTool("process", ...)` in `server.ts` is wrapped in `if (!READ_ONLY)`
  directly, so the whole `process` tool (and by extension
  `.claxedo/processes.jsonc` mutation and process lifecycle control) is
  omitted in read-only mode.
- `summarize_logs`, `browser_evaluate_js`, and `browser_navigate` are gated the
  same way at their `registerTool`/`registerBrowserTools` call sites — the
  README's "Read-only mode omits" list enumerates the exact set.
- `registerDocumentTools` is unconditional: `documents_list` and
  `documents_open` are read-only by nature and register in both modes.

## How `documents-tools`/`cloud-workspace-tools` plug into `server.ts`

`server.ts` imports both registration functions and calls them once at module
load, before `registerBrowserTools` and before connecting the stdio
transport:

```ts
registerDocumentTools(registerTool, (path, init) => httpRequest(path, init, "json"), {
  directory: DEFAULT_DIR,
  sessionId: DEFAULT_SESSION_ID,
})

registerCloudWorkspaceTools(
  registerTool,
  (path, init) => httpRequest(path, init, "json", undefined, "owner"),
  READ_ONLY,
)
```

`registerTool` is a small adapter (`server.ts`) that calls
`server.registerTool(name, config, handler)` on the `McpServer` instance,
matching the `Register` type both `documents-tools.ts` and
`cloud-workspace-tools.ts` expect — this is the seam that lets both modules
stay agnostic about the concrete registration target.

Cloud-workspace tools always call `httpRequest(..., "owner")` scope: every
`cloud_workspace_*` request omits the workspace directory/id headers and hits
the server's owner-scoped API regardless of the process's
`directory`/`workspace_id` argument. Document tools instead use the default
`"workspace"` scope and get `directory`/`sessionId` defaults merged in per-call
by `registerDocumentTools`'s `defaults` argument.
