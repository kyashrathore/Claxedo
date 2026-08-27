---
title: Durable Local Control Plane and Standalone Workspace Runtimes - Plan
type: feat
date: 2026-08-27
topic: durable-local-control-plane
artifact_contract: ce-unified-plan/v1
artifact_readiness: blocked-on-prerequisite-measurement
product_contract_source: ce-brainstorm
execution: code
---

# Durable Local Control Plane and Standalone Workspace Runtimes - Plan

## Goal Capsule

- **Objective:** Browser refresh, Electron restart, app update, and local control-plane restart must not terminate an active terminal, TUI, harness server, or model turn while the execution machine remains available.
- **Means:** Make the local control plane a machine-owned daemon and make a standalone `@claxedo/workspace-runtime` process the owner of execution for each active workspace. The existing supervisor policy and `SandboxManager` remain the only lifecycle authority.
- **Clean cut:** Remove the desktop-only embedded-runtime lifecycle in the same migration. There is no dual mode, live pre-cutover migration, synthesized continuation, or embedded fallback.
- **Survival boundary:** Work survives UI and control-plane replacement. It does not survive machine/process-namespace loss or an unexpected crash of the workspace runtime that owns it.
- **Execution blocker:** Slice 0 must repair or replace the unreliable performance instruments, establish the direct-runtime transport baseline, and receive explicit budget sign-off before implementation proceeds.
- **Revised effort:** Approximately **14-21 engineer-weeks** for one engineer. Allow **18-24 weeks** for complete macOS and Windows update, credential, process-tree, and failure qualification. Multiple engineers may reduce calendar time, not total effort.

---

## Product Contract

### Direct Answer

The durable process is not a terminal daemon and not a second supervisor.

The control plane remains the desired-state authority. Local execution becomes another `SandboxManager` placement using a local process driver and the existing workspace-runtime protocol.

High-volume local data does not proxy through the daemon. The daemon resolves placement and mints a short-lived local capability; the client then connects directly to the addressed runtime for PTY and workspace event streams.

```text
Electron / browser
   | control API
   v
durable local control-plane daemon
   |  Workspace Supervisor policy
   |       -> SandboxManager + durable lease store
   |             -> LocalProcessDriver
   |                   -> standalone workspace-runtime
   |                        -> harness adapters / active turns
   |                        -> per-workspace OpenCode server child on demand
   |                        -> PTYs / TUIs
   |                        -> durable control-event outbox
   |
   +-- returns RuntimeConnectionDescriptor
             |
             +-- direct authenticated PTY WebSocket
             +-- direct authenticated workspace SSE

daemon also owns: machine enrollment + one relay tunnel
```

Cloud and local targets still use different access transports. The convergence is lifecycle and runtime protocol, not a promise that relay and loopback networking become identical.

### Current Code Flow and Change Points

#### A. Canonical hosted/self-hosted flow that remains

1. `packages/claxedo-server/src/workspace/supervisor/index.ts` owns desired state, holds, recent activity, idle decisions, and configuration fan-out.
2. `@claxedo/sandbox-manager` owns leases, ensure/target, epochs, retry, stop, destroy, and garbage collection.
3. `SandboxDriver` owns placement only. Its contract sends PTY, session, file, and agent work through `@claxedo/workspace-runtime`.
4. `@claxedo/workspace-runtime` owns session adapters, active turns, harness children, PTYs, runtime stores, and runtime events.

#### B. Desktop-local exception that is removed

1. Electron forks the server and explicitly kills it during ordinary quit/update.
2. `start-local-server.ts` explicitly installs no workspace supervisor.
3. `embedded-workspace-runtime.ts` creates `createWorkspaceRuntimeApp()` instances in a process-local `hosts` map.
4. Shutdown calls `shutdownEmbeddedWorkspaceRuntimes()`, disposing execution.
5. `server-workspace-pty-proxy.ts` separately bypasses runtime dispatch and reaches the process-global `Pty` map through `connectEmbeddedWorkspacePty()`.
6. The embedded composition injects callbacks, closures, and storage roots that the current env-only standalone boot does not reproduce.
7. The central local `/global/event` bus receives embedded compat events in-process; usage metering and session projections consume that same callback path.

