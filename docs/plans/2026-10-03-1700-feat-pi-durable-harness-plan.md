---
title: Pi on pi-durable (local + cloud SessionDO), Codex/Cursor sharing, OpenCode per-session instances, Boat driver
status: in-progress
date: 2026-10-03
branch: feat/pi-harness
base: dev edea4f03f3
---

# Plan: Pi on pi-durable (local + cloud SessionDO), Codex/Cursor sharing, OpenCode per-session instances, Boat driver

## Amendments (orchestrator, before execution)

- Base is dev `edea4f03f3` (includes the reviewed staging fixes, group 1). Line numbers below were read at `60fe7c6385`; re-check before editing.
- Process ownership: Pi's shell must not spawn unowned processes. Lane A implements Pi's `Shell` over `services.spawn` (an adapter to the published `ExecutionEnv` seam) unless `NodeExecutionEnv` accepts a spawn hook; open question 14 is decided as "owned, not accepted". The same applies to the CF `execution-env` route, which spawns through `createSpawnService(ownership)`.
- Lane E needs nothing from Lane 0 and runs in wave 0 alongside it.
- Reference-only material lives outside the repo (scratchpad): the rejected experiment snapshot and the research proofs. Port code from it only where this plan names the file.

## 0. Direct answer

The work splits into 8 lanes in 4 waves. No more than 3 lanes run at a time.

| Wave | Lanes | Notes |
|---|---|---|
| 0 | **Lane 0: foundations** | Serial, small. Adds contracts, dependencies, the D1 migration, and mechanical moves into session-core. Must merge before anything else, so that parallel lanes never touch `bun.lock` or move shared modules. |
| 1 | **A** local Pi; **B1** cloud control plane, relay and client routing; **CF** execution-env route, stdio MCP relay, Boat driver | Parallel |
| 2 | **B2** SessionDO; **D** Codex/Cursor sharing; **E** OpenCode instances | Parallel. B2 needs A, B1 and CF merged. |
| 3 | **G** | Integration docs, app e2e, live acceptance list |

Merge order: `0 → CF → B1 → A → E → D → B2 → G`. Within a wave, any order compiles, but this order keeps the largest diff (A) rebasing only once.

Production LOC, total estimate: about +3.5k added and about −2.3k removed (per-lane table in §9).

## 1. Facts in current code that force the design

- **Pi RPC is 1,418 production lines.** It lives in `packages/harness/src/transports/pi-rpc/` and `packages/harness/src/profiles/pi/` (130). It is composed at:
  - `packages/harness/src/compose.ts:9,19,37`;
  - `packages/harness/src/registry/table.ts:18` (`pi: "pi-rpc"`) and `:26` (`pi: false` MCP);
  - `TransportKind` in `packages/harness/src/contract/transport.ts:24`.
  
  Its options come from `packages/workspace-runtime/src/host/composition.ts:29-36`, which uses `requirePiExecutable` and `piRuntime` from `host/executables/pi.ts`. Every sandbox image installs `@earendil-works/pi-coding-agent`:
  - `packages/claxedo-server/scripts/sandbox/Dockerfile:39`;
  - `scripts/sandbox/cloudflare-worker/Dockerfile:14`;
  - `packages/sandbox-manager/src/drivers/vercel.ts:323`.
- **Harness package rules** (`packages/harness/AGENTS.md`): no comments; files ≤300 lines and functions ≤40; a per-transport budget in `budget.json`. Transports may import only the contract, translate, rpc, their own folder, their vendor packages (`@earendil-works/` is already a vendor prefix, `scripts/check.ts:23`), Node built-ins, helpers and agent-runtime-contract. `scripts/check.ts:24-31` lists vendors per transport. The new transport needs an entry there, and `pi-rpc` must be removed.
- **The session-core Durable Object host is already proven as a fixture.** It runs at `packages/session-core/src/test-support/durable-object-host.ts` and is exercised by `src/durable-object.node-test.ts` on Miniflare without `nodejs_compat`. `durableObjectSqliteDatabase` exists at `src/sqlite/durable-object.ts:16`. Its doc, `docs/durable-object.md`, names "a real harness transport (Pi in process)" as the missing piece.
- **Boot recovery** has two steps:
  - `RuntimeStore.recoverBusySessions()` (`packages/session-core/src/store.ts:1152`) marks busy sessions interrupted. It is called at `packages/workspace-runtime/src/workspace/durable-state.ts:50`.
  - `recoverQueuedPrompts` runs at `workspace/runtime.ts:531`.
  
  The continuation provider turn already exists: `ProviderTurnInput {reason:"continuation"}` (`harness/src/contract/broker.ts:78`, `session-core/src/broker-ports/provider-turns.ts:77-90`), used by Claude at `transports/claude-sdk/turns.ts:214`.
- **CP turn leases** are acquired only at the route layer (`session-core/src/routes/session-turn-lease.ts:58`). Renew and release authenticate with the lease JWT alone (`workspace-runtime/src/remote-session-authority.ts:96-101`), and the TTL is 60 s (`workspace-relay-protocol/src/index.ts:5`). `/connection-secrets` already verifies a turn lease (`claxedo-server/src/routes/runtime-connection-secrets.ts:65-73`). That is the model for a per-turn delivery.
- **The relay** has two backings, `RelayBacking = "cloud-vm" | "local-worktree"` (`workspace-relay/src/auth.ts:18`, `isRelayBacking :299`). Targets are resolved by `GET /internal/relay/target` (`claxedo-server/src/deployments/shared-routes/internal-relay.ts:106`) using `sandboxRelayTargetLookup` (`claxedo-server/src/authority/sandbox-relay-target.ts:17`). Forwarding uses `workspaceRelayForwardRequestInit` (`workspace-relay/src/server.ts:926`).
- **Session-scoped connections already exist** for shares:
  - CP `hostedSessionConnection` (`claxedo-server/src/connections/hosted-connection-info.ts:390`), which is viewer-only today;
  - the app's `createWorkspaceConnections.read(workspaceId, sessionId)` (`claxedo-app/src/server/transport.ts:89-101`).
  
  App session lists come from the control plane (`claxedo-app/src/server/session-list.ts:36-49`). The app's checkpoint pull is in `claxedo-app/src/server/session-projection.ts:15-31`.
- **The CP Worker** is built with `nodejs_compat` (`claxedo-server/scripts/deploy/hosted-worker-bundle.ts:21-22`) and its wrangler config comes from `renderWorkerWranglerConfig` (`scripts/deploy/wrangler-config.ts:41`). The relay is a separate Worker (`workspace-relay/wrangler.toml`).
- **D1** schema: the four `harness_id` CHECKs at `claxedo-server/migrations/control-plane/0001_baseline.sql:44,52,62,102` lack `'pi'`. `sessions` is at `:601`, and `sessions_scope_immutable` at `:1226`. The package README says a schema change is made as a numbered migration followed by `bun run d1:baseline:generate`, never by editing the baseline by hand.
- **Credentials**:
  - Local sessions spend egress-broker placeholders (`agent-runtime-contract/src/provider-projection.ts:15-36`), selected by `selectSessionCredentials` (`harness/src/registry/credentials.ts:31`).
  - Cloud uses `nativeProviderDeliveriesFromRepository` (`claxedo-server-core/src/credentials/native-delivery-plan.ts:136`), which today only supports `secretBrokering: "native"`.
  - No direct-delivery mode exists on dev.
- **Cloudflare `agents/harness/pi`**: `PiHarness extends LifecycleCapability`, not `Agent`. It is installed into a plain `DurableObject` with `Lifecycle.install(this).use(harness)` (`/tmp/claxedo-cloudflare-pi-df9c0ef/README.md` "Core pattern"; `harness.ts:208`). Its lifecycle imports `node:async_hooks` (`durable-object-lifecycle.ts:1`), so the DO Worker needs `nodejs_compat`. Its factory receives `{storage, context}` and returns `Harness.open(...)`. `onStart` wakes every session with live Pi tasks (`harness.ts:250-259`).
- **Box/Boat**: `packages/sandbox-manager/src/drivers/box.ts` does run the normal workspace-runtime image (`docker run` inside the VM, then the in-VM `host <port>` / `host url <port>` CLI, `targetAccess: "relay"`). It targets the old Box-by-ASCII API:
  - `https://ascii.dev/api/box/v1`, `/boxes`, a `{box}` envelope (`:73,134-177`);
  - credential verify at `claxedo-server-core/src/credentials/operations/sandbox-verify.ts:134` (`/me`).
  
  The current Boat v1 API is different. The experiment's client, verified against docs.boat.dev and re-checked today, uses `https://boat.dev/api/v1`, `/sandboxes`, `{ok, type, sandbox}`, an `Idempotency-Key` header, a create body of `{noEnv, ttlSeconds, from|template}`, and command results of `{success, stdout, stderr, exitCode, timedOut}`. The current docs document neither public port exposure nor Docker-in-VM. Conclusion: **dev's driver does not work with the current Boat API**. Its design is still right (it runs the standard image), and only the API client needs to change.

## 2. Target design

### 2.1 Local

`PiDurableTransport` is one transport class shared by both placements. It holds one pi-durable `Harness` per session, embedded in the daemon. A session works like this:
1. `Harness.open(openNodeSqliteStorage(<harnessStateRoot>/pi/sessions/<sessionId>.sqlite), opts)` opens it.
2. Pi's `CodingTools` run over `NodeExecutionEnv({ cwd, shellEnv: harnessSpawnEnv(process.env) })`.
3. Compaction and retry stay at their upstream defaults.
4. A Claxedo extension carries the `beforeTool` approval hook, a `question` tool, the skills section, and pi-mcp tools.
5. pi-ai `createModels` runs over a per-session credential slot fed by `ResolvedCredentials.direct`.
6. A long-lived `watchEvents` stream per session is translated to `AgentRuntimeEvent`s.

