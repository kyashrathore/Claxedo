---
title: Durable Claxedo Local Server Daemon - Plan
type: feat
date: 2026-08-27
topic: durable-local-server-daemon
artifact_contract: ce-unified-plan/v1
artifact_readiness: ready-for-execution
product_contract_source: conversation-and-codebase-research
execution: code
supersedes: docs/plans/2026-08-27-0144-feat-durable-local-control-plane-plan.md
---

# Durable Claxedo Local Server Daemon - Plan

## Goal Capsule

- **Objective:** A browser reload, Electron restart, or desktop update must not terminate an active terminal, TUI, native harness process, or model turn while the machine and the local daemon remain alive.
- **Means:** Make the existing `claxedo-local-server` process the one durable local daemon. It already owns the process-global PTY registry and the embedded workspace runtimes that own adapters and active turns.
- **Clean cut:** Remove Electron-parent lifetime coupling and Electron-only remote-access ownership. Do not retain sidecar-kill IPC, parent watchdogs, unsafe port adoption, or a second local execution mode.
- **Survival boundary:** Work survives loss and replacement of browser/Electron clients. It does not survive destruction or an unexpected crash of the daemon process or machine.
- **Update rule:** Updating Electron may replace the client immediately. Replacing the daemon is deferred until its authoritative activity summary says there is no volatile work, unless the user explicitly chooses interruption.
- **Estimated effort from the current branch:** **6-8 engineer-weeks** for the full cut and macOS qualification; **8-11 engineer-weeks** including Windows process/update qualification. The daemon bootstrap already implemented in this branch removes roughly one week from the estimate. Core reload/restart continuation alone is approximately **3-4 weeks**; remote access, safe update draining, and cross-platform qualification make up the remainder.

## Direct Answer

Yes: daemonizing `claxedo-local-server` is the smallest correct architecture.

The earlier standalone-runtime proposal is unnecessary. In the current code, `packages/claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts` keeps a process-wide `hosts` map. Each entry is a real `createWorkspaceRuntimeApp()` whose `WorkspaceHost` owns adapter instances and active-turn scopes. `@claxedo/workspace-runtime` also owns the process-global `Pty` registry. Keeping that one process alive therefore keeps both kinds of work alive.

The hosted control plane remains unchanged. Its `WorkspaceSupervisor` and `SandboxManager` are deployment orchestration for hosted/self-hosted runtimes; reproducing them locally would duplicate policy without improving desktop restart survival.

```text
browser / Electron renderer
        |
        | HTTP + SSE + WebSocket
        v
durable claxedo-local-server daemon
        |
        +-- local control-plane routes and stores
        +-- embedded runtime hosts map
        |     +-- adapters and active model turns
        |     +-- harness child processes and their existing idle reapers
        +-- process-global PTY registry
        |     +-- PTY processes, replay buffers, TUI mode state
        +-- machine remote-access connector (after cutover)
        +-- daemon discovery, lifecycle pins, update drain, diagnostics

Electron is a replaceable client and launcher. It is not the process owner.
```

## Requirements

### Functional

1. **Reload continuation:** Reloading the renderer reconnects to the same PTY ID and session ID. A TUI preserves input, resize, cursor replay, alternate-screen mode, and new output produced while disconnected.
2. **Desktop continuation:** Quitting or restarting Electron leaves the daemon and its active work alive. The new Electron instance authenticates and adopts the same daemon instead of spawning a duplicate.
3. **Active-turn continuation:** Disconnecting every UI client while a native harness turn is running neither aborts the turn nor disposes its adapter. Reconnection obtains missed events through SSE replay or canonical state refetch and can continue the same session.
4. **App update continuation:** `autoUpdater.quitAndInstall()` may replace Electron while the current daemon continues from an immutable staged artifact. Daemon replacement waits for a safe drain point.
5. **Remote access without Electron:** After the user enables remote access, its connector and heartbeat remain active under the daemon after every Electron window and process exits.
6. **Idle reclamation:** Persisted history alone does not keep processes alive. Existing per-harness reapers run first; the daemon exits after an idle grace period only when no authoritative lifecycle pin remains. A running user-owned PTY/TUI is work, even while detached, and remains alive until its process exits or the user closes it.
7. **One daemon:** Concurrent desktop launches use an authenticated discovery record plus a launch lock/single-flight start. Port availability alone never establishes ownership.
8. **Honest failure:** Daemon loss is shown as execution loss. The product may restore persisted history, but it must not label a respawned process or synthesized transcript as continuation.

### Lifecycle pins

The daemon is active while any of these canonical conditions is true:

- `Pty.listDetailed()` contains a committed user terminal whose process is live and non-removed;
- any embedded `runtime.host.checkpoint.detail().activeTurns` is greater than zero;
- a runtime adapter or engine reports an existing activity lease during its configured idle window;
- at least one authenticated client lease is current;
- remote access is enabled or the Host Connector is enrolling, heartbeating, or revoking;
- an update transition, checkpoint, migration, or diagnostics operation is in progress.

`hosts.size`, stored sessions, transcript files, and an open browser window are not independently sufficient pins. The daemon lifecycle must consume the authoritative counts above rather than infer activity from renderer state.

Pins have two effects and must not be flattened into one boolean:

- **Residency pins** prevent idle exit. Live user PTYs, active turns, active adapter leases, current clients, remote enablement, and lifecycle operations are residency pins.
- **Replacement blockers** prevent daemon binary replacement because their in-memory state cannot move. Live PTYs, active turns/writes, and checkpoints are replacement blockers. A client lease and an established remote tunnel are not: clients can reconnect, and the tunnel can be deliberately re-established by a ready successor.

PTY creation also gains an explicit ownership state. A route-created terminal becomes `committed` once its canonical terminal record is returned to the client; it remains a residency pin across subscriber loss. A PTY that never commits, loses its creator during creation, or has already exited remains eligible for bounded orphan cleanup. The current `managed` bit and 60-second subscriber-based orphan timer are not sufficient to express this distinction and must not be reused as a hidden approximation.

### Non-functional

- Discovery credentials and identity files remain owner-only (`0600`) and bearer comparison remains constant-time.
- The daemon bearer never appears in URLs or logs. Electron passes a scoped, expiring client credential through preload; browser-only clients obtain an equivalent HttpOnly, SameSite session after local user authorization. Client credentials can renew leases but cannot read the discovery token or perform daemon update/termination operations.
- The discovery record contains protocol version, running build ID, desired build ID, generation, PID, port, token, and start time.
- A stale PID or a different process on the same port cannot be adopted or killed.
- Cold startup regression budget: no more than 5% relative to the valid pre-change shell baseline, with profiler variance reported.
- Warm adoption must be faster than cold startup and must report daemon RSS separately and in the combined total.
- An idle daemon must eventually release its measured roughly 375 MiB resident set by exiting; remote-enabled mode is an explicit exception and must report its steady-state cost.

## Current Code Flow

### A. Desktop launch and adoption

1. `packages/claxedo-desktop/src/main/index.ts` starts desktop initialization.
2. The current branch reads an owner-only discovery file via `server-daemon-discovery.ts` and authenticates `GET /api/claxedo/daemon` with the discovery bearer token.
3. If the record and live response agree on service, protocol, generation, PID, port, and token, Electron adopts that URL.
4. Otherwise Electron forks `scripts/claxedo-server-entry.ts` with a new generation and token.
5. The child starts `startLocalServer()`, publishes discovery only after listening, disconnects its Electron IPC channel, and remains detached.
6. Ordinary `shutdown()` in `main/index.ts` now disposes Electron-owned UI services but does not terminate the local server.

**Observed gap:** check-then-spawn is not yet protected by a launch lock. Two simultaneous clients may race. Discovery also lacks running/desired artifact identity and a stable staged bundle.

### B. Terminal and TUI ownership

1. A local PTY route reaches `connectEmbeddedWorkspacePty()` in `embedded-workspace-runtime.ts`.
2. It validates that the PTY belongs to the requested workspace and calls process-global `Pty.connect()`.
3. `packages/workspace-runtime/src/pty/index.ts` retains up to 2 MiB of replay, emits cursor metadata, tracks live TUI mode, accepts resize/input after reconnect, and currently starts an orphan timer after the final subscriber leaves for unmanaged PTYs.
4. `packages/claxedo-app/src/features/terminal/ui/terminal.tsx` chooses cursor replay for TUI/alternate-screen state and tail attachment for an already-hydrated normal shell.

**Result:** keeping the local-server daemon alive preserves the real PTY process and its existing reconnection state. No terminal-specific daemon split is needed. The subscriber-based orphan policy must change before this is a complete promise, or a detached user TUI will still be destroyed after the current default 60-second timeout.

### C. Native harness turn ownership

