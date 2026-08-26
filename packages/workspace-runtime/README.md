# `@claxedo/workspace-runtime`

The workspace-runtime is the per-workspace host service. One process per
workspace. It owns workspace host wiring around the runner adapters, plus the
PTY and process managers, the LSP/VCS surface, and the relay-host tunnel to
`workspace-relay`. Runner adapters live in `@claxedo/agent-sdk-runtime`;
workspace-runtime only wraps them where it needs host storage or environment
wiring.

UI never imports this package directly. The user's browser talks to
`claxedo-server`, which proxies to a workspace-runtime instance via the
gateway pattern in `claxedo-server/src/proxy.ts`.

See [`docs/architecture.md`](docs/architecture.md) for the five deployment
shapes, the two event systems, the harness adapter seam, and the
journal-backed store, in one place.

## Install

```sh
npm install @claxedo/workspace-runtime
```

Minimal loopback host, no `claxedo-server` or control plane involved:

```ts
import { startServer, loopbackWorkspaceRuntimeExposure } from "@claxedo/workspace-runtime"

startServer(
  3002,
  {
    exposure: loopbackWorkspaceRuntimeExposure(),
    target: { workspaceId: "demo", directory: process.cwd() },
  },
  // Opt in to process-global SIGTERM/SIGINT/exit handling; omit this to let
  // the host process own signals itself.
  { signals: true },
)
```