#### C. Exact full-cut changes

- Replace `LocalWorkspaceRuntimePort -> ensureEmbeddedWorkspaceRuntime()` with `WorkspaceSupervisor -> SandboxManager -> LocalProcessDriver`.
- Replace the local PTY proxy's direct `Pty` access with a daemon-issued direct runtime connection descriptor.
- Use the existing local workspace event-stream support in `claxedo-events.tsx` as the canonical client topology and remove the older assumption that local execution only appears on the central stream.
- Replace embedded callbacks with an explicit local runtime host contract and durable runtime-to-daemon control-event outbox.
- Pin the existing Claxedo data roots explicitly in every standalone launch.
- Replace workspace-kind transport branching with target-access branching: loopback capability for local targets, relay token for remote targets.

### Review Disposition

| Review item | Disposition |
| --- | --- |
| Quiescent CPU is unreliable | Valid. Instrument repair/replacement and baseline sign-off move to mandatory Slice 0. |
| Terminal throughput already fluctuates below 20 MiB/s | Valid. Direct runtime WebSocket becomes the default local design; the proxy is no longer the default fallback. |
| Idle reclamation cannot repay peak RSS | Valid. Peak RSS remains a separate re-baselined gate requiring product sign-off; idle RSS is an additional metric, not a replacement. |
| Local client has no workspace stream | Partially stale in the current worktree: `claxedo-events.tsx` now opens local workspace streams. The older global-fetch path still treats local specially, so the plan makes the per-workspace stream canonical. |
| PTY bypasses runtime dispatch | Valid. The dedicated local PTY WebSocket path is now a primary change point and test surface. |
| Embedded-only options lack a process contract | Valid. A signed launch manifest, child-owned policy factory, and durable control outbox are a distinct implementation slice. |
| Default runtime paths orphan Claxedo history | Valid. Exact existing Claxedo roots are immutable launch inputs and data-continuity acceptance criteria. |
| Usage metering loses daemon-gap events | Valid. Usage and projection events use a durable acknowledged outbox, not transient SSE alone. |
| Local package boundary forbids supervisor dependencies | Valid. Shared supervisor extraction and SQLite lease-store relocation are mandatory, not conditional. |
| Hosted callers still use `LocalWorkspaceRuntimePort` | Valid. `signed-access.ts` and `hosts/workspace-runtime/session-env.ts` are named cutover sites. |
| Update has a connect-or-launch race | Valid. A durable update interlock and rollback generation are required before daemon shutdown. |
| `sandboxFetch` cannot literally have one transport path | Valid. It becomes target-access driven but still has loopback-direct and relay branches. |
| Per-workspace engine cost omitted | Valid direction, corrected mechanism: absent `opencodeUrl`, `OpenCodeHarnessAdapter` spawns an authenticated `opencode serve` child per workspace runtime; it does not embed SDK-next in every runtime. Its real RSS/start cost must be measured. |

### Key Decisions

- **Existing control plane remains supervisor.** No terminal supervisor or machine supervisor is introduced.
- **Shared supervisor package is mandatory.** Extract product-neutral supervisor mechanics into a package composed by both desktop-local and hosted products without importing hosted capability graphs.
- **Standalone runtime per active workspace.** Runtime process isolation provides workspace identity and ownership by construction.
- **Per-workspace OpenCode execution.** The runtime's `OpenCodeHarnessAdapter` owns and lazily spawns its authenticated OpenCode server child. The daemon's embedded engine may remain for daemon-owned global/catalog compatibility routes, but it must never own a workspace turn promised to survive daemon restart.
- **Direct local data plane.** PTY WebSockets and workspace SSE connect directly to the runtime with a daemon-minted, target-bound capability.
- **Durable control-event outbox.** Session projection, usage metering, turn outcomes, and diagnostics do not depend on an in-process callback or transient daemon connection.
- **Identical persisted roots.** The standalone host reuses the exact current Claxedo session, transcript, extension, and PTY-history locations. “No live-session migration” does not authorize history loss.
- **Bounded daemon update gap.** Active runtimes continue during a short daemon outage. An update interlock prevents Electron or another launcher from starting a third daemon during handoff.
- **Generation draining.** Existing runtimes remain on their installed generation until canonical active work is zero. New runtime starts use the new generation.
- **Clean removal.** Embedded ownership, process-global local PTY access, and silent clone continuation are deleted.