1. A local session mutation dispatches through the embedded workspace runtime.
2. `ensureEmbeddedWorkspaceRuntime()` creates or returns the runtime held in the process-wide `hosts` map.
3. `packages/workspace-runtime/src/workspace/runtime.ts` creates an active-turn scope and holds it in `activeTurns` for the chosen adapter until the turn completes or is explicitly aborted.
4. The live app dispatches through `prompt_async` (`packages/claxedo-app/src/features/session/submit/dispatch.ts`), whose route starts the turn in a detached async task and returns `204`; it does not bind the turn's abort signal to the request connection.
5. The adapter owns the native harness process. Existing lifecycle logic in `packages/agent-sdk-runtime/src/harnesses/shared/process-lifecycle.ts` and adapter-specific implementations reaps idle processes without tying them to Electron.
6. Compat events are bridged to the daemon's central event bus. `packages/claxedo-local-server/src/opencode/compat-routes/events.ts` serves event IDs, `Last-Event-ID` replay, and explicit replay-gap notices.

**Result:** loss of a renderer does not need a new harness process. It only requires the next client to resume the event stream and refetch canonical session state when replay retention was exceeded.

### User-visible lifecycle states

- **Reconnecting:** the UI has lost its local-server stream and is re-reading authenticated discovery; input that cannot be safely retried is disabled.
- **Continued:** the same daemon generation and same PTY/session identity were reattached. This is the normal reload/restart result.
- **Update pending:** a newer daemon artifact is staged, but live PTYs or active turns are blocking replacement. Work continues on the running build.
- **Recovered history:** the previous daemon or OS process is gone and only persisted transcript/history could be loaded. The UI must not call this continued.
- **Remote active:** Electron may be absent; the status names the daemon build, tunnel health, last successful renewal, and remote-only memory mode.
- **Idle grace:** no residency pin remains and the daemon is scheduled to exit; new local work cancels the countdown.

### D. Remote access today

1. `packages/claxedo-desktop/src/main/index.ts` constructs `setupElectronHostConnector()`.
2. `electron-child.ts` resolves and forks the Host Connector artifact through Electron `utilityProcess.fork`.
3. `child-supervisor.ts` owns identity bootstrap, account-operation requests, heartbeat state, stop, and revoke.
4. Renderer operations cross `registerHostConnectorIpc()` and status changes return through `status-channel.ts`.
5. Electron `shutdown()` calls `hostConnector.dispose()`, so remote access cannot outlive the app.

The current Host Connector only enrolls and heartbeats. It does not open the relay host tunnel. The reusable data-plane client already exists as `startWorkspaceRelayHostTunnel()` in `packages/workspace-runtime/src/workspace-relay-host-tunnel.ts`, and the self-hosted composition already wraps it for machine-wide registration in `packages/claxedo-server/src/user-hosted-tunnel.ts`.

**Change point:** the local daemon supervises the small Host Connector child, while that child owns the machine private key, enrollment heartbeat, and a composition of the existing `startWorkspaceRelayHostTunnel()` primitive. This preserves the package's narrow trust boundary: the key does not move into the large local-server process, and the child still listens on no inbound socket. Initial enable remains an explicit signed-in user action. After enrollment, a new host-key-authenticated renewal endpoint mints heartbeat/Host Tunnel Tokens without an account bearer, so Electron and the user's refresh token are not liveness dependencies. The private machine key moves from Electron `safeStorage` into an OS credential-store adapter usable by the standalone child; because this is a pre-user full cut, the existing Electron-encrypted identity is deleted and the machine is re-enrolled rather than migrated.

### E. App update today

1. `installUpdate()` calls `autoUpdater.quitAndInstall()`.
2. Electron's shutdown no longer kills the daemon in the current branch.
3. The daemon executable and lazy-loaded chunks still originate from the installed app resources tree.

**Observed gap:** the updater may replace that tree while the old daemon still runs. The daemon therefore needs an immutable, versioned copy under the user data directory before the app can claim update safety.

## Superset Comparison

The inspected Superset implementation uses a detached per-organization `pty-daemon`, an owner-only socket manifest, authenticated adoption, reconnect replay, crash budgets, and an FD-handoff successor protocol. Those are strong patterns for identity, adoption, and terminal continuity.

Its own `apps/desktop/docs/HOST_SERVICE_LIFECYCLE.md` states that in-flight chat does **not** survive Host Service replacement. That split is correct for Superset because only PTYs live in its daemon. It is not the right split here: Claxedo's current local server already contains both `Pty` and `WorkspaceHost.activeTurns`.

Use from Superset:

- authenticated manifest adoption and PID safety;
- single-flight startup and stale-manifest recovery;
- explicit protocol/build negotiation;
- detached file logging and crash-loop budget;
- sequence-based reconnect, replay-gap handling, and redraw tests;
- staged successor readiness and rollback.

Do not copy:

- a PTY-only daemon boundary;
- per-workspace local process supervision;
- FD handoff as a claim that arbitrary JavaScript adapter state or active model turns can migrate between daemon binaries.

## Implementation Units

### Unit 1 — Finish daemon identity and singleton launch

**Files:**

- `packages/claxedo-desktop/src/main/server-daemon-discovery.ts`
- `packages/claxedo-desktop/src/main/index.ts`
- `packages/claxedo-desktop/scripts/claxedo-server-entry.ts`
- new `packages/claxedo-local-server/src/daemon/identity.ts`
- new `packages/claxedo-desktop/src/main/server-daemon-launch-lock.ts`

**Work:**

- Keep the implemented detached launch, authenticated discovery endpoint, conditional record cleanup, and removal of parent watchdog/kill IPC.
- Move the shared discovery schema and verification contract into a runtime-neutral package location so desktop and daemon do not duplicate parsing.
- Add an owner-only exclusive launch lock. A loser waits for the winner's authenticated ready record; it does not choose another port and create a second daemon.
- Add `runningBuildId`, `desiredBuildId`, and protocol compatibility fields.
- Verify PID start identity where the platform provides it before signaling a stale process.
- Write daemon stdout/stderr to bounded rotating logs in the daemon data directory after Electron IPC disconnects.

**Acceptance:** two simultaneous launcher processes yield one daemon PID; malformed, stale, wrong-token, wrong-build, and port-reuse records fail closed; a failed starter releases the lock.

### Unit 2 — Make lifecycle state authoritative and idle the daemon

**Files:**

- `packages/workspace-runtime/src/workspace/host.ts`
- `packages/workspace-runtime/src/workspace/runtime.ts`
- `packages/workspace-runtime/src/pty/index.ts`
- `packages/claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts`
- new `packages/claxedo-local-server/src/daemon/activity.ts`
- new `packages/claxedo-local-server/src/daemon/lifecycle.ts`
- `packages/claxedo-local-server/src/app/local-app.ts`

**Work:**

- Add a read-only runtime activity snapshot containing active turns, active writes, adapter leases, and last activity. Preserve `WorkspaceHost.checkpoint.detail()` as the source of turn/write counts.
- Add explicit `provisional`/`committed` PTY ownership and a PTY activity snapshot based on the existing session records rather than a second PTY registry. Subscriber loss alone does not reap a committed live terminal; the current orphan timer remains for provisional/failed creation and exited cleanup.
- Aggregate runtime, PTY, client, remote, and update pins in one daemon lifecycle state machine.
- Add authenticated client lease/renew/release endpoints. Lease expiry handles crashed clients.
- Start an idle grace timer only at zero pins. Cancel it on the first new pin. On expiry, stop accepting work, recheck, close stores/listeners, conditionally clear discovery, and exit.
- Preserve existing adapter idle timers. Narrow the PTY orphan timer to provisional/failed creation and exited cleanup so it cannot kill a committed detached TUI.

**Acceptance:** a live turn, committed PTY, remote heartbeat, update, or fresh client lease prevents exit; persisted sessions do not; a detached committed TUI remains alive beyond the old 60-second timeout; zero-pin daemon exits and releases RSS; work arriving during grace cancels exit without loss.

### Unit 3 — Qualify terminal/TUI continuation through real entrypoints

**Files:**

- `packages/claxedo-desktop/scripts/claxedo-server-boot.test.ts`
- `packages/workspace-runtime/src/pty/index.test.ts`
- `packages/claxedo-app/src/features/terminal/core/integration/terminal-pipeline.test.ts`
- `packages/claxedo-app/e2e/playwright/core-terminal.spec.ts`
- new packaged desktop daemon-restart test under `packages/claxedo-desktop/scripts/`

**Work:**

- Keep the implemented real proof that a PTY survives launcher IPC disconnect, retains its ID, replays output, and accepts new input.
- Add a full renderer reload test with a real alternate-screen TUI fixture, cursor resume, resize, focus, and redraw.
- Add Electron process replacement: launch app A, start PTY, quit A, launch app B, verify the same daemon PID/PTY ID and bidirectional TUI operation.
- Verify a committed PTY does not enter orphan timing merely because all clients detach. Verify provisional/failed creation and exited-terminal cleanup remain bounded.
- Treat a newly spawned PTY with restored transcript as recovery, not continuation, and expose that distinction in UI state.

**Acceptance:** same PID, same PTY ID, same child process, correct TUI screen, and new commands after reload/restart on macOS and Windows.

### Unit 4 — Qualify ordinary chat/harness continuation

**Files:**

