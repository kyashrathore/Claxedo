# OpenCode v2 Worker plan: second review

Date: 2026-09-05. Repository baseline: `eefd4a8777`.
Reviewed: [plan 003](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md), including both identical pasted copies, and its [evaluation](./opencode-v2-workerd-evaluation-2026-09-05.md).

**Verdict: promising upstream choice, but not ready for implementation beyond a corrected feasibility spike.** The workerd profile genuinely supplies durable database/events and harness services. It does not make the proposed workspace attachment, durable files, safe remote-effect recovery, credential scoping or cross-version promotion work automatically. Several findings are concrete mismatches in the exact published build, not hypothetical beta risks.

This is a review, not a rewrite of the proposal. No runtime implementation or dependency changes were made.

## Evidence scope

Downloaded and inspected the published SDK, core and server tarballs at **0.0.0-dev-19120**, without installing or executing them. Relevant distribution files are named below. Published metadata: [SDK](https://registry.npmjs.org/@opencode-ai/sdk/0.0.0-dev-19120), [core](https://registry.npmjs.org/@opencode-ai/core/0.0.0-dev-19120), [server](https://registry.npmjs.org/@opencode-ai/server/0.0.0-dev-19120).

Also inspected repository composer/runtime/broker/deployment code and official [OpenCode workerd documentation](https://opencode.ai/v2/docs/build/sdk/cloudflare). Moving `v2` branch sources corroborate some behavior, but the pinned distribution is the authority for this review. No bundle, typecheck, Miniflare, provider, machine, transfer or eviction test was run; reported bundle measurements remain supplied evidence.

## Findings requiring changes

### R1 — P1: the public workerd SDK drops the proposed workspace-provider option

Plan locations: [SDK composition](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:132), [driver decision](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:90).

In the pinned SDK, `dist/workerd.d.ts` has no `workspaceProviders` option. `dist/workerd.js` passes remaining options through `WorkerdProfile.make()`. That calls `ServerWorkerd.serverOptions()`, whose explicit return fields omit `workspaceProviders`. The value therefore never reaches `EmbeddedHost.create()`, even though the latter supports it. The Effect workerd wrapper forwards this option separately; the Promise wrapper used by the proposal does not.

Consequently, the example `OpenCodeWorkerd.create({ workspaceProviders: { claxedo: driver } })` is not supported by the stated public entrypoint. A bundle of the host alone cannot prove that the driver was registered.

**Required change:** choose and pin a supported Effect composition or an upstream fix exposing the option through the intended API. Unit 1 must register a sentinel provider and prove real workspace creation/connect calls reach it through the public host. Do not bypass the SDK with undocumented imports while continuing to describe this as an unchanged public contract.

Evidence: SDK `dist/workerd.js`, `dist/workerd.d.ts`, `dist/effect/workerd.js`, `dist/internal/workerd.js`, `dist/internal/host.js`; server `dist/workerd.js`.

### R2 — P1: the claimed bootless tool environment is neither installed nor durable

Plan locations: [base tools](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:37), [memory-driver claim](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:71), [Unit 1](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:171).

In the pinned core's `Environment` layer, a location without a workspace uses `makeLocalDriver(spawner)`, not `makeMemoryDriver()`. The workerd profile replaces the spawner with the unavailable implementation; it does not inject the memory driver. Separately, the memory driver stores nodes in an in-memory `Map` and explicitly rejects process spawning. Its presence in the package proves neither virtual shell support nor persistence across eviction.

This blocks the proposed read/edit spike as composed and invalidates the larger claim that every listed tool works without a machine. Reconstructed conversation history will not restore files written into that Map.

**Required change:** identify a supported environment replacement seam, declare the actual bootless tool subset and add durable scratch storage or explicitly disposable scratch semantics. If virtual shell is required, name its implementation and maintenance cost. Test file write → object replacement → file read independently from message continuity. Also test two workspace-less sessions at the same directory to establish file isolation.

Evidence: core `dist/chunks/location-service-map-stk731w5.js` (Environment selection), `dist/chunks/location-service-map-aaet6srn.js` (memory Map and failing spawner); server `dist/workerd.js` (replacement graph).

### R3 — P1: attaching a workspace is not an immediate switch inside a running tool

Plan locations: [attachment decision](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:91), [machine flow](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:140).

The pinned `SessionMove.move()` resolves the destination with host `FSUtil.stat()` and project resolution before admitting a move. For an active session it enqueues an inbox move and wakes execution; it does not immediately mutate the environment used by the currently executing tool batch. The proposal assumes `/workspace` can be resolved before provisioning and that the next tool necessarily uses it. Both need proof.

There is another missing connection: `WorkspaceDriver.create()` receives only `workspaceID`. The plan's `Workspace.create({ provider: "claxedo" })` does not explain how the driver obtains the authorized repository, commit, compute policy and checkout request after an eviction.

**Required change:** persist preparation intent keyed by workspace ID before creation. Specify when provisioning, destination validation and the queued move complete, how parallel tool calls are held at the boundary, and which event establishes readiness. Test attachment from a live model tool through the actual SDK, not by pre-attaching a workspace in test setup. Include cancellation, failed preparation and retry without a second machine.

Evidence: core `dist/chunks/location-service-map-20hnz5p1.js` (`SessionMove.resolveDestination` and `move`), `dist/types/workspace/driver.d.ts`.

### R4 — P1: upstream restart recovery does not guarantee remote commands are never repeated

Plan locations: [recovery ownership](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:134), [dropped command claim](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:145), [Unit 4 acceptance](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:189).

The upstream restart contract explicitly states recovery is at-least-once and does not prevent repeated external side effects. The pinned implementation also describes previously running shell jobs as cancelled after server restart. With remote execution, a DO restart does not establish that the machine's process stopped. A command might have pushed a commit or changed files before its result was lost.

The SDK host launches a recovery sweep on creation. This does not by itself establish when an evicted object will be reactivated without another client request, or that the resumed work obtains a fresh valid credential.

**Required change:** retain durable remote operation IDs, arguments digests, lease-generation fencing and status/reconciliation at the machine execution owner. Unknown is distinct from failed/cancelled. Prove cancellation acknowledgement and reconnect behavior before re-driving tools. Specify durable activation for disconnected users. Test crash after an external effect but before result persistence and verify that replay does not repeat that effect. These remain Claxedo integration responsibilities even if upstream owns the model loop.

Evidence: [upstream restart contract](https://github.com/anomalyco/opencode/blob/v2/packages/core/src/session/execution/restart.ts), pinned core `dist/session/execution/restart.js`, SDK `dist/internal/host.js`; current [session-env execution](../../packages/workspace-runtime/src/routes/session-env.ts).

### R5 — P1: one tenant-wide provider configuration cannot supply per-turn credentials safely as described

Plan locations: [host scope and provider configuration](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:88), [turn tokens](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:133), [gateway metering](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:149).

The host is long-lived and tenant-wide, but its inline provider key is described as a session grant minted per turn. No request-scoped injection or cache-safe refresh mechanism is identified. Concurrent sessions, expiry, compaction, subagents and restart sweeps cannot safely rely on mutating a single host configuration. The pinned provider implementation caches SDK/model instances from settings and headers, making this an integration contract to prove, not a detail deferred to the gateway.

The draft also restores the previously rejected one-usage-row-per-assistant-message rule. Provider retries and compaction can produce billable calls without a matching displayed assistant message.

**Required change:** identify an upstream per-request model transport/hook carrying trusted session/turn identity. Do not derive identity from model-controlled headers or a mutable global token. Specify renewal for boot-sweep/subagent calls, resource/action grants, provider endpoint allowlists and fail-closed behavior. Bill once per provider attempt with an invocation ID in the existing ledger; reconcile incomplete usage instead of counting display events. Test two concurrent sessions with different connections/grants and one expiring token.

Evidence: core `dist/chunks/location-service-map-7dqecfa5.js` (cached SDK/model settings); current [broker claims](../../packages/sandbox-manager/src/drivers/cloudflare-egress.ts), [existing metering ingress](../../packages/claxedo-server/src/session/runtime.ts:724).

### R6 — P1: the proposed promotion and v1 deletion conflict with the retained sandbox runtime

Plan locations: [retain v1 in sandboxes](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:89), [promotion](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:200), [delete v1 transport](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:204).

The plan keeps the vendored 1.17.13 tree for desktop and sandbox execution, but sends v2 session transfers there and deletes the v1 adapter transport. Neither the v1 import contract nor a Pi reader of OpenCode v2 transfer data is established. A shared app UI does not make these protocols/formats interchangeable.

Even between compatible v2 hosts, `SessionTransfer.export()` exports session info and settled messages. Import preserves the native ID, rejects an existing target session and requires a referenced parent to exist. It does not transfer a machine filesystem, pending jobs or credentials, and it does not fence the old host. A record flip after import can leave two active owners if the operation crashes between steps.

**Required change:** pin a compatible v2 sandbox target for v2 promotion, or explicitly defer promotion. Treat OpenCode-to-Pi continuation as a separate conversion/new-session feature unless a real format contract exists. Keep each transport until its actual callers migrate. Add idle/fenced staging, target validation, parent-graph handling, idempotent import reconciliation, app/native identity mapping and one authoritative placement cutover.

Evidence: pinned core `dist/session/transfer.js`; the pinned `@opencode-ai/sdk` version in `packages/workspace-runtime/package.json`, and the retired v1 adapter callers (the SDK harness is now `packages/workspace-runtime/src/opencode/harness-adapter.ts`).

### R7 — P1: tenant keying is a data and authorization decision, not a later key rename

Plan locations: [object keying](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:88), [identity](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:133), [unit 2 public transport](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:178).

One tenant host shares a database, configurations, routes and event history. Resolving a tenant does not establish that each member may read every session or attachment, mutate provider config, execute against every workspace, or subscribe to the host-wide event feed. The plan does not specify how existing participant authority filters those entrypoints.

Later splitting that host into per-session objects changes database ownership, event cursors, list/search, workspace records and parent/child operations. It requires data routing and migration; changing the DO key would strand existing state. The official workerd example establishes one host per object, not a tenant isolation recommendation or a cold-start performance guarantee.

**Required change:** choose and document the ownership unit before persistence ships. Keep authenticated session/participant/workspace authorization in front of every exposed route and event stream. Test two users in one organization with private sessions and forged identifiers. If future partitioning is intended, specify a stable directory/routing record and migration protocol. Measure memory/concurrency/cold starts instead of treating per-tenant boot amortization as established evidence.

Evidence: [official hosting example](https://opencode.ai/v2/docs/build/sdk/cloudflare), existing [session authority](../../packages/claxedo-server/src/routes/runtime-session-authority.ts), [session metadata](../../packages/claxedo-server-core/src/session/meta/index.ts).

### R8 — P2: the hosted-core composition violates an existing resource boundary

Plan location: [Unit 2](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md:177).

The proposal adds the runtime beside `LiveSyncRoom` in the core renderer. The existing hosted core explicitly excludes optional-service implementations, jobs, storage and DOs. The repository also contains `WakeLane`, so “the only hosted Durable Object” is too broad.

**Required change:** put the runtime behind the existing typed service/deployment boundary with its own certified import/resource closure, or explicitly propose and justify a change to that boundary before bundling. Do not simply raise the ratchet ceiling after importing the full v2 graph.

Evidence: [core ownership contract](../../packages/claxedo-server/src/deployments/hosted-workerd/core-worker.cf.ts:1), [resource closure tests](../../packages/claxedo-server/src/deployments/hosted-workerd/core-resource-closure.test.ts), [wake lane](../../packages/claxedo-server/src/deployments/hosted-workerd/wake-lane.cf.ts).

## Other corrections to carry forward

- The draft says 001 UX is unchanged, but removes Files/Changes/Processes surfaces for Worker sessions with attached machines. State this product reduction explicitly, or include those adapters in scope and estimates.
- Selecting an incompatible package should offer an explicit Sandbox action. It must not silently promote an existing session or overwrite a saved placement. Selecting Pi for a new draft can resolve its supported default; that is different from silently changing an explicit Worker selection.
- `WorkspaceDriver` is an upstream interface, but Claxedo still owns its remote process protocol: stdin/EOF, byte fidelity, stdout/stderr backpressure, exit status, signals, process-tree cancellation, reconnect and leases. Four method names do not bound its maintenance cost.
- Persist repo/ref preparation and any bootless change sets. Specify scratch-to-checkout behavior; changing a session location does not copy files. Git Data creates objects/refs; PR creation uses the separate PR API. Keep revision-consistent search and idempotent publication from the reviewed Pi plan.
- “No provisioning without request_machine” needs an explicit exception for Sandbox placement/promotion. “Promotion round-trip” is inconsistent with one-way placement. Test facts intentionally retained by compaction, not every pre-compaction fact.
- Restoring native messages does not independently restore goals. Remove the claim that this fix is already tracked unless an actual issue/task is linked.
- A Node DO shim cannot satisfy the product's workerd placement contract. Report Worker unavailable on unsupported deployments.
- Do not register a memory hook stub for an out-of-scope memory feature. Keep an extension point without implying behavior exists.

## Revised feasibility gate

Before parallel implementation, one small integration slice should demonstrate:

1. Exact public SDK composition forwards the provider and a deliberately selected bootless environment; typecheck this entrypoint.
2. Supported bootless tools work, file state has declared persistence, and two sessions cannot see each other's scratch accidentally.
3. A live model tool admits machine work, persists repository/commit intent, completes the location transition and then executes on the correct machine. Test mixed/parallel calls and failed provisioning.
4. Two simultaneous sessions use different scoped gateway grants; expiry, compaction, child work and eviction recovery retain correct identity and usage attribution.
5. Kill the host or channel after a remote mutation; reconcile the same operation without duplicate effects or false cancellation.
6. A compatible v2-to-v2 transfer, if in scope, preserves the declared data while fencing the old owner. v1 and Pi cases remain explicitly unsupported until separately proven.

Also measure startup, memory and compressed bundle limits in the actual workerd deployment. A successful Node-target bundle and absence of `bun:` imports are necessary packaging evidence, not runtime acceptance.

The recommendation remains **evaluate OpenCode v2 first**, because using upstream persistence/compaction is attractive. The spike should decide how much upstream integration or patching is necessary. Do not claim the harness-maintenance cost has disappeared until these contracts pass. Plan 002 remains an alternative design with its own unproven gates, not an automatically validated fallback.