### Actors and Authorities

- **Client:** Renders state and reconnects. It owns no execution process.
- **Electron launcher:** Authenticates to or starts the daemon; observes update interlocks; does not parent or kill normal daemon execution.
- **Local control-plane daemon:** Owns product APIs, workspace authority, supervisor composition, lease storage, machine enrollment, relay tunnel, connection descriptors, projections, and usage ledger.
- **Workspace Supervisor:** Sole desired-state and idle-policy owner.
- **SandboxManager:** Sole lease, epoch, target, retry, and lifecycle implementation.
- **LocalProcessDriver:** Starts, inspects, touches, and explicitly stops standalone runtime processes.
- **Local runtime host:** Constructs every Claxedo-specific runtime option from a signed launch manifest and child-local policy implementations.
- **Workspace runtime:** Owns sessions, active turns, adapters, OpenCode/ACP/Codex harness children, PTYs, runtime events, and the durable control outbox.
- **Relay:** Carries authenticated runtime-owned traffic only.

### Requirements

#### R1. One lifecycle authority

- Supervisor policy and `SandboxManager` are the only desired-state and lease authority.
- Local placement is a driver, never another supervisor.
- No local `hosts` registry, independent idle timer, or second lease table remains.

#### R2. Standalone execution ownership

- Each active workspace has exactly one adopted workspace-runtime target per lease epoch.
- Runtime identity includes workspace ID, canonical directory, host ID, epoch, launch ID, binary generation, and protocol version.
- The runtime owns all workspace PTYs, adapters, turns, and harness children.
- OpenCode execution is spawned and leased by its runtime, not the daemon's shared embedded engine.

#### R3. Durable daemon ownership

- Electron uses authenticated connect-or-launch and is not the daemon's lifetime parent.
- App quit, crash, reload, and update do not signal runtimes.
- The daemon enforces one writer for its data directory and durable lease store.
- PID or port existence alone is never accepted as identity.

#### R4. LocalProcessDriver

- `ensureHost()` launches the versioned local runtime host detached from the daemon's lifetime and returns a loopback `SandboxTarget`.
- `inspect()` validates authenticated health, immutable identity, epoch, and launch ID.
- `touch()` reports liveness without manufacturing work activity.
- `stop()` runs only for an explicit supervisor stop/delete decision, never ordinary daemon shutdown.
- Persisted lease and launch metadata are sufficient for a replacement daemon to adopt a live runtime.

#### R5. Explicit local runtime host contract

- The daemon writes a versioned, owner-only launch manifest; the child validates it before binding.
- The manifest carries target identity, runner policy, store roots, transcript roots, agent-extension state root, PTY-history root, exposure, management capability, config revision, and diagnostics identity.
- `runtimeEventAuthorization` and transcript parent authorization are constructed inside the runtime against its own session store rather than shipped as callbacks.
- The host provides child-local equivalents for embedded `afterCreateSession`, `onTurnOutcome`, `onCompatEvent`, and `processObserver` through durable control-event/diagnostic protocols.
- Readiness is published only after all required paths and policies are active.

#### R6. Data continuity

- Runtime `storeRoot` remains `dataDir()/agent-core/<workspaceId>`.
- Transcript handles remain in the existing workspace store's `transcript-handles.db`.
- Agent Extension replay state remains under `agentExtensionStateRoot({ dataRoot: dataDir() })` for the same workspace identity.
- Existing Cursor transcript resolution remains unchanged.
- Existing PTY history location is inventoried before cutover and explicitly preserved.
- A pre-cutover persisted session, transcript handle, extension ledger, and terminal history remain readable without copying into `.workspace-runtime` defaults.

