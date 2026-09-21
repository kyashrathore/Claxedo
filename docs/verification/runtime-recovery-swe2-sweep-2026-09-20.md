# Runtime recovery sweep — validated findings

Date: 2026-09-20. Status: completed source sweep and independent validation. Investigation only; implementation and live recovery are not authorized.

The validated register contains **13 concrete findings and 4 broader capability gaps**. Seven isolated fault scenarios were checked. The most consequential findings are a delayed abort releasing a replacement turn, hidden teardown/persistence failures, false process-stop results, and daemon recovery using insufficient process identity. These establish failure mechanisms in code; this sweep does not prove that any currently running process is an OS zombie or orphan.

## How the sweep was run

- External reviewer: **Devin CLI 3000.10.31 (b98cc431), SWE-2 High, model ID `swe-2-high`**, local session `longing-lake`. The completed export records only `swe-2-high` as its agent model. Claude was not used as a reviewer.
- Devin was instructed to inspect source and callers only, avoid mutations/live sessions/databases/providers, and return its report through stdout. Its completed export contains 43 read calls, 37 searches and 2 read-only directory-listing commands. It ran no tests or fixes.
- The first short run stopped at its permission checker on a compound read-only file-count command. The same session was resumed with simple source-reading commands and the same read-only `auto` permission mode; permissions were not broadened.
- The coordinating Codex agent independently traced the cited owners, rejected unsupported conclusions, added findings that Devin missed, and ran the seven isolated scenarios below. This document is the validated combined report; it is not a verbatim endorsement of Devin's output.
- Working-tree base: HEAD `e06522f6e6092f90c549815edb33b37264759b20`, with substantial pre-existing uncommitted work. A starting hash manifest covered 896 source files. Other work changed ACP, host, and desktop files during the sweep; relevant cited paths were re-read. The report describes the inspected working tree, not an assertion about the code loaded in an existing daemon.

CLI invocation:

```sh
devin --model swe-2-high --permission-mode auto --prompt-file /tmp/claxedo-swe2-recovery-sweep-prompt.md --export /tmp/claxedo-swe2-recovery-sweep-export.json -p
devin --model swe-2-high --permission-mode auto --resume longing-lake --prompt-file /tmp/claxedo-swe2-recovery-sweep-resume.md --export /tmp/claxedo-swe2-recovery-sweep-export.json -p
```

Captured evidence: [original prompt](/tmp/claxedo-swe2-recovery-sweep-prompt.md), [resume prompt](/tmp/claxedo-swe2-recovery-sweep-resume.md), [raw Devin report](/tmp/claxedo-swe2-recovery-sweep-final.md), [run receipt](/tmp/claxedo-swe2-sweep-receipt.json), [starting source hashes](/tmp/claxedo-swe2-sweep-source-baseline.json), [validated source hashes](/tmp/claxedo-swe2-sweep-validated-source-hashes.json). These are local temporary artifacts. Use this validated report for planning; the raw report contains corrections discussed below.

This review treats frozen sessions as a warning about error propagation and resource ownership. A healthy background turn may outlive the desktop. A retained lease is not evidence of a dead process, and a responsive HTTP endpoint is not evidence of healthy execution. The defects below concern concrete failures of cancellation, ownership, error reporting, or truthful results.

Reference contract: [Runtime recovery contract](../architecture/runtime-recovery-contract.md), proposed rather than implemented.

## Coverage and limits

This is a source sweep with isolated fault injection, not an exhaustive proof of every provider or operating system. "Examined" means the responsible implementation and production callers were traced; it does not mean live acceptance passed.

