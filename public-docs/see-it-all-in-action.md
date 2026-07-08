# See It All In Action

This page shows the value of the Claxedo package family as one composable app
stack. It is for builders who want to run terminal coding agents, expose them
to users or teams, and keep the product surface stable while swapping harness,
workspace, deployment, and extension backends underneath.

## What This Lets You Build

| Value | What Claxedo provides |
| --- | --- |
| Talk to many agent harnesses through one surface | Your app talks to the `AgentRuntime` facade from [Agent SDK Runtime](./agent-sdk-runtime.md), not directly to each harness. Today that covers OpenCode, ACP harnesses, native SDK harnesses, and Pi. New harnesses fit by adding a harness factory and event translation path. |
| Normalize harness output once | [Agent Event Runtime](./agent-event-runtime.md) turns harness-specific streams into canonical `AgentRuntimeEvent`s and compatibility projections, so UI/session replay does not branch for every harness. |
| Run terminal coding-agent infrastructure | [Workspace Runtime](./workspace-runtime.md) gives you sessions, PTYs, managed processes, files, diffs, runtime events, health, capabilities, config apply, and harness lifecycle next to the project directory. |
| Install capabilities once and materialize them for many harnesses | [Agent Extensions](./agent-extensions.md) let users discover a package, install it into workspace desired state, and materialize its skills, MCP configs, and harness plugin assets into OpenCode, Claude, Codex, and Cursor targets. |
| Host a team app on your own system | Put your own control plane in front for auth, org policy, credentials, workspace routing, and marketplace policy. The Workspace Host stays the execution boundary; your server decides who can reach it. |
| Let others reach a local worktree through Relay | A workspace can be backed by a local worktree on a user's machine and still be accessed by teammates through [Workspace Relay](./relay-and-deployment.md), when your control plane authorizes and routes that access. |
| Support local, container, and cloud VM workspaces | The runtime only needs to run next to the project directory. That directory can live on a laptop, inside Docker/a container, or on a real cloud VM. |
| Keep long-running services close to the agent | Managed process APIs let the agent or UI add/start/stop/restart dev servers, watchers, tests, and other long-running workspace processes, then read logs and port mappings. |
| Add an MCP orchestration layer | [Claxedo MCP](./mcp.md) exposes runtime tools to any MCP client. Current tools cover processes, logs, session messages, log summaries, and browser panes. The same pattern can be extended with more MCP tools that call the Claxedo HTTP API stack, such as starting related sessions, summarizing browser state, comparing session outputs, or building consensus workflows. |

## One Stack, Different Workspace Backings

| Workspace backing | How it works |
| --- | --- |
| Local worktree | `workspace-runtime` runs next to a project directory on the user's machine. The product can call it over loopback. |
| Container or Docker workspace | `workspace-runtime` runs inside or beside a container where the project directory is mounted, for example `/workspace/repo`. |
| Cloud VM | `workspace-runtime` runs on the VM next to the project checkout. The control plane reaches it directly on private networking or through Relay. |
| User-hosted team workspace | A user runs the runtime locally, it attaches to Relay, and authorized teammates reach that workspace through the hosted/self-hosted control plane. |

## Full App In A Few Pieces

| Piece | Responsibility |
| --- | --- |
| Product UI | Workspace/session/process/file/browser experience. |
| Product control plane | Auth, org policy, credentials, workspace routing, extension policy, audit, and team access. |
| Workspace Runtime | Per-workspace execution host. |
| Agent Extensions | Package discovery, desired/lock state, policy, materialization, and runtime replay. |
| Agent SDK Runtime | Runtime facade, harness factories, stores, turns, events, and capability checks. |
| Agent Event Runtime | Canonical event model and projections. |
| Workspace Relay | Remote access to cloud or user-hosted runtime hosts. |
| Claxedo MCP | Tool layer for MCP clients to orchestrate runtime/server APIs. |

## Compose A Local Runtime

Start with a Workspace Host next to the project directory the agent should work
on. `POST /api/wr/config` is only authorized through an explicit management-auth
adapter, so wire one at startup. For a local single-user composition, the
allow-all helper from `@claxedo/workspace-runtime/testing` is enough; production
hosts wire `createWorkspaceRuntimeJwtManagementAuth` instead (or configure it
from env with `WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL` / `_VERIFY_PEM` /
`_ISSUER` / `_AUDIENCE`) and send the signed management JWT in the
`x-workspace-runtime-management-token` header:

```ts
import { loopbackWorkspaceRuntimeExposure, startServer } from "@claxedo/workspace-runtime"
import { allowWorkspaceRuntimeManagementAuth } from "@claxedo/workspace-runtime/testing"

startServer(4096, {
  exposure: loopbackWorkspaceRuntimeExposure(),
  managementAuth: allowWorkspaceRuntimeManagementAuth(),
  managementTarget: { workspaceId: "ws_local", hostId: "ws_local" },
})
```