At daemon start, sessions that `recoverBusySessions` interrupted and whose transport declares `durableRuns` are attached again. Attach finds live Pi tasks and resumes them as a `continuation` provider turn.

### 2.2 Cloud

One `SessionDO` per top-level Pi session, in a new private Worker package `packages/session-host`:
- The DO hosts `PiHarness` over its SQLite, plus a session-core host whose `RuntimeStore` is also on DO SQLite. Session routes are composed by the shared `composeSessionRoutes`, with `remoteWorkspaceSessionAccessPolicy` posting to CP through a service binding.
- Clients reach it through the relay: RAT for host `session-do:<root>` → relay `durable-object` target → the DO verifies the RHT.
- At turn start the DO calls CP once, `/turn-delivery`, authenticated by the turn lease, to get direct credentials plus the plugin MCP and skills snapshot.
- On the first tool call it calls `/turn-execution` to get a session-scoped RAT for the workspace VM.
- Tools run on the VM through `/api/wr/execution-env` (wrapping `NodeExecutionEnv`). VM-materialized stdio MCP servers run through a WebSocket relay route.
- CP records placement in `sessions.session_host_root`: Pi on a cloud workspace goes to the DO, every other harness stays native.

The list row comes from register and pull. Transcripts are read from the DO. There is no checkpoint pull for DO sessions.

## 3. Lane map and file ownership

A file is owned by exactly one lane. A lane may only read files owned by others. There are two shared-file rules:
- **`packages/harness/budget.json`**: each lane edits only its own key's line.
- **`packages/harness/scripts/check.ts`**: only the transport-vendor map line of the lane's own transport.

At merge, keep both sides of those two files.

| Lane | Owns (create/change/delete) |
|---|---|
| 0 | `package.json`/`bun.lock` of `harness`, `workspace-runtime`, `session-core`; `agent-runtime-contract/src/provider-projection.ts`; `harness/src/registry/credentials.ts`; `harness/src/contract/projection.ts`; `workspace-relay/src/auth.ts` (backing only); `workspace-relay-protocol/src/index.ts`; `session-core/src/{routes/session-route-composition.ts (new), relay-host-auth.ts (moved), remote-session-authority.ts (moved), index.ts, package.json exports}`; every importer of the moved modules in `workspace-runtime` and `claxedo-server` tests; `workspace-runtime/src/workspace/session-routes.ts` (deleted); `claxedo-server/migrations/control-plane/*` |
| A | `harness/src/transports/pi-durable/**` (new), `harness/src/transports/pi-rpc/**` (delete), `harness/src/profiles/pi/**` (delete), `harness/src/{compose.ts, registry/table.ts, contract/transport.ts, contract/capabilities.ts, contract/mcp-support.ts}`, `harness/src/translate/corpus/pi-rpc/**` (delete) and `corpus/pi-durable/**` (new), `harness/src/conformance/{pi.test.ts,pi-mcp.test.ts,native-process.test.ts,translate/corpus.test.ts,test-support/presentation/tool-names.ts}`, `harness/e2e/{flows/H18-pi-owner.flow.ts,flows/H20-pi-session-owner.flow.ts,flows/H13.pi-usage.flow.ts,flows/version-matrix.ts,harness/pinned-pi.ts,harness/pi-rpc-fault.ts,harness/stack.ts,harness/daemon.ts,harness/pinned-agent-env.ts,corpus/H18-pi-owner.json}`, `harness/{AGENTS.md,README.md}`, `agent-runtime-contract/src/harness-permission-modes.ts`, `session-core/src/{store.ts (recoverBusySessions only), host/runtime.ts, host/contracts.ts}`, `workspace-runtime/src/{host/composition.ts, host/executables/pi.ts (delete), workspace/durable-state.ts, workspace/runtime.ts (resume call only), test-support/home/fake-pi-rpc.*, test-support/pinned-pi.mjs, pi-native.node-test.ts, package.json test script}`, `process-ownership/src/spawn-env.ts`, `claxedo-local-server/src/credentials/broker.ts`, `claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts` (direct rows only), `claxedo-server-core/src/agent-plugins/runtime/harness-registry.ts`, sandbox images (`claxedo-server/scripts/sandbox/Dockerfile`, `cloudflare-worker/Dockerfile`, `sandbox-manager/src/drivers/vercel.ts`), `docs/pi-native-user-guide.md` (local part) |
| B1 | `claxedo-server/src/{connections/hosted-connection-info.ts, routes/hosted/workspace.ts, authority/sandbox-relay-target.ts, deployments/shared-routes/internal-relay.ts, routes/runtime-session-authority.ts, routes/session-host-delivery.ts (new), authority/hosted-session-pull.ts, routes/hosted/control.ts, authority/adapters/d1/session-authority.ts, authority/adapters/d1/session-read-store.ts}`, `claxedo-server-core/src/{credentials/native-delivery-plan.ts, session/session-placement.ts (new)}`, `workspace-relay/src/{server.ts, cloudflare.ts, worker.ts, host-tunnel-forwarding.ts}`, `workspace-relay/wrangler.toml`, `claxedo-app/src/server/{transport.ts, relay.ts, wire/connection.ts, sessions.ts, session-reservation.ts, session-list.ts, wire/session-row.ts, session-projection.ts, transcript-reads.ts}` |
| CF | `workspace-runtime/src/routes/{execution-env.ts, mcp-stdio-relay.ts}` (new), `workspace-runtime/src/server.ts` (mount only), `sandbox-manager/src/drivers/{box.ts→boat.ts, box.test.ts→boat.test.ts}`, `sandbox-manager/{package.json exports, README.md, src/driver-catalog.ts}`, `sandbox-contract/src/index.ts`, `claxedo-server-core/src/credentials/operations/sandbox-verify.ts`, every `"box"` driver-id test listed by `rg -l '"box"'` |
| B2 | `packages/session-host/**` (new), `session-core/src/routes/session-turn-lease.ts` (adopt helper), `session-core/docs/durable-object.md`, `claxedo-server/scripts/deploy/wrangler-config.ts` + deploy script, `harness/e2e/flows/H19.pi-cloud-turn.flow.ts`, `H19.hostedpi-cloud-turn.flow.ts`, `harness/e2e/harness/{hosted-cloud.ts, BOOT_TARGETS.md}` |
| D | `harness/src/transports/codex-app-server/**`, `harness/src/transports/cursor-sdk/**`, `harness/src/profiles/codex/index.ts`, `harness/src/conformance/codex*.test.ts`, `harness/src/conformance/cursor.test.ts`, `workspace-runtime/src/{harness-services.ts, host/shared-harness-hosts.ts (new), host/executables/codex.ts, host/executables/codex.test.ts, workspace/host-options.ts}`, `workspace-runtime/src/host/composition.ts` (codex/cursor entries only, after A merged), `workspace-runtime/src/server.ts` (host options only, after CF merged), `claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts` (shared hosts only, after A merged) |
| E | `harness/src/transports/opencode-sdk/**`, `harness/src/profiles/opencode/**`, `harness/src/conformance/opencode*.test.ts` |
| G | `docs/harness/README.md`, `docs/README.md`, `docs/plans/README.md`, `docs/pi-native-user-guide.md` (cloud section), `claxedo-app/e2e/**` |

## 4. Cross-lane contracts (fixed up front)

### 4.1 Credentials (Lane 0)

`agent-runtime-contract/src/provider-projection.ts`:
```ts
export type ProviderDirect = {
  delivery: "direct"
  baseUrl: string            // vendor origin or a custom provider's base URL
  apiPath?: string
  secret: string             // API key or OAuth access token
  authKind: "api-key" | "subscription"
  expiresAt?: number
  account?: BindingAccount
}
export function isProviderDirect(row: object): row is ProviderDirect
export function providerDirect(input: unknown): ProviderDirect | undefined   // strict parser, rejects CR/LF in secret
export type CredentialSnapshot<T = ProviderProjectionSource> = {
  machineOwnerUserId: string
  accounts: Record<string, Record<string, T>>
  direct?: Record<string, Record<string, ProviderDirect>>   // by user id, then provider id
}
```
`credentialSnapshot()` parses `direct`.

`harness/src/contract/projection.ts`: `ResolvedCredentials` gains `direct?: Readonly<Record<string, ProviderDirect>>`.

`harness/src/registry/credentials.ts`: `selectSessionCredentials` copies `snapshot.direct?.[userId]`. A direct row for any `providerIds` entry counts as selected, so an owner with only direct rows is not refused.

Direct rows are consumed only by Pi (A, B2) and Codex (D). Claude, Cursor and OpenCode ignore them.

### 4.2 Relay and host identity (Lane 0)

`workspace-relay-protocol/src/index.ts`:
```ts
export const SESSION_HOST_PREFIX = "session-do:"
export function sessionHostId(rootSessionId: string): string
export function sessionHostRootOf(hostId: string): string | undefined
```
`workspace-relay/src/auth.ts`: `RelayBacking = "cloud-vm" | "local-worktree" | "durable-object"`, and `isRelayBacking` accepts it. RHT minting is unchanged. B1 owns everything else.

### 4.3 Session routes and relay-host auth moved to session-core (Lane 0)