- `packages/workspace-runtime/src/workspace/runtime.test.ts`
- `packages/claxedo-local-server/src/deployments/local/embedded-workspace-runtime.test.ts`
- `packages/claxedo-local-server/src/opencode/compat-routes/events.test.ts`
- `packages/claxedo-app/src/app/integrations/claxedo-events.tsx`
- new desktop daemon harness-continuation integration test under `packages/claxedo-desktop/scripts/`

**Work:**

- Run a deterministic long turn through the public local-server session route, disconnect every client and Electron IPC channel, then reconnect from a fresh client.
- Assert the same runtime host, adapter process, session, and turn complete without abort/restart.
- Resume central SSE with `Last-Event-ID`; on `stream.replay-gap`, refetch session/messages/status from canonical stores before resuming live events.
- Test permission requests and tool calls that become pending while no renderer is attached; they remain pending and visible after reconnect.
- Confirm explicit user abort and daemon idle drain still propagate to the real adapter.

**Acceptance:** a native Codex/Claude/Cursor/OpenCode test matrix demonstrates same-session active-turn completion across renderer and Electron replacement. No synthetic completion or second harness process is accepted.

### Unit 5 — Complete machine remote access under the daemon

**Files:**

- `packages/claxedo-host-connector/src/connector.ts`
- `packages/workspace-runtime/src/workspace-relay-host-tunnel.ts`
- extract the deployment-neutral parts of `packages/claxedo-server/src/user-hosted-tunnel.ts` instead of importing its hosted `WorkspaceSupervisor` dependencies
- move reusable ownership from `packages/claxedo-desktop/src/main/host-connector/child-supervisor.ts` and `child-protocol.ts` into `packages/claxedo-local-server/src/host-connector/`
- `packages/claxedo-desktop/src/main/index.ts`
- `packages/claxedo-desktop/src/main/host-connector/electron-child.ts`
- `packages/claxedo-desktop/src/main/host-connector/ipc.ts`
- `packages/claxedo-desktop/src/renderer/remote-access/electron-machine-remote-access.ts`
- `packages/claxedo-local-server/src/app/local-app.ts`
- hosted enrollment/renewal routes and authority adapters under `packages/claxedo-server/src/routes/hosted/` and `packages/claxedo-server-core/src/platform/auth/`

**Work:**

- Start with a two-day platform spike that proves a daemon-readable OS credential store on macOS Keychain, Windows Credential Manager, and Linux Secret Service. Missing secure storage fails closed; no plaintext/file-key fallback is allowed.
- Make the daemon supervise the Host Connector child and own its crash budget, projected status, and remote lifecycle pin. Make the child own machine identity, enrollment heartbeat, and the existing relay Host Tunnel client. Keep the connector as a client; do not make it a second listening server.
- Replace renderer Electron IPC operations with authenticated local-server operations and an SSE status stream.
- Keep machine display-name selection and enrollment intent explicit; starting the daemon does not enroll a machine.
- Keep user authentication only on initial enable/revoke operations. Add a host-key-authenticated control-plane renewal operation that verifies the enrolled public key and returns the next heartbeat expiry plus a short-lived Host Tunnel Token scoped to the current canonical local workspace IDs. The daemon never receives or stores the user's account access/refresh tokens.
- Compose `startWorkspaceRelayHostTunnel()` in the child against daemon-supplied, authenticated local-server workspace runtime-dispatch URLs. Extract only the reusable registration/routing policy from `claxedo-server/src/user-hosted-tunnel.ts`; do not import or duplicate its hosted `WorkspaceSupervisor`/`SandboxManager` ownership.
- Delete the old Electron `safeStorage` machine identity on cutover and require one explicit re-enrollment. There is no compatibility reader or dual identity store.
- Remove `hostConnector.dispose()` from Electron shutdown and delete the Electron-only connector path after the daemon route is complete.
- When remote access is enabled, idle shutdown is disabled. Revocation removes the pin and permits normal grace shutdown.

**Acceptance:** enable remote access, close Electron completely, connect remotely through a real Relay and use a local workspace, observe host-key-authenticated token renewal without an account bearer, reopen Electron to the same status, then revoke and verify tunnel termination plus eventual daemon exit. Security tests reject a stolen discovery token, wrong machine key, expanded workspace set, expired Host Tunnel Token, and missing OS credential store.

### Unit 6 — Stage immutable daemon artifacts and drain updates

**Files:**