Then push the user's selected harness, auth, MCP config, and Agent Extension
desired state (the initial harness can also be passed at boot via the `harness`
server option):

```ts
await fetch("http://127.0.0.1:4096/api/wr/config", {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({
    version: 2,
    harnesses: [{ id: "codex", access: "native" }],
    model: "default",
    auth: {
      "codex-app-server": process.env.OPENAI_API_KEY,
    },
    mcp: {},
    agent_extensions: {
      version: 1,
      installs: [],
    },
    workspaceHarnessEnabled: true,
  }),
})
```

Your product UI can now call the runtime:

```ts
const session = await fetch("http://127.0.0.1:4096/session", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "Fix the failing tests" }),
}).then((res) => res.json())

await fetch(`http://127.0.0.1:4096/session/${session.id}/message`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    parts: [{ type: "text", text: "Find and fix the failing tests." }],
  }),
})
```

Use the same runtime for terminals, processes, files, diffs, and events:

```ts
await fetch("http://127.0.0.1:4096/api/wr/process/start-all", {
  method: "POST",
})

const files = await fetch("http://127.0.0.1:4096/file/all")
  .then((res) => res.json())

const events = new EventSource("http://127.0.0.1:4096/global/event")
events.onmessage = (event) => {
  console.log(JSON.parse(event.data))
}
```

Add Claxedo runtime tools to any MCP client. The JSON below is not runtime
config; it is MCP-client config. It tells an MCP client such as Claude Desktop,
Codex, or another MCP-compatible app how to start the Claxedo MCP bridge
(the `npx` form requires `@claxedo/mcp` to be available on npm — from this repo
you can run `bun run --cwd packages/claxedo-mcp start` instead):

```json
{
  "command": "npx",
  "args": ["-y", "@claxedo/mcp"],
  "env": {
    "CLAXEDO_SERVER_URL": "http://127.0.0.1:3001"
  }
}
```

You do not execute that JSON in a terminal. Put it in the MCP client's server
configuration file or settings UI. If the client has fields instead of raw JSON,
enter `npx` as the command, `-y` and `@claxedo/mcp` as args, and
`CLAXEDO_SERVER_URL=http://127.0.0.1:3001` as an environment variable. Note the
port: the bridge targets the Claxedo control-plane server (default
`http://127.0.0.1:3001`), not the raw workspace runtime started on `4096`
above.

For a quick manual smoke test only, the equivalent shell command is:

```sh
CLAXEDO_SERVER_URL=http://127.0.0.1:3001 npx -y @claxedo/mcp
```

What happens after the client reads that config:

1. The MCP client starts a subprocess by running `npx -y @claxedo/mcp`.
2. That subprocess registers tools named `process`, `get_logs`,
   `session_messages`, `summarize_logs`, and browser tools.
3. When an agent in the MCP client calls one of those tools, `@claxedo/mcp`
   makes an HTTP request to `CLAXEDO_SERVER_URL`.
4. `CLAXEDO_SERVER_URL` points at the Claxedo server fronting the workspace.
   By default that is the control plane on `http://127.0.0.1:3001`, which
   proxies workspace calls to the runtime — not the runtime port `4096`
   directly.

So `@claxedo/mcp` does not run the agent or own the workspace. It is a small
tool bridge from "MCP tool call" to "Claxedo HTTP API call".

What that gives the MCP client:

| MCP tool | What it does | Runtime routes it calls |
| --- | --- | --- |
| `process` | Lists, adds, updates, starts, stops, restarts, and removes managed process configs such as dev servers and watchers. | `/api/wr/process/*` |
| `get_logs` | Reads terminal or managed-process output by `process_id`, process `name`, `pty_id`, or `terminal_id`. | `/api/wr/process/logs` |
| `session_messages` | Reads structured agent session messages, or resolves the current terminal/tab agent session when running inside Claxedo. | `/session/:id/message`, `/api/wr/hook/terminal-session` |
| `summarize_logs` | Fetches logs or accepts raw log text, creates a temporary agent session, and asks the configured harness to summarize the output. | `/api/wr/process/logs`, `/session`, `/session/:id/message` |
| Browser tools | Lists browser tabs, captures screenshots, reads console logs, evaluates JavaScript, and navigates browser panes through the Claxedo desktop bridge. | Browser bridge routes exposed by the Claxedo server/runtime integration. |

Example tool calls an MCP client could make:

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

```json
{ "tool": "summarize_logs", "args": { "name": "web", "lines": 500 } }
```

Attach the same runtime through Relay when it runs in a cloud VM or on a user's
machine behind a tunnel:

