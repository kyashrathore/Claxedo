# `@claxedo/workspace-runtime`

The workspace-runtime is the per-workspace host service. One process per
workspace. It owns the runtime host that drives every harness through its
`@claxedo/harness` transport, plus the PTY manager, the LSP/VCS
surface, and the relay-host tunnel to `workspace-relay`. The transports live in
`@claxedo/harness`; this package composes them and owns what they never decide.

UI never imports this package directly. The user's browser talks to
`claxedo-server`, which proxies to a workspace-runtime instance via the
gateway pattern in `claxedo-server/src/proxy.ts`.

See [`docs/architecture.md`](docs/architecture.md) for the five deployment
shapes, the two event systems, the harness transport seam, and the
journal-backed store, in one place.

## Install

```sh
npm install @claxedo/workspace-runtime
```

Minimal loopback host, no `claxedo-server` or control plane involved:

```ts
import {
  startServer,
  loopbackWorkspaceRuntimeExposure,
  type WorkspaceRuntimeServerOptions,
} from "@claxedo/workspace-runtime"

export function startLoopbackHost(
  ports: Pick<WorkspaceRuntimeServerOptions, "placement" | "sessionIdWorkspace" | "storeFactory">,
) {
  return startServer(3002, {
    ...ports,
    exposure: loopbackWorkspaceRuntimeExposure(),
    target: { workspaceId: "demo", directory: process.cwd() },
  }, { signals: true })
}
```