#### R7. Direct authenticated runtime transport

- The daemon returns a `RuntimeConnectionDescriptor` containing target URL, workspace ID, host ID, epoch, generation, protocol, expiry, and a short-lived capability.
- Local PTY WebSockets and workspace event SSE connect directly to that target.
- Capabilities are scoped to one target, workspace, role, and route family.
- Low-volume runtime HTTP may use a daemon proxy, but the proxy is not the default PTY/event data path.
- Cloud/user-hosted targets continue to use relay endpoints and runtime access tokens.
- Transport branches on target access (`loopback` or `relay`), not on a claim that networking is identical.

#### R8. Client reconnection

- Browser refresh and renderer replacement reconnect to the same runtime, session, and PTY identities.
- Reconnection reconciles authoritative runtime state before declaring work live, ended, or lost.
- Target/capability rotation resolves a fresh descriptor; it never clones a terminal to simulate continuation.

#### R9. Canonical event topology

- Local clients use the per-workspace runtime event stream already modeled by `claxedo-events.tsx`.
- The older global SDK event fetch path must not strip a known local workspace identity or route runtime events only through the central global bus.
- Central `/api/wr/events` remains for central events; it is not a fan-in substitute for workspace streams.
- Runtime SSE replay handles short client gaps; replay-gap frames require authoritative state refetch.
- Daemon restart recovery for projections and metering uses the durable outbox, not the finite in-memory SSE ring.

#### R10. Durable projections and usage metering

- The runtime appends control events with stable IDs and monotonic sequence numbers before publishing dependent public lifecycle events.
- Required events include session create/update, compat turn events, turn outcomes, and process/diagnostic ownership transitions.
- The daemon consumes from its last acknowledged sequence and persists consumer progress transactionally with each projection/usage effect.
- Redelivery is idempotent; event IDs/revisions prevent double charging and duplicate projection.
- Unacknowledged events survive daemon restart and compact only after all required consumers acknowledge them.
- `reconcileProvisionalOnStart` queries adopted runtimes before marking provisional turns `process_lost`; daemon restart alone is not process loss.

#### R11. Normal chat and harness continuity

- In-flight ordinary turns continue through client and daemon disconnect.
- Harness adapters and child servers remain in the workspace-runtime ownership tree.
- A replacement daemon adopts the runtime and drains durable control events before reporting projections current.
- Unexpected runtime death is explicit loss; saved state is never described as live continuation.

#### R12. App and daemon updates

- Daemon/runtime artifacts install under versioned paths; live resources are never overwritten in place.
- Before stopping the old daemon, the updater writes an authenticated durable interlock with current, desired, rollback generation, and expiry.
- Connect-or-launch callers observing the interlock wait for successor/rollback rather than launching another daemon.
- The old daemon closes listener, tunnel, and DB without stopping runtime targets, then exits with a controlled update code.
- The successor acquires the data lock, adopts leases, writes discovery, reconnects the tunnel, and clears the interlock.
- Failed successor readiness launches the recorded rollback daemon.
- A bounded control-plane/tunnel outage is allowed; active runtime execution continues.
- Runtime protocol support for an adopted live generation is operational update safety, not retention of the embedded path.

#### R13. Remote access without Electron

- Enrollment, credential refresh, heartbeat, and one machine relay tunnel live in the daemon.
- Remote enablement pins the daemon but not every runtime.
- Relay requests ensure/resolve the addressed runtime before forwarding runtime-owned routes.
- Disabling remote immediately removes external routing without terminating independent local work.

#### R14. Resource lifecycle

- Runtime activity includes active turns, live PTYs, held streams, and canonical runtime-reported work.
- Persisted history alone does not keep a runtime alive.
- Existing harness-specific reapers remain authoritative.
- Runtime stop requires supervisor grace plus authoritative no-active-work.
- Daemon exit requires remote disabled, no control clients, no update, and no active/held runtime lease.