```ts
import { startServer } from "@claxedo/workspace-runtime"
import { workspaceRelayRuntimeOptionsFromEnv } from "@claxedo/workspace-runtime/relay"

const port = Number(process.env.WORKSPACE_RUNTIME_PORT ?? 3002)

startServer(port, await workspaceRelayRuntimeOptionsFromEnv(process.env, port))
```

## What Runs Where

| Layer | Runs in | Owns | Package/source |
| --- | --- | --- | --- |
| Product UI | Browser, desktop app, CLI, or MCP client | User-facing workspace, session, terminal, process, file, and settings screens | Your app |
| Product control plane | Local server, self-hosted server, or hosted service | User auth, org/workspace authorization, credential storage, marketplace policy, workspace routing | Product code; Claxedo server package in this repo |
| Workspace Host | Next to the project directory the agent should work on | Harness lifecycle, sessions, terminals, processes, files, diffs, runtime events, config apply, Agent Extensions | `@claxedo/workspace-runtime` |
| Agent Extensions | In the product server and Workspace Host | Discovery, install lifecycle, lock state, effective policy, and materialized harness files | `@claxedo/agent-extensions` |
| Agent SDK Runtime | Inside the Workspace Host | One `AgentRuntime` facade over OpenCode, ACP harnesses, native SDK harnesses, and Pi | `@claxedo/agent-sdk-runtime` |
| Event runtime | Inside adapters/host projections | Canonical `AgentRuntimeEvent` stream and compatibility projections | `@claxedo/agent-event-runtime` |
| Relay | Separate relay process | Bidirectional tunnel between gateway/browser traffic and workspace-runtime hosts | `@claxedo/workspace-relay` |
| Relay protocol | Shared dependency | Tunnel frame types, protocol version, token verifier seam | `@claxedo/workspace-relay-protocol` |
| MCP server | MCP client subprocess | Runtime tools for processes, logs, sessions, and browser panes | `@claxedo/mcp` |

## User Action: Open A Workspace

The product control plane decides how to reach the workspace:

1. Authorize the user against your own org/workspace policy.
2. Resolve the workspace backing: local worktree, container, cloud VM, or
   user-hosted runtime.
3. Route directly to `workspace-runtime` for local/private access, or through
   `workspace-relay` for cloud/user-hosted access.
4. Read runtime health and capabilities.

```ts
const health = await fetch("http://127.0.0.1:4096/api/wr/health")
  .then((res) => res.json())

const capabilities = await fetch("http://127.0.0.1:4096/api/wr/capabilities")
  .then((res) => res.json())
```

The UI can use those capabilities to decide which panels are available:
sessions, terminals, processes, files, diffs, MCP, LSP, VCS, and runtime events.

## User Action: Select Or Change Harness

The harness does not have to be fixed when the Workspace Host starts. After the
user selects a harness, push a new runtime snapshot. The request is authorized
by the management-auth adapter wired at startup; a JWT-backed adapter expects
the signed token in the `x-workspace-runtime-management-token` header:

```ts
await fetch("http://127.0.0.1:4096/api/wr/config", {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({
    version: 2,
    harnesses: [{ id: "claude", access: "native" }],
    model: "claude-sonnet-4-6",
    auth: { anthropic: process.env.ANTHROPIC_API_KEY },
    mcp: {},
    workspaceHarnessEnabled: true,
  }),
})
```

If harness id, access, or connection changes, `workspace-runtime` disposes the
old adapter and creates the matching adapter:

| Harness config | Adapter |
| --- | --- |
| `{ id: "opencode", access: "native" }` | `OpenCodeHarnessAdapter` |
| `{ id: "claude" | "codex" | "cursor", access: "acp" }` | `AcpHarnessAdapter` |
| `{ id: "claude", access: "native" }` | `ClaudeHarnessAdapter` |
| `{ id: "codex", access: "native" }` | `CodexHarnessAdapter` |
| `{ id: "cursor", access: "native" }` | `CursorHarnessAdapter` |
| `{ id: "pi", access: "native" }` | `PiHarnessAdapter` |

## User Action: Send A Prompt

The UI calls one session surface. The Workspace Host starts a turn through the
`AgentRuntime` facade, which selects the active harness and streams normalized
events back through the runtime event surface.