| Area | Coverage | Important boundaries / limits |
|---|---|---|
| Runtime admission and finalization | Examined | `agent-sdk-runtime/src/runtime.ts`, `runtime/turn-admission.ts`, `runtime/lifecycle.ts`; actual runtime exercised for delayed abort. |
| Shared SDK producers and turn lifecycle | Examined | Adapter finalization, lifecycle abort/idle waits, producer disposal. |
| Codex | Examined | Driver cancellation, app-server requests, process-group drain, terminal cleanup, relevant tests. No live provider or real descendant cleanup probe. |
| Pi | Examined | RPC process, cancellation/disposal callers, exit notification and process ownership, tests. No live descendant probe. |
| Cursor | Examined | Prompt/goal cancellation and stream completion, disposal callers, tests. SDK implementation and real failed cancellation remain unverified. |
| Claude | Partial | Local driver delegates closure to SDK and withholds terminal result until stream cleanup; no concrete additional SDK-exit defect claimed. |
| ACP | Examined locally; remote partial | Process cancellation, transport retirement, uncertainty/fences, process manager and disposal. Concurrent edits occurred here; remote authority and blocked transport writes are acceptance gaps. |
| Embedded OpenCode | Partial | Shared host, adapter interrupt and event-pump ownership inspected. SDK interrupt/close postconditions not proven live. |
| Workspace host/store/routes | Examined | Active-turn ownership, checkpoint freeze, adapter retirement, disposal, abort entrypoint, journal replay/projection. No fault injected into the user's database. |
| Local daemon | Examined | Work pins, lease shutdown acknowledgement, adoption and shutdown routing. Fake-clock pin test; no live daemon shutdown. |
| Desktop process owner | Examined | Discovery verification, failed-health recovery, lease exit, launch path. Fake-process exit test; no real process signalled. |
| PTY and managed processes | Examined | Tree cleanup, registry removal, process stop/dispose and accounting. Cross-platform/native PTY faults remain untested. |
| Host serving | Examined | Workspace listener ensure/drain/dispose/retirement. Hosted control-plane and remote-host replacement are partial. |
| Diagnostics | Partial | Action authorization checks distinguish launch/creation identity from optional observations. Full platform metric collection not audited. |
| Client session controls | Examined for Stop; partial elsewhere | Composer Stop and status dispatcher, abort-before-revert callers, completion refresh read path. No browser acceptance; not a full rendering review. |

## Existing safeguards and rejected suspicions

- `workspace-runtime/src/store.ts:1110` already migrates `pending_permission.options_json`. The original missing-column defect should not be reported as still present in this checkout.
- `agent-sdk-runtime/src/harnesses/codex/app-server-process.ts:296` already emits a numeric JSON-RPC error code (`-32603`) for a failed server request. Its tests include failed permission storage. This does not establish that an already-running daemon has loaded this version.
- `workspace-runtime/src/store.ts:2924` projects and advances the checkpoint in one transaction, records a failed session, and `commit` retries that session's journal before later writes. This guards new projection failures; it does not by itself rebuild projections skipped by an older version.
- ACP cancellation has an explicit uncertainty path and retains the original pending execution. Stdio transport retirement has a five-second bound and retains failed retirement as a fence. Preserve these safeguards. End-to-end deadlines still need to include notification delivery, and remote transport closure is not evidence of remote termination.
- `createProcessLifecycle` is exported and tested but has no production constructor call found. Its swallowed stop failure is not included as a reachable production finding. `createIdleReaper` from the same file does have production callers and must not be confused with it.
- `createSdkRuntimeProducers.dispose` aggregates stop and producers with `Promise.all`; a stop rejection can propagate promptly there. R3 is specifically about the outer runtime lifecycle's ordering, not every shared disposal helper.
- Keeping a daemon resident for a healthy turn or managed dev server is intentional. Optional observer/telemetry catches do not, by themselves, establish an operational failure. Neither is counted as a bug.
- Diagnostics action grants already check ownership/launch identity and platform creation evidence in their supported path. That safeguard does not automatically protect the separate failed-health daemon replacement path in R8.

## Proposed work order for approval