#### R15. Isolation and authentication

- Loopback is not authentication.
- Installation capability storage is restricted to the owning OS user.
- One-runtime-per-workspace makes PTY ownership structural: a runtime cannot attach another runtime's PTYs.
- Every descriptor/request still validates workspace, host, epoch, generation, role, and route family.
- Nested paths do not establish PTY ownership; current `ownsPath()` authorization is deleted.

#### R16. Clean removal and package boundaries

- Delete embedded creation, `hosts`, embedded PTY connection, and execution disposal on listener shutdown.
- Delete/replace `LocalWorkspaceRuntimePort` in all callers, including `signed-access.ts` and `hosts/workspace-runtime/session-env.ts`.
- Move/extract the SQLite lease adapter from the hosted package into a local composition boundary.
- Deliberately update product-boundary policies, package manifests, closure ceilings, and architecture ownership.
- Remove automatic clone-on-missing-terminal continuation.

### Main Flows

#### F1. Start or connect to the daemon

1. Electron reads authenticated discovery and the update interlock.
2. During update it waits for successor or rollback.
3. With no valid daemon/interlock, it launches the installed daemon detached.
4. Daemon acquires data/lease ownership, starts control APIs, writes discovery, and restores optional remote access.

#### F2. Ensure a runtime

1. Control request resolves the workspace and calls shared supervisor/manager.
2. LocalProcessDriver inspects a target or writes a signed manifest and starts the versioned host.
3. Child opens exact Claxedo stores, constructs authorization/transcript/outbox policy, binds loopback, and publishes authenticated readiness.
4. Manager records target and daemon returns a connection descriptor.

#### F3. Direct terminal and event data

1. Client presents descriptor capability directly to runtime.
2. Runtime validates target identity and route scope.
3. PTY WebSocket and workspace SSE bypass daemon.
4. On expiry/reconnect, client resolves a fresh descriptor and reconciles state.

#### F4. Continue ordinary harness work

1. Runtime creates/reuses selected adapter and owns its child process.
2. OpenCode without external URL lazily starts an authenticated per-workspace `opencode serve` child and holds it for work/streams.
3. Runtime journals state and appends durable control events.
4. Client/daemon disconnect does not release runtime active work.

#### F5. Update the daemon

1. Updater installs versioned artifacts and writes interlock.
2. Old daemon shuts control/storage without stopping runtimes.
3. Successor or rollback acquires ownership, adopts targets, resumes outbox consumers, updates discovery, reconnects tunnel, and clears interlock.
4. Clients resolve fresh descriptors; old runtimes continue until idle.

#### F6. Reclaim resources

1. Harness reapers stop idle children, including per-workspace OpenCode server.
2. Supervisor stops runtime after no active PTY, turn, stream, or hold for full grace.
3. Daemon exits after pins reach zero and remote is disabled.

### Acceptance Examples

| ID | Scenario | Required result |
| --- | --- | --- |
| AE1 | Refresh during full-screen TUI | Direct runtime WebSocket reconnects to same PTY/process |
| AE2 | Quit/reopen Electron during Codex, ACP, or OpenCode work | Harness/turn continue and client resumes canonical state |
| AE3 | Kill/restart daemon during active TUI and turn | Runtime, harness, and PTY PIDs survive and are adopted |
| AE4 | Update daemon during active work | Interlock prevents third daemon; successor or rollback adopts targets |
| AE5 | Close Electron with remote enabled | Daemon/tunnel remain; inactive runtimes are not pinned |
| AE6 | Disable remote during local work | External routing closes; runtime continues |
| AE7 | Daemon gap exceeds SSE replay | Outbox restores projection/usage once; UI refetches on replay gap |
| AE8 | Existing history opens after cut | Session, transcripts, extension ledger, and terminal history use same paths |
| AE9 | Nested workspace presents parent PTY ID | Target identity rejects it regardless of path containment |
| AE10 | Stale PID is reused | Launch identity mismatch prevents adoption |
| AE11 | Runtime crashes | Work is marked lost; no replacement is presented as continuation |
| AE12 | Everything idles | Harness child, runtime, then daemon exit in order |
| AE13 | Terminal qualification | Direct runtime path passes Slice 0 signed gate across required replicates |
| AE14 | Daemon restarts during provisional usage | Adopted active turn is not marked lost; durable events settle it once |