```ts
const session = await fetch("http://127.0.0.1:4096/session", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "Implement dark mode" }),
}).then((res) => res.json())

await fetch(`http://127.0.0.1:4096/session/${session.id}/message`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    parts: [{ type: "text", text: "Implement dark mode and update tests." }],
  }),
})
```

Your UI does not need a separate streaming implementation for Claude ACP, Codex
ACP, Cursor ACP, Claude SDK, Codex app-server, and OpenCode.

## User Action: Use Runtime Tools

The Workspace Host also owns the non-chat runtime surfaces a full coding-agent
app needs:

| User action | Runtime surface |
| --- | --- |
| Open a terminal | `/api/wr/pty/*` creates and connects PTYs over WebSocket. |
| Start a dev server | `/api/wr/process/*` manages process configs and lifecycle. |
| View logs | `/api/wr/process/logs` reads process or terminal logs. |
| Browse files | `/find/file`, `/file`, `/file/content`, `/file/raw`, `/file/all`. |
| Review changes | `/api/wr/diff/*` and `/vcs`. |
| Watch session/runtime events | `/global/event` and `/api/wr/runtime-events`. |
| Check host state | `/api/wr/health` and `/api/wr/capabilities`. |

## User Action: Install Agent Extensions

Agent Extensions give your product a package lifecycle:

```text
discover -> install -> sync effective snapshot -> materialize into harnesses
```

A package can be made discoverable to users, installed into workspace desired
state, and then materialized by every connected runtime that receives that
workspace's effective snapshot. The install records choose targets such as
OpenCode, Claude, Codex, and Cursor; the runtime turns the package contents into
harness-native files.

Your product can use `@claxedo/agent-extensions` directly for package lifecycle
and policy primitives:

```ts
import {
  installGitHubAgentExtension,
  getRuntimeAgentExtensionsSnapshot,
} from "@claxedo/agent-extensions"
```

For many workspaces, the control plane stores or derives desired state per
workspace and syncs each connected runtime. That is how a team can make the
same extension available across workspaces while still letting a workspace or
user turn it off.

```json
{
  "agent_extensions": {
    "version": 1,
    "installs": [
      {
        "desired": {
          "id": "review-tools",
          "package_name": "review-tools",
          "scope": "workspace",
          "enabled": true,
          "targets": ["opencode", "claude", "codex", "cursor"],
          "source": {
            "type": "github",
            "owner": "acme",
            "repo": "agent-extensions",
            "ref": "main",
            "package_path": "packages/review-tools"
          }
        },
        "lock": { "resolved_sha": "abc123" },
        "components": []
      }
    ]
  }
}
```

The host materializes supported assets such as `SKILL.md`, `mcp.json`, and
Cursor plugin files into harness-native locations.

Activation is separate from package resolution. The same package can be
installed but disabled for a workspace:

```json
{
  "desired": {
    "id": "review-tools",
    "scope": "workspace",
    "enabled": false,
    "targets": ["opencode", "claude", "codex"]
  }
}
```

Or it can be filtered by effective policy before the runtime snapshot is
produced:

```json
{
  "id": "review-tools",
  "scope": "user",
  "enabled": false,
  "reason": "User disabled this extension"
}
```

`@claxedo/agent-extensions` supports local project/machine installs, workspace
install records, workspace enable/disable, and user/workspace/org policy
override records. Org activation as a full product workflow belongs in the
control plane; the runtime materializer only applies the enabled snapshot it
receives. `workspace-runtime` calls this package during config replay.

## Local App Composition

For a local single-user app:

```text
Product UI -> local control plane -> workspace-runtime -> project directory
```

The local server can call the runtime directly over loopback. `@claxedo/mcp`
can also point at the local server with:

```json
{
  "command": "npx",
  "args": ["-y", "@claxedo/mcp"],
  "env": {
    "CLAXEDO_SERVER_URL": "http://127.0.0.1:3001"
  }
}
```

## Cloud Or User-Hosted Composition

For a cloud VM or user-hosted runtime:

```text
Product UI
  -> control plane / gateway
  -> workspace-relay
  -> workspace-runtime host tunnel
  -> project directory
```

The runtime host can attach to Relay with:

```ts
import { startServer } from "@claxedo/workspace-runtime"
import { workspaceRelayRuntimeOptionsFromEnv } from "@claxedo/workspace-runtime/relay"

const port = Number(process.env.WORKSPACE_RUNTIME_PORT ?? 3002)

startServer(port, await workspaceRelayRuntimeOptionsFromEnv(process.env, port))
```

The relay and runtime share `@claxedo/workspace-relay-protocol` so both sides
speak the same `TunnelMessage` protocol without making the runtime depend on
the relay server implementation.

## Supported Example Shapes In This Repo

| Example | Shows |
| --- | --- |
| `examples/runtime-only-host` | A runtime-only host attaching to Relay from env. |
| `examples/local-single-user` | Local Claxedo server startup. |
| `examples/headless-client` | Headless client flow against the local server. |
| `examples/extension-client` | Agent Extension route usage through the server package. |
| `examples/hosted-team` | Hosted composition with injected auth, services, relay options, and workspace authority. |

## Read Next

- [Workspace Runtime](./workspace-runtime.md)
- [Agent SDK Runtime](./agent-sdk-runtime.md)
- [Agent Event Runtime](./agent-event-runtime.md)
- [Agent Extensions](./agent-extensions.md)
- [Relay And Deployment](./relay-and-deployment.md)
- [MCP](./mcp.md)
- [Supported Surfaces](./supported-surfaces.md)
