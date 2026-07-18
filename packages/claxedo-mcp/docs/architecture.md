# Architecture

This package ships two things that share one tool implementation: a standalone
stdio MCP server (`src/server.ts`, published as the `claxedo-mcp` bin) and a
set of registration functions (`registerWorkGraphTools`, `registerDocumentTools`)
that a host process can import directly to register the same tools in-process.
Everything downstream of tool registration — schemas, handlers, error mapping —
is shared code; only how a call reaches Claxedo Server differs.

## stdio server vs. embedded registration

**Stdio server** (`src/server.ts`): a `node --import tsx` / compiled `dist/server.js`
subprocess. It builds a `McpServer` from `@modelcontextprotocol/sdk`, calls
`registerWorkGraphTools` and `registerDocumentTools` with an HTTP-backed
transport (`httpRequest`, built on `fetch`), registers the process/logs/session
tools inline, calls `registerBrowserTools` for the desktop-bridge tools, and
connects a `StdioServerTransport`. Every call this process makes crosses an
HTTP boundary to `CLAXEDO_SERVER_URL` (default `http://127.0.0.1:3001`); there
is no in-process access to Claxedo Server's services. `server.ts` also doubles
as the `claxedo-mcp documents ...` CLI entry point: when `process.argv[2] ===
"documents"`, it runs `runDocumentsCli` instead of connecting the MCP
transport (see `src/documents-cli.ts`).

**Embedded registration**: Claxedo Server imports `registerWorkGraphTools`
from this package's `./workgraph-tools` export (see
`packages/claxedo-server/src/workgraph-agent-tools.ts`,
`createLocalWorkGraphAgentTools`) and passes an `EmbeddedWorkGraphTransport`
object instead of the HTTP `Request` function. That transport
(`createLocalEmbeddedWorkGraphTransport`) calls the embedded WorkGraph
service's `execute`/query methods directly — no HTTP hop, no
`CLAXEDO_AUTH_TOKEN`. `registerWorkGraphTools` accepts either shape because its
`transport` parameter is typed as `Request | EmbeddedWorkGraphTransport`
(`src/workgraph-tools.ts`); `callWorkGraph` branches on `typeof transport ===
"function"` to route between the two. Tools registered this way become
OpenCode application tools available to local Claxedo agent Sessions, using
the same tool names, descriptions, and Zod schemas as the stdio server.
`registerDocumentTools` is not currently consumed this way anywhere in the
repo — the documents tools only run over the stdio server's HTTP transport
today.

Both paths run the exact same `WORKGRAPH_CAPABILITY_MAP` /
`WORKGRAPH_TOOL_SCHEMAS` tables and the same `callWorkGraph` request/response
mapping (including `WorkGraphRecordNotFoundError`, `McpHttpError`, etc.), so a
tool call looks identical to an agent regardless of which registration path
served it. What differs is trust: the embedded path runs inside Claxedo
Server's own process under a server-derived `WorkGraphContext` (organization
id, owner user id, `access: { mode: "owner" }`); the stdio path runs as an
external subprocess that must authenticate its HTTP calls (see below).

## Desktop-bridge HTTP client and the `CLAXEDO_AUTH_TOKEN` trust boundary

Two distinct HTTP clients live in this package, with two distinct trust
boundaries:

- **`httpRequest`** (`src/server.ts`) talks to Claxedo Server itself
  (`CLAXEDO_SERVER_URL`, default `http://127.0.0.1:3001`). It attaches
  `Authorization: Bearer ${CLAXEDO_AUTH_TOKEN}` when that env var is set, plus
  scope headers from `claxedoRequestScope` (`src/request-scope.ts`): a
  `directory`/`workspaceId` query string and `x-opencode-directory` /
  `x-workspace-id` headers for workspace-scoped calls, or no scope headers at
  all for `scope: "owner"` calls (used by every `workgraph_*` tool and the
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
  `CLAXEDO_ENABLE_BROWSER_TAB` not set), `desktopRequest` short-circuits to a
  legible `DESKTOP_UNAVAILABLE_MESSAGE` rather than attempting a request. All
  five `browser_*` tools registered by `registerBrowserTools`
  (`src/browser-tools.ts`) go through `desktopRequest`.