| Order | Existing owner | Concrete slice and exit criterion |
|---|---|---|
| 1 | Runtime admission, cancellation, lifecycle | Preserve target generation through cancellation; report known failures before producer drain; distinguish pending command from execution state. Reproduce R1/R3, then verify replacements cannot be finalized/released by an old abort and failure remains inspectable while work is pending. |
| 2 | Harness and process launch owners | Bound attempts and retain unresolved cleanup. Correct Codex, Cursor, Pi and PTY/managed-process result semantics; support checked retry rather than a cached rejection. Verify each real supported execution shape, including descendants and late events. |
| 3 | Workspace/store owner | Add bounded reconciliation and inspection of failed projections/finalization, generation fencing, persistence-outage handling, and bounded checkpoint blockers. Repair canonical state from evidence; do not synthesize successful tools or clear leases solely to unblock UI. |
| 4 | Machine/desktop and host-serving owners | Enforce process creation identity and final exit proof; retain failed retirements for retry; expose named blockers, scope preview and authorized escalation that does not depend on daemon HTTP cooperation. Verify daemon adoption/replacement with live process trees. |
| 5 | Existing client controls | Consume factual operation results, show stopping/uncertain/cleanup-blocked state and available actions, and preserve last-known execution state after failure. Validate stop/retry/reconnect in the packaged desktop and supported remote flow. |

The first reviewable implementation should span a single session cancellation from the runtime owner to the existing client, with generation fencing and visible failure. Process-wide escalation should follow only with verifiable ownership and an explicit shared-impact contract. Each slice needs positive, negative, persistence, retry and isolation checks. No implementation is included in this sweep.

## Disposition of Devin's findings

Devin returned eleven numbered findings. Some overlap, some describe missing capabilities, and several details or recommendations do not survive validation. Additional independent findings are retained with separate R identifiers below.

| Devin item | Validated disposition |
|---|---|
| F-01 unbounded abort | Retained in R2; independently probed. Its claim of bounded background-terminal calls is not supported by the current `createCodexTurnStop`/`request` path. Shared process disposal cannot be an unconditional session-only escalation. |
| F-02 dependent lifecycle waits | Split across R2/R3/R9 with a production-scope caveat. A runtime-backed HTTP subscriber and the internal producer have different lifetimes. |
| F-03 managed-process false stop | Retained as R7. Removed the blanket claim that a failed removal necessarily keeps a daemon pin: PTY activity excludes entries already marked removed. PID liveness alone is not sufficient ownership proof. |
| F-04 no terminal fact on abort failure | Not retained as stated. Failed cancellation does not establish terminal execution, and the normal producer may already publish terminal state. Preserve/report cleanup failure and uncertainty; do not fabricate terminalization. |
| F-05 daemon pin/adoption cycle | Classified as capability gap 1 and 4. Healthy background work intentionally pins the daemon; automatic forced shutdown based on age or counts is not the remedy. |
| F-06 embedded retirement fence | Retained as an additional affected owner in R10. Keep the fence; add visible ownership and a checked retry/containment path. |
| F-07 daemon stop waits | Retained as the daemon-level consequence of R3 and independent owner requirements. Ordinary adapter teardown can break a Codex RPC wedge; it does not bound every pending request or process drain. |
| F-08 lease-loss containment | Retained as R13, with the claim narrowed to suppressed cleanup failure. Write fencing remains a valuable safeguard. |
| F-09 persistence failure | Retained as R12 and independently reproduced. No blanket claim that every failure prevents every existing terminal event or all queue progress. |
| F-10 client Stop | Retained and expanded as R11. Failure toast and execution state are separate obligations. |
| F-11 frozen while producer survives | Retained as a specific acceptance risk within R9, not claimed as runtime-reproduced. Requires an actual checkpoint/late-producer integration probe. |

Recommendations deliberately not adopted: synthesize terminal events when persistence fails; discard a lease merely because a timeout expired; assume `fences.set(session, null)` exists in current `runtime.ts` (it does not); kill a shared harness without reviewed impact; treat `process.kill(pid, 0)` alone as safe termination authority; or exit a daemon regardless of unresolved ownership. Fix the canonical owner and preserve unknown facts instead.

## Independently verified findings

### R1 — P1: A delayed abort can finalize and release a replacement turn

**Confidence: high; reproduced through `createAgentRuntime` with an in-memory store and fake harness.**

User Stop enters `AgentRuntime.turns.abort`. [packages/agent-sdk-runtime/src/runtime.ts:683](/Users/yashvardhansingh/test/opencode/packages/agent-sdk-runtime/src/runtime.ts:683) checks the requested turn against the current admission, then awaits adapter resolution and adapter cancellation. After those waits, `completeCancellation` at `runtime.ts:509` finishes whichever turn the store currently considers active and calls `admissions.discard(sessionId)`. `runtime/turn-admission.ts:109` discards by session, without checking the original generation.