Mechanical moves with no behavior change:
- `workspace-runtime/src/workspace-host-service-auth.ts` → `session-core/src/relay-host-auth.ts`, exported as `@claxedo/session-core/relay-host` (adds the `jose` dependency to session-core).
- `workspace-runtime/src/remote-session-authority.ts` → `session-core/src/remote-session-authority.ts` (same subpath).
- `mountSessionRoutes` (`workspace-runtime/src/workspace/session-routes.ts:34-69`) → `session-core/src/routes/session-route-composition.ts`:

```ts
export type SessionRouteCompositionInput = {
  core: SessionCore
  runtime: () => Promise<AgentRuntime>
  recovery: () => AgentRuntimeRecovery | undefined
  store: () => RuntimeStore
  sessionStarts: AgentSessionStarts
  sessionAccessPolicy: SessionAccessPolicy
  currentRunner: () => SessionHarness
  deriveChildSessionId: (identity: ChildSessionIdentity) => Promise<string> | string
  subagentAdmission: (parentSessionId: string, observation: SubagentObservation) => Promise<SubagentUpdatedEvent>
  backgroundWork: (sessionId: string) => BackgroundWork | undefined
  machine?: {                       // workspace-runtime only
    checkpoint: WorkspaceCheckpoint-like port { createActiveTurnScope, turnsOf, cancelActiveTurn }
    readAttachment, flushSessionDocuments, disposeSessionDocuments,
    sessionToolPrompt(sessionId): string | undefined
    afterCreateSession?
  }
}
export function composeSessionRoutes(input: SessionRouteCompositionInput): ReturnType<SessionCore["sessionRoutes"]>
```
Every importer is updated in place, with no re-export left in `workspace-runtime/src/index.ts`. `script/session-core-node-free.test.ts` must stay green: `jose` is node-free, and `relay-host-auth.ts` uses only hono and jose.

### 4.4 D1 (Lane 0)

Migration `claxedo-server/migrations/control-plane/0002_pi_session_host.sql`, folded with `bun run --cwd packages/claxedo-server d1:baseline:generate`:
- Add `'pi'` to the four `agent_plugin_*` `harness_id` CHECKs (table rebuilds).
- `ALTER TABLE sessions ADD COLUMN session_host_root text` (nullable).
- Recreate `sessions_scope_immutable` so it also fires on `session_host_root` (`new.session_host_root IS NOT old.session_host_root`).

### 4.5 Turn delivery wire (Lane 0 types; B1 producer, B2 consumer)

In `agent-runtime-contract/src/session-host-delivery.ts` (new, owned by Lane 0):
```ts
export type TurnDeliveryRequest = { turnLease: string }
export type TurnDelivery = {
  expiresAt: number                                   // min(lease, credential expiries)
  auth: CredentialSnapshot<ProviderProjectionSource>  // only direct rows for the session owner, accounts: {}
  plugins: RuntimeConfigSnapshotPlugins               // the section composeRuntimeConfigSnapshot already emits for harness "pi"
  providerDefinitions: readonly CustomProviderDefinition[]
}
export type TurnExecutionAccess = {
  relayUrl: string; workspaceId: string; hostId: string; routingId?: string
  runtimeAccessToken: string; expiresAt: number; directory: string
}
export function parseTurnDelivery(input: unknown): TurnDelivery | undefined
export function parseTurnExecutionAccess(input: unknown): TurnExecutionAccess | undefined
```
Use the existing exported plugin-section type from `agent-runtime-contract` (the same one `workspace-runtime/src/routes/config.ts:171` parses). If it lives only in server-core, Lane 0 moves the type, not the composer.

HTTP routes (B1), mounted in the `RuntimeSessionAuthority` app beside `/connection-secrets` and reached by the DO through `env.CONTROL_PLANE.fetch`:
- `POST /api/runtime-authority/turn-delivery` → `200 TurnDelivery`. Errors: `401 session_turn_lease_invalid`, `403 turn_delivery_denied` (session not DO-placed or actor lost access), `409 account_unavailable`.
- `POST /api/runtime-authority/turn-execution` → `200 TurnExecutionAccess`. Errors: `409 cloud_runtime_unavailable` with `retryAfterMs`, plus the same 401/403.

### 4.6 Execution-env and stdio MCP relay routes (CF producer, B2 consumer)

All requests pass the relay with an RHT for `backing: "cloud-vm"`. The route requires a `session_id` claim and role `editor` or higher. No CP call is made per request.

- `POST /api/wr/execution-env/fs`, body `{ op: FsOp; args: unknown[] }`, where `FsOp` is every `FileSystem` method of `@earendil-works/pi-durable/env` except `openTextLineReader` and `cleanup`. Binary payloads are `{ base64 }`.
  - Response: `{ ok: true, value } | { ok: false, error: { code: FileErrorCode, message, path? } }`, always status 200 for domain errors.
- `POST /api/wr/execution-env/exec`, body `{ command, cwd?, env?, timeout?, spill? }`, answers `text/event-stream`:
  - `event: output` `data: {"text": "..."}` repeated;
  - then `event: result` `data: {"ok":true,"value":{"exitCode":0,"spillPath"?:...}}` or `{"ok":false,"error":{"code":ExecutionErrorCode,"message"}}`.
  - Client disconnect aborts the chord context, and `NodeExecutionEnv` kills the child.
- `GET /api/wr/execution-env/mcp/:serverName` (WebSocket upgrade). Each frame is one JSON-RPC message, bridged to the stdin and stdout of the stdio server named `serverName` in the runtime's current Pi projection (`origin: "plugin"`, `kind: "stdio"`). An unknown name answers 404. The DO never sends a command string.

### 4.7 Pi placement port (A defines, B2 implements)

In `harness/src/transports/pi-durable/placement.ts`, which must stay node-free:
```ts
export type PiSessionRuntime = {
  readonly harness: Harness
  readonly conversation: Conversation
  readonly registry: Registry               // live; the transport installs/replaces its extensions
  submit(input: UserInput, options: { requestId: string; whenBusy: "steer" | "followUp" }): Promise<void>
  close(): Promise<void>
}
export type PiTurnContext = {
  credentials: ResolvedCredentials
  projection: PluginProjection
  providerDefinitions: readonly CustomProviderDefinition[]
}
export interface PiPlacement {
  open(input: { sessionId: string; directory: string; models: Models }): Promise<PiSessionRuntime>
  env(input: { sessionId: string; directory: string }): HarnessOptions["env"]
  mcpTransport(server: ProjectedMcpServer, sessionId: string): Promise<McpTransport>   // pi-mcp Transport
  prepareTurn?(sessionId: string, signal: AbortSignal): Promise<PiTurnContext>          // cloud only
  refreshCredential?(providerId: string, sessionId: string): Promise<ProviderDirect | undefined>
}
export function piHarnessOptions(input: { models: Models; registry: Registry; env: HarnessOptions["env"]; onReport(error: unknown): void }): HarnessOptions
export class PiDurableTransport implements HarnessTransport { constructor(services: HarnessServices, placement: PiPlacement) }
```
Package export (A): `@claxedo/harness/pi-durable` → `src/transports/pi-durable/index.ts`, which is node-free (used by B2). Node parts live in `src/transports/pi-durable/node.ts` (`createNodePiPlacement({ stateRoot, env, services })`) and are reached only through `compose.ts`.

### 4.8 Durable runs at boot (A)

- `harness/src/contract/capabilities.ts`: `TransportCapabilities.durableRuns?: true`.
- `RuntimeStore.recoverBusySessions(): readonly string[]` returns the ids it interrupted.
- `AgentRuntime.resumeDurableRuns(sessionIds: readonly string[]): Promise<void>`: for each id whose attached transport declares `durableRuns`, call `attachments.for(id)`. Failures go to `recovery.reportOwnerFailure`.
- Hosts call it before `recoverQueuedPrompts`. The workspace runtime is changed by A; SessionDO by B2.

### 4.9 Placement and connection (B1, consumed by app and B2)

- `claxedo-server-core/src/session/session-placement.ts`: `sessionPlacement(input: { backing: "cloud-vm" | "local-worktree"; harnessId: string }): "durable-object" | "runtime"`. It answers `durable-object` exactly for `cloud-vm` with `pi`.
- `POST /api/workspace/:id/connection`, body `{ session: { sessionId, harness: SessionHarness } }`. When placement is `durable-object`, it mints a RAT for host `sessionHostId(sessionId)` with role editor, `sessionId` claim and no `routingId`, and answers `{ connection: { backing: "durable-object", hostId, sessionId, relayUrl, runtimeAccessToken, tokenExpiresAt, role } }`. Otherwise it answers the existing workspace connection. This requires workspace write and does not need the session to exist.
- `GET /api/workspace/:id/connection?sessionId=` (`hostedSessionConnection`): if the row has `session_host_root`, it answers the DO target, with role editor when `authorizeSessionWrite` allows and viewer otherwise.
- Session list items carry `sessionHostRoot?: string`.

## 5. Lanes

### Lane 0: foundations (wave 0, serial)

**Goal:** contracts, dependencies, the D1 migration and module moves land on green, so wave-1 lanes never edit the same files or `bun.lock`. No user-visible behavior changes.

**Changes:**
1. Dependencies, all exact pins:
   - `harness`: `@earendil-works/pi-durable@1.0.0`, `@earendil-works/pi-ai@1.0.0`, `@earendil-works/pi-mcp@1.0.0`, `@earendil-works/chord@1.0.0`;
   - `workspace-runtime`: `@earendil-works/pi-durable@1.0.0`, `@earendil-works/chord@1.0.0`;
   - `session-core`: `jose` (same version as workspace-runtime);
   - then `bun install` and commit `bun.lock`.
   
   Check that `bun install` does not trip `minimumReleaseAge`-style settings (`bunfig.toml`). B2 adds `agents@0.26.0` itself in wave 2, as the only wave-2 dependency change.
