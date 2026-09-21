# U0 — launch identity and activation qualification (macOS)

Date: 2026-09-21. Status: qualification complete on macOS only. Disposable fixture; zero production launcher edits. This record states what was measured on one machine. Every claim below that is not a measurement is labelled as an inference or as unmeasured.

Plan: [runtime recovery implementation plan §4.4, §6 U0](../plans/2026-09-20-002-refactor-runtime-recovery-plan.md). Contract: [runtime recovery contract §4, §10](../architecture/runtime-recovery-contract.md).

## 1. Environment

| Item | Value |
|---|---|
| OS | macOS 26.6.2, build 25G83, Darwin 25.6.0, arm64 |
| Node | v26.8.1 |
| Bun | 1.3.14 |
| `kern.maxproc` / `kern.maxprocperuid` | 6000 / 4000 |
| Repository | worktree `refactor/runtime-recovery`, package `@claxedo/workspace-runtime` |

Linux and Windows were not available in this environment. Nothing in this record measures them.

## 2. Protocol implemented

The §4.4 launch protocol, as a disposable fixture under `packages/workspace-runtime/src/ownership/`:

- `launch-gate.ts` — the launch-gate interface plus a macOS/POSIX implementation: creation identity (`readCreationIdentity`, `verifyCreationIdentity`), identity-checked signalling (`signalOwnedGroup`, `drainOwnedGroup`), the durable prepared-launch record (`LaunchOwnershipStore`), execution reconciliation (`reconcileLaunch`), and the gate launcher (`spawnLaunchGate`).
- `launch-gate-child.ts` — the gate program that is spawned in place of the payload.
- `launch-qualification.test.ts` — the scenarios.

Sequence:

1. The host persists a prepared launch ID and role **before** any spawn.
2. The host spawns the gate with `detached: true` and `stdio: ["ignore", "ignore", "ignore", "ipc"]`. Inherited stdout/stderr pipes are deliberately not used: the gate outlives its parent, and the first write after the parent exits would be an unhandled `EPIPE`.
3. The gate reads its own creation identity (`pid`, `pgid`, `ps -o lstart=`), **mints a nonce of its own**, and sends both over the private IPC channel.
4. The host records the identity and the nonce durably, records that activation is authorized, then sends `activate` carrying that nonce.
5. Only then does the gate spawn the payload, inside the gate's own process group.

The nonce is minted by the gate and delivered only over the private channel, so activation proves the sender received that message. An environment variable or an argv token cannot authorize the payload: neither carries the nonce. Before activation, channel loss or the activation deadline makes the gate exit without ever spawning the payload.

`reconcileLaunch` derives execution from protocol facts only:

| Durable record | Reconciled execution |
|---|---|
| prepared only, no identity ever received | `none` — the gate never reported, so it can never have held the nonce |
| identity received, activation never authorized | `none` — authorization is recorded before it is sent |
| activation authorized, no acknowledgement | `unknown` |
| activation acknowledged | `started` |

## 3. Results per U0 scenario

All 14 cases pass under `node --test` and under `bun test`.

| U0 "Prove" item | Case | Result |
|---|---|---|
| prepared row, no spawn | reconciles a prepared launch that was never spawned | `execution: "none"`, justified by "no creation identity was ever received over the gate channel" |
| parent dies before identity is used | private channel closed | gate exits `20`, payload marker absent |
| parent dies before identity is used | owning parent process SIGKILLed | gate exits within 5s of the kill against a 30s activation deadline; payload marker absent; record reconciles `none` |
| identity saved, activation absent | activation never sent | gate exits `21` at the 2s deadline; payload marker absent |
| (nonce authority) | activation with a nonce the gate did not mint | gate exits `22`; payload never ran |
| activation delivered, parent dies before acknowledgement | proxy SIGKILLs itself inside `child.send`'s flush callback | payload **did** run and kept running with no parent; record reconciles `unknown`; a fresh owner reacquired by `(pid, start time)`, verified `live`, and killed the group |
| identity reacquisition after owner restart | recorded identity of an exited process | `{ state: "exited" }`; `signalOwnedGroup` refuses |
| stale PID | live pid, recorded creation time altered | `{ state: "identity-mismatch" }`; `signalOwnedGroup` refuses and the candidate process is left running |
| (scope guard) | recorded process that does not lead its own group | `signalOwnedGroup` refuses with `not-group-leader` |
| surviving/detaching child | payload spawns a `detached` descendant, then the owned group is drained | owned group reaches ESRCH, the escaped descendant is **still alive**, and `drainOwnedGroup` reports `cleanup: "unknown"` |
| installed SDK without a controllable handle | read-only inspection | §7 below; no test |