If A completes and B starts while A's abort acknowledgement is delayed, that acknowledgement clears B's busy state and lease. The isolated probe also admitted C while B's producer was still open. This is an ownership violation, not only stale presentation. A similar recheck is needed before invoking an adapter after asynchronous resolution; the adapter abort API currently identifies a session, not an immutable target execution.

**Canonical change:** keep cancellation bound to the original admission and provider turn across every asynchronous boundary; finalize and release only that generation. Contract §§3.6, 6, 9.5. Existing `runtime/turn-admission.test.ts:416` checks already-stale requests but does not suspend cancellation while a replacement starts. Acceptance must cover both adapter-resolution and acknowledgement races, including delayed replies after replacement and cross-instance durable authority.

### R2 — P1: Codex Stop depends indefinitely on the provider it must stop

**Confidence: high; production cancellation helper probed with a nonresponding request and a rejected request.**

The abort route calls the runtime, the shared SDK adapter calls `lifecycle.abort` and awaits `whenIdle` (`harnesses/shared/sdk-runtime-adapter.ts:770`). Codex rejects its turn-completion promise on abort, but `runLeasedTurn` still awaits `stop()` in its `finally` (`harnesses/codex/driver.ts:301`, `:385`). `createCodexTurnStop` (`harnesses/codex/protocol.ts:34`) waits for the turn ID, `turn/interrupt`, terminal enumeration, and terminal termination. `CodexAppServerProcess.request` (`harnesses/codex/app-server-process.ts:203`) has no deadline.

A provider that stays alive but does not answer interrupt keeps Stop, producer cleanup, admissions, and daemon pins pending. The helper also permanently caches its first rejected stop promise: the probe's second call made no second upstream attempt. An error response and an unanswered request need different factual results, but both need an owner-visible recovery path.

**Canonical change:** the existing cancellation owner needs a parent deadline, explicit attempt/result semantics, and an independently authorized process-owner escalation. Do not release admission merely because a timer expires. Contract §§6–8. `codex/cancellation.test.ts` verifies paginated terminal cleanup and an explicit termination error; the missing cases are a never-answering RPC, failed-attempt retry, and safe escalation of a shared process.

### R3 — P1: Runtime disposal hides a known stop failure behind pending work

**Confidence: high; reproduced using `createRuntimeLifecycle`.**

[packages/agent-sdk-runtime/src/runtime/lifecycle.ts:35](/Users/yashvardhansingh/test/opencode/packages/agent-sdk-runtime/src/runtime/lifecycle.ts:35) starts teardown, suppresses its early rejection, then drains `pendingTasks` before awaiting the teardown result. With a stuck admitted operation and an immediately failing teardown, the disposal promise remains pending and the final error logger has not run. The probe observed zero reported errors until it released the unrelated pending operation.

[packages/workspace-runtime/src/workspace/runtime.ts:1938](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace/runtime.ts:1938) has a related ordering problem: it starts adapter teardown but waits for `applyQueue` and all pending requests before reaching the aggregate teardown result. An adapter-specific logger may report a failure there; that does not make workspace disposal bounded or its failure available to its caller.

This reaches daemon shutdown through [packages/claxedo-local-server/src/app/start-local-server.ts:406](/Users/yashvardhansingh/test/opencode/packages/claxedo-local-server/src/app/start-local-server.ts:406): the five-second listener drain does not bound `shutdownEmbeddedWorkspaceRuntimes`, usage drain, or the OpenCode owner close. [packages/claxedo-desktop/scripts/claxedo-server-entry.ts:84](/Users/yashvardhansingh/test/opencode/packages/claxedo-desktop/scripts/claxedo-server-entry.ts:84) exits after `server.stop()` settles, so an unresolved teardown can also prevent cooperative SIGTERM exit. Existing adapter disposal can break an ordinary Codex RPC wedge by stopping its process; the remaining risk is a teardown/request/process-drain that does not settle. A parent deadline must report that state and preserve independent, authorized containment.

