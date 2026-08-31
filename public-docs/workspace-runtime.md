# Workspace Runtime

`@claxedo/workspace-runtime` is the per-workspace host package. It runs next to
the project directory the agent should work on, whether that directory is on a
laptop, inside a container, or inside a cloud VM. It serves the runtime API that
product UI, control planes, and MCP tools call.

## What The Workspace Host Owns

The Workspace Host owns the live workspace execution boundary. It composes the
lower-level packages into one per-workspace service.

| Capability | Description |
| --- | --- |
| Harness selection and lifecycle | The host chooses, creates, replaces, and disposes the active harness adapter for `opencode`, ACP harnesses, native SDK harnesses, and Pi. The adapter layer comes from [Agent SDK Runtime](./agent-sdk-runtime.md); emitted harness events are normalized through [Agent Event Runtime](./agent-event-runtime.md). |
| Session APIs | The host mounts normalized session routes from [Agent SDK Runtime](./agent-sdk-runtime.md): create, list, read, send message, abort, config read/update, permissions, questions, todos, command execution, and message replay. Product code can call one session surface instead of branching per harness. |
| Runtime event streams | The host exposes `/global/event` and runtime event streams so UI clients can subscribe to session lifecycle, assistant output, tool progress, permission prompts, questions, and status changes. |
| PTY lifecycle | The host creates and manages terminal sessions for the workspace: create, list, inspect, resize/update, remove, and connect over WebSocket for input/output streaming. |
| Managed processes | The host manages repeatable workspace services such as dev servers and watchers. It supports process config CRUD, start, stop, restart, start-all, stop-all, diagnostics, termination diagnostics, port mapping, and log retrieval. |
| Files | The host exposes workspace file discovery and reads: find files, read file metadata, read content, read raw bytes/text, inspect git-backed file status, and list all known files. |
| Diff and VCS | The host exposes git-backed diff routes for targets, file diffs, refs, and VCS status. It also provides lightweight local VCS metadata such as branch/default branch when OpenCode-backed VCS data is unavailable. |
| Runtime config apply | `/api/wr/config` applies a `RuntimeSnapshot` containing harnesses, model, auth, MCP, workspace harness, and commands. When harness id, access, or connection changes, the host replaces the active adapter. A v2 snapshot's `harnesses` list may also carry operator-configured ACP connections (`acp:<slug>` identities with process descriptors); the host retains them as the applied registry and resolves selections against it fail-closed. See [Operator-Configured ACP Connections](./acp-connections.md). |
| Optional product contributions | A containing product may mount generic provisioning and route contributions. Claxedo's Agent Plugins module uses that seam without adding plugin lifecycle state to the public runtime contract. |
| MCP compatibility | The host exposes MCP status/connect/disconnect compatibility routes for harness-hosted MCP config. |
| Relay attachment | The host can attach itself to Workspace Relay as a host tunnel. In that mode the relay forwards HTTP/WebSocket traffic to the local runtime URL. See [Relay And Deployment](./relay-and-deployment.md). |
| Health and capabilities | The host reports runtime health, active harness, workspace id, process counts, and a capability manifest. Embedders can also call `host.detail()` and `host.capabilities()` directly. |
| Drain and dispose | When started with `{ signals: true }`, the standalone server handles SIGTERM/SIGINT by closing the HTTP server, closing the Relay host tunnel, and disposing the active adapter with a drain timeout. Embedded callers can call `host.dispose()` directly. |

The host does not own product concerns such as end-user sign-in, organization
authorization, billing, marketplace catalog policy, cloud VM provisioning, or
long-term product data storage. Those belong in the product control plane.

## Run A Standalone Host

```ts
import { loopbackWorkspaceRuntimeExposure, startServer } from "@claxedo/workspace-runtime"

startServer(4096, {
  exposure: loopbackWorkspaceRuntimeExposure(),
}, { signals: true })
```

`startServer(port, options, lifecycle)` opens the HTTP/WebSocket runtime,
injects WebSocket handling, optionally starts a Relay host tunnel, and installs
agent hooks. It registers SIGTERM/SIGINT (and unhandled-rejection/uncaught-exception)
drain handling only when the third `lifecycle` argument sets `{ signals: true }`.
By default `startServer` registers zero process-level signal listeners and never
calls `process.exit`, so a process that owns its own lifecycle — such as the
standalone host entrypoint above — should opt in explicitly.

## Host Shapes

`workspace-runtime` exposes three supported integration shapes. They use the
same underlying Workspace Host, but differ in how much server lifecycle and
route mounting the package handles for you.