2. §4.1 types, parser, selection, and `providerProjection` tests.
3. §4.2 constants and backing.
4. §4.3 moves, updating every importer:
   - `rg -l "workspace-host-service-auth|remote-session-authority|session-routes"` across `packages/workspace-runtime/src` and `packages/claxedo-server/src`;
   - about 25 files, mostly tests;
   - `workspace-runtime/src/workspace/runtime.ts:512` calls `composeSessionRoutes`;
   - the `session-core/src/test-support/durable-object-host.ts` fixture switches to `composeSessionRoutes` without `machine`.
5. §4.4 migration and regenerated baseline.
6. §4.5 wire types and parsers.

**Deletes:** `workspace-runtime/src/workspace/session-routes.ts` and the two moved files at their old paths.

**Tests:**
- `agent-runtime-contract` provider-projection parser cases: a direct row round-trips, CR/LF in secret is refused, unknown keys are refused.
- `harness/src/registry/credentials` direct-only owner selection.
- session-core `durable-object.node-test.ts` still passes on the moved composition.
- Moved auth tests move with their modules: `workspace-host-service-auth.test.ts` and `remote-session-authority.test.ts` go to `session-core/src/`.
- `claxedo-server` `d1:baseline:check`.

**Done when:**
- `bun run typecheck`, `bun run lint`;
- `bun run --cwd packages/session-core test`, `bun run --cwd packages/workspace-runtime test`, `bun run --cwd packages/harness test`, `bun run --cwd packages/claxedo-server test`;
- `bun run --cwd packages/claxedo-server d1:baseline:check`;
- `bun run test:architecture-ratchets`;
- `bun run --cwd packages/claxedo-server verify:closure`, `bun run --cwd packages/claxedo-local-server verify:closure`, `bun run --cwd packages/claxedo-desktop verify:closure`. The moves change closures; raise nothing, because only paths moved.

**LOC:** about +140 added, about −10 removed (moves are net zero).

### Lane A: local Pi transport on pi-durable, Pi RPC deletion (wave 1)

**Goal and user-visible behavior:**
- Choosing Pi on Local needs no installed `pi` CLI.
- Turns run in the daemon process and stream text, thinking and tool cards.
- Pi's own read, write, edit and bash run in the workspace.
- Compaction and retry appear as `session-compaction` and `session-retry`.
- Stop aborts the turn.
- A permission mode `ask` prompts before write, edit, bash and MCP tool calls; `full` never asks and is the default.
- The model can ask the user questions.
- The session title is generated.
- The model picker lists pi-ai models for providers the owner connected.
- Plugin skills and MCP servers and Claxedo's first-party MCP work per session.
- Killing the daemon mid-turn and restarting resumes the run as a continuation turn.
- Credential renewal does not restart anything.

**Create** in `harness/src/transports/pi-durable/` (≤300 lines per file, no comments):
- `index.ts`: `PiDurableTransport` (kind `"pi-durable"`). Implements:
  - `start`, `attach`: open and bind; attach resumes live tasks;
  - `send`: `prepareTurn?` → configure turn model and effort through `conversation.configure` → `submit({requestId: turn.turnId, whenBusy: "followUp"})` → drain events until the submission settles;
  - `cancel`: `conversation.abort` raced with the deadline;
  - `configure`: credentials update the slot in place; projection reinstalls extensions; both answer `applied`;
  - `close`, `dispose`, `steer.steer` (`whenBusy: "steer"`, `requestId: userMessageId`), `config`, `naming.generateTitle`, `health`.
  - Capabilities: `requests {permissions: true, questions: true, elicitation: false}`, `subagents: false`, `history: "store"`, `durableRuns: true`, `instructionChannel: "prompt-prefix"`. Keep the `flattenTurnPrompt` system prefix, as pi-rpc did (`pi-rpc/index.ts:37-45`).
- `placement.ts`: §4.7 port, plus `piHarnessOptions`.
- `node.ts`: `createNodePiPlacement`:
  - storage file under `<stateRoot>/sessions/<sessionId>.sqlite`;
  - `harness.resume()` after open;
  - `NodeExecutionEnv` with `harnessSpawnEnv(env)` from `process-ownership/src/spawn-env.ts:64`;
  - pi-mcp `StdioTransport({inheritEnv: false})` and `StreamableHttpTransport`.
- `stream.ts`: one `watchEvents(harness, conversation.id)` per session, routed to the current owner (none, the Claxedo turn, or a continuation provider turn). Same ownership model as `pi-rpc/session-stream.ts`, minus RPC.
- `translate/` (adapter, messages, tools, usage): `AgentEvent` → `AgentRuntimeEvent`:

  | Pi event | Claxedo event |
  |---|---|
  | `message_update` text/thinking deltas | `text-delta` / `thinking-delta` |
  | `tool_execution_start/update/end` | `tool-start` + `tool-input` / `tool-output` / `tool-status`, `tool-error` |
  | `usage_changed` | `usage` (reasoning split) |
  | `auto_retry_start` | `session-retry` |
  | `compaction_start/end` | `session-compaction` |
  | `task_failed` and an unanswered submission | the harness's own `error` |
  | settle | `finish` |
  | anything else | one bounded `unrecognized` diagnostic |

  The stream passes through `withTurnAccount`, using `selectedTurnAccount("pi", …, piCredentialProviderIDs(provider))`.
- `extension.ts`: the Claxedo Pi extension `defineExtension({ name: "claxedo", tools: [question], hooks: [hook(ToolTask, { beforeTool })], sections: [skills] })`.
- `approvals.ts`: `beforeTool` maps a tool call to `TurnRequest {kind: "permission", requestId: "pi-tool:" + toolCallId, permission, options, grantKey}`. It asks the current turn broker, or the session broker during a continuation:
  - allow → `undefined`;
  - reject, cancelled or expired → `{ block: "<reason>" }`.
  
  Grants are keyed by tool name. The deterministic request id lets a re-ask after a crash replay the saved answer (`packages/harness/README.md` "Reply-only rows").
- `question.ts`: tool `question` (replay unsafe) → `broker.ask({kind: "question"})` → answers as text content.
- `credentials.ts`: per-session `createModels({ credentials: slotStore, authContext: { env: async () => undefined, fileExists: async () => false } })`. Provider overrides set `auth.oauth = { refresh, toAuth: c => ({ apiKey: c.access }) }`, where `refresh` uses the latest delivered row or `placement.refreshCredential`, and otherwise throws `TransportError("pi","configuration","credential_expired")`. Custom `providerDefinitions` are registered with their `baseUrl`. A provider with no direct row is `unavailable: direct_credential_required`. Pi never reads `~/.pi`.
- `mcp.ts`: `sessionMcpServers(input, services, {includeFirstParty: input.locality === "local"})` (`contract/mcp.ts:5`) → one pi-mcp `McpClient` per server, connected lazily. `listTools` → `defineTool` with raw JSON Schema; names are `mcp__<server>__<tool>`, sanitized `[A-Za-z0-9_]` ≤64 with a hash suffix. `tools/list` is cached by `projection.generation`.
- `skills.ts`: a section rendering `<available_skills>` (name, description, `SKILL.md` location) from `projection.pluginRoots`, read through the section's `input.env`. This works unchanged in the DO.
- `config.ts`: model catalog from pi-ai's registry for providers with direct rows or definitions; efforts from the model's thinking levels; `permissionModes` and `setPermissionMode` using `PI_PERMISSION_MODES`; `setModelSettings` through `conversation.configure`.
- `title.ts`: one `completeSimple` call under the session's `Models` and model.
- `errors.ts`, `README.md`: what it carries, the event map, the crash semantics (tool intent before execute; unsafe tools get an `interrupted` result), resume, and approvals.

**Change:**
- `harness/src/compose.ts:9,19,37`: `pi: () => PiNodeOptions`, building `new PiDurableTransport(services, createNodePiPlacement(...))`.
- `registry/table.ts:18,26`: `pi: "pi-durable"`, MCP `true`.
- `contract/transport.ts:24`: `"pi-rpc"` → `"pi-durable"`.
- `contract/mcp-support.ts:7`: the Pi rule (stdio and streamable HTTP; keep the name rule).
- `contract/capabilities.ts`: `durableRuns`.
- `harness/package.json` exports `./pi-durable`.
- `budget.json`: delete `transports/pi-rpc`, add `transports/pi-durable` with the measured production lines, reviewed (estimate 1,150).
- `scripts/check.ts:29`: vendors for `pi-durable` are `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/pi-mcp`, `@earendil-works/chord`.
- `harness/AGENTS.md` credentials paragraph: drop the "owner's own Pi profile" sentence.
- `agent-runtime-contract/src/harness-permission-modes.ts`: `PI_PERMISSION_MODES = { modes: [ask, full], defaultModeId: "full", appliesFrom: "next-turn" }`.
- `session-core/src/store.ts:1152`: return the interrupted ids.
- `host/runtime.ts`, `host/contracts.ts`: `resumeDurableRuns`.
- `workspace-runtime/src/workspace/durable-state.ts:50`: keep the ids.
- `workspace/runtime.ts:531`: call `resumeDurableRuns` before `recoverQueuedPrompts`.
- `host/composition.ts:29-36`: `pi: () => ({ stateRoot: path.join(harnessStateRoot, "pi"), env })`.
- `process-ownership/src/spawn-env.ts:49`: drop `CLAXEDO_PI_MCP_HANDOFF`.
- `claxedo-local-server/src/credentials/broker.ts` and `deployments/local/embedded-workspace-runtime.ts`: emit `CredentialSnapshot.direct` for the machine owner's selected Pi and Codex rows. OAuth access tokens come from the local authority's own refresh, with `expiresAt` so the existing renewal re-push (`embedded-workspace-runtime.ts:439,666-690`) refreshes them.
- `claxedo-server-core/src/agent-plugins/runtime/harness-registry.ts:66`: add `pi: { label: "Pi", projection: "standard-root", skillNamespace: "plugin", delivery: NATIVE_DELIVERY }`.
- Images: remove `@earendil-works/pi-coding-agent` from both Dockerfiles and `vercel.ts:91,323`.
- `docs/pi-native-user-guide.md`: rewrite the local part (no CLI, no extensions, credentials, approvals, resume).