- `packages/claxedo-desktop/scripts/bundle-claxedo-server.ts`
- `packages/claxedo-desktop/scripts/claxedo-server-startup.ts`
- `packages/claxedo-desktop/src/main/index.ts`
- new `packages/claxedo-desktop/src/main/server-daemon-artifact.ts`
- new `packages/claxedo-local-server/src/daemon/update.ts`

**Work:**

- Before launch, verify the packaged server manifest and copy/link its complete bundle into `<userData>/daemon/artifacts/<build-id>/` using atomic staging.
- Launch only from the immutable staged directory. Never depend on app resources after ready.
- On a new app version, publish `desiredBuildId` to the running daemon. If pins exist, report `update-pending` and continue serving from the old artifact.
- At zero replacement blockers, stop accepting new work, recheck activity, flush stores, and self-launch the staged successor on a new loopback port. Client and remote residency pins do not block this controlled reconnect. If no residency pin exists, the daemon may instead exit and let the next launcher start the desired build.
- Require successor authenticated readiness on its new port before atomically replacing discovery. After the swap, the predecessor closes its listener and exits; local clients and the remote tunnel reconnect to the successor. On failure, keep the predecessor serving and record the error.
- Make the daemon the only owner of local-store schema migration. Run migrations after replacement blockers drain and before successor readiness; use the existing store transaction/backup facilities where available, retain the previous artifact until migration verification completes, and classify an irreversible schema change as an explicit update blocker rather than pretending binary rollback is safe.
- Retain the running, desired, and last-known-good artifacts; garbage-collect older unreferenced versions only after process identity checks.

**Acceptance:** Electron updates while a PTY and harness turn are active; both continue on the old daemon. After work drains, the new daemon becomes ready on a new port and discovery changes atomically. A corrupt successor or failed reversible migration leaves the old daemon usable. An irreversible migration is refused before mutation unless its forward-only policy was explicitly approved. No lazy import references the replaced app tree.

### Unit 7 — Move diagnostics to daemon-aware transport and qualify performance

**Files:**

- `packages/claxedo-desktop/src/main/diagnostics/profiler.ts`
- `packages/claxedo-desktop/scripts/claxedo-server-entry.ts`
- `packages/claxedo-local-server/src/app/local-app.ts`
- diagnostics UI consumers under `packages/claxedo-app/src/`
- benchmark scripts under `packages/claxedo-desktop/scripts/`

**Work:**

- Replace the now-inert post-detach IPC diagnostics sender with authenticated daemon diagnostics endpoints/events.
- Add daemon PID/build/activity/update state to desktop diagnostics.
- Make the profiler discover and sample the authenticated daemon even when it is no longer in Electron's process tree.
- Record cold launch, warm adoption, daemon-only idle, remote-enabled idle, peak combined RSS, CPU, event-loop delay, terminal throughput, and reconnect latency.
- Repair the existing full-lane benchmark that fails to reach its selector on the unchanged baseline; do not silently substitute shell-lane numbers for full-app acceptance.

**Acceptance:** no benchmark excludes the daemon from totals; warm adoption and cold startup meet signed budgets; zero-pin expiry shows the daemon RSS returning to zero; diagnostics remain available after Electron replacement.

### Unit 8 — Delete replaced ownership and enforce the architecture

**Files:**

- `packages/claxedo-desktop/src/main/index.ts`
- `packages/claxedo-desktop/src/main/ipc.ts`
- `packages/claxedo-desktop/src/preload/index.ts`
- `packages/claxedo-desktop/src/preload/types.ts`
- `packages/claxedo-desktop/src/renderer/restart.ts`
- architecture scanner tests in desktop/local-server packages

**Work:**

- Keep removal of `kill-sidecar` and desktop-parent watchdog variables.
- Remove Electron Host Connector ownership and IPC after Unit 5.
- Remove all port-only local-daemon adoption and every ordinary app-shutdown server kill path.
- Add scanners that fail if Electron re-acquires daemon-owned PTY, active-turn, remote, or update lifecycle responsibilities.
- Update product and operations documentation with the survival boundary, idle behavior, update-pending state, logs, and recovery steps.

**Acceptance:** repository search finds one local process owner, one discovery contract, one remote connector owner, and no fallback lifecycle.

## Security Review Contract

The three highest-impact threats and required mitigations are:

1. **A local process steals discovery and controls the daemon.** Keep discovery and logs owner-only, use a high-entropy token, never place it in URLs, mint narrower client credentials, compare secrets in constant time, bind to loopback, and rotate the discovery generation on replacement.
2. **A compromised renderer keeps the daemon alive or reaches privileged lifecycle operations.** Separate client-lease scope from update/termination scope, validate Electron callers before credential minting, use HttpOnly/SameSite browser sessions, enforce origin/CSRF checks on mutations, and rate-limit lease creation/renewal.
3. **A stolen machine identity expands remote workspace access.** Store the private key only in the OS credential store, sign canonical challenges, scope each Host Tunnel Token to the authoritative workspace set and short expiry, reject registration expansion without a fresh signed renewal, and make revoke close the live tunnel immediately.