---

## Performance Contract and Slice 0 Blocker

### Honest observed baseline

- Cold-ready median is approximately **1,868 ms**.
- Current shared embedded SDK-next engine has an approximately **840 ms** first-load wall and materially contributes to server RSS.
- Current server child is approximately **375-392 MiB** after engine use.
- Prior process split changed cold ready **1,875 -> 2,004 ms** and peak family RSS about **1,930 -> 2,060 MiB**, around **+116-130 MiB net**.
- `resource.peak_process_family_rss_mib` is a peak metric; later idle exit cannot reduce it.
- Terminal throughput valid-run spread is about **19.15-20.85 MiB/s**, so 20 MiB/s already fails intermittently.
- `resource.quiescent_cpu_p95_pct` is quantized and has wandered about **1-8%** on identical code.
- The default per-workspace spawned OpenCode server has a 30-second idle lifecycle, but its production RSS/start cost is unmeasured.

### Slice 0: prerequisite instrumentation and architecture spike

No implementation slice may claim performance acceptance until Slice 0 completes:

1. Replace/supplement quiescent CPU with precise per-process CPU-time sampling; publish repeatability and noise floor.
2. Stabilize terminal throughput instrumentation and publish at least five valid isolated control runs.
3. Retain peak family RSS and obtain explicit sign-off for its new threshold. Add daemon-only settled RSS and per-workspace incremental RSS; do not silently substitute them for peak.
4. Build a production-shaped standalone runtime with real host, PTY, SSE, and spawned OpenCode server.
5. Measure daemon-only RSS/CPU; runtime before harness; runtime plus each harness; cold/warm ensure/adoption; direct PTY throughput/input; direct SSE latency/reconnect; peak family RSS; and every idle exit.
6. Compare direct PTY/SSE with today's embedded path. Proxy results are diagnostic, not proposed architecture.
7. Record signed budgets and replicate rules in this plan before implementation.

### Provisional go/no-go rules

- Direct local PTY/event transport is mandatory unless measurement disproves it.
- No fixed per-workspace RSS is asserted before measuring the real spawned OpenCode server.
- Peak regression remains visible and requires sign-off; idle reclamation is not presented as repayment.
- CPU acceptance uses only the repaired instrument.
- Terminal acceptance uses a stabilized workload, signed non-inferiority margin, and absolute product floor.

---

## Implementation Slices and Effort

### Slice 0. Repair metrics and measure process shape

- Complete the performance prerequisite and record approved budgets.

**Estimate:** 5-8 engineer-days. **Blocks all later slices.**

### Slice 1. Extract shared supervisor and durable local lease adapter

- Create product-neutral supervisor package/composition over injected manager/store/driver.
- Move/reimplement SQLite lease adapter at local boundary.
- Update manifests, product-boundary policies, closure ceilings, and governance tests.

**Estimate:** 7-10 engineer-days.

### Slice 2. Build explicit local runtime host contract

- Add signed launch manifests and reconstruct every embedded option as child-local policy/protocol.
- Add durable sequenced control outbox and acknowledgement/compaction.
- Prove exact path continuity.

**Estimate:** 10-15 engineer-days.

### Slice 3. Add LocalProcessDriver and adoption

- Implement detached launch, readiness, inspect, touch, stop, process-tree handling, generation metadata, stale-PID rejection, and daemon-restart adoption.

**Estimate:** 6-10 engineer-days.

### Slice 4. Cut local transport to direct runtime capabilities

- Add descriptors, direct PTY, canonical local workspace SSE, target-access fetch branches, target rotation, and replay-gap reconciliation.

**Estimate:** 8-12 engineer-days.