Green tests are claims, so five mutations were applied to the implementation and reverted:

| Mutation | Failing cases |
|---|---|
| gate stops listening for `disconnect` | both channel-loss cases (they then hit the 30s/10s waits) |
| gate accepts any nonce | the nonce case |
| gate runs the payload without waiting for activation | all four pre-activation cases |
| `verifyCreationIdentity` compares only the pgid | the stale-creation-time case |
| `drainOwnedGroup` reports `cleanup: "verified"` | the descendant-escape case |

## 4. Capability matrix

| Capability | macOS 26.6.2 (measured here) | Linux | Windows |
|---|---|---|---|
| New process group per launch | **Yes.** `spawn(..., { detached: true })` yields `pgid === pid` and a pgid different from the launcher's, under both Node v26.8.1 and Bun 1.3.14. | Not measured | Not measured |
| Group-wide signal | **Yes.** `process.kill(-pgid, sig)` reached an in-group grandchild; both leader and member exited. | Not measured | Not measured |
| Session leadership independently observable | **No.** `ps -o sess=` printed `0` for the launcher and for both detached and non-detached children, so `setsid` could not be confirmed separately from the group change. Node documents `detached` as `setsid` on POSIX; that documentation was not verified here. | Not measured | Not measured |
| Kernel process handle immune to PID reuse | **No.** macOS has no `pidfd`. | `pidfd_open`/`pidfd_send_signal` exist — **not measured here** | Job Object handle — **not measured here** |
| Descendant containment | **No.** Process group only. A descendant that leaves the group cannot be enumerated. | cgroup v2 could contain descendants — **not measured here** | Job Object with declared breakaway policy — **not measured here** |
| Creation timestamp | **`ps -o lstart=` only**, one-second resolution, no sub-second field. `sysctl -n kern.proc.pid.<pid>` is rejected by the macOS sysctl CLI, so no sub-second creation time is reachable without a native addon (`proc_pidinfo`, or `sysctl(3)` with a `KERN_PROC_PID` MIB through FFI). | Not measured (`/proc/<pid>/stat` field 22 is in clock ticks) | Not measured |
| Boot identity | **Available but unused.** `sysctl kern.boottime` returns `{ sec = …, usec = … }`. The fixture does not record it. | Not measured | Not measured |

Native dependency choice on macOS: **none is required** for the scope §4.4 declares. Everything above was obtained with `child_process`, `process.kill` and `ps`. A native addon or FFI would only buy a sub-second creation timestamp, which §6 shows is not needed here.

## 5. Automatic actions supported on macOS, given these measurements

Supported without operator action:

- Refuse to acknowledge a managed launch until the prepared record, the reported creation identity and the authorization are durable — proven, because the payload cannot run before the host has the gate's nonce.
- Reconcile a prepared-but-unactivated launch as **no execution**, from protocol facts rather than from a PID probe.
- Reacquire an owned launch after the owner restarts, using `(pid, pgid, ps lstart)` from the durable record alone, with no surviving channel.
- Verify liveness and refuse to signal on `exited`, on `identity-mismatch`, or when the recorded process does not lead its own group.
- `SIGTERM`, then `SIGKILL`, the owned process group, and wait for the group to reach `ESRCH`.