Daemon diagnostics redact discovery tokens, client credentials, machine private keys, account credentials, Host Tunnel Tokens, prompt bodies, and terminal contents. Security tests inspect persisted files and logs as well as HTTP responses.

## Delivery Order

1. Complete Units 1-2 together so the detached process is both singleton-safe and reclaimable.
2. Execute Units 3-4 before remote/update work; these are the core user promises and prevent architecture drift.
3. Execute Unit 5 so remote access becomes a real daemon pin and Electron can disappear.
4. Execute Unit 6 after lifecycle pins exist; safe update decisions depend on their authoritative zero state.
5. Execute Units 7-8 and run packaged qualification.

Each unit is independently reviewable, but the feature is not shippable until all eight are complete. The current branch's detached bootstrap is a foundation, not the finished lifecycle.

## Verification Matrix

| Event | PTY/TUI | Active harness turn | Remote access | Expected daemon action |
| --- | --- | --- | --- | --- |
| Browser reload | same process/ID, replay and redraw | continues; SSE resumes/refetches | unchanged | none |
| Electron quit | same process/ID | continues | heartbeat continues | client lease expires; other pins remain |
| Electron restart | adopted by authenticated identity | same runtime/adapter/session | status rehydrates | renew client lease |
| Electron update | continues on staged old build | continues on staged old build | continues | mark desired build; defer daemon replacement |
| Final committed PTY exits/closes | removed normally | unaffected | unaffected | recompute pins |
| Final turn completes | unaffected | adapter follows existing idle reaper | unaffected | recompute pins |
| Remote revoked and no local work | none | none | connector/tunnel stop | start idle grace, then exit |
| Daemon crashes | lost | lost | lost | report execution loss; next launch starts cleanly |
| Machine/VM destroyed | lost | lost | lost | out of survival scope |

## Measurements Already Collected

The unchanged branch's valid shell lane established:

- ready: 6,673 ms;
- post-renderer session list: 1,460 ms;
- peak tree RSS: 1,703.5 MiB;
- settled tree RSS: 1,677.3 MiB;
- main-process peak RSS: 198.1 MiB.

After the detached daemon bootstrap, the same cold shell lane measured:

- ready: 6,900 ms (`+3.4%`);
- post-renderer session list: 1,513 ms;
- peak tree RSS: 1,651.9 MiB;
- settled tree RSS: 1,588.6 MiB;
- main-process peak RSS: 197.9 MiB.

After authoritative PTY/turn activity, authenticated client leases, idle exit,
and descriptor detachment were implemented, two fresh-profile cold shell runs
measured:

- ready: 6,082 ms and 7,399 ms;
- post-renderer session list: 1,186 ms and 2,612 ms;
- peak tree RSS: 1,699.8 MiB and 1,709.2 MiB;
- settled tree RSS: 1,683.7 MiB and 1,674.0 MiB;
- main-process peak RSS: 198.3 MiB and 198.2 MiB.

The paired authenticated warm adoption measured 4,390 ms ready and 644 ms
post-renderer session list. Because the daemon was already reparented, the
existing descendant-only profiler reported 1,378.5 MiB settled without it;
direct sampling measured the daemon at 263,296 KiB (257.1 MiB), for an
approximately 1,635.6 MiB combined settled footprint. That is about 2.5% below
the unchanged 1,677.3 MiB baseline, while warm readiness is about 34.2% faster.

The performance run itself caught two lifecycle defects and was repeated only
after both were fixed: `server.close()` could wait forever on stale HTTP/SSE
keep-alives after the authoritative pin count reached zero, and the detached
child retained the launcher's stdout/stderr pipes. Idle shutdown now closes
residual HTTP connections only after the zero-pin gate, and daemon stdio is
fully detached except for the bounded startup IPC channel. A real-process test
also proves an empty daemon exits and removes discovery after its grace.

A warm authenticated adoption with matching server runtime flags measured 6,372 ms ready (`4.5%` faster than the unchanged cold baseline). The existing profiler omitted the detached daemon because it only walks Electron descendants. Direct sampling found the daemon at approximately 374.7 MiB RSS after 21 seconds; combined accounting was roughly 1,778.8 MiB and is not yet a controlled comparison.