### Slice 5. Move projections, usage, and diagnostics across boundary

- Consume/ack durable outbox with independent idempotent consumers.
- Preserve create ordering/title updates, usage reconciliation, and diagnostics without callbacks.

**Estimate:** 8-12 engineer-days.

### Slice 6. Durable daemon and remote ownership

- Add connect-or-launch, singleton/data lock, discovery, pin reasons, idle exit, logs/reset, secure host identity, heartbeat, refresh, and machine tunnel.

**Estimate:** 10-15 engineer-days.

### Slice 7. Versioned update and rollback

- Implement versioned artifacts, update interlock, controlled exit, successor/rollback, adoption, discovery swap, client wait/reconnect, and generation drain.

**Estimate:** 6-10 engineer-days.

### Slice 8. Delete legacy paths and qualify package

- Remove embedded ownership, port, PTY path, callbacks, parent watcher, and clone continuation.
- Update named callers and run packaged crash/update/remote/idle/security/performance qualification on macOS and Windows.

**Estimate:** 8-12 engineer-days.

### Total

- Sequential estimate: **68-104 engineer-days**.
- One experienced engineer: **14-21 weeks**.
- Conservative complete macOS/Windows qualification: **18-24 weeks**.
- Parallelism can shorten calendar time after Slice 0, but integration/qualification remain serial bottlenecks.

---

## Verification Matrix

### Contract tests

- One shared supervisor/lease lifecycle across local and hosted compositions.
- Driver ensure/reuse/inspect/stop/epoch/stale-PID behavior.
- Manifest validation and exact store-root derivation.
- Store/transcript/extension/PTY-history continuity.
- Outbox ordering, ack, crash recovery, compaction, and independent consumers.
- Usage redelivery never double-charges; adopted turn is not marked lost.
- Descriptors reject cross-workspace, wrong epoch/generation, expired, and wrong-route requests.
- PTY directly reaches runtime; local-server no longer imports process-global `Pty` state.
- Both client event paths open canonical local workspace stream and handle gaps.
- Target-access fetch covers loopback capability and relay token.
- Update interlock prevents third daemon and tests successor rollback.
- Architecture tests forbid embedded owner and second supervisor.

### End-to-end drills

1. Start TUI; refresh and reconnect to same PTY.
2. Start Codex, ACP, OpenCode turns; quit/reopen Electron; receive original results.
3. Terminate daemon during work; adopt same runtime/harness/PTY PIDs.
4. Leave daemon down beyond SSE retention; restore projection/usage once from outbox.
5. Update during work; prove interlock, successor/rollback, old runtime survival.
6. Enable remote, quit Electron, remotely start runtime, then prove independent reap.
7. Disable remote during local work; prove tunnel closes and work survives.
8. Crash runtime; prove explicit loss.
9. Open existing history after cut; prove no path divergence.
10. Idle all work; prove harness, runtime, daemon exit order.

### Required evidence

- Focused tests/typechecks for all changed packages.
- Product-boundary, closure, and architecture ownership checks.
- Packaged boot, connect-or-launch, update, rollback tests.
- Signed performance artifacts with raw per-process samples and replicates.
- Repository search proving embedded owners, path-based PTY auth, and clone fallback are absent.

---

## Scope Boundaries

### Included

- Browser/renderer reload; Electron quit/crash/restart/update; daemon crash/restart/update.
- Terminal/TUI and ordinary harness continuity.
- Direct authenticated local runtime data transport.
- Durable projection and usage delivery.
- Remote access without Electron.
- Runtime and daemon idle reclamation.

### Excluded

- Machine reboot, VM/sandbox destruction, or cross-machine migration.
- Survival of unexpected workspace-runtime crash.
- Migration of already-live embedded processes at release boundary.
- Parallel embedded fallback, PTY FD transfer, per-terminal keeper, or permanently resident remote workspaces.

---

## Primary Code Changes