Not supported, and therefore honest-unknown:

- Whole-tree cleanup. Group exit is reported as `cleanup: "unknown"` because a descendant can leave the group and macOS offers no enumeration that would find it. Measured, not assumed: the escaped descendant survived the group kill.
- Signalling an owned group whose **leader has already exited** while members survive. `verifyCreationIdentity` returns `exited`, so `signalOwnedGroup` refuses. `kill(-pgid)` would still reach the surviving members, but the identity guarantee no longer covers that pgid, and §4.4 forbids a PID-only fallback. This is a deliberate refusal and it leaves that cleanup for an operator.

## 6. The adopted-daemon gate (§4.4 "Unresolved architecture gate")

**Question:** after the app relaunches, does `(pid, start time)` reacquisition give a race-safe signal target on macOS?

**Measured answer: yes in practice, but as an arithmetic property of the PID allocator, not as a kernel guarantee.**

What was measured on this machine:

- `ps -o lstart=` resolution is one second. Two processes spawned back to back carried byte-identical `lstart` strings.
- PID allocation is sequential and wraps. A spawn loop observed `99998 → 100` after 19,310 consecutive spawns in 46 seconds, i.e. roughly 420 process creations per second sustained, and roughly 1,000 per second in a shorter 2,000-spawn burst.

The consequence: a stale record is mistaken for a live process only if a **different** process holds that pid **and** reports the same `lstart` second. Reusing one specific pid requires the allocator to traverse the whole ~100,000-entry space. At the fastest rate measured here that takes about 100 seconds, and at the sustained rate about 240 seconds. Both are orders of magnitude larger than the one-second `lstart` bucket, so the reused pid's creation second cannot equal the recorded one.

Scope and limits of that conclusion:

- It is an empirical property of one machine's allocator, measured once. It is not a documented kernel contract and nothing prevents a future allocator change. `pidfd` and a Job Object are contracts; this is a bound.
- There is an unavoidable TOCTOU gap between `verifyCreationIdentity` and `process.kill`. The same wrap argument bounds it, so the gap is safe by the same reasoning and by no stronger one.
- A record that survives a reboot is not covered by the wrap argument, because pids restart low. `sysctl kern.boottime` is available and would close this; the fixture does not record it, and production must.
- The argument protects the **leader**'s identity, and `pgid == leader pid`, so it extends to the group id. It says nothing about descendants that left the group.

### What the desktop adoption path does today

Read-only, and the reason this gate matters. `packages/claxedo-desktop/src/main/index.ts:549-568`:

- `~/.claxedo/local-daemon.json` (`server-daemon-discovery.ts:11-23`) holds `{ service, protocol, generation, token, pid, port, startedAt }`. Adoption (`verifyClaxedoDaemonDiscovery`, `:73-99`) is an authenticated HTTP round trip to `127.0.0.1:<port>/api/claxedo/daemon` that compares `service`, `protocol`, `generation` and `pid` **against what the listener reports about itself**. A healthy adoption is therefore sound: a responding, token-authenticated listener that agrees about its own generation is the daemon.
- The unhealthy branch is the problem. It runs precisely when that authenticated probe failed, so the only remaining evidence is the number in the file. `stopUnhealthyPublishedDaemon` (`:115-130`) guards with `process.kill(pid, 0)` — existence, nothing more — then calls `killProcessTree(pid, signal)` (`index.ts:1252`), which is the `tree-kill` package: the pid **and every descendant the OS attributes to it at kill time**, `SIGTERM` then `SIGKILL`.
- `startedAt` is the one field that could support an identity check. It is the daemon's own `new Date().toISOString()` (`packages/claxedo-desktop/scripts/claxedo-server-entry.ts:82`), not an OS creation time, and it has no reader: a grep across `claxedo-desktop/src`, `claxedo-desktop/scripts` and `claxedo-local-server/src` finds only the type, a non-empty-string shape guard at `server-daemon-discovery.ts:148`, and two test fixtures. No boot id, uid, executable path or process-group id is recorded anywhere.
- The discovery file is unlinked on clean exit and on `SIGTERM`/`SIGINT` (`claxedo-server-entry.ts:84-96`), so the stale-record window opens on `SIGKILL`, crash or power loss. The code shows the window exists; it does not bound it.