Both shell runs exceeded the repository's existing 100 ms post-renderer session-list budget, including the unchanged baseline. The full lane failed to reach its selector before changes and remains an instrument defect, not a daemon result.

These measurements establish two decisions:

1. detached/adopted startup cost is small enough to continue the design;
2. idle exit is mandatory, and profiler process discovery must be fixed before performance acceptance.

## Implemented Foundation on This Branch

- detached local-server spawn and Electron IPC disconnect;
- authenticated owner-only discovery record and daemon identity route;
- adoption of a live authenticated daemon;
- removal of parent-PID watchdog and renderer `kill-sidecar` API;
- Electron shutdown/update no longer terminates the daemon;
- real boot test proving PTY identity, replay, and new input after launcher disconnect;
- safe diagnostics behavior after the child IPC channel closes.
- provisional-to-committed PTY ownership: abandoned creates are bounded while
  committed running TUIs survive every subscriber disconnect;
- a canonical `WorkspaceHost.activity()` count for live harness turns and
  checkpoint writes;
- authenticated Electron-main leases with expiry, renewal, reacquisition and
  explicit release, without exposing the daemon token to the renderer;
- one daemon lifecycle state machine combining leases, PTYs and runtime work,
  with a tested idle grace and real-process reclamation;
- fully detached stdin/stdout/stderr ownership so the daemon cannot retain the
  app launcher or terminal by file descriptor;
- focused tests proving active Codex/Claude-style turns enter and leave the
  authoritative activity count;
- a public `prompt_async` regression proving an accepted harness turn continues
  after its initiating client request is aborted and releases its activity
  scope only when the turn reaches a terminal event.

The final review pass also closed four concurrency boundaries found after the
initial implementation: lease renewal now replaces rather than accumulates
lifecycle timers; a diagnostic snapshot cannot consume the pre-start lifecycle
transition; explicit PTY deletion joins native-exit/orphan cleanup and remains
immediately authoritative; and daemon shutdown closes ingress before awaiting
usage/runtime teardown.

Units 5 and 6 remain design-complete but not implemented: the current Host
Connector still belongs to Electron and its heartbeat still brokers an account
operation, while the discovery protocol has no staged-build replacement
handoff. Those are intentionally not represented as current daemon pins.

Focused verification on the final rebuilt daemon artifact passed:

- workspace-runtime PTY, public route, prompt-disconnect, and runtime activity
  suites: 126 passed, 0 failed;
- local-server app, lifecycle, and real listener suites: 28 passed, 0 failed;
- desktop daemon/startup/restart/adoption/lease suites: 34 passed, 0 failed;
- final standalone-bundle boot rerun: 5 passed, 0 failed;
- workspace-runtime, local-server, and desktop typechecks;
- workspace-runtime and local-server builds, local-server built-entry smoke,
  and desktop `predev` standalone daemon bundle.

The request-level ordinary-harness survival contract is covered, but the full
packaged Electron replacement matrix with real Codex/Claude/Cursor/OpenCode
harnesses remains required. The launch lock, remote migration, immutable
artifact staging, and packaged update qualification also remain required.

## Risks and Decisions

- **Secure storage:** Electron `safeStorage` cannot be imported into the standalone child. Unit 5's mandatory platform spike validates the selected Keychain/Credential Manager/Secret Service adapter before remote implementation proceeds; failure on any shipping platform blocks remote-access completion rather than introducing a plaintext or Electron-liveness fallback.
- **Daemon update semantics:** arbitrary active adapter state cannot be transferred safely to a new JavaScript process. Drain/defer is the honest update model. PTY FD handoff can be a future optimization, not a prerequisite.
- **Client leases:** a renderer connection is useful for idle timing but cannot be the authority for active work. Runtime and PTY sources win.
- **Replay bounds:** SSE and PTY rings are bounded. A replay gap must trigger canonical refetch/reanchor, never invented events.
- **Remote memory:** remote-enabled mode intentionally keeps the daemon resident. Measure and surface this cost; later optimize component idling inside the process if needed.
- **Crash recovery:** persistence supports history recovery, not continuation of OS processes. UI language and tests must preserve that distinction.

## Definition of Done

- All requirements and verification-matrix rows pass through public packaged entrypoints.
- Same PID/PTY/harness evidence proves continuation; restored history is not accepted as proof.
- Remote access works with Electron fully absent.
- A safe app update preserves active work and later advances the daemon build.
- Zero-pin daemon exits after grace and releases memory.
- Performance totals include the detached daemon.
- The obsolete standalone-runtime plan and every replaced lifecycle path remain explicitly superseded or deleted.