**Delete:**
- `harness/src/transports/pi-rpc/**` (all files, including `test-support/scripted-pi.ts`), `harness/src/profiles/pi/**`, `harness/src/translate/corpus/pi-rpc/**`;
- `harness/e2e/harness/pi-rpc-fault.ts`, `pinned-pi.ts`, and the Pi entries in `version-matrix.ts`, `pinned-agent-env.ts`, `stack.ts`, `daemon.ts`;
- `workspace-runtime/src/host/executables/pi.ts`, `test-support/home/fake-pi-rpc.{mjs,d.mts}`, `test-support/pinned-pi.mjs`, and the `--import ./src/test-support/pinned-pi.mjs` in `workspace-runtime/package.json:130`;
- Pi RPC references in `session-core/src/host/{recovery,turn-admission,turn-terminal}.test.ts`, `workspace-runtime/src/{harness-compose,server}.test.ts`, `routes/session-open-view.test.ts`, `workspace/runtime-{connection-provider,lifecycle}.test.ts`, `claxedo-local-server/.../embedded-workspace-runtime.test.ts`, and `claxedo-server/src/hosts/workspace-runtime/session-env-document-roundtrip.integration.test.ts`. Rewrite each to pi-durable or a scripted transport.

**Tests** (real pi-durable plus real SQLite, scripted model server from `harness/src/test-support`):
- `conformance/pi.test.ts`, rewritten:
  - turn with text, tool (real file write through `NodeExecutionEnv`), usage and title;
  - steer incorporated;
  - stop mid-tool kills the child;
  - compaction triggered by a small context window;
  - retry on a scripted 529;
  - `ask` mode permission asked and denied → blocked result;
  - question answered;
  - two sessions in one process see only their own credentials and MCP tools (port the `$SCRATCH/pi-research2/proof/isolation.mjs` assertions).
- `conformance/pi-mcp.test.ts`: real stdio MCP fixture with `inheritEnv: false` (assert no daemon env leaks), HTTP MCP, first-party MCP local only.
- **Crash resume**: a node child process holds a Harness mid-tool, gets SIGKILLed, the store reopens, `resumeDurableRuns` resumes, and the continuation turn finishes (port `$SCRATCH/pi-research/proof/proof2-crash-resume.mjs`).
- Translator corpus `corpus/pi-durable/*.json`, recorded from real runs, plus `corpus.test.ts`.
- Flows `H18-pi-owner`, `H20-pi-session-owner`, `H13.pi-usage` rewritten. `workspace-runtime/src/pi-native.node-test.ts` rewritten: HTTP routes keep the session across restart, and only the direct secret reaches the scripted provider.

**Done when:**
- `bun run --cwd packages/harness check`, `typecheck`, `test`;
- `bun run --cwd packages/harness flows H18 H20 H13`;
- `bun run --cwd packages/harness corpus all compare`;
- session-core, workspace-runtime, process-ownership, claxedo-local-server and claxedo-server-core typecheck and test;
- `bun run test:architecture-ratchets`;
- `verify:closure` for claxedo-local-server, claxedo-desktop and claxedo-server: the closure adds pi-durable, pi-ai, pi-mcp and chord and removes pi-rpc. Raise only the exact measured ceiling, with a comment naming `transports/pi-durable`.
- `rg -n "pi-rpc|PiRpc|selectPiProfile|PI_EXECUTABLE|pi-coding-agent|CLAXEDO_PI_MCP_HANDOFF" packages docs` returns only historical docs outside `packages`, or nothing.

**Depends on:** Lane 0.

**LOC:** about +1,300 added (transport about 1,150; session-core about 30; local-server about 50; contract about 15; other about 55); about −1,750 removed (pi-rpc 1,418; profile 130; executables about 90; images and spawn-env about 20; fake-pi helpers are not production).

### Lane B1: cloud control plane, relay `durable-object` target, client routing (wave 1)

**Goal:** CP and relay can place, authorize and route a Pi session to a DO, and the app talks to it. No DO exists yet: tests use a stub DO class. Not user-visible until B2.

**Changes:**
- `claxedo-server-core/src/session/session-placement.ts` (new): §4.9.
- `claxedo-server-core/src/credentials/native-delivery-plan.ts:136-189`: `nativeProviderDeliveriesFromRepository({..., delivery: "direct"})` emits `ProviderDirect` from the same destination lookup. Same account-holder and duplicate-host rules; `authKind` comes from credential kind.
- `claxedo-server/src/connections/hosted-connection-info.ts:390` plus a new `hostedSessionHostConnection` (§4.9), wired in `routes/hosted/workspace.ts`. The RAT is recorded with `recordRuntimeAccessToken`, exactly like `:425-434`.
- `authority/sandbox-relay-target.ts:96-108`: for `sessionHostRootOf(hostId)`, answer `{found: true, baseUrl: "", backing: "durable-object"}` when the workspace is a cloud workspace and the `sessions` row is absent or has `session_host_root === root`; otherwise not found. No `routingId`.
- `deployments/shared-routes/internal-relay.ts:140-145`: passes the backing through, unchanged otherwise.
- `routes/runtime-session-authority.ts`:
  - `register`/`start` from a proof whose `hostId` is a session host requires `sessionId === root` and passes `sessionHostRoot` to `registerRuntimeSession` (`authority/adapters/d1/session-authority.ts:310`);
  - `reserve` and `adopt` from a session host are refused;
  - recommended (Q4): `acquireSessionTurn :556` sets `sessions.status='busy'`, and `releaseSessionTurn` sets `'idle'`, in the same statements.
- `routes/session-host-delivery.ts` (new), §4.5. It is modelled on `runtime-connection-secrets.ts:34-129` (`turnLeaseVerifier`, `proofDenial`):
  - **delivery**: session row with `session_host_root`; owner = session owner; `nativeProviderDeliveriesFromRepository(..., delivery: "direct")` filtered by `PI_LAUNCH_PROVIDERS.flatMap(piCredentialProviderIDs)`; the plugin section from `createHostedMcpRuntimePreparer` (`claxedo-server/src/agent-plugins/mcp/runtime-preparation.ts`) plus `composeRuntimeConfigSnapshot` (`claxedo-server-core/src/agent-config/runtime-snapshot.ts`) for harness `pi`; provider definitions.
  - **execution**: `resolveWorkspaceRuntimeTarget` (`authority/runtime-target.ts:14`), then mint a RAT (turn actor, role editor, `sessionId = root`, TTL ≤ 10 min and ≤ lease expiry plus 10 min), then record it.
- `authority/hosted-session-pull.ts` and `routes/hosted/control.ts:101-124`: `register`/`repair` pull a DO session through the relay with the DO host. `checkpoint` is a no-op for DO sessions.
- `authority/adapters/d1/session-read-store.ts`: list items include `sessionHostRoot`.
- `workspace-relay/src/server.ts`, `cloudflare.ts`, `host-tunnel-forwarding.ts:11-35`: a `durable-object` target forwards with `env.SESSION_HOST.getByName(sessionHostRootOf(hostId)).fetch(targetUrl, workspaceRelayForwardRequestInit(...))`.
  - Cookies are stripped as for tunnels.
  - SSE streams through.
  - A WebSocket upgrade to a DO target is refused with `400 durable_object_websocket_unsupported`; session-core events are SSE.
  - `parseWorkspaceRelayTarget` allows an empty `baseUrl` for this backing only.
- `workspace-relay/wrangler.toml`: `[[durable_objects.bindings]] name = "SESSION_HOST" class_name = "SessionDO" script_name = "claxedo-session-host"`, and the same under `env.staging` with the staging worker name. Update `relay-config-drift.test.ts` if it pins bindings.
- `claxedo-app/src/server/transport.ts:8-13`:
  - `RuntimeRoute` gains `sessionHost?: { sessionId: string }`;
  - `runtime` and `runtimeJson` use `relay.fetch(workspaceId, path, init, sessionId)` keyed by session (`relay.ts`);
  - `createWorkspaceConnections` gains `mintSession(workspaceId, sessionId, harness)` (account `session.connection.mint` or `POST /connection`).
- `sessions.ts` and `session-reservation.ts`: creating a session on a cloud workspace mints `connection {session}` first. If the answer is `durable-object`, the client creates the session with that explicit id on the session route.
- `session-list.ts` and `wire/session-row.ts`: carry `sessionHostRoot` into the route.
- `session-projection.ts:24-29`: skip `checkpoint` for DO rows.
- `transcript-reads.ts`: use the session route.

**Deletes:** nothing outside this lane.

**Tests:**
- CP Worker tests on Miniflare with real D1 (pattern: `claxedo-server/src/authority/hosted-session-pull.workerd.test.ts`):
  - placement minting;
  - relay target for an absent row, a matching root, and a different root;
  - register sets the root, the immutable trigger refuses a change, a reserve from a DO host is refused;
  - `/turn-delivery`: direct rows only for the owner; denied after the actor's access is revoked; expired lease → 401;
  - `/turn-execution`: provisioning → 409 with retry; RAT scoped to session.