So a recycled PID, with its whole descendant tree, is signalled today with no test that it is the process that wrote the file. This corroborates sweep finding R8 from source, and it is what §6's `(pid, pgid, lstart)` check plus a boot id would close.

**Therefore, for the plan's gate:** the safe negative result passes — no guessed signal is ever issued, on any of the three refusal paths. Automatic signalling of an adopted daemon is available on macOS under the bound above, provided the durable record also carries boot identity. The full G6 automatic-containment goal is **not** satisfied, because whole-tree cleanup stays `unknown` on macOS for any launch whose descendants can call `setsid`.

## 7. Read-only inventory of what production launchers own today

No file below was edited.

| Launcher | Identity and handle it has today |
|---|---|
| `packages/agent-sdk-runtime/src/harnesses/shared/windows-process.ts` | `killHarnessProcess` signals `-proc.pid` when the caller passes `ownedProcessGroup`; `drainHarnessProcessGroup` polls `process.kill(-pid, 0)` for `ESRCH` with `SIGKILL` escalation at 1s, and treats Darwin's `EPERM` as "not exited". It signals through a live in-process `ChildProcess`, so pid reuse cannot bite while that handle exists — and there is no creation-identity check to carry the same safety across a restart. |
| `packages/agent-sdk-runtime/src/harnesses/codex/app-server-process.ts:119` | `spawn(..., { detached: process.platform !== "win32" })` — already owns a process group, and disposes through `killHarnessProcess(..., true)` plus `drainHarnessProcessGroup`. It records the pid into the optional observer **after** an unconstrained spawn: the exact crash gap §4.4 names. No prepared record, no activation gate. |
| `packages/agent-sdk-runtime/src/harnesses/pi/rpc-process.ts:53` | `spawn` with no `detached` and `killHarnessProcess(this.child, "SIGTERM")` with no `ownedProcessGroup` — single-pid signalling, no group ownership. |
| `packages/agent-sdk-runtime/src/harnesses/acp/process.ts:202,655,691` | Uses `this.transport.pid` for observation only; the process handle belongs to the ACP transport. |
| `packages/workspace-runtime/src/pty/index.ts:466,701` | Spawns through the PTY library and cleans up via `killProcessTree(session.info.pid, …)`. |
| `packages/workspace-runtime/src/managed-processes/manager.ts:1204-1226` | `process.kill(-info.pid, "SIGKILL")` then `process.kill(info.pid, "SIGKILL")` from a stored numeric pid, each inside a bare `catch {}`. Pid-only, no creation identity, no reported outcome. |
| `packages/claxedo-desktop/src/main/server-daemon-discovery.ts:115-130` | The adopted daemon. `process.kill(pid, 0)` then `tree-kill` on a pid read from `~/.claxedo/local-daemon.json`. See §6. |

`packages/claxedo-local-server/src/app/daemon-admission.ts:114-134` carries no process identity either: admission is a constant-time comparison of the `x-claxedo-daemon-capability` secret. `packages/claxedo-local-server/src/app/local-daemon-lifecycle.ts` scopes leases to the daemon `generation` string, not to a process. There is no lock file anywhere in this path — a grep for `flock`, `LOCK_EX` and `.lock` across `claxedo-local-server/src`, `workspace-runtime/src` and `claxedo-desktop/src` finds nothing. The only mutual exclusion is the TCP bind walk in `packages/claxedo-desktop/src/main/server-port.ts:97`, which makes the comment at `server-daemon-discovery.ts:110-114` about a "data-dir lock" a description of port contention rather than of a lock artifact.