**Canonical change:** report the initiating and cleanup failure immediately through the existing runtime/host owner while retaining unresolved resource ownership and keeping the store available to possible writers. Contract §§3.1, 7–9. Validate an immediate teardown rejection with a permanently pending producer/configuration request; reporting must complete independently of resource drain. Do not equate an early failed result with permission to close the store.

### R4 — P1: Codex process retirement can leave its exit promise unresolved

**Confidence: high from source; no OS fault injection in this sweep.**

`CodexAppServerProcess.dispose` returns `this.exited` (`harnesses/codex/app-server-process.ts:224`). On child exit/error, `handleExit` starts `drainProcessGroup().then(resolveExited)` without a rejection branch (`:240`). `harnesses/shared/windows-process.ts:54` defaults the process-group drain timeout to infinity. A persistent inability to verify exit loops indefinitely; an unexpected drain rejection never rejects `this.exited` and can produce an unhandled rejection instead.

This leaves the responsible teardown caller unable to distinguish running descendants, denied signalling, a verification failure, and a finished process. The diagnostic exit observation is also published before group cleanup is proved; it is not cleanup authority.

**Canonical change:** the launch owner's retirement result must settle within a budget and retain unresolved ownership on failure. Contract §§5, 7, 10. Acceptance: TERM ignored, KILL denied, group inspection failure, leader exit with descendants, and later successful cleanup; test actual process trees on supported platforms as well as injected errors.

### R5 — P1: Cursor cancellation discards its error and still waits for the stream

**Confidence: high from source; real SDK failure behavior not reproduced.**

[packages/agent-sdk-runtime/src/harnesses/cursor/driver.ts:322](/Users/yashvardhansingh/test/opencode/packages/agent-sdk-runtime/src/harnesses/cursor/driver.ts:322) and `:379` attach abort handlers that call `run.cancel().catch(() => {})`; the lifecycle close callbacks do the same. Both prompt and goal execution continue awaiting `run.stream()` and then `run.wait()`. If cancellation rejects and the stream remains open, the known cancellation error disappears while the shared adapter waits for producer idle.

**Canonical change:** the Cursor driver must propagate cancellation failure to its existing owner immediately, separately from stream settlement, and provide a truthful bounded result using the SDK's supported authority. Contract §§3.1, 7–8. Goal tests cover normal completion and an iterator error, not rejected cancellation plus a live iterator. Acceptance must inject that combination and verify visible error, retained ownership, retry/escalation semantics, and no invented terminal event.

### R6 — P1: Pi reports exit before OS exit and does not own a POSIX descendant group

**Confidence: high from source; orphaned process not reproduced.**

[packages/agent-sdk-runtime/src/harnesses/pi/rpc-process.ts:136](/Users/yashvardhansingh/test/opencode/packages/agent-sdk-runtime/src/harnesses/pi/rpc-process.ts:136) calls the observer's `exit` and all exit listeners when `fail` is called. `dispose` calls `fail` before sending TERM (`:150`), returns synchronously, and schedules KILL without awaiting verified exit. The child is spawned without `detached` (`:49`), and `killHarnessProcess` uses single-PID signalling for this call on POSIX. Descendants therefore have no cleanup guarantee from this owner.

`PiDriver.closeProcesses` clears entries immediately (`harnesses/pi/driver.ts:586`), and driver disposal releases its auth profile after issuing stops. New execution can treat a failed process as absent while termination is still pending. The RPC's 30-second response timeout does not establish process termination.

**Canonical change:** distinguish transport failure from verified process exit, retain mandatory launch ownership, and await a bounded retirement result for the actual owned tree. Contract §§4–5, 10. `pi/rpc-process.test.ts:37` waits on the application exit callback, which `dispose` invokes before OS exit; it does not prove tree cleanup. Acceptance must include a TERM-ignoring process, surviving child, denied kill, and replacement admission while cleanup is unresolved.

### R7 — P1: Managed-process Stop can discard ownership without proof of exit

**Confidence: high from source; signal failure not injected into a live PTY.**