- Relay workerd test with a stub `SessionDO` class bound as `SESSION_HOST`: HTTP and SSE forwarded with an RHT; WebSocket refused; cookie stripped.
- App unit tests (`transport.test.ts`, `sessions.test.ts`, `session-projection.test.ts`).

**Done when:**
- claxedo-server `typecheck`, `typecheck:services`, `typecheck:auth-d1`, `test`, `d1:baseline:check`, `verify:closure`;
- workspace-relay `typecheck` and `test`;
- claxedo-server-core `typecheck` and `test`;
- claxedo-app `typecheck`, `test`, `check`;
- `bun run test:architecture-ratchets`.

**Depends on:** Lane 0.

**LOC:** about +480 added, about −10 removed.

### Lane CF: execution-env route, stdio MCP relay, Boat driver (wave 1)

**Goal:**
- A cloud workspace runtime serves Pi's `ExecutionEnv` and the VM's own stdio MCP servers to a DO-placed Pi session.
- Boat becomes an ordinary sandbox driver that runs the standard workspace-runtime image, so every harness works on Boat workspaces.

**Create:**
- `workspace-runtime/src/routes/execution-env.ts` (about 170): §4.6 fs and exec over `new NodeExecutionEnv({ cwd: directory, shellEnv: harnessSpawnEnv(process.env) })`. One env per request; the abort signal comes from the request. Authorized from `RelayHostAuthContext` (now imported from `@claxedo/session-core/relay-host`): `backing === "cloud-vm"`, `sessionId` claim, role editor or higher. Any other exposure gets 404.
- `workspace-runtime/src/routes/mcp-stdio-relay.ts` (about 70): WebSocket route. It looks the server up by name in `piProjection().mcpServers` (plugin and stdio only), spawns it through `createSpawnService(ownership)` (`workspace-runtime/src/spawn-service.ts`) with `harnessSpawnEnv`, bridges NDJSON, and retires the process on socket close.

**Change:**
- `workspace-runtime/src/server.ts`: mount both routes when exposure is `relay`, passing `piProjection: () => launch.projection({ id: "pi", access: "native" })` from the workspace host.
- Rename `sandbox-manager/src/drivers/box.ts` → `boat.ts` (driver id `boat`):
  - `DEFAULT_BASE_URL = "https://boat.dev/api/v1"`;
  - `/sandboxes`, `/sandboxes/{id}`, `/resume`, `/stop`, `DELETE` with the confirmation header the docs require;
  - envelope `{ ok, type, sandbox }` with type checks;
  - create body `{ ttlSeconds, noEnv: true }` plus an `Idempotency-Key` built from workspace and epoch;
  - command result `{ success, stdout, stderr, exitCode, timedOut }`;
  - file write response `file.written`.
  
  Keep the existing staged env file, `docker run` of `resolveImage(input)`, health probe and `host` publish. Port the response validators from `$SCRATCH/exp/packages/sandbox-manager/src/providers/boat.ts` (`sandbox()`, `string`/`integer` guards, the bounded body reader).
- `sandbox-contract/src/index.ts:16,50,79,87`: `box` → `boat` (id, auth slot, credential field, label "Boat").
- `sandbox-manager/package.json`: exports `./drivers/boat`, keywords, description.
- `driver-catalog.ts`: entry renamed.
- `claxedo-server-core/src/credentials/operations/sandbox-verify.ts:77,131-139`: verify with `GET https://boat.dev/api/v1/sandboxes?limit=1`, or the documented account endpoint if one exists, to be verified live.
- Every `"box"` test fixture from `rg -l '"box"' packages`.

**Do NOT port:** the experiment's execution-only target kind, `executionInspect`/`archiveExecution`, `targetKind: "execution"`, or the Pi-only workspace rules.

**Tests:**
- `execution-env.test.ts`: real `NodeExecutionEnv` in a temp dir; read, write, edit round-trip; exec streams output; client abort kills a `sleep 60` (pid gone); runtime secret env vars absent from `env` output; non-session RHT → 403; `local-worktree` backing → 404.
- `mcp-stdio-relay.test.ts`: real stdio MCP fixture (`harness` e2e scripted MCP), round-trip `tools/list`, unknown name 404, process retired on close.
- `boat.test.ts`: request and response shapes with an injected `fetchImpl` against recorded current-API payloads.

**Done when:**
- workspace-runtime `typecheck` and `test`;
- sandbox-manager, sandbox-contract, claxedo-server-core `typecheck` and `test`;
- claxedo-server `test` (sandbox verify);
- `bun run test:architecture-ratchets`;
- `bun run --cwd packages/claxedo-server verify:closure` (the host entry closure now includes the pi-durable env).

**Depends on:** Lane 0.

**LOC:** about +300 added (routes about 250, boat about 50 net), about −60 removed.

### Lane B2: SessionDO with PiHarness (wave 2)

**Goal and user-visible behavior:**
- A Pi session on a cloud workspace runs its loop in a SessionDO and its tools on the workspace VM, whatever the sandbox driver.
- It appears in the session list and its transcript loads from the DO.
- Stop works.
- An eviction mid-turn resumes through Pi's wake.
- Native harnesses on the same workspace are unaffected.

**Create** `packages/session-host/` (private; dependencies: `@claxedo/session-core`, `@claxedo/harness`, `@claxedo/agent-runtime-contract`, `@claxedo/workspace-relay-protocol`, `@claxedo/helpers`, `agents@0.26.0` exact, `@earendil-works/pi-durable`, `pi-ai`, `pi-mcp`, `chord`, `hono`; dev: `miniflare`, `esbuild`, `tsx`, `@cloudflare/workers-types`):
- `src/session-do.ts` (about 130): `class SessionDO extends DurableObject`.
  - Constructor:
    - `RuntimeStore` over `durableObjectSqliteDatabase(ctx.storage)`, `location: "session-do:" + root`;
    - a meta row `{workspaceId, directory}` written on first create, workspaceId from RHT and directory from the create body;
    - composition;
    - `Lifecycle.install(this).use(piHarness)`.
  - Inside `blockConcurrencyWhile`: `const ids = store.recoverBusySessions()`, then lease adoption, then `runtime.resumeDurableRuns(ids)`, then `recoverQueuedPrompts()`.
  - `fetch`: `createRelayHostAuthMiddleware` (`{key, workspaceId, hostId: sessionHostId(root)}`), then the Hono app (`composeSessionRoutes` plus `core.events`).
  - Session delete → after CP deletion, `ctx.storage.deleteAll()` (Q11).
- `src/composition.ts` (about 80):
  - `createStoreBrokerPorts`, `createRuntimeEventHub`, `createAgentRuntime` (session-core exports);
  - `createSessionCore` with placement `{workspaceId, directory, sessionIdWorkspace: () => undefined, …}` as in `session-core/src/test-support/durable-object-host.ts:60-70`;
  - `remoteWorkspaceSessionAccessPolicy({ url: <CP>/api/runtime-authority/session-authorize, fetch: env.CONTROL_PLANE.fetch.bind(env.CONTROL_PLANE) })`, wrapped by `turn-leases.ts` to record and observe leases;
  - transports `{ pi: new PiDurableTransport(services, cloudPlacement) }`.
- `src/pi-placement.ts` (about 90): `PiPlacement` over one `PiHarness({ harness: ({storage, context}) => Harness.open(storage, piHarnessOptions({...}), context) })`.
  - Registry and `Models` are created once per DO.
  - `submit` goes through `piHarness.submit` so the wake job is pushed first.
  - `prepareTurn` → `turn-delivery.ts`.
  - `env` → `RemoteExecutionEnv`.
  - `mcpTransport`: HTTP via pi-mcp `StreamableHttpTransport`, stdio via `WebSocketMcpTransport`.
- `src/turn-delivery.ts` (about 70): a client for `/turn-delivery` and `/turn-execution`, cached by `leaseId` and dropped on lease loss. Refresh = repeat the call. Parses with §4.5 parsers.
- `src/turn-leases.ts` (about 50): records the latest lease per session in a one-row-per-session DO table (`session_host_turn_lease`), deleted on release. On boot it calls `adoptSessionTurnLease` for a stored lease. If renewal fails, it calls `piHarness.abort()` for that session and deletes the row.
- `src/remote-env.ts` (about 150): `ExecutionEnv` over §4.6 through `relayUrl` with `Bearer runtimeAccessToken`. `id = "vm:" + workspaceId`. `openTextLineReader` is built from one `readTextFile` capped at 8 MiB (over the cap → `FileError("invalid")`). Exec parses SSE and aborts the fetch on the context signal.
- `src/mcp-relay-transport.ts` (about 45): a pi-mcp `Transport` over a WebSocket to `/api/wr/execution-env/mcp/:serverName`.
- `src/worker.ts`: `export { SessionDO }` and a default `fetch` answering 404.
- `README.md`.

**Change:**
- `session-core/src/routes/session-turn-lease.ts`: extract the renewal loop and add `adoptSessionTurnLease({ policy, access, lease: { turnId, leaseId, fencingToken, expiresAt }, onLost })`. It shares the internal `schedule()` with `acquireSessionTurnLease` (about +20).
- `session-core/docs/durable-object.md`: production entry, ports table "DO" column (Pi in process), eviction resume.
- `claxedo-server/scripts/deploy/wrangler-config.ts`: `renderSessionHostWranglerConfig({ workerName, controlPlaneWorkerName, configDirectory, variables })` with:
  - `main` = `packages/session-host/src/worker.ts`;
  - `compatibility_date` and `compatibility_flags = ["nodejs_compat"]` (Lifecycle needs `node:async_hooks`);
  - `[[services]] binding = "CONTROL_PLANE"`;
  - DO binding `SESSION_HOST` / `SessionDO` with `[[migrations]] tag = "v1" new_sqlite_classes = ["SessionDO"]`;
  - vars: relay host public key, kid, relay URL, CP authority path.
  
  Wire it into the existing deploy script so the session-host Worker deploys before the relay.