### Installed SDKs without a controllable handle

- **Claude** (`@anthropic-ai/claude-agent-sdk`, `packages/agent-sdk-runtime/src/harnesses/claude/driver.ts:787`): the SDK accepts a `spawnClaudeCodeProcess` hook, and `spawnObservedClaudeCodeProcess` already calls `child_process.spawn` itself. **A real `ChildProcess` handle is obtainable**, so this harness can adopt the launch gate. It currently passes no `detached`, so the child shares the app's process group, and its observation declares `ownerActions: false`.
- **Cursor** (`@cursor/sdk` 1.0.24, `packages/agent-sdk-runtime/src/harnesses/cursor/driver.ts`): no spawn hook is used and no process handle is obtained. The only control is an `AbortController`. The driver's own observation says so — `confidence: "not-process-backed"` at line 473, and stdio MCP servers are `"inferred"`. Per contract §10 this is the "SDK-managed local process with inferred PID" row: it must escalate to a verified containing owner, and it cannot be given launch-gate ownership without a supported SDK spawn hook.

## 8. Commands run

From `packages/workspace-runtime`:

```sh
node --import ./src/text-imports.mjs --import tsx --test src/ownership/launch-qualification.test.ts   # 14 pass, 0 fail, exit 0
bun test src/ownership/launch-qualification.test.ts --timeout 30000                                  # 14 pass, 0 fail, exit 0
bun run typecheck                                                                                    # exit 0
npx tsc --noEmit -p tsconfig.typecheck.json --listFiles                                              # all three new files are in the program
```

From the worktree root:

```sh
bun run test:architecture-ratchets   # exit 0: 5 products, 8 policies; 13872 helpers, 523 divergent names, 166 duplicated copies held
grep -rn "ownership/launch-gate\|ownership/launch-qualification" packages --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.json' \
  | grep -v "packages/workspace-runtime/src/ownership/"   # no matches: zero production edges
pgrep -fl launch-gate ; pgrep -fl parent-proxy            # no matches after the run
```

Platform measurements were taken with `ps -o pid=,pgid=,sess=,lstart=`, `sysctl kern.maxproc kern.maxprocperuid kern.boottime`, a failed `sysctl -n kern.proc.pid.<pid>`, and a shell loop that spawned until the pid counter wrapped.

## 9. What remains for the user to decide

1. **Accept the empirical PID-wrap bound, or require a kernel handle.** macOS offers no `pidfd`. The bound in §6 is strong but is a measurement, not a contract. Accepting it authorizes automatic signalling of an adopted daemon on macOS; rejecting it ends adopted-daemon recovery at operator action, as §4.4 allows.
2. **Boot identity in the durable record.** The wrap argument does not survive a reboot. Recording `kern.boottime` alongside `(pid, pgid, lstart)` closes that, and is a production requirement, not a fixture change.
3. **The unhealthy-daemon replacement path.** Today it `tree-kill`s a pid from a stale file after an existence check only, and the tree it kills is resolved from the live process table at kill time. Replacing that with the §2 identity check is a production change in U3/U6, not a U0 edit; the user should confirm that refusing to signal — and reporting unresolved ownership — is the wanted behaviour when the identity does not match, since it means the replacement daemon will not start until an operator intervenes.
4. **`cleanup: "unknown"` as a permanent macOS outcome.** Whole-turn cleanup can never be claimed verified on macOS for a launch whose descendants may call `setsid`. §4.4 already says this blocks a claim of fully verified retirement; the user should confirm the UI consequence.
5. **Cursor.** It has no process handle at all. Either it is escalated to a containing owner per contract §10, or managed Cursor execution is refused, or a spawn hook is obtained upstream.
6. **Linux and Windows.** `pidfd` and the Job Object were not measured. U0 has qualified macOS only; §4.4's platform scope decision for the other two remains unproven.