[packages/workspace-runtime/src/managed-processes/manager.ts:1168](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/managed-processes/manager.ts:1168) sends interruption/removal/signals and repeatedly calls `gone`. It ignores the final `gone` result, then unconditionally calls `scrub(..., "stopped")` (`:1232`). `scrub` clears `ptyId` and `assignedPort`, records `exitedAt`, and may publish `process.stopped` with an invented zero exit code (`:847`). Directory disposal catches stop errors and deletes manager state (`:1566`).

The underlying PTY path compounds this: `pty/index.ts:249` suppresses signal failures, and `cleanupSessionOwned` logs a process-tree enumeration failure but still removes the session (`:462`). Explicit removal sets `removed` before the sweep; `activity()` excludes removed sessions. Consequently, the accounting and UI can claim stopped even when cleanup failed or exit is unverified. Missing registry state is then treated as gone by `manager.ts:830`.

**Canonical change:** PTY launch/cleanup ownership must return verified exit or an unresolved cleanup obligation; the manager consumes that result and keeps the PTY/port association while cleanup is unresolved. Contract §§4–5, 8, 10. Test TERM/KILL denial, process enumeration failure, native handle failure, survivor descendants, and retry after partial cleanup. Existing successful-stop tests are not proof of these failure paths.

### R8 — P1: Desktop recovery can signal a stale PID and declares success without final verification

**Confidence: high from source; false-success branch reproduced with injected process operations.**

On launch, `setupServerConnection` reads discovery and attempts authenticated daemon verification. If verification fails, it calls `stopUnhealthyPublishedDaemon` ([packages/claxedo-desktop/src/main/index.ts:561](/Users/yashvardhansingh/test/opencode/packages/claxedo-desktop/src/main/index.ts:561)). That helper checks only numeric PID liveness before signalling (`main/server-daemon-discovery.ts:115`); it does not verify creation identity against the recorded generation. A stale discovery record whose PID has been reused can therefore target an unrelated process tree.

After KILL and a 500ms wait the helper unconditionally returns `"stopped"`, without another liveness check. An isolated probe whose fake process remained alive returned stopped. The caller proceeds to start a replacement; the old writer/lock may still exist.

**Canonical change:** the external launch owner must verify process-generation identity before any signal and verify the required exit afterward. A failed HTTP identity check is not authority to kill the PID. Contract §§3.6, 4, 10. Current discovery tests check identity on the adoption path and TERM-to-KILL escalation, but not PID reuse on the failed-health path or a survivor after KILL. Acceptance must cover both and retain a truthful unresolved state.

### R9 — P2: Interrupting checkpoint freeze has a timeout that does not bound freeze

**Confidence: high from source.**

[packages/workspace-runtime/src/workspace/runtime.ts:1205](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/workspace/runtime.ts:1205) aborts active turns, suppresses abort errors, and races their completion against a replacement-drain timeout. `freezeCheckpoint("interrupt")` then unconditionally calls `waitForCheckpointIdle` (`:1252`), which waits without a deadline for the same active-turn/write counters to reach zero. The first timeout does not tell its caller whether drain succeeded and does not bound the public operation. A stuck owner leaves the checkpoint freezing and new writes gated indefinitely.

**Scope qualification:** the normal runtime-backed route uses `runRuntimePromptTurn` ([packages/workspace-runtime/src/session/service.ts:424](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/session/service.ts:424)), which can release its host scope after its subscription is aborted even while the internal SDK producer remains pending. Thus a frozen Codex turn does not necessarily leave the host's active-turn counter nonzero after interruption. The indefinite-freeze case requires a scope/write that cannot drain (for example, blocked post-abort message read or an adapter-direct iterator). There is an opposite acceptance risk: a local producer with no invalidated durable admission may later write after those host scopes have disappeared and the checkpoint reports frozen. Proving that branch through the real checkpoint entrypoint is still required; counting only host scopes is not itself proof of producer quiescence.

**Canonical change:** the checkpoint owner should carry one deadline through interruption and idle verification, return named blockers and failures, and retain its admission fence honestly. Contract §§6–8. Acceptance: abort rejects or never settles, writes remain active, and the public checkpoint operation returns a bounded blocked result without claiming frozen or reopening unsafe admission.

### R10 — P2: Host retirement retains a rejected promise with no actual retry

**Confidence: high from source.**