| Capability | Standalone process: `startServer` | Embedded app: `createWorkspaceRuntimeApp` | Low-level host: `createWorkspaceHost` |
| --- | --- | --- | --- |
| Opens a listening port | Yes. Calls the Node server adapter for you. | No. You pass `runtime.app.fetch` to your own server. | No. You own the server. |
| Provides a Hono app | Internally. | Yes: returns `app`. | No. You provide a Hono app and call `host.mount(app, { exposure })`. |
| Injects WebSocket support | Yes. | Returns `injectWebSocket` and `upgradeWebSocket`; you call `injectWebSocket(server)`. | You provide WebSocket upgrade support if mounting PTY/core routes. |
| Mounts session/harness routes | Yes. | Yes. | Yes, when you call `host.mount(app, { exposure })`. |
| Mounts PTY/process/file/diff/core routes | Yes. | Yes. | Only if you pass `core` to `host.mount` or call `mountWorkspaceCore`. |
| Applies runtime snapshots | Via `POST /api/wr/config`. | Via `POST /api/wr/config` or `runtime.host.apply(snapshot)`. | Via `host.apply(snapshot)`, and via `/api/wr/config` only if you mount that route yourself. |
| Harness can change after startup | Yes, through config apply. | Yes, through config apply or direct `host.apply`. | Yes, through direct `host.apply`. |
| Relay host tunnel | Yes, when `options.hostTunnel` is set. | No automatic tunnel startup. You can wire tunnel helpers yourself. | No automatic tunnel startup. You can wire tunnel helpers yourself. |
| Signal drain handling | Opt-in. Only when you pass `{ signals: true }` as the third `lifecycle` argument does `startServer` register SIGTERM/SIGINT handlers; it then closes the server/tunnel and disposes the host. | No. Your process owns drain. | No. Your process owns drain. |
| Best fit | One runtime process per workspace, container, VM, or user-hosted laptop runtime. | Product already has a Node/Hono server but wants the full runtime app. | Framework/platform code that wants to compose only selected host routes and lifecycle calls. |

## Embed The Runtime App

Use `createWorkspaceRuntimeApp(options)` when your product already owns the
Node/Hono server and you want the runtime app without opening a port.

```ts
import { createWorkspaceRuntimeApp, loopbackWorkspaceRuntimeExposure } from "@claxedo/workspace-runtime"
import { serve } from "@hono/node-server"

const runtime = createWorkspaceRuntimeApp({
  exposure: loopbackWorkspaceRuntimeExposure(),
  target: {
    workspaceId: "ws_local",
    directory: "/workspace/repo",
  },
})

const server = serve({
  fetch: runtime.app.fetch,
  port: 4096,
})

runtime.injectWebSocket(server)
```

The harness does not need to be chosen at construction time. The host can start
with its default harness and receive the user's selected harness later through
`/api/wr/config`. Config mutation is only authorized through the
management-auth adapter wired at startup (`managementAuth` +
`managementTarget` options): use the allow-all helper from
`@claxedo/workspace-runtime/testing` for a local single-user host, or
`createWorkspaceRuntimeJwtManagementAuth` (which takes an explicit
`{ key, issuer, audience }` options object) and send the signed management JWT
in the `x-workspace-runtime-management-token` header. The
`WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL` / `_VERIFY_PEM` / `_ISSUER` /
`_AUDIENCE` env vars are not read by `createWorkspaceRuntimeJwtManagementAuth`
itself — they are consumed by the `managementAuthFromEnv` helper in
`workspace-relay-env.ts`, which loads the verification key from them and
constructs the JWT auth adapter for you.

```ts
await fetch("http://127.0.0.1:4096/api/wr/config", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    // Required by every management-auth adapter except the allow-all
    // testing helper, which ignores the token entirely.
    "x-workspace-runtime-management-token": managementToken,
  },
  body: JSON.stringify({
    version: 2,
    harnesses: [{
      id: "codex",
      access: "native",
    }],
    model: "default",
    auth: {
      "codex-app-server": process.env.OPENAI_API_KEY,
    },
    mcp: {},
    workspaceHarnessEnabled: true,
  }),
})
```

When a config snapshot changes harness id, access, or connection, the host
disposes the previous adapter and creates the right new adapter.

## Use The Low-Level Host

Use `createWorkspaceHost(options)` when you own the server and want to mount
only the host routes you need.