So a single MCP process can hold up to three independent trust contexts at
once: an optional bearer token for the Claxedo Server API, a bridge secret for
the desktop app's browser-control surface, and (for the embedded registration
path only, which never runs inside this package's own process) an in-process
server-derived context that carries no token at all.

## Read-only vs. full-control tool-policy gating

`src/tool-policy.ts` exports `claxedoMcpMode`/`claxedoMcpReadOnly`, which read
`CLAXEDO_MCP_READ_ONLY` (truthy: `1`/`true`/`yes`) or `CLAXEDO_MCP_MODE=read-only`
from the environment. `server.ts` computes `READ_ONLY` once at module load and
threads it into every registration call:

- `registerWorkGraphTools(register, transport, readOnly, creationContext)`
  filters `WORKGRAPH_CAPABILITY_MAP` on `!readOnly || !capability.mutating`
  before registering each tool, so mutating WorkGraph tools (created/updated
  via `mutating: true` entries in the capability map) simply never get a
  `register(...)` call in read-only mode — the client never sees them, rather
  than seeing them and getting a permission error.
- `registerTool("process", ...)` in `server.ts` is wrapped in `if (!READ_ONLY)`
  directly, so the whole `process` tool (and by extension
  `.claxedo/processes.jsonc` mutation and process lifecycle control) is
  omitted in read-only mode.
- `summarize_logs`, `browser_evaluate_js`, and `browser_navigate` are gated the
  same way at their `registerTool`/`registerBrowserTools` call sites — the
  README's "Read-only mode omits" list enumerates the exact set.
- `registerDocumentTools` is unconditional: `documents_list` and
  `documents_open` are read-only by nature and register in both modes.

The same `readOnly` boolean is passed through to the embedded registration
path (`createLocalWorkGraphAgentTools` calls `registerWorkGraphTools(..., false)`
today, i.e. embedded registration always requests the full capability set;
gating for that path is Claxedo Server's concern, not this package's).

## How `workgraph-tools`/`documents-tools` plug into `server.ts`

`server.ts` imports both registration functions and calls them once at module
load, before `registerBrowserTools` and before connecting the stdio
transport:

```ts
registerWorkGraphTools(
  registerTool,
  (path, init) => httpRequest(path, init, "json", undefined, "owner"),
  READ_ONLY,
  async () => { /* build WorkGraphCreationContext.execution from DEFAULT_WORKSPACE_ID / DEFAULT_DIR */ },
)

registerDocumentTools(registerTool, (path, init) => httpRequest(path, init, "json"), {
  directory: DEFAULT_DIR,
  sessionId: DEFAULT_SESSION_ID,
})
```

`registerTool` is a small adapter (`server.ts`) that calls
`server.registerTool(name, config, handler)` on the `McpServer` instance,
matching the `Register` type both `workgraph-tools.ts` and
`documents-tools.ts` expect — this is the seam that lets both modules stay
agnostic about whether they're registering against a real `McpServer` (stdio
path) or a `Map` collecting tool definitions for OpenCode application-tool
registration (embedded path in `workgraph-agent-tools.ts`).

WorkGraph tools always call `httpRequest(..., "owner")` scope: every
`workgraph_*` request omits the workspace directory/id headers and hits the
server's owner-scoped API regardless of the process's `directory`/`workspace_id`
argument — the README calls this out as "WorkGraph calls use authenticated
owner scope independently of process workspace selection." The
`creationContext` callback supplies `WorkGraphCreationContext.execution` for
`workgraph_create_stream` (and `.session` for the session-context tool group:
`workgraph_bind_session`, `workgraph_current_work`, `workgraph_select_work`,
`workgraph_record_progress`, `workgraph_refresh_context`,
`workgraph_complete_current_work`, `workgraph_release_session`) — it resolves
either a `local_worktree` environment from `DEFAULT_DIR` or a
`hosted_workspace` environment by resolving `DEFAULT_WORKSPACE_ID`'s Git
remote through `/api/workspace/resolve`. Document tools instead use the
default `"workspace"` scope and get `directory`/`sessionId` defaults merged in
per-call by `registerDocumentTools`'s `defaults` argument.