[packages/claxedo-host-serving/src/runtime.ts:221](/Users/yashvardhansingh/test/opencode/packages/claxedo-host-serving/src/runtime.ts:221) removes a runtime from the serving map and caches its retirement promise. On failure it deliberately retains that promise. The comment says the next ensure retries, but `ensure` simply awaits the same rejected promise (`:254`), and `dispose` returns it again (`:280`). There is no remaining entry through which to start a new checked retirement attempt. `workspaceIds()` also omits that unresolved owner because it only lists serving entries.

The fence is appropriate; the missing retry/inspection path is the defect. A transient disposal error leaves the workspace unavailable until the containing owner is replaced. Its nominal drain timeout also falls through to unbounded runtime disposal.

Devin found the same pattern in [packages/claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts:392](/Users/yashvardhansingh/test/opencode/packages/claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts:392): `disposeRuntime` retains a failed retirement promise and `ensureEmbeddedWorkspaceRuntime` awaits it (`:445`). This is a second existing owner to fix under the same contract, not a reason to erase the retirement fence or admit a replacement writer without cleanup evidence.

**Canonical change:** retain the retired entry and partial effects as ownership state; distinguish joining an in-progress operation from explicitly retrying failed retirement. Contract §§4, 7, 10. `runtime.test.ts:220` checks successful drain/removal and repeated successful disposal, not fail-once retirement. Acceptance must show a failed attempt stays fenced and visible, then a checked retry succeeds without admitting overlapping writers.

### R11 — P2: Failed Stop leaves the client with an optimistic idle state

**Confidence: high from source; UI not exercised in this sweep.**

[packages/claxedo-app/src/features/session/composer/ui/submit-abort.ts:98](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/features/session/composer/ui/submit-abort.ts:98) writes idle and clears todos before requesting cancellation. The dispatcher immediately updates the status query and clears its optimistic timeout metadata (`store/session-status-dispatcher.ts:151`). If the abort rejects or returns `ok: false`, the function exits before refreshing authoritative status. The wrapper shows a toast, but this path does not restore the prior status or keep a separate stopping/uncertain command state. Until another server update arrives, the displayed state can disagree with execution.

The request also carries no caller deadline, so a pending backend cancel produces neither success nor a failure toast. Related abort-before-revert paths suppress cancellation rejection in `ui/session-message-actions.ts:71` and `ui/use-session-commands.tsx:563`, then continue to the next mutation. Those callers must consume the same factual cancellation result rather than assuming a caught failure means the precondition was met.

**Canonical change:** the existing composer/status owner must represent pending cancellation separately and consume the runtime's factual result. Preserve last-known execution state until authoritative reconciliation. Contract §§3.2, 5, 11. `submit-abort.test.ts:92` checks toast and zero refresh calls; it does not initialize busy and assert the final status on failure. Acceptance: nonresponding cancel, rejected cancel, uncertain response, reconnect, and delayed results from an older turn.

### R12 — P1: A failed terminal write can leave busy state with only a console error

**Confidence: high; reproduced through `createAgentRuntime` with injected authoritative-write failure.**

After `turns.start` accepts a turn, execution proceeds in a detached tracked promise ([packages/agent-sdk-runtime/src/runtime.ts:675](/Users/yashvardhansingh/test/opencode/packages/agent-sdk-runtime/src/runtime.ts:675)). `runTurn` normally commits its final outcome; if that fails, its catch attempts `store.finishTurn` again (`:452`). If that authoritative write also fails, the last handler only calls `console.error` (`:676`). There is no independent owner-health/error result in this path.

The isolated probe accepted a turn, then made event/finalization writes fail while reads remained available. The producer settled; one console error was recorded, the stored session remained busy, and the runtime emitted no event after the fault. This is the swallowed-error failure class the recovery contract must address. The initiating caller has already received acceptance and cannot learn this outcome through its original response. The exact queue effect depends on which prior events committed; no universal queue-stall claim is needed to establish the visibility defect.

**Canonical change:** the runtime finalization owner must retain an inspectable persistence failure and unresolved execution/cleanup facts outside the failed append path, gate conflicting work as required, and retry canonical persistence after repair. Contract §§3.1, 8–9. Do not emit a fabricated successful terminal event or maintain a second transcript. Acceptance: fail the terminal append after acceptance, verify prompt failure visibility while storage is unavailable, repair storage, reconcile the same generation, and verify no duplicate turn or success is invented.