`startServer(port?, options?, lifecycle?)` requires an explicit `exposure`
declaration (`loopbackWorkspaceRuntimeExposure()` here) and refuses to start
without one. The host supplies `placement` and the required `sessionIdWorkspace`
reader from its authoritative session index. `storeFactory` is optional for
the machine host. See [Supported runtime shapes](#supported-runtime-shapes) below
for the other four exposure/deployment options, and
[`docs/architecture.md`](docs/architecture.md) for the full picture.

## Package role: a kit, not a runnable artifact

This package ships the runtime **primitives** (host wiring, harness composition,
PTY/file/git/event surfaces, config apply behavior, exposure/relay
contracts). It deliberately ships **no bin**: runnable hosts are composed by
downstream packages. ACP binaries are not shipped by Claxedo. The operator
installs them and names their command, arguments, and environment in the
applied runtime descriptor.

The kit ships env **parsers** (`workspaceRelayRuntimeOptionsFromEnv`,
`relayHostAuthFromEnv`, `managementAuthFromEnv`, `hostTunnelFromEnv`,
`workspaceRuntimeListenHostname`, `isLoopbackHostname`), the canonical
env-trim helper (`runtimeEnvText`, exported from the root so hosts trim env
exactly the way the kit does), the exposure factories, and `startServer` —
but **no boot-policy ladder**.

Host decision seams (all default to decision-free kit behavior):
`storeFactory` (store implementation; default SQLite `RuntimeStore`),
`corsOrigin` (origin policy; kit default = loopback dev origins only, no
product domains), generic `connectionProviders` (custom harness providers the
`@claxedo/harness` registry composes beside its built-in ACP and Pi RPC ones)
plus a strict v4 runtime snapshot (operator-owned process/remote descriptors
and secret references), `placement` (where the runtime runs and whose machine
it is, which every transport's own-login decision reads), `harnessStateRoot`
and `env` (where Claxedo-owned harness homes live and the environment harness
processes inherit), and `startServer`'s third argument `{ signals: true }` (process
signal/exit handling; kit default makes no process-global claims). Claxedo
supplies all of these from `claxedo-server` (`runtime-boot.ts`, embedded
options); guards in claxedo-server's architecture tests ban product strings
and ambient policy env reads from this package. Deciding how env
maps to a running server (which exposure when, which defaults) is host policy:
each host composes its own ladder from the parsers. Claxedo's lives at
`packages/claxedo-server/src/hosts/workspace-runtime/runtime-boot.ts`
(used by its `host-entry.ts`); the relay e2e's process fixture
(`src/workspace-relay-e2e-entry.ts`) composes the minimal ladder its scenarios
need. An OSS quickstart, when it ships, will be a separate reference-host
package with its own ladder.

## Public surface

The package root is intentionally small and checked by
[`docs/api-manifest.json`](docs/api-manifest.json). Use focused subpaths for
lower-level helpers:

| Import | Use |
| --- | --- |
| `@claxedo/workspace-runtime` | Standalone bootstrap, host creation, exposure/management contracts, route manifest, and stable config types. |
| `@claxedo/workspace-runtime/client` | Manual typed HTTP client for health, capabilities, config apply, events, files, diff/git, and PTY routes. |
| `@claxedo/workspace-runtime/file-index` | Machine file listing, bounded search index, and explicit cache invalidation. |
| `@claxedo/workspace-runtime/host` | Low-level host construction and route mounting. |
| `@claxedo/session-core` | Runtime-neutral session storage, orchestration, projection, session routes, event delivery and HTTP primitives. |
| `@claxedo/harness/opencode-sdk` | The embedded OpenCode engine and its transport, which this runtime composes as the `opencode` registry row (Node 24+). |
| `@claxedo/workspace-runtime/exposure` | Explicit loopback, relay, private-network, and embedded exposure declarations. |
| `@claxedo/workspace-runtime/relay` | Relay-host auth and host tunnel helpers. |
| `@claxedo/workspace-runtime/config` | Runtime config snapshot and management-auth contracts. |
| `@claxedo/workspace-runtime/routes` | Neutral `/api/wr/*` route manifest. |
| `@claxedo/workspace-runtime/route-contribution` | Host route-contribution contracts and lifecycle-safe route mounting. |
| `@claxedo/workspace-runtime/testing` | Test support: management-auth helpers, the loopback login policy, and the fake transport and connection provider. |

`@claxedo/workspace-runtime/file-index` exposes `createFileIndex` and the shared
`machineFileIndex`. `get(root)` caches files and their parent directories for
10 seconds across at most 32 roots, evicting the least recently used root.
`list(root)` reads a fresh listing, and `invalidate(root)` or `invalidate()`
discards one root or all roots. Git lists tracked and non-ignored untracked
files in one command; non-repositories use a symlink-free walk capped at
200,000 files. Indexed paths use `/` separators, and matching remains with
each caller.

Root runtime value exports:

`FIRST_PARTY_MCP_PATH`, `FIRST_PARTY_MCP_SERVER_NAME`, `Pty`, `PTY_NOT_FOUND_REFUSAL`,
`WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER`,
`WorkspaceRuntimeRouteManifest`, `WorkspaceRuntimeRoutes`, `WorkspaceWorktreeManager`,
`authorizePtyAttach`, `createAuthorizedPtyConnection`,
`isPtyStreamSocket`, `ptyAccessRefusalResponse`, `ptyStreamAccess`, 
`createRuntimeCredentialIssuer`, `createWorkspaceHost`,
`createWorkspaceRuntimeApp`, `createWorkspaceRuntimeJwtManagementAuth`, `embeddedWorkspaceRuntimeExposure`,
`firstPartyMcpServerFor`, `flushRuntimeDocument`, `forgetRuntimeDocuments`, `isLoopbackHostname`,
`loadWorkspaceRuntimeManagementVerificationKey`, `loopbackWorkspaceRuntimeExposure`,
`normalizeRuntimeSnapshot`, `privateNetworkDevUnsafeWorkspaceRuntimeExposure`,
`privateNetworkWorkspaceRuntimeExposure`, `relayWorkspaceRuntimeExposure`,
`runtimeCredentialWorkspaceId`, `runtimeEnvText`, `startServer`, `startWorkspaceRuntime`,
`waitForWorkspaceRuntimeServerPort`, `workspaceRuntimeListenHostname`, `workspaceRuntimeRoute`,
`workspaceStorageRoot`, `WORKSPACE_RUNTIME_OWNER_GRANT_AUDIENCE`, `WORKSPACE_RUNTIME_OWNER_GRANT_ISSUER`,
`ownerGrantIdentity`, `ownerGrantIdentityFromEnv`.

The first-party MCP group is how a runtime hands each session it launches an
entry for the built-in Claxedo MCP server, authenticated by a bearer token the
runtime itself mints per session:

- `FIRST_PARTY_MCP_SERVER_NAME` is the server name a harness sees for the
  built-in MCP entry, and `FIRST_PARTY_MCP_PATH` is the path the hosting
  process mounts it at.
- `createRuntimeCredentialIssuer` mints, verifies, and rotates the HS256
  token a runtime signs per session; a token is re-minted once half its TTL
  has passed so a long-lived harness always holds at least half the lifetime.
- `firstPartyMcpServerFor` builds the MCP server entry for one session (name,
  session-scoped URL, bearer header) and returns nothing when the project has
  no tool groups enabled.
- `runtimeCredentialWorkspaceId` reads the workspace id claim from a token
  without verifying it, so a process hosting several runtimes can pick which
  runtime's verifier to call.

Relay host helpers are intentionally exposed from
`@claxedo/workspace-runtime/relay`, not the package root:
`startWorkspaceRelayHostTunnel`, `hostTunnelFromEnv`, `relayHostAuthFromEnv`,
and `workspaceRelayRuntimeOptionsFromEnv`. The Relay Host Token middleware,
`createRelayHostAuthMiddleware`, belongs to `@claxedo/session-core/relay-host`,
and the control-plane session authority client,
`remoteWorkspaceSessionAccessPolicy`, to `@claxedo/session-core`: every session
host verifies and authorizes the same way.

The runtime root does not export Claxedo control-plane clients or Agent Plugins
materializers. Products that need catalog, activation, retained artifacts, or
projection compose those concerns outside the OSS runtime boundary.

## Routes

| Route | Source | Auth |
| --- | --- | --- |
| `GET  /api/wr/health` | [`server.ts`](src/server.ts) | none; minimal liveness and exposure boundary metadata only |
| `GET  /api/wr/capabilities` | [`server.ts`](src/server.ts) | exposure-dependent runtime auth |
| `*    /api/wr/checkpoint/*` | [`routes/checkpoint.ts`](src/routes/checkpoint.ts) | workspace-runtime management auth; a `freeze` with `idleBefore` closes admission only when the workspace has been idle since then, else 409 `workspace_not_idle` |
| `POST /api/wr/config` | [`routes/config.ts`](src/routes/config.ts) | workspace-runtime management auth |
| `GET  /api/wr/harness-config-options` | [`workspace/runtime.ts`](src/workspace/runtime.ts) | exposure-dependent runtime auth; a draft preview of a harness that serves a provider catalog is the workspace owner's only |
| `GET  /api/wr/harness-providers` | [`workspace/runtime.ts`](src/workspace/runtime.ts) | exposure-dependent runtime auth; workspace owner only |
| `GET  /api/wr/events` | [`routes/events.ts`](src/routes/events.ts) | exposure-dependent runtime auth; a principal the workspace admits reads unscoped and the session authority decides per session what reaches it (the workspace's owner is not special); a refused principal reads one session under `?sessionID=` |
| `*    /api/wr/file/*`, `GET /api/wr/find/file` | [`routes/file.ts`](src/routes/file.ts) | exposure-dependent runtime auth |
| `*    /api/wr/diff/*`, `* /api/wr/git/*` | [`routes/diff.ts`](src/routes/diff.ts), [`routes/git-source.ts`](src/routes/git-source.ts) | exposure-dependent runtime auth |
| `*    /api/wr/pty/*` | [`routes/pty.ts`](src/routes/pty.ts) | exposure-dependent runtime auth |
| `*    /api/wr/hook/*` | [`routes/agent-hook.ts`](src/routes/agent-hook.ts) | exposure-dependent runtime auth |
| `*    /api/wr/worktrees/*` | [`routes/worktree.ts`](src/routes/worktree.ts) | exposure-dependent runtime auth |
| `*    /api/wr/execution-env/*` | [`routes/execution-env.ts`](src/routes/execution-env.ts), [`routes/mcp-stdio-relay.ts`](src/routes/mcp-stdio-relay.ts) | relay exposure only: a `cloud-vm` Relay Host Token with a `session_id` claim and role editor or above; no control-plane call per request |
| `*    /session/*` | `SessionRoutes` (mounted via `mountWorkspaceCore`) | implicit (host-level) |
| `*    /mcp/*` | MCP routes | implicit |
| `*    /lsp`, `*    /vcs` | client-presentation routes mounted by host | implicit |

The capability response is versioned with `api_version: 2`.

### Execution environment

A relay-exposed runtime serves a Durable-Object-hosted Pi session the
workspace machine as Pi's `ExecutionEnv`. Every request carries a `cloud-vm`
Relay Host Token with the session's `session_id`, role editor or above, and
`purpose: "turn-execution"`, which only the control plane's `/turn-execution`
mint sets; a share holder's session token is refused with 403, any other
backing answers 404, and nothing calls the control plane per request.

- `POST /api/wr/execution-env/fs` takes `{ op, args }`, where `op` names a
  pi-durable `FileSystem` method other than `openTextLineReader` and `cleanup`,
  and answers `{ ok: true, value } | { ok: false, error: { code, message, path? } }`
  with status 200. Bytes travel as `{ base64 }`. A whole-file read
  (`readTextFile`, `readBinaryFile`, `readTextLines` without `maxLines`) of a
  file over 8 MiB answers `invalid`.
- `POST /api/wr/execution-env/exec` takes `{ command, cwd?, env?, inheritEnv?, timeout?, spill? }`
  and streams `output` events (`{ text }`) then one `result` event. Commands run
  through Pi's owned shell (`@claxedo/harness/pi-durable/shell`) under the
  workspace's launch ownership with the harness env allowlist: a timeout or a
  client disconnect mid-command retires the command's process group, and a
  background job it started outlives it in that session's live set until the
  runtime stops. `timeout` is bounded by Pi's own ceiling. `spill` is accepted
  and ignored: output is never spilled to a file, so a result never carries
  `spillPath`. Output past 8 MiB characters is cut with an
  `[execution-env: output truncated …]` marker, which bounds what one command
  can queue on the stream.
- `GET /api/wr/execution-env/mcp/:serverName` upgrades to a WebSocket bridged
  through Pi's `OwnedStdioMcpTransport` to the plugin stdio MCP server of that
  name in the runtime's Pi projection, one JSON-RPC message per frame. The
  server gets the same minimal inherited env as a local Pi session plus its own
  `env`, is spawned on open, and is retired on close, on a socket that stops
  answering pings, or when the runtime stops. At most 64 messages wait for it
  to start; the caller never sends a command.

## Event contract

`workspace-runtime` serves one event stream. Terminal bytes are not an event
stream and have their own transport:

| Surface | Transport | Event family | Contract |
| --- | --- | --- | --- |
| `GET /api/wr/events` | SSE | `{ directory, payload }` frames: the runtime's projected client-presentation events (parts, deltas, tool state, status, permission and question asks, todo, diagnostics), the committed `subagent.updated` / `goal.*` presentation events, `harness.health` (a session's `harnessHealth` and `connectionState`, as `/api/wr/health?sessionId=` answers them, sent when either changes around a turn), `session.background-work` (whether the session's harness runs work outside any turn, sent when it changes), and the workspace's control frames from `sessionCore.bus` (PTY lifecycle and stream summaries, agent lifecycle, session lifecycle) | The one stream a workspace runtime serves. Mounted by `mountWorkspaceCore()`; resumable by `Last-Event-ID`, with a second retained ring for the frames that settle a state machine. A principal the workspace authority admits reads it unscoped, on a workspace lease the control plane mints for the read and the delivery policy renews, and the session authority decides per session what reaches it — the workspace's owner is no exception; a principal it refuses is answered 403 `workspace_event_stream_denied` and reads `?sessionID=` under a session lease, that session and its subagent children. A connection lives at most one runtime-access-token lifetime and reconnects by cursor into the reader's actor-keyed replay scope |
| `GET /api/wr/pty/:ptyID/connect` | WebSocket | PTY bytes plus cursor metadata | Supported PTY data stream. PTY lifecycle summaries also appear on `/api/wr/events`, but terminal bytes are delivered over this WebSocket. |

`harness.health` is owned by `src/workspace/harness-health-feed.ts`. A session is
watched from its turn's start until one read after the turn ends. Adapters call
`reportHealthChanged` when they record what their health answers from (a process
lost under a turn, its replacement, an unsettled retirement, an ACP connection's
state), and every call, turn start and turn end schedules one read of each
watched session on the next task; a read that differs from the last one sent for
that session is published.

`session.background-work` is owned by `session-core/src/broker-ports/background-work.ts`. A
harness publishes `{ type: "background-work", agents, shells, other }` through
`SessionBroker.publish` whenever the work it runs for a session outside any
turn (background agents, shells and other tasks in a process that outlives the
turn) changes, all zero once it settled. The counts are held in memory by the
engine's broker ports, not in the store: they describe a process this runtime
owns, so a restart or a retired engine ends them, and nothing stored could
outlive that truthfully. A change is broadcast as `session.background-work`
with the same counts, never journaled, and the settling frame (all zero) is
retained in the replay ring; `GET /session/status` and the open view's
`status` add `backgroundWork: { agents, shells, other }` beside the turn's own
status while any count is above zero (an idle session with background work is
listed as `{ type: "idle", backgroundWork: { … } }`). It never enters turn admission: a prompt sent while it is set starts a turn on
the same attached session as any other.

`POST /session/:id/background-task/stop` with `{ toolCallId }` stops one
background task (`src/host/background-tasks.ts`, route in
`src/routes/session-background-tasks.ts`). It is an `agent_turn` write
(`background_task_stop`), authorized like a prompt or a turn cancel, so a
`send` share may stop a task its turn started. The task is named by the call
that started it, which the subagent row carries. The runtime asks the held
attachment's `HarnessTransport.backgroundTasks.stop` and answers what the
harness answers: 200 `{ ok: true }` once the harness accepted (the task's end
still arrives as its row's own update), 404 `not_found` for a call with no
running task, and for a session holding no harness process, which is never
launched to answer. A harness without the operation is refused 409
`unsupported_operation` and reads `backgroundTasks: false` in
`GET /session/:id/capabilities`.

`RuntimeEventHub` is the hub for session/runtime events: session routes
publish committed client-presentation events to its global channel, which
`/api/wr/events` serves. `createSessionEventWriter` appends each projected event,
subagent revisions included, before publication; a goal change is appended and
published by the store's goal write. Raw runtime events stay on its runtime
channel for in-process subscribers. The session
routes' `publishGlobal` (`bridgeLifecycleEvent` in
[`session routes`](../session-core/src/routes/session.ts)) also forwards a session's
lifecycle states onto `sessionCore.bus` as `agent.lifecycle` frames:
`session.status` with busy status becomes `Busy`, a permission or question ask
`UserActionRequired`, `session.idle` `Idle`, and `session.error` `Error`.

`sessionCore.bus` belongs to one session core instance. PTY callbacks retain
the bus of their creating host, and agent hooks publish to the bus their host
supplies. Subscribers are isolated: a throwing or rejecting
subscriber is reported and cannot prevent later subscribers from receiving the
same event.

## Supported runtime shapes

`workspace-runtime` supports five deployment shapes. They share the same
per-workspace route surface, but they do not share the same trust boundary:

| Shape | How it is created | Listen/auth expectation |
| --- | --- | --- |
| Local loopback / trusted local | `startServer(port, { exposure: loopbackWorkspaceRuntimeExposure() })` with the default host or `WORKSPACE_RUNTIME_HOST=127.0.0.1` / `localhost` | May run without host-level auth because the socket is loopback-only. This is for local development and app-owned desktop flows. |
| Private VM runtime | `startServer(port, { exposure: privateNetworkWorkspaceRuntimeExposure(...), target })` inside an operator-controlled VM, usually with `WORKSPACE_RUNTIME_HOST=0.0.0.0` or a private interface | Must configure either relay-host auth or a private-network exposure with both a host guard and runtime auth. The dev-unsafe opt-out is only for self-managed deployments where surrounding controls are intentionally the auth boundary. |
| Relay-attached runtime | `startServer()` with `workspaceRelayRuntimeOptionsFromEnv()` / `relayHostAuthFromEnv()` and `hostTunnelFromEnv()` | Verifies Relay Host Tokens (RHTs) from `workspace-relay`, requires the relay transit marker on relay-issued tokens, and may maintain an outbound host tunnel to the relay. |
| Embedded Hono app | `createWorkspaceRuntimeApp()` mounted inside another trusted process | The embedding process owns the outer network/auth boundary. Pass `relayHostAuth`, `configToken`, and a `WorkspaceTarget` explicitly when exposing runtime routes outside loopback. |
| Low-level host object | `createWorkspaceHost()` / `mountWorkspaceCore()` used without `startServer()` | No socket is created. The caller owns routing, auth, lifecycle, and disposal; use this only behind an existing trusted API surface. |

Runtime CORS follows the same exposure declaration. Loopback exposure allows
local browser origins such as `localhost`, `127.0.0.1`, and hosted
`opencode.ai` app origins. Relay, private-network, and embedded exposure do not
emit runtime CORS headers by default because the relay, trusted ingress, or
embedding server owns the browser origin policy.

For all shapes, `WORKSPACE_RUNTIME_CONFIG_TOKEN` is a trusted direct token for
health discovery through relay-host middleware, not whole-server auth.
Config mutation is authorized only by an explicit workspace-runtime management
auth adapter. The config token does not authorize PTY/file/session/VCS
routes or `/api/wr/config`.

## Standalone listen policy

`startServer()` requires an explicit exposure declaration and defaults to
`127.0.0.1` for the listen host. A runtime may listen on a non-loopback host
such as `0.0.0.0`, `::`, or a LAN address only when
relay-host auth is configured, a private-network exposure supplies both host
guard and runtime auth, or the operator explicitly sets
`WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK=1`.

The opt-out is the `private-network-dev-unsafe` path: it is only for
self-managed deployments behind trusted private-network controls and does not
add application-level auth.
`WORKSPACE_RUNTIME_CONFIG_TOKEN` participates in trusted direct health access
when relay-host auth is enabled; it is not standalone config mutation auth and
is not a whole-server credential for PTY, file, session, or VCS routes.

## Relay-attached runtime configuration

A relay-attached runtime has two independent pieces:

1. **Relay-host auth verification**, which protects inbound requests that the
   relay forwards to the runtime.
2. **Host tunnel attachment**, which opens the outbound connection from this
   runtime to `workspace-relay`.

Inbound RHT verification is configured by `relayHostAuthFromEnv()`:

| Env var | Purpose |
| --- | --- |
| `WORKSPACE_RUNTIME_RELAY_JWKS_URL` | Preferred RHT verification source. The runtime uses this JWKS to verify relay-minted RHTs and support signing-key rotation. |
| `WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM` | Static PEM fallback for RHT verification when JWKS discovery is unavailable. |
| `WORKSPACE_RUNTIME_WORKSPACE_ID` | Workspace id the runtime hosts; RHT claims and `x-workspace-id` must match it. |
| `WORKSPACE_RUNTIME_HOST_ID` | Host id expected in the RHT. Defaults to `workspaceId()` when omitted. |
| `WORKSPACE_RUNTIME_CONFIG_TOKEN` | Supervisor bearer accepted without an RHT on `GET /api/wr/health` only; every other route still needs an RHT or a management token. The Cloudflare sandbox Worker reads `idleSince` there: when the workspace last had no turn, admitted write or background work, no checkpoint in progress and no terminal input or output (an open but quiet shell keeps nothing awake); and `frozenSince`, since when a checkpoint has held it frozen (`workspace/idle.ts`, the one owner the idle freeze also asks). |

Relay-issued RHT requests must include `x-forwarded-by: workspace-relay`.
`workspace-relay` sets that marker after stripping client-supplied
`x-forwarded-*` headers. Direct trusted-token calls bypass the marker because
they do not originate from the public relay.

Outbound host tunnel attachment is configured by `hostTunnelFromEnv()`:

| Env var | Purpose |
| --- | --- |
| `WORKSPACE_RUNTIME_RELAY_URL` | Relay base URL. If unset, the runtime does not open a host tunnel. |
| `WORKSPACE_RUNTIME_RELAY_TUNNEL_TOKEN` | Bearer token for the runtime-to-relay tunnel connection. |
| `WORKSPACE_RUNTIME_RELAY_TUNNEL_AUTHORIZATION` | Full `Authorization` header override for the tunnel connection. Takes precedence over `WORKSPACE_RUNTIME_RELAY_TUNNEL_TOKEN`. |
| `WORKSPACE_RUNTIME_RELAY_WORKSPACE_IDS` | Comma-separated workspace ids advertised by this host tunnel. Defaults to the current workspace id. |
| `WORKSPACE_RUNTIME_LOCAL_BASE_URL` | Local runtime URL forwarded by the tunnel. Defaults to `http://127.0.0.1:<port>`. |
| `WORKSPACE_RUNTIME_RELAY_PING_INTERVAL_MS` | Optional host-tunnel ping cadence. |

Programmatic callers can pass `tokenProvider` to
`startWorkspaceRelayHostTunnel()` when the tunnel token must be refreshed before
each connection attempt. Static env auth remains available for supervised
processes whose token is already rotated by the parent process. Callers can also
pass `onEvent` and `maxReconnectAttempts` to surface tunnel lifecycle state and
stop retrying after a bounded number of failed reconnect attempts.

## Workspace target and path containment

`workspace-runtime` is a per-workspace host. Session, file, PTY,
OpenCode-compat, and diff/VCS routes are pinned to
`WORKSPACE_RUNTIME_DIRECTORY` or the `WorkspaceTarget` passed to
`createWorkspaceRuntimeApp()`. Callers may omit `directory` and use the pinned
workspace, pass that exact directory, or pass the synthetic
`workspace:<workspaceId>` target. A request for any other directory is
rejected.

Filesystem route `path` values and PTY `cwd` overrides are relative
to the pinned workspace. Absolute paths, `..` escapes, null bytes, and symlinks
that resolve outside the workspace are rejected before the route reads, writes,
streams file content, or starts a subprocess. Client-provided subprocess env is
filtered through the same allowlist/denylist policy used by PTY startup.

## Lifecycle

States: `"ready" | "applying" | "error"` (see
[`workspace/runtime.ts`](src/workspace/runtime.ts)).

1. **Cold start** — `startServer(port, { exposure, target?, relayHostAuth?, configToken? })`.
2. **Health discoverable** — `/api/wr/health` returns minimal liveness, including `{ status: "ready" | "applying" | "error" }`, without workspace identity, directory, diagnostics, or capabilities.
3. **Config apply observable** — accepted runtime config writes redacted metadata to `<workspace>/.workspace-runtime/runtime-config/accepted-snapshot.json`, and apply progress writes `<workspace>/.workspace-runtime/runtime-config/apply-status.json` with `applying`, `applied`, or `failed`. Auth values are never written to these status files; only auth key names are recorded.
4. **Config applied** — `claxedo-server` POSTs a `RuntimeSnapshot` to
   `/api/wr/config`. The host transitions to `"applying"` while the
   attached sessions are reconfigured, then back to `"ready"`.
5. **Relay/direct discovery** — supervisors and relays track runtime
   availability outside the OSS runtime package. `/api/wr/health` exposes only
   liveness and boundary metadata; richer diagnostics stay behind authenticated
   host-owned surfaces.
6. **Drain & exit** — on SIGTERM/SIGINT we close the listening socket,
   close the host tunnel (so the relay reroutes), remove remaining PTYs, then
   `host.dispose()` (with `WORKSPACE_RUNTIME_DRAIN_TIMEOUT_MS` wall-clock cap,
   default 10s). See `server.ts` for the exact phase sequence (P4).

Expected route, harness, process, and relay failures are handled at their
own owner boundaries and mapped to route-specific responses or runtime
state. Process-level `unhandledRejection` and `uncaughtException` handlers
are last-resort fatal paths: they stop accepting new work, run the same
workspace drain used by SIGTERM/SIGINT, and exit non-zero so the supervisor
can restart the runtime. They are not suppress-and-continue handlers.

## Runtime store durability

`RuntimeStore` keeps the `runtime_journal` table as the source of truth and
the rest of its SQLite tables as a projection of it. A mutation journals its
row first, then applies the projection and advances `journal_checkpoint` in
one transaction. If projection fails, that transaction rolls back, the
session is gated for writes, and a later open replays the journal rows past
the session's checkpoint.

The store runs on whatever `SqliteDatabase` its host opens: `store-file.ts`
opens `state.db` under the store root on a machine, and a Durable Object
hands it `ctx.storage.sql`. The workspace host opens it on first use and
closes it when disposed, including one a `storeFactory` supplied.

The schema is declared once, in `src/store-schema.ts`, and its identity is
that DDL text with whitespace normalized, recorded in `runtime_store_schema`
when a store is created. Any edit to the DDL, a reformat included, is a
storage-contract change: every store written before it is refused at open
with `RuntimeStoreSchemaMismatchError` (a typed 503 on requests), and there
are no migrations while the product is unreleased.

## Harness transports

The session host in `@claxedo/session-core` drives every harness through one
`HarnessTransport` per composed harness, from `@claxedo/harness/contract`.
`src/workspace/transports.ts` composes them through the `@claxedo/harness`
registry: a native harness (Claude, Codex, Cursor, OpenCode, Pi) by its
registry row, a configured connection by its descriptor, directory and secret
lease. There is no second path: OpenCode is a registry row like the others.

The host owns what a transport never decides: turn admission and fencing,
durable writes and the SSE projection (`session-core/src/projection/`), recovery and its
receipts, goals the harness does not run natively, session titles, handoffs
and child sessions. One request broker per store (`@claxedo/harness/broker`
over `session-core/src/broker-ports/`) answers every permission, question and elicitation a
transport asks, and persists each answer before the harness is released.

A notice the person needs reaches the transcript, not a diagnostic. The
client-presentation projection (`session-core/src/projection/client-presentation/notices.ts`)
turns a turn's `harness-notice` into a `notice` part on its reply, and a
compaction into one `notice` part that goes from running to completed or
failed, and a `conversation-reset` (Claude's `/clear`) into a boundary part; the
session and its stored history stay, and later turns run on the new
conversation. A `debug` notice, or one published outside any turn, has no reply to
land in and stays a `runtime.diagnostic`.

A harness that names its model responses (`response-start`) lets the
projection remember which text, reasoning and tool parts each response wrote.
A `response-retracted` for those responses becomes `message.part.retracted`:
the store marks exactly those text and reasoning parts `retracted`, keeping
their content, and a tool call the response never ran settles as withdrawn. A
tool call that ran keeps its recorded outcome, because what it did happened.

A descriptor whose revision or secret lease changes replaces its transport.
The superseded one is disposed only once the turns admitted on it have ended,
so their cancellation and requests still reach the process running them.
Shutdown disposes every transport first: a pending start or a running turn may
only settle once its harness stops.

Resolution is fail-closed: a connection with no applied descriptor, or one
whose secret references no host resolves, raises
`WorkspaceHarnessUnavailableError` (`workspace_harness_not_configured`), which
the session routes answer with 409. It never falls back to a bundled
first-party binary. A descriptor, including a process environment, only enters
through the trusted config-apply path (`POST /api/wr/config` / `host.apply`),
so session callers can never supply one. Operator-facing semantics live in
[`public-docs/acp-connections.md`](../../public-docs/acp-connections.md).

A configuration change reaches each attached session once through
`transport.configure`. A transport may hold it until that session's turn ends;
a refusal fails the apply that asked for it, and a held push refused after the
turn is reported on the apply status the same way.

## Plugging in auth

Relay-host auth can use the built-in JWT key path or a custom
[`TokenVerifier`](../workspace-relay-protocol/src/token-verifier.ts).
Use this to back the runtime's relay boundary with a custom IdP (OIDC, a
hosted control plane, or a self-managed key-table).

```ts
import { createStaticTokenVerifier, type RelayHostVerifierClaims } from "@claxedo/workspace-relay-protocol"
import { createRelayHostAuthMiddleware } from "@claxedo/session-core/relay-host"

// Verifier claims are still validated against the relay-host contract:
// `iss` must be "workspace-relay", `aud` must be "workspace-host-service",
// `sub`/`org_id`/`workspace_id`/`host_id`/`role`/`exp`/`iat`/`jti` are required,
// and `backing` must name a placement ("cloud-vm", "local-worktree" or "durable-object").
// `workspace_id`/`host_id` must match the middleware's expected values.
const now = Math.floor(Date.now() / 1000)
const verifier = createStaticTokenVerifier<RelayHostVerifierClaims>({
  tokens: {
    "tok-tenant-1": {
      subject: "u1",
      scopes: ["workspace:write"],
      claims: {
        iss: "workspace-relay",
        aud: "workspace-host-service",
        sub: "u1",
        org_id: "org_1",
        workspace_id: "ws_1",
        host_id: "host_1",
        role: "editor",
        backing: "cloud-vm",
        exp: now + 300,
        iat: now,
        jti: "jti-1",
      },
    },
  },
})

app.use("*", createRelayHostAuthMiddleware({
  key: relayKey,
  workspaceId: "ws_1",
  hostId: "host_1",
  verifier,
}))
```

Config mutation uses the separate `WorkspaceRuntimeManagementAuth` contract from
`@claxedo/workspace-runtime/config`. The built-in JWT helper verifies
management tokens with `WORKSPACE_RUNTIME_MANAGEMENT_*` inputs, and Claxedo maps
its product-specific control-plane credential into that contract outside
workspace-runtime core.

The built-in `HttpTokenVerifier` accepts a remote endpoint that returns
`{ subject, scopes, claims }` for a posted token — useful for
hosted-control-plane deployments. See
`packages/workspace-relay-protocol/src/token-verifier.ts` for the full
contract.

## Configuration env vars

| Env var | Purpose |
| --- | --- |
| `WORKSPACE_RUNTIME_HOST`, *port arg* | Listening socket. Defaults to `127.0.0.1`. Non-loopback values require relay-host auth, guarded private-network exposure, or the explicit dev-unsafe opt-out below. |
| `WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK` | Set to `1` only for self-managed runtimes behind trusted private-network controls that intentionally expose unauthenticated host routes. Reports as `private-network-dev-unsafe`. |
| `WORKSPACE_RUNTIME_CONFIG_TOKEN` | Supervisor bearer for `GET /api/wr/health` discovery only. Not config mutation auth and not whole-server auth. |
| `WORKSPACE_RUNTIME_DIRECTORY`, `WORKSPACE_RUNTIME_WORKSPACE_ID`, `WORKSPACE_RUNTIME_HOST_ID` | Runtime target identity. |
| `WORKSPACE_RUNTIME_NATIVE_HARNESS`, `WORKSPACE_RUNTIME_CONNECTION_ID`, `WORKSPACE_RUNTIME_ACP_BINARY` | Optional CLI launcher defaults for the initial harness. Select a native harness or a connection, not both. Runtime config apply can replace this after startup. |
| `WORKSPACE_RUNTIME_ENABLE_ACP_REMOTE_TRANSPORT` | Enables remote ACP transport URLs in runner config. Disabled by default. |
| `WORKSPACE_RUNTIME_TERMINAL_SESSION_TTL_MS` | Retention window for terminal lifecycle session summaries. |
| `WORKSPACE_RUNTIME_DATA_DIR`, `WORKSPACE_RUNTIME_STATE_DIR`, `WORKSPACE_RUNTIME_STORE_DIR`, `WORKSPACE_RUNTIME_PTY_HISTORY_DIR` | Neutral runtime-owned storage locations. Defaults are under `~/.workspace-runtime`. |
| `WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL`, `WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM`, `WORKSPACE_RUNTIME_MANAGEMENT_ISSUER`, `WORKSPACE_RUNTIME_MANAGEMENT_AUDIENCE` | Management-token verification inputs for `/api/wr/config`. Remote JWKS requires HTTPS and refuses redirects. Local development uses a pinned PEM public key. |
| `WORKSPACE_RUNTIME_DRAIN_TIMEOUT_MS` | Drain wall-clock cap (default `10000`). |
| `WORKSPACE_RUNTIME_RELAY_JWKS_URL`, `WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM` | RHT verification inputs for relay-attached runtimes. |
| `WORKSPACE_RUNTIME_RELAY_*` | Host tunnel settings for relay-attached runtimes. See the relay-attached section above and `workspace-relay/README.md`. |
| `CLAXEDO_RELAY_RESOLVER_*` | Relay-process resolver settings. See `workspace-relay/README.md`. |

Claxedo deployments translate any product-specific environment outside this
package before launching the runtime. Runtime library APIs and examples use the
neutral `WORKSPACE_RUNTIME_*` names.

## Boundary rule

`grep -rn "claxedo-app" packages/workspace-runtime/src` must return
zero hits. The host is UI-agnostic — any rendering coupling belongs in
`claxedo-app` and should reach the host via `claxedo-server`.

`packages/containers/` is the OCI image build, **not** the host.

## Development

```sh
bun --cwd packages/workspace-runtime dev
bun --cwd packages/workspace-runtime test
bun --cwd packages/workspace-runtime typecheck
```

The TS error baseline for this package is **0** in isolation. The
errors that appear when typechecking from the monorepo root are
project-reference leakages from `claxedo-server` (8 baseline errors)
and are tracked separately outside this package.