```ts
import { Hono } from "hono"
import { createWorkspaceHost, loopbackWorkspaceRuntimeExposure } from "@claxedo/workspace-runtime"

const app = new Hono()
const host = createWorkspaceHost({
  target: {
    workspaceId: "ws_embedded",
    directory: "/workspace/repo",
  },
})

host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })

await host.apply({
  version: 2,
  harnesses: [{ id: "claude", access: "native" }],
  model: "claude-sonnet-4-6",
  auth: { anthropic: process.env.ANTHROPIC_API_KEY ?? "" },
  mcp: {},
  commands: {},
  workspaceHarnessEnabled: true,
})
```

The low-level host object exposes:

| Method | Purpose |
| --- | --- |
| `mount(app, options)` | Mount session, provider, MCP, event, LSP, VCS, and compatibility routes. `options.exposure` is required; pass `options.core` to also mount PTY/process/file/diff/agent-hook/event routes as a unified host. |
| `apply(snapshot)` | Apply harness, auth, MCP, commands, and workspace-harness config. |
| `detail()` | Return host state, active harness, error, and harness status. |
| `capabilities()` | Return the current runtime capability manifest. |
| `dispose()` | Dispose the active adapter. |

If your embedded app also needs PTY, process, file, diff, agent hook, and
runtime-event routes, mount the core routes:

```ts
import { loopbackWorkspaceRuntimeExposure } from "@claxedo/workspace-runtime"
import { createRuntimeEventHub, mountWorkspaceCore } from "@claxedo/workspace-runtime/host"

mountWorkspaceCore(app, upgradeWebSocket, {
  eventHub: createRuntimeEventHub(),
  exposure: loopbackWorkspaceRuntimeExposure(),
})
```

## Mounted Route Families

`createWorkspaceRuntimeApp` mounts these route families today:

| Route family | Purpose |
| --- | --- |
| `GET /api/wr/health` | Runtime health, active harness, workspace id, process counts, capabilities. |
| `GET /api/wr/capabilities` | Runtime capability manifest. |
| `/api/wr/checkpoint/*` | Freeze, flush, scrub, resume, and restore reconciliation for consistent provider capture. |
| `POST /api/wr/config` | Apply a `RuntimeSnapshot`. Requires configured auth. |
| `GET /api/wr/harness-config-options` | Probe harness config options for non-OpenCode harnesses. |
| `/api/wr/events` | Process-global compatibility event stream. |
| `/api/wr/runtime-events` | Runtime event stream. |
| `/api/wr/file/*` | File metadata, content, raw content, status, and list routes. |
| `/api/wr/find/file` | Workspace file search. |
| `/api/wr/diff/*` | Git diff and refs routes. |
| `/api/wr/git/*` | Git source snapshot and commit routes. |
| `/api/wr/pty/*` | PTY lifecycle and WebSocket connect routes. |
| `/api/wr/process/*` | Managed process config, lifecycle, diagnostics, port map, logs. |
| `/api/wr/hook/*` | Agent hook routes. |
| `/api/wr/subagent-transcripts/*` | Resolve authorized opaque transcript handles for a parent session. |
| `/api/wr/session-env/*` | Session environment descriptors for tools-only central sessions. |
| `/api/wr/worktrees/*` | Registered per-session Git worktree creation, inspection, and repair. |
| `/session/*` | Session create/list/read/update/delete/message/abort/revert/fork/command routes. |
| `/agent`, `/permission`, `/question`, `/command`, `/event` | Compatibility and session support routes. |
| `/mcp`, `/mcp/:name/connect`, `/mcp/:name/disconnect` | Harness MCP status and connect/disconnect compatibility. |
| `/lsp`, `/vcs`, `/provider` | Compatibility surfaces backed by OpenCode or fallback metadata. |
| `/global/event` | Runtime/global SSE event stream. |
| `/global/health` | Legacy health shape with `healthy`. |
| `/find/file`, `/file`, `/file/content`, `/file/raw`, `/file/status`, `/file/all` | OpenCode-compatible file discovery and read routes. |

Product-specific route families are supplied through host route contributions
and documented by their owning packages; they are not part of the Workspace
Runtime route manifest.

## Grounding

Implemented in:

- `packages/workspace-runtime/src/server.ts`
- `packages/workspace-runtime/src/workspace/runtime.ts`
- `packages/workspace-runtime/src/workspace/host.ts`
- `packages/workspace-runtime/src/workspace/core.ts`
- `packages/workspace-runtime/src/routes/config.ts`
- `packages/workspace-runtime/src/management-auth.ts`
- `packages/workspace-runtime/src/workspace-relay-env.ts`