### R13 — P2: Durable lease-loss containment failures are silently discarded

**Confidence: high from source; provider continuation after lease loss not reproduced.**

The lease owner detects expiry or renewal loss and aborts its signal ([packages/workspace-runtime/src/routes/session-turn-lease.ts:72](/Users/yashvardhansingh/test/opencode/packages/workspace-runtime/src/routes/session-turn-lease.ts:72)). It starts `input.onLost()` with an empty rejection handler (`:78`). The production callback invokes `stopLostTurn`, which itself discards runtime/adapter abort failures (`routes/session-core.ts:877`). A failed cancellation is consequently neither returned to the lease owner nor exposed as a cleanup obligation; a cancellation that never settles also has no result deadline.

Durable fencing prevents stale authoritative writes where enforced, but it does not prove the provider stopped executing tools. That distinction matters during authority transfer: the old owner must retain cleanup responsibility and identify which execution lost its lease. `stopLostTurn` currently calls abort by session alone, so delayed lease-loss cancellation also needs the generation protection from R1.

**Canonical change:** report loss and containment outcome through the existing lease/runtime owner, retain the exact turn generation, and expose unresolved cleanup independently of the revoked session's mutation authority. Contract §§3–4, 7–9. Acceptance: lose the lease during a live turn, reject or hang cancellation, verify stale writes stay fenced and the containment failure is visible; let a replacement start and prove the old callback cannot cancel it.

## Capability gaps to keep separate from bugs

1. **Bounded drain with named blockers.** `local-daemon-lifecycle.ts:87` intentionally retains a daemon while work is pinned. `requestShutdown` acknowledges the request rather than termination. The 24-hour fake-clock probe demonstrates that stranded work can hold it indefinitely. The missing contract is an inspectable owner list, a bounded drain result, and an explicitly authorized recovery operation—not killing healthy background work by age.
2. **Recovery independent of a broken producer or store.** Inspection, cancellation results, and containment need a direct existing-owner path that does not await the stuck iterator, configuration queue, database append, or daemon HTTP loop. Errors should remain available even if durable reconciliation is unavailable.
3. **Generation-scoped operations and shared impact preview.** Existing turn IDs, durable leases, process descriptors, and diagnostics action grants are useful foundations. They do not yet provide the complete inspect/reconcile/cancel/retire/drain operation contract, durable request identity, retries, or an authorized scope revision for shared-harness escalation.
4. **Reconciliation while the existing daemon remains alive.** Startup recovery does not solve a lost terminal event in an adopted daemon. Recovery needs canonical evidence, ordered replay, explicit unresolved state, and a bounded repair of old skipped projections. A renderer refresh cannot establish that a still-owned process has stopped.

## Independent verification

No live sessions, user databases, or provider processes were changed. Tests used injected functions, an in-memory store, or production helpers. The probes establish control-flow defects under the injected conditions; they are not packaged-app or real-provider acceptance.

| Command | Result |
|---|---|
| `bun /tmp/claxedo-recovery-boundary-probe.ts` | Exit 0; four assertions reproduced provider-dependent Stop, cached failed retry, delayed disposal error, and pin-blocked daemon shutdown. The daemon check evaluates the current production function with imports removed and fake activity/time. |
| `bun /tmp/claxedo-delayed-abort-sweep-probe.ts` | Exit 0; B busy before A's delayed abort reply; B's stored busy status cleared afterward; C admitted while B producer still open. |
| `bun /tmp/claxedo-daemon-exit-sweep-probe.ts` | Exit 0; helper returned stopped while injected liveness remained true. All signals were fake callbacks. |
| `bun /tmp/claxedo-finalization-error-sweep-probe.ts` | Exit 0; injected event/finalization write failure produced one console error, left stored status busy, and emitted zero runtime events after the fault. |

No repository test suite, typecheck, build, architecture ratchet, or live OS/process-tree acceptance was run for this documentation-only investigation. Those checks remain necessary for implementation as applicable.