- `packages/claxedo-desktop/src/main/index.ts` — connect-or-launch, update wait, no ordinary server kill.
- `packages/claxedo-desktop/scripts/claxedo-server-entry.ts` and `claxedo-server-startup.ts` — daemon discovery/interlock, no parent-death ownership.
- `packages/claxedo-local-server/src/app/start-local-server.ts` — shared supervisor/lease and outbox consumers.
- `packages/claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts` — extract reusable child policy, then delete.
- `packages/claxedo-local-server/src/deployments/local/server-workspace-pty-proxy.ts` — replace direct `Pty` access and delete local special path.
- `packages/claxedo-server-core/src/workspace/local-runtime-port.ts` — remove after caller cutover.
- `packages/claxedo-server-core/src/workspace/http/sandbox-target-fetch.ts` — target-access transport.
- `packages/claxedo-server/src/workspace/signed-access.ts` — remove local runtime port fan-out.
- `packages/claxedo-server/src/hosts/workspace-runtime/session-env.ts` — remove embedded requester.
- `packages/claxedo-server/src/workspace/supervisor/*` — extract neutral lifecycle.
- `packages/claxedo-server/src/sandbox/stores/sqlite.ts` and SQL — relocate local lease adapter.
- `packages/sandbox-manager/src/drivers/` — local process driver.
- New local runtime host entry/package — manifest, child options, exact roots, outbox.
- `packages/claxedo-app/src/app/providers/global-sdk-event-fetch.ts` — preserve known local identity.
- `packages/claxedo-app/src/app/integrations/claxedo-events.tsx` — canonical local stream/direct descriptors.
- `packages/claxedo-app/src/features/terminal/providers/` — direct descriptor, rotation, no clone.
- Product-boundary policies, manifests, and ownership tests — intentional graph update.

---

## Sources and Evidence

- `packages/claxedo-server/src/workspace/supervisor/index.ts` — existing authority.
- `packages/sandbox-manager/src/index.ts` — manager/driver contract.
- `packages/claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts` — hosts, callbacks, roots, bus bridge, direct PTY access.
- `packages/claxedo-local-server/src/deployments/local/server-workspace-pty-proxy.ts` — separate PTY path.
- `packages/workspace-runtime/src/server.ts` — standalone options unavailable through env-only boot.
- `packages/workspace-runtime/src/env.ts` — divergent defaults unless pinned.
- `packages/workspace-runtime/src/routes/events.ts` and `runtime-events.ts` — finite SSE replay/gaps.
- `packages/agent-sdk-runtime/src/harnesses/opencode/process.ts` — per-workspace OpenCode server and 30-second idle lifecycle.
- `packages/claxedo-local-server/src/app/start-local-server.ts` — in-process projection/usage consumers.
- `packages/claxedo-server-core/src/usage/turn-meter.ts` — provisional restart behavior.
- `packages/claxedo-app/src/app/providers/global-sdk-event-fetch.ts` — older local global assumptions.
- `packages/claxedo-app/src/app/integrations/claxedo-events.tsx` — current local workspace stream support.
- `script/product-boundary/policies/local-server.ts` and `desktop.ts` — dependency prohibitions/ceilings.
- `docs/perf/u11-qualification-status.md` and `docs/perf/HANDOFF.md` — CPU, terminal, split, peak-RSS evidence.

---

## Completion Standard

Complete only when:

1. Slice 0 yields repeatable instruments and approved budgets.
2. Active TUI and ordinary turns survive Electron and daemon replacement through packaged entrypoints.
3. Local PTY/events use direct authenticated runtime transport.
4. Projection/usage recover exactly once after gaps beyond SSE retention.
5. Existing persisted local history/ledgers remain at identical paths.
6. Remote works with Electron closed while inactive runtimes stay stopped.
7. Runtime then daemon idle reclamation occurs in order.
8. Update uses interlock and successor/rollback without terminating runtimes.
9. Signed peak, steady, CPU, terminal, event, and runtime-start gates pass.
10. Embedded ownership, path PTY auth, `LocalWorkspaceRuntimePort`, second lifecycle policy, and silent continuation fallback are absent.