`startServer(port?, options?, lifecycle?)` requires an explicit `exposure`
declaration (`loopbackWorkspaceRuntimeExposure()` here) and refuses to start
without one. See [Supported runtime shapes](#supported-runtime-shapes) below
for the other four exposure/deployment options, and
[`docs/architecture.md`](docs/architecture.md) for the full picture.

## Package role: a kit, not a runnable artifact

This package ships the runtime **primitives** (host wiring, adapters,
PTY/process/file/git/event surfaces, config apply behavior, exposure/relay
contracts). It deliberately ships **no bin**: runnable hosts are composed by
downstream packages. The ACP adapter binaries
(`@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`)
live with the code that spawns them (`@claxedo/agent-sdk-runtime`), not here.

The kit ships env **parsers** (`workspaceRelayRuntimeOptionsFromEnv`,
`relayHostAuthFromEnv`, `managementAuthFromEnv`, `hostTunnelFromEnv`,
`workspaceRuntimeListenHostname`, `isLoopbackHostname`), the canonical
env-trim helper (`runtimeEnvText`, exported from the root so hosts trim env
exactly the way the kit does), the exposure factories, and `startServer` —
but **no boot-policy ladder**.

Host decision seams (all default to decision-free kit behavior):
`storeFactory` (store implementation; default SQLite `RuntimeStore`),
`harnesses` (adapter registry; default `defaultWorkspaceHarnessRegistry()`),
`corsOrigin` (origin policy; kit default = loopback dev origins only, no
product domains), `opencodeCompat` (three-state OpenCode compatibility:
`undefined` default keeps the OpenCode **adapter mechanism** on — upstream
list/status proxying — while the root compat **route surface** (`/mcp`,
`/provider`, `/vcs`, `/session/status`) stays off; `true` enables both;
`false` is a full kill switch), `opencodeRequest` (OpenCode engine transport:
inject an in-process `(request: Request) => Promise<Response>` handler and the
adapter/compat routes/`/global/event` proxying all ride it — no socket, no
child process; when set it wins over `opencodeUrl`), and `startServer`'s third argument
`{ signals: true }` (process
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
| `@claxedo/workspace-runtime/client` | Manual typed HTTP client for health, capabilities, config apply, events, files, diff/git, PTY, and process routes. |
| `@claxedo/workspace-runtime/host` | Low-level host construction and route mounting. |
| `@claxedo/workspace-runtime/exposure` | Explicit loopback, relay, private-network, and embedded exposure declarations. |
| `@claxedo/workspace-runtime/relay` | Relay-host auth and host tunnel helpers. |
| `@claxedo/workspace-runtime/config` | Runtime config snapshot and management-auth contracts. |
| `@claxedo/workspace-runtime/routes` | Neutral `/api/wr/*` route manifest. |
| `@claxedo/workspace-runtime/route-contribution` | The one seam a host uses to mount named route groups into the runtime, with a lifetime and a narrow context. The runtime learns nothing about what they are for. |
| `@claxedo/workspace-runtime/http` | Request primitives a route contribution needs to answer like a built-in route: bounded JSON body reading, bearer-token parsing, and the shared `{ error: { code, message } }` envelope. Published so a contribution does not vendor a second copy of the 5 MiB body limit, which is a security bound. |
| `@claxedo/workspace-runtime/testing` | Small test management-auth helpers. |

Root runtime value exports:
`Pty`, `WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER`,
`WorkspaceRuntimeRouteManifest`, `WorkspaceRuntimeRoutes`,
`WorkspaceWorktreeManager`, `createMemoryTranscriptHandleStore`,
`createPersistentTranscriptHandleStore`, `createProcessObserver`,
`createTranscriptResolver`, `createWorkspaceHost`,
`createWorkspaceRuntimeApp`, `createWorkspaceRuntimeJwtManagementAuth`,
`defaultWorkspaceHarnessRegistry`, `embeddedWorkspaceRuntimeExposure`,
`flushRuntimeDocument`, `forgetRuntimeDocuments`, `isLoopbackHostname`,
`loadWorkspaceRuntimeManagementVerificationKey`,
`loopbackWorkspaceRuntimeExposure`, `normalizeRuntimeSnapshot`,
`privateNetworkDevUnsafeWorkspaceRuntimeExposure`,
`privateNetworkWorkspaceRuntimeExposure`, `relayWorkspaceRuntimeExposure`,
`runtimeEnvText`, `startServer`, `startWorkspaceRuntime`,
`waitForWorkspaceRuntimeServerPort`, `workspaceRuntimeListenHostname`,
`workspaceRuntimeRoute`, and `workspaceStorageRoot`.

Relay host helpers are intentionally exposed from
`@claxedo/workspace-runtime/relay`, not the package root:
`createRelayHostAuthMiddleware`, `startWorkspaceRelayHostTunnel`,
`hostTunnelFromEnv`, `relayHostAuthFromEnv`, and
`workspaceRelayRuntimeOptionsFromEnv`.

The runtime root does not export Claxedo control-plane clients or
agent-extension materializers. Hosts that need projection, metadata sync, or
extension installation should compose those concerns outside the OSS runtime
boundary.

## Routes

| Route | Source | Auth |
| --- | --- | --- |
| `GET  /api/wr/health` | [`server.ts`](src/server.ts) | none; minimal liveness and exposure boundary metadata only |
| `GET  /api/wr/capabilities` | [`server.ts`](src/server.ts) | exposure-dependent runtime auth |
| `*    /api/wr/checkpoint/*` | [`routes/checkpoint.ts`](src/routes/checkpoint.ts) | workspace-runtime management auth |
| `POST /api/wr/config` | [`routes/config.ts`](src/routes/config.ts) | workspace-runtime management auth |
| `GET  /api/wr/harness-config-options` | [`workspace/runtime.ts`](src/workspace/runtime.ts) | exposure-dependent runtime auth |
| `GET  /api/wr/events`, `GET /api/wr/runtime-events` | [`routes/runtime-events.ts`](src/routes/runtime-events.ts), [`routes/events.ts`](src/routes/events.ts) | exposure-dependent runtime auth |
| `*    /api/wr/file/*`, `GET /api/wr/find/file` | [`routes/file.ts`](src/routes/file.ts) | exposure-dependent runtime auth |
| `*    /api/wr/diff/*`, `* /api/wr/git/*` | [`routes/diff.ts`](src/routes/diff.ts), [`routes/git-source.ts`](src/routes/git-source.ts) | exposure-dependent runtime auth |
| `*    /api/wr/pty/*` | [`routes/pty.ts`](src/routes/pty.ts) | exposure-dependent runtime auth |
| `*    /api/wr/process/*` | [`routes/process.ts`](src/routes/process.ts) | exposure-dependent runtime auth |
| `*    /api/wr/hook/*` | [`routes/agent-hook.ts`](src/routes/agent-hook.ts) | exposure-dependent runtime auth |
| `GET  /api/wr/subagent-transcripts/*` | [`routes/transcript.ts`](src/routes/transcript.ts), mounted by `mountWorkspaceCore` | exposure-dependent runtime auth |
| `*    /api/wr/session-env/*` | session-env routes (mounted by the host) | exposure-dependent runtime auth |
| `*    /api/wr/worktrees/*` | [`routes/worktree.ts`](src/routes/worktree.ts) | exposure-dependent runtime auth |
| `*    /session/*` | `SessionRoutes` (mounted via `mountWorkspaceCore`) | implicit (host-level) |
| `*    /mcp/*` | MCP routes | implicit |
| `*    /lsp`, `*    /vcs`, `*    /global/event` | compatibility routes mounted by host | implicit |

The capability response is versioned with `api_version: 2`. It advertises
`process_observer: true` for the public, redacted owner-event API used by an
embedding desktop. Local CPU/RSS diagnostics are delivered by the desktop IPC
capability; the runtime HTTP surface remains the workspace execution boundary.

## Event contract

`workspace-runtime` has two event systems with different jobs:

| Surface | Transport | Event family | Contract |
| --- | --- | --- | --- |
| `GET /global/event` | SSE | OpenCode-compatible `CompatEnvelope` values | Primary client stream for session/message/permission/question lifecycle. For OpenCode compatibility mode this may proxy the upstream OpenCode `/global/event`; otherwise it fans out the host `RuntimeEventHub` global stream and emits `server.connected` plus heartbeat frames. |
| `GET /api/wr/runtime-events` | SSE | `RuntimeEventEnvelope` values wrapping raw `AgentRuntimeEvent` payloads | Primary runtime-event stream for host-mounted core clients that need adapter-native runtime events. This route is mounted by `mountWorkspaceCore()`. |
| `GET /api/wr/events` | SSE | `WorkspaceRuntimeEvent` values from `workspaceRuntimeBus` | Neutral runtime path for the compatibility/internal process-global stream. |
| `GET /event` | SSE | `WorkspaceRuntimeEvent` values from `workspaceRuntimeBus` | Compatibility/internal process-global stream for PTY lifecycle, PTY stream summaries, process status/config events, agent lifecycle, session lifecycle, and heartbeats. It is not the primary session/message event stream. |
| `GET /api/wr/pty/:ptyID/connect` | WebSocket | PTY bytes plus cursor metadata | Supported PTY data stream. PTY lifecycle summaries also appear on `/event`, but terminal bytes are delivered over this WebSocket. |
| `GET /api/wr/process/logs` | HTTP snapshot | Text log tail | Process output is poll/snapshot based through PTY log snapshots. There is no separate supported process-output event stream. Process status summaries appear on `/event`. |

`RuntimeEventHub` is the primary hub for session/runtime events. Session
routes publish OpenCode-compatible events to its global channel and bridge only
terminal lifecycle states into `workspaceRuntimeBus` as `agent.lifecycle`
compatibility events. That bridge maps `session.status` with busy status to
`Busy`, permission/question asks to `UserActionRequired`, `session.idle` to
`Idle`, and `session.error` to `Error`.

`workspaceRuntimeBus` is intentionally process-global runtime state. It is used
by PTY, process, and agent-hook code that already lives inside the
workspace-runtime process. Subscribers are isolated: a throwing or rejecting
subscriber is reported and cannot prevent later subscribers from receiving the
same event. The product-branded `claxedoBus` / `ClaxedoEvent` names remain as
deprecated aliases on the `/host` subpath.

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
auth adapter. The config token does not authorize PTY/process/file/session/VCS
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
is not a whole-server credential for PTY, process, file, session, or VCS routes.

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
| `WORKSPACE_RUNTIME_TRUSTED_DIRECT_TOKEN` | Direct host token accepted by the relay-host middleware without an RHT. This bypass is for trusted supervisor/control-plane calls only; treat it as whole-host authority and keep it off untrusted clients. |

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

`workspace-runtime` is a per-workspace host. Session, session-env, file, PTY,
process, OpenCode-compat, and diff/VCS routes are pinned to
`WORKSPACE_RUNTIME_DIRECTORY` or the `WorkspaceTarget` passed to
`createWorkspaceRuntimeApp()`. Callers may omit `directory` and use the pinned
workspace, pass that exact directory, or pass the synthetic
`workspace:<workspaceId>` target. A request for any other directory is
rejected.

Filesystem route `path` values and PTY/session-env `cwd` overrides are relative
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
   adapter is reconfigured, then back to `"ready"`.
5. **Relay/direct discovery** — supervisors and relays track runtime
   availability outside the OSS runtime package. `/api/wr/health` exposes only
   liveness and boundary metadata; richer diagnostics stay behind authenticated
   host-owned surfaces.
6. **Drain & exit** — on SIGTERM/SIGINT we close the listening socket,
   close the host tunnel (so the relay reroutes), dispose managed process
   state, remove remaining PTYs, then
   `host.dispose()` (with `WORKSPACE_RUNTIME_DRAIN_TIMEOUT_MS` wall-clock cap,
   default 10s). See `server.ts` for the exact phase sequence (P4).

Expected route, adapter, process, and relay failures are handled at their
own owner boundaries and mapped to route-specific responses or runtime
state. Process-level `unhandledRejection` and `uncaughtException` handlers
are last-resort fatal paths: they stop accepting new work, run the same
workspace drain used by SIGTERM/SIGINT, and exit non-zero so the supervisor
can restart the runtime. They are not suppress-and-continue handlers.

## Runtime store durability

`RuntimeStore` treats per-session JSONL journals as the source of truth and
SQLite as a derived projection. Journaled control/event mutations append the
JSONL row first, then apply the SQLite projection and checkpoint in one
transaction. If projection fails after the append, the current DB transaction
rolls back and a later runtime start rebuilds the projection from the journal.

Startup replay resets the SQLite projection and replays journals in sequence.
Replay-time recovery normalization, multi-row event projections, session
deletion, and multi-field session updates run inside SQLite transactions.
Adapters that create a `RuntimeStore` close it during adapter disposal; callers
that inject their own store remain responsible for closing it.

## `AgentHarnessAdapter` contract

Defined in `@claxedo/agent-sdk-runtime/adapters` and re-exported as a type from
the workspace-runtime root. The adapter is the single deep seam between the
host and a specific harness (OpenCode, ACP harnesses, native SDK harnesses, or
Pi).

```ts
export interface AgentHarnessAdapter {
  // Session lifecycle
  listSessions(directory: string): Promise<unknown[]>
  getSession(id: string, directory: string): Promise<unknown | null>
  createSession(directory: string, title?: string): Promise<{ id: string }>
  updateSession(id: string, updates: { title?: string; time?: { archived?: number } }, directory: string): Promise<unknown | null>
  getSessionConfig(id: string, directory: string): Promise<SessionConfig>
  updateSessionConfig(id: string, update: SessionConfigUpdate, directory: string): Promise<SessionConfig>
  deleteSession(id: string, directory: string): Promise<void>

  readHarnessCapabilities(directory: string): Promise<HarnessCapabilities> | HarnessCapabilities

  // Messaging
  sendMessage(id: string, input: PromptInput, directory: string): AsyncIterable<AgentRuntimeStreamEvent>
  getMessages(id: string, directory: string): Promise<unknown[]>
  abort(id: string, directory: string): Promise<AbortResult>
  revert(id: string, directory: string): Promise<void>
  unrevert(id: string, directory: string): Promise<void>
  forkSession(id: string, messageId: string, directory: string): Promise<{ id: string }>

  // Commands
  executeCommand(id: string, command: string, directory: string): Promise<void>
  listCommands(directory: string): Promise<unknown[]>

  // Agents / todos / permissions / questions
  listAgents(directory: string): Promise<unknown[]>
  getTodos(sessionId: string, directory: string): Promise<Array<{ content: string; status: string; priority: string }>>
  listPermissions(directory: string): Promise<unknown[]>
  respondPermission(permId: string, decision: PermissionDecision, directory: string): Promise<void>
  listQuestions(directory: string): Promise<unknown[]>
  replyQuestion(qId: string, answer: string, directory: string): Promise<void>
  rejectQuestion(qId: string, directory: string): Promise<void>

  // Config injection (called by /api/wr/config)
  applyConfig(config: Record<string, unknown>): Promise<void>

  // Runner config-options surface (no-op when unsupported)
  probeConfigOptions(directory: string): Promise<unknown[]>
  peekConfigOptions?(directory: string): Promise<unknown[] | null> | unknown[] | null

  dispose(): void
}
```

### Implementations

Adapter implementations live in `@claxedo/agent-sdk-runtime`, not in this
package. Workspace Runtime owns hosting, routing, target containment, config
apply, PTYs, processes, files, diffs, and relay attachment around those
adapters.

### Adapter selection

Strict type-based dispatch happens once, at host construction
([`workspace/runtime.ts`](src/workspace/runtime.ts)). After that, the rest
of the codebase calls into the `AgentHarnessAdapter` interface only — there are
no `if (runner.type === "claude-acp")` branches in the call paths.

The four model-fallback sites (`bootstrap.ts`, `opencode-compat.ts`)
are *model defaulting* decisions, not adapter-selection branches.

### Error semantics

- `sendMessage` yields a `CompatEvent` async iterable. Adapter-level
  errors surface as `{ type: "error", error }` events; transport
  faults raise as exceptions and are caught by the host route handler.
- `abort` returns a typed `AbortResult` (`cancelled` / `already_idle`
  / `not_found` / `recovering` / `failed`). Callers map this onto HTTP
  status codes.
- `dispose()` is fire-and-forget. The drain phase runs it inside
  `Promise.race` with a wall-clock timeout (default 10s) so a stuck
  dispose cannot strand SIGTERM-driven shutdown.

### Crash recovery

ACP runner crashes are caught by the ACP adapter in
`@claxedo/agent-sdk-runtime`, which calls `onDead()` and emits
`session.recover`. The session is marked
`"recovering"` and the workspace itself stays alive; only the affected
session is impacted. This is the same shape as opencode adapter
crash-handling.

## Plugging in auth

Relay-host auth can use the built-in JWT key path or a custom
[`TokenVerifier`](../workspace-relay-protocol/src/token-verifier.ts).
Use this to back the runtime's relay boundary with a custom IdP (Clerk,
OIDC, hosted control plane, or a self-managed key-table).

```ts
import { createStaticTokenVerifier, type RelayHostVerifierClaims } from "@claxedo/workspace-relay-protocol"
import { createRelayHostAuthMiddleware } from "@claxedo/workspace-runtime/relay"

// Verifier claims are still validated against the relay-host contract:
// `iss` must be "workspace-relay", `aud` must be "workspace-host-service",
// `sub`/`org_id`/`workspace_id`/`host_id`/`role`/`exp`/`iat`/`jti` are required,
// and `access`/`backing` must be a valid pair ("cloud"/"cloud-vm" or
// "user-hosted"/"local-worktree"). `workspace_id`/`host_id` must match the
// middleware's expected values.
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
        access: "cloud",
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
| `WORKSPACE_RUNTIME_CONFIG_TOKEN` | Trusted direct token for relay-host middleware and health discovery. Not standalone config mutation auth and not whole-server auth. |
| `WORKSPACE_RUNTIME_TRUSTED_DIRECT_TOKEN` | Whole-host direct token accepted by relay-host auth without an RHT. Use only for trusted supervisor/control-plane traffic. Also acts as the config token when `WORKSPACE_RUNTIME_CONFIG_TOKEN` is unset. |
| `WORKSPACE_RUNTIME_DIRECTORY`, `WORKSPACE_RUNTIME_WORKSPACE_ID`, `WORKSPACE_RUNTIME_HOST_ID` | Runtime target identity. |
| `WORKSPACE_RUNTIME_RUNNER`, `WORKSPACE_RUNTIME_ACP_BINARY` | Optional CLI launcher defaults for the initial harness. Runtime config apply can replace this after startup. |
| `WORKSPACE_RUNTIME_ENABLE_ACP_REMOTE_TRANSPORT` | Enables remote ACP transport URLs in runner config. Disabled by default. |
| `WORKSPACE_RUNTIME_OPENCODE_COMPAT` | Set to `0` by the host to disable the OpenCode compatibility adapter and routes. The executable translates this process-boundary setting into the `opencodeCompat` host option. |
| `WORKSPACE_RUNTIME_TERMINAL_SESSION_TTL_MS` | Retention window for terminal lifecycle session summaries. |
| `WORKSPACE_RUNTIME_DISABLE_PORTLESS` | Disables optional Portless named-url discovery for managed processes. |
| `WORKSPACE_RUNTIME_DATA_DIR`, `WORKSPACE_RUNTIME_STATE_DIR`, `WORKSPACE_RUNTIME_STORE_DIR`, `WORKSPACE_RUNTIME_PTY_HISTORY_DIR` | Neutral runtime-owned storage locations. Defaults are under `~/.workspace-runtime`. |
| `WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL`, `WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM`, `WORKSPACE_RUNTIME_MANAGEMENT_ISSUER`, `WORKSPACE_RUNTIME_MANAGEMENT_AUDIENCE` | Management-token verification inputs for `/api/wr/config`. |
| `WORKSPACE_RUNTIME_DRAIN_TIMEOUT_MS` | Drain wall-clock cap (default `10000`). |
| `WORKSPACE_RUNTIME_RELAY_JWKS_URL`, `WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM` | RHT verification inputs for relay-attached runtimes. |
| `WORKSPACE_RUNTIME_RELAY_*` | Host tunnel settings for relay-attached runtimes. See the relay-attached section above and `workspace-relay/README.md`. |
| `CLAXEDO_RELAY_RESOLVER_*` | Relay-process resolver settings. See `workspace-relay/README.md`. |

Claxedo deployments translate any product-specific environment outside this
package before launching the runtime. Runtime library APIs and examples use the
neutral `WORKSPACE_RUNTIME_*` names.

## Runtime-only example

The runnable example lives in the repo-root [`claxedo-cookbook`](../../claxedo-cookbook),
not inside this package. Recipe 05 boots a loopback Workspace Host
(`createWorkspaceRuntimeApp`) over a sandboxed temp directory and tours the
file, git/diff, managed-process, and event-stream route families over plain
`fetch` — no `claxedo-app`, `claxedo-server`, Clerk, Convex, agent CLI, or
control plane involved:

```sh
cd claxedo-cookbook
bun install
bun run recipe:05-workspace-host
```

See [`claxedo-cookbook/README.md`](../../claxedo-cookbook/README.md) for the
full recipe ladder and what each recipe needs.

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