- `harness/e2e/harness/hosted-cloud.ts` and `BOOT_TARGETS.md`: boot the session-host Worker in Miniflare next to the CP Worker, bind it into the relay process.
- Flows `H19.pi-cloud-turn` and `H19.hostedpi-cloud-turn` assert DO placement: the session row has `session_host_root`, a tool writes a file visible through the VM `routes/file.ts`, and the transcript is read through the DO.

**Deletes:** the cloud Pi path through the VM runtime (that flow's assertions).

**Tests:**
- `session-do.node-test.ts`, Miniflare, following `session-core/src/durable-object.node-test.ts`. It bundles the real Worker, a real `PiHarness`, a Node HTTP CP stand-in that implements only the §4.5 and `/session-authorize` wire with real JWT verification keys, the real workspace-runtime execution-env route from CF in Node, and the scripted model server. Cases:
  - create, prompt, tool on the VM, transcript read;
  - stop aborts the remote exec (pid gone on the VM side);
  - `abortAllDurableObjects()` mid-tool → the alarm restarts → lease adopted → continuation finishes;
  - lease renewal denied → Pi run aborted, session interrupted;
  - credentials only from `/turn-delivery`, one call per turn (assert the count);
  - stdio MCP through the relay.
- The E2E flows above.

**Done when:**
- session-host `typecheck` and `test`;
- session-core `test` (including `durable-object.node-test.ts`);
- claxedo-server `test`;
- `bun run --cwd packages/harness flows H19`;
- `bun run test:architecture-ratchets`; claxedo-server `verify:closure` (unchanged: the DO is a separate Worker; prove it).
- `wrangler deploy --dry-run` for the session-host config renders and bundles.

**Depends on:** 0, A, B1, CF.

**LOC:** about +700 added (session-host about 640, session-core about 20, wrangler about 40), 0 removed.

### Lane D: Codex sharing (fixed), native Codex binary, Cursor host-lifetime registry (wave 2)

**Goal:**
- Concurrent Codex sessions of one owner, account and plugin selection share one `codex app-server`.
- One session's stray frame, early-frame overflow, turn timeout or credential change never affects siblings.
- An idle process is released 30 s after its last member leaves.
- Codex runs as the native binary on every platform.
- Cursor agents share one SDK host across workspaces.

**Create:**
- `workspace-runtime/src/host/shared-harness-hosts.ts`: `createSharedHarnessHosts({ clock, log }) → { codex: CodexProcessPool; cursor: CursorHostRegistry; dispose() }`. It is created once per process by the daemon composition (`workspace-runtime/src/server.ts` and `claxedo-local-server/.../embedded-workspace-runtime.ts`) and passed through `WorkspaceHostOptions.sharedHarnessHosts` (`workspace/host-options.ts`) to `harnessCompositionOptions` (`host/composition.ts:38-54`).
- In `harness/src/transports/codex-app-server/`:
  - `pool.ts` (about 90): key → `{ rpc, router, members, idleTimer }`; `acquire(key, create)`; release arms a 30 s idle retire; a process-level failure evicts the entry.
  - `router.ts` (about 120), port of `$SCRATCH/exp/.../router.ts` with these fixes:
    - `fail()` runs only for a process exit or a broken channel;
    - an unowned-thread frame past 10 s, or an early-frame overflow, is dropped with an `unrecognized` diagnostic, and a held request is answered with a JSON-RPC refusal; the router never fails;
    - `reserveReplacement` is removed: a credential or launch change moves that member to the pool entry of its new key.
  - `member.ts` (about 170), port slimmed to one explicit state machine (fold `member-state.ts` and `entry-state.ts`). A `turn/start` timeout fails only this member and sends `turn/interrupt` for its thread; it never calls `raw.abandon`.
  - `early-frames.ts` (about 50), port with expiry and overflow rejecting only the frame.
  - `account.ts` (about 40): before each `turn/start`, `account/login/start` with `chatgptAuthTokens` (direct subscription, account id from the JWT) or `apiKey` (direct key or broker placeholder). Answers `account/chatgptAuthTokens/refresh` from the member's current `StartInput.credentials.direct`. Logins are serialized per process.
  - `launch-key.ts` (about 25): `sha256(JSON([binary identity, accountOwner, selected account credentialId or "own-login", codexHomeKey(...), pluginSelection, projection.generation]))`. Never secrets, placeholders, `auth.json` content, or a full env hash.
  - `thread-release.ts` (about 50): on close, unsubscribe the threads and clear background terminals, then release the member.
- `workspace-runtime/src/host/executables/codex.ts`: resolve the native executable for darwin and linux like win32 (`:62-90`). Follow the shim to `@openai/codex/vendor/<triple>/bin/codex` (layout verified: `node_modules/.bun/@openai+codex@0.159.2-darwin-arm64/.../vendor/aarch64-apple-darwin/bin/codex`) or the hoisted `@openai/codex-<platform>-<arch>`. Replicate what `bin/codex.js` puts in the child env and `PATH` (`vendor/<triple>/codex-path` for the bundled `rg`); verify against the 0.159.2 launcher.

**Change:**
- Codex `launch.ts` (acquire from pool), `sessions.ts`, `session.ts`, `turn.ts`, `entry.ts`, `index.ts` (dispose releases only this transport's members), `rpc.ts` (connection interface), `README.md` (sharing, isolation, idle release).
- `profiles/codex/index.ts:71-80`: the broker provider fragment keeps `base_url` and drops the placeholder `http_headers` (the key now arrives via login).
- Cursor:
  - `host-registry.ts:115-194`: the registry outlives transports (no transport signal); `cursorHostId` includes `backendUrl` (exp fix).
  - `index.ts:50,59`: take `options.hosts`; dispose releases only its own acquisitions.
  - `README.md`.
- `harness-services.ts`: unchanged API. Shared hosts are composition options, not services.

**Do NOT port:** `execution-resources.ts`, `execution-owner*.ts` (473 lines), `test-support/resources.ts`, any SQLite membership ledger, `codex-account-generation` refusal semantics. Orphans are cleaned by existing `process-ownership` launch records: the pool spawns with the acquiring workspace's `services.spawn`.

**Tests:**
- Real Codex app-server 0.159.2 plus the scripted model server (`conformance/codex*.test.ts`, extend `codex-shared-sessions.test.ts`):
  - two sessions with the same owner and account share one pid;
  - different accounts use different pids;
  - a credential change on A moves A to a new pid while B's turn completes;
  - an injected stray frame or 300 early frames fail nothing;
  - an A turn timeout leaves B streaming;
  - the process is retired 30 s after the last close (fake clock in the unit `pool.test.ts`; a real process in conformance with a short injected idle).
- Port `sharing.test.ts` and `routing-safety.test.ts` from the experiment with inverted sibling assertions, running against the real pool.
- Cursor `host-registry.test.ts`: two transports (workspaces) share one host; disposing one keeps the host.
- `executables/codex.test.ts`: darwin and linux layouts in temp dirs.

**Done when:**
- harness `check`, `typecheck`, `test`;
- `bun run --cwd packages/harness flows H13.codex H14.codex H15.codex H25`;
- workspace-runtime and claxedo-local-server `typecheck` and `test`;
- `bun run test:architecture-ratchets`; `verify:closure` for local-server and desktop;
- the Codex budget is updated with the measured production lines (estimate 3,300).

**Depends on:** 0, A (`host/composition.ts`, local-server file), CF (`server.ts`).

**LOC:** about +620 added (codex about 545, cursor about 35, native about 40), about −70 removed.

### Lane E: OpenCode per-session instances (wave 2)

**Goal:** each OpenCode session sees exactly its own MCP servers, skills and Claxedo tools, even when it shares a directory with another session. A projection change applies to that session only.

**Change** (`harness/src/transports/opencode-sdk/`):
- `host.ts:60-70`: `OpenCode.create({ ..., instances: { key: (session) => keys.of(session), configure: (key) => ({ plugins: instancePlugins(documents.get(key)) }) } })`.
  - The key is `sha256` of the session's MCP and skill selection, computed by `mcp-projection.ts` from `projection.generation` plus its servers.
  - Child sessions resolve by `parentID`.
  - An unknown key throws, and the turn is refused.
  - The key map is filled at `start`/`attach` from the session record before the first SDK call.
- `launch-policy.ts`: becomes the instance plugin factory (`mcp.transform` and `skill.transform` from that key's document). Delete the per-directory `stores` map, the latest-wins behavior, and the rollback (`open-rollback.ts`, if only used for that).
- `tool-port.ts:76` and `provider-policy.ts:38`: directory-keyed maps become per-instance context.
- `interaction-port.ts`: permission and form lists scoped by session.
- `transport.ts`:
  - after the first prompt of a new key, wait for that instance's MCP servers to settle (status connected or failed, bounded 10 s);
  - `configure(projection)` records the new key for that session (`deferred: after-active-turns` while busy).
- `README.md`: replace the "launch document is the folder's… latest wins" paragraph; state the limits (instances are never evicted; location routes do not see instances; MCP OAuth tokens are shared per server name and URL).

**Tests** (real OpenCode engine, `conformance/opencode.test.ts` and `opencode-skills.test.ts`; port `$SCRATCH/oc-research/proof.mjs`):
- two sessions in one directory with different MCP and skill selections each list only their own tools and skills;
- a child inherits its parent's key;
- an unknown key is refused;
- a projection change reaches only that session at its next turn.

**Done when:**
- harness `check`, `typecheck`, `test`;
- `bun run --cwd packages/harness flows H17 H19.opencode`;
- `bun run test:architecture-ratchets`.

**Depends on:** 0.

**LOC:** about +130 added, about −70 removed (net about +60).

### Lane G: integration (wave 3)

**Docs:**
- `docs/harness/README.md`: transport table row Pi → `PiDurableTransport`; credentials and conversation-store bullet for Pi (embedded Harness, per-session SQLite, direct credentials); cloud Pi placement (SessionDO); questions and permissions (Pi `beforeTool`).
- `docs/pi-native-user-guide.md`: cloud section (loop in the DO, tools on the workspace machine, any driver, Boat included).
- `docs/README.md` index.
- `docs/plans/README.md` entry for this plan.
- Run `bun run docs:check-links`.

Package READMEs are updated by their lanes:
- harness, `transports/pi-durable`, codex, cursor, opencode;
- session-core and `docs/durable-object.md`;
- session-host, workspace-runtime (new routes), sandbox-manager (Boat), workspace-relay (`durable-object` backing in the token table and forwarding section), claxedo-server (session-host Worker deploy).

**App e2e** (`packages/claxedo-app/e2e`):
- New `flows/42-pi-local.spec.ts`:
  - Pi turn with a tool card (scripted model writes a file);
  - `ask` mode approval allow and deny;
  - question answered;
  - Stop;
  - daemon killed mid-tool and restarted, after which the transcript shows the interrupted turn followed by a continuation reply;
  - model picker lists only connected providers.
- New `flows/43-pi-cloud.spec.ts` on the hosted stack:
  - Pi on a cloud workspace creates a DO session (request goes to `connection {session}`; the session row has `sessionHostRoot`);
  - the turn streams; the file written by the tool appears in the workspace file tree (VM `routes/file.ts`);
  - reload reads the transcript from the DO;
  - a Codex session on the same workspace still runs on the VM.
- Adjust:
  - `00-isolation.spec.ts`: Pi direct credentials reach the scripted server through provider definitions;
  - `harness/agent-env.ts`: drop `PI_EXECUTABLE`;
  - global setup: no Pi install;
  - `README.md`: Pi model traffic and agent CLIs.

**Done when:**
- `bun run --cwd packages/claxedo-app typecheck:e2e`;
- `bun e2e/run.ts flows/42-pi-local.spec.ts flows/43-pi-cloud.spec.ts flows/00-isolation.spec.ts flows/24-cloud-sandbox.spec.ts`;
- root `bun run lint`, `bun run typecheck`, `bun run test:architecture-ratchets`;
- `bun run --cwd packages/harness flows` (full);
- every product's `verify:closure`.

**LOC:** docs only; no production code.

## 6. Deletions summary (no shims)

- **Pi RPC:** `transports/pi-rpc/**`, `profiles/pi/**`, `translate/corpus/pi-rpc/**`, Pi CLI e2e pinning, `executables/pi.ts`, fake Pi helpers, `CLAXEDO_PI_MCP_HANDOFF`, Pi CLI in images, `TransportKind "pi-rpc"`, version-matrix Pi, and the Pi CLI paragraphs in the guide.
- **Moved modules:** old `workspace-runtime` paths of `workspace-host-service-auth.ts`, `remote-session-authority.ts`, `workspace/session-routes.ts`.
- **Box:** driver id `box` and the old Box API client.
- **OpenCode:** per-directory launch documents map, latest-wins, rollback.
- **Codex:** per-session process spawning in `CodexLaunches.launch`.
- **Cloud Pi:** running Pi inside the VM runtime.
- **Never introduced:** anything in the experiment's list (`workspace-execution`, guest, admission hooks, continuation journals, resume grants, `/publish`, execution leases).

## 7. Open questions (with the default each lane implements)

1. **Does PiHarness require extending `Agent`?** No. It is a `LifecycleCapability` installed into a plain `DurableObject` through `Lifecycle.install(this).use(...)`. It needs `nodejs_compat` (`node:async_hooks`). Default: `SessionDO extends DurableObject`. Lane 0 or B2 confirms this against the published `agents@0.26.0` `harness/pi` exports right after `bun add`; if 0.26.0 differs from the df9c0ef source copy, B2 stops and reports.
2. **How do approvals map?** The `beforeTool` hook awaits `TurnBroker.ask` (or the session broker during a continuation) with request id `pi-tool:<toolCallId>`; allow → run, otherwise `block`. New `PI_PERMISSION_MODES` `ask | full`. Default `full`, matching base Pi, which never asked. Grants are keyed by tool name.
3. **Questions:** a Claxedo `question` tool in the Claxedo extension (replay unsafe). Default: on.
4. **How does a DO session appear in lists?** As a D1 `sessions` row registered by the DO's own `register` (CP sets `session_host_root` from the RHT host id). Status for unwatched sessions: stamp `busy` and `idle` in `turn_acquire`/`turn_release` for both placements. Default: yes (B1, about 10 lines); the alternative is pull-only.
5. **Credentials for a mid-turn eviction resume:** the DO persists the turn-lease JWT and adopts it on wake if it is still renewable (60 s TTL plus D1 actor re-check). Otherwise it aborts the Pi run, and the turn stays interrupted. Default as described; there are no new grant types.
6. **DO workspace directory:** taken from the first create body, stored immutable, cross-checked against `/turn-execution`'s `directory`; a mismatch refuses the turn. Default as described.
7. **Direct credentials for member sessions on someone else's enrolled machine:** default is no. Direct rows go only to the machine owner's own runtime and to the DO. Pi refuses member sessions there with `direct_credential_required`, and Codex falls back to its existing broker placeholder. Owner may revisit decision 7.
8. **Remote MCP OAuth for Pi:** default is none in v1. Plugin HTTP servers arrive with gateway URLs and headers from the projection (local) or delivery (DO).
9. **Boat port publishing:** dev's driver relies on Docker in the VM and an in-VM `host <port>` CLI, and the current API docs document neither. Default: keep that mechanism and verify it live (§8). If it is absent, Boat stays unsupported until the owner picks a mechanism. There is no fallback.
10. **Codex members per process:** default cap 8 (experiment value); a ninth member opens a second process under the same key.
11. **Deleting a DO session:** Pi has no conversation delete. Default: `ctx.storage.deleteAll()` after CP deletion succeeds.
12. **Pi machine login:** Pi no longer reads `~/.pi`. Default: Pi always needs a Claxedo-stored account, and `machineLoginAllowed` is ignored for Pi.
13. **First-party MCP in the DO:** `firstPartyMcp` is local-only (`workspace-runtime/src/harness-services.ts:21`). Default: absent for DO sessions, so there is no Claxedo `create_subagent` there.
14. **Orphaned bash children after a daemon crash:** `NodeExecutionEnv` spawns outside `services.spawn`, so they have no launch records. Default: accept; abort kills active children. Flag in the transport README.

## 8. Live acceptance (deployed staging; deploying needs owner approval)

Needs a deployed environment:
1. **Staging D1 reset.** The baseline changed; a deploy refuses an existing database (`claxedo-server/README.md` "Control-plane D1 schema"), so `wrangler d1 delete` is required. Needs owner approval.
2. **Deploy order:** session-host Worker → CP Worker → relay Worker, with its `SESSION_HOST` `script_name` binding. Then confirm the cross-Worker DO binding and the DO→CP service binding.
3. Pi cloud turn end to end through the deployed relay: tool on a Cloudflare-sandbox VM, then Docker/Modal/Vercel if configured.
4. **Real eviction mid model stream:** a deploy during a turn and a forced eviction resume within the 60 s lease. A stream longer than 15 minutes is a known platform limit; record the observed behavior.
5. Real `openai-codex` subscription with direct token: local daemon and DO; refresh near expiry.
6. **Boat:** create, docker run, `host` publish, health, relay reachability, stop and resume against the real Boat account; the credential verify endpoint.
7. Codex native binary on macOS, Linux (images) and Windows desktop builds; RSS per extra shared session.
8. Cursor shared host across two workspaces on the desktop.
9. Real remote and stdio plugin MCP servers for Pi locally and in the DO via the VM relay.

## 9. LOC summary (production)

| Lane | Added | Removed |
|---|---|---|
| 0 | ~140 | ~10 |
| A | ~1,300 | ~1,750 |
| B1 | ~480 | ~10 |
| CF | ~300 | ~60 |
| B2 | ~700 | 0 |
| D | ~620 | ~70 |
| E | ~130 | ~70 |
| G | 0 | 0 |
| **Total** | **~3,670** | **~1,970** |

## 10. Risks to watch during execution

- **The pi-durable API is marked experimental.** Pin exact, and keep the translator corpus as the proof.
- **The `agents` beta API may differ from the source copy.** See Q1.
- **The closure growth of desktop and local-server from pi-ai and TypeBox (~23 MB RSS unbundled per the pi-durable README) must be measured** at `verify:closure`. Raise only the exact ceiling, never more.
- **Parallel tool calls:** pi runs one round's tool calls at once by default, and remote exec has no ordering guarantee. Keep the default; note it in the session-host README.
- **Rename churn:** the Boat rename touches credential-slot keys (`auth.box`). There is no migration (no back-compat by owner rule); stored Box keys must be re-entered.
