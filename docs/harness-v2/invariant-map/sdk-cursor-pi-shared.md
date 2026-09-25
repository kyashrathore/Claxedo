# Invariant map — cursor, pi, shared, and root harness tests

Scope: `packages/agent-sdk-runtime/src/harnesses/cursor/**`, `.../pi/**`, `.../shared/**` test files, plus the root `harnesses/*.test.ts`. 39 files.

## Case count vs row count

- **Test declarations** (`test(`, `it(`, `test.each`, `test.skipIf`): **307**
- **Generated-case expansions**: +15
  - `pi/driver.test.ts`: `test.each(["resolve","reject"])` → +1
  - `shared/sdk-runtime-adapter.test.ts`: two `test.each` pairs → +2
  - `shared/sdk-runtime-interactions.test.ts`: three top-level loops (2 session/dir pairs, 2×2 operation/session-dir pairs, 3 provider-option values) → +6
  - `goal-conformance.test.ts`: loop over 4 builtins → +3
  - `goal-recovery.test.ts`: loop over 2 matrix entries → +1
  - `steer-conformance.live.test.ts`: two `test.skipIf` loops over 3 steer + 1 queue harnesses → +2
- **Expanded case count: 322**
- **TSV data rows: 322** (323 lines with header) — they match.

## Replacement classes

| class | rows |
|---|---|
| FLOW(Hn) | 145 |
| FLOW(NEW: …) | 13 |
| WIRE-CORPUS | 39 |
| TRANSLATOR-CORPUS | 7 |
| KEEP(…) | 111 |
| OBSOLETE(…) | 7 |
| **total** | **322** |

FLOW(NEW) collapses to seven distinct proposed flows:

1. A bound Cursor account routes the SDK through the credential broker with a placeholder key (3 cases).
2. An unavailable brokered credential fails the turn rather than falling back to the machine key (1).
3. Cursor resume prepends the saved handoff transcript to the first prompt (1).
4. The Cursor model catalog requires a resolvable cursor-sdk credential and surfaces vendor errors verbatim (4).
5. An SDK-only Cursor agent registers an inferred, action-ineligible process descriptor (1).
6. A real Pi turn over a scripted provider: native tool call, usage, session-file resume, compaction, evaluated goal (1).
7. Per-workspace Pi credential profiles so one placeholder never serves another workspace's turns (3).

## KEEP rows and their reasons

Every KEEP is a race, timing, concurrency, ordering, or fault-injection invariant a scripted real-stack flow cannot reach deterministically. Grouped by file:
- `cursor/backend-url-freeze.test.ts` — a process that never imported the SDK freezes nothing and refuses nothing: process-wide module freeze state
- `cursor/backend-url-freeze.test.ts` — an injected agent module freezes the value exactly as the real import does: test-injection seam must run the freeze
- `cursor/backend-url-freeze.test.ts` — the driver's own load is what freezes the value, with nobody calling the freeze: call-order invariant inside driver load
- `cursor/backend-url-freeze.test.ts` — the value in force at the import is what the SDK keeps: process-wide module freeze ordering
- `pi/auth.test.ts` — a profile reacquired during cleanup serializes its new credential write after removal: concurrency: write-after-remove serialization across two retains
- `pi/auth.test.ts` — a shared managed profile survives until its final adapter is disposed: refcount lifecycle ordering over a shared profile
- `pi/auth.test.ts` — an idle reap on a live adapter leaves the account overlay for its next launch: timing: idle reap vs overlay retention
- `pi/driver.test.ts` — a deferred auth release is retried by the retirement that settles the launch blocking it: descendant retirement ordering under a fault-injected unsettled result
- `pi/driver.test.ts` — an idle RPC check cannot dispose a new turn after a stale reject: stale idle-check race vs admitted turn
- `pi/driver.test.ts` — an idle RPC check cannot dispose a new turn after a stale resolve: stale idle-check race vs admitted turn
- `pi/driver.test.ts` — the goal evaluator receives its request on stdin, keeping prompt material out of argv: spawn-channel invariant a flow cannot observe
- `pi/rpc-process.test.ts` — dispose retires the owned group, including a descendant that ignores TERM: descendant retirement
- `pi/rpc-process.test.ts` — exit is published when the OS reports it, not when disposal starts: ordering: transport-down vs process-exited are separate facts
- `recovery-contract.test.ts` — per-harness recovery capability matrix > a cancel that rejects while the stream is still open reports the provider's error, not a stopped turn: fault injection: refused cancel while turn runs
- `recovery-contract.test.ts` — per-harness recovery capability matrix > a concurrent second stop joins the attempt in flight rather than starting another: single-flight stop
- `recovery-contract.test.ts` — per-harness recovery capability matrix > a late answer from an old turn is refused and reported to the session's owner: stale-reply refusal + owner notification
- `recovery-contract.test.ts` — per-harness recovery capability matrix > a producer that left after a cancel the provider refused is unknown, never terminal: fault injection: exit over unacked cancel
- `recovery-contract.test.ts` — per-harness recovery capability matrix > a provider that never answers the interrupt is bounded, and is never reported terminal: timing: bounded wait on a hung provider
- `recovery-contract.test.ts` — per-harness recovery capability matrix > a transient cancellation failure does not poison the retry: stop-attempt memoization under faults
- `recovery-contract.test.ts` — per-harness recovery capability matrix > an ACP prompt that never settles after the acknowledgement is bounded: timing: bounded wait
- `recovery-contract.test.ts` — per-harness recovery capability matrix > an interaction the store could not project reaches the session's owner, not only its caller: fault injection: reportOwnerFailure path
- `recovery-contract.test.ts` — per-harness recovery capability matrix > the loser of a deadline race releases its timer and its listener: timing: race cleanup, no leaked timer/listener
- `shared/child-event-routing.test.ts` — createChildEventRouter > dispose clears timers and drops unresolved content diagnostically: dispose ordering + diagnostic
- `shared/child-event-routing.test.ts` — createChildEventRouter > drops unmeasurable child events without poisoning later serializable content: fault input: unserializable event
- `shared/child-event-routing.test.ts` — createChildEventRouter > expires an unresolved correlation that exceeds one MiB: buffer bound
- `shared/child-event-routing.test.ts` — createChildEventRouter > expires the offending correlation at the 257th unresolved event: buffer bound
- `shared/child-event-routing.test.ts` — createChildEventRouter > expires unresolved content after thirty seconds without a journal write: timing: 30s unresolved-buffer expiry
- `shared/child-event-routing.test.ts` — createChildEventRouter > flushes content received across a live reconnect in source order after association: ordering: pre-association buffer flush
- `shared/child-event-routing.test.ts` — createChildEventRouter > keeps unrelated buffered correlations when one correlation overflows: buffer isolation
- `shared/child-event-routing.test.ts` — usage a dropped child would lose > keeps metering on the parent once a rolled-up correlation binds, so its cumulative is counted once: rollup/bind ordering
- `shared/child-event-routing.test.ts` — usage a dropped child would lose > keeps two uncorrelated children apart by the provider session each reports from: per-provider uncorrelated scoping
- `shared/child-event-routing.test.ts` — usage a dropped child would lose > reaches the parent turn after its correlation is poisoned, while the child's transcript stays dropped: rollup after poisoning
- `shared/child-event-routing.test.ts` — usage a dropped child would lose > reaches the parent turn when its correlation expires, as each scope's latest cumulative and every delta: usage rollup on buffer expiry
- `shared/child-event-routing.test.ts` — usage a dropped child would lose > reaches the parent turn when its correlation overflows the count or byte limit, the overflowing event included: usage rollup on bound breach
- `shared/child-event-routing.test.ts` — usage a dropped child would lose > reaches the parent turn when the turn ends before its correlation binds: usage rollup on dispose
- `shared/child-event-routing.test.ts` — usage a dropped child would lose > reaches the parent turn without a correlation key, and other uncorrelated events are still dropped: uncorrelated usage rollup
- `shared/goal-publisher.test.ts` — createGoalPublisher > dedupes an unchanged snapshot and republishes once it changes: publication dedupe ordering
- `shared/goal-publisher.test.ts` — createGoalPublisher > dedupes per session, so equal snapshots from two sessions both publish: per-session dedupe keying
- `shared/goal-publisher.test.ts` — createGoalPublisher > forget retires the dedup entry so a re-created session republishes: dedupe reset on session forget
- `shared/goal-publisher.test.ts` — createGoalPublisher > mirrors adapter state even when no event hub is wired: state mirror independent of publication
- `shared/goal-publisher.test.ts` — createGoalPublisher > runs applyState only on an accepted change, before the event goes out: applyState-before-publish ordering
- `shared/goal-stop-order.test.ts` — a Goal stop whose turn never leaves its producer is bounded by the caller's deadline: timing: bounded wait on a stuck producer
- `shared/goal-stop-order.test.ts` — goal stop ordering > a failed disable interrupts nothing and is returned untouched: ordering: failed disable short-circuits
- `shared/goal-stop-order.test.ts` — goal stop ordering > a session with no registered turn has nothing to wait for: ordering
- `shared/goal-stop-order.test.ts` — goal stop ordering > continuation is disabled, the turn interrupted, and only then settled: ordering: disable→abort→idle→settle
- `shared/goal-stop-order.test.ts` — goal stop ordering > without a settle step the disabling result is the answer: ordering
- `shared/process-lifecycle.test.ts` — harness process lifecycle > a child that arrives after a stop is handed straight to stop: start/stop race
- `shared/process-lifecycle.test.ts` — harness process lifecycle > a failed startup rejects every joiner and still allows a later retry: fault injection: failed startup is not cached
- `shared/process-lifecycle.test.ts` — harness process lifecycle > a stop scoped to an old generation cannot take down its replacement: generation-scoped stop; exit-handler ordering
- `shared/process-lifecycle.test.ts` — harness process lifecycle > a stop that lands after its replacement is ready leaves the replacement owning the state: stale-stop ordering across generations
- `shared/process-lifecycle.test.ts` — harness process lifecycle > a stop that never completes is abandoned at the bound: timing: bounded stop
- `shared/process-lifecycle.test.ts` — harness process lifecycle > acquire holds its lease across a slow start: lease covers startup race
- `shared/process-lifecycle.test.ts` — harness process lifecycle > acquire releases its lease when the start fails: fault injection
- `shared/process-lifecycle.test.ts` — harness process lifecycle > an active lease suspends the idle deadline until it is released: lease-vs-idle ordering
- `shared/process-lifecycle.test.ts` — harness process lifecycle > an idle generation is torn down after the grace period: timing: idle-grace teardown
- `shared/process-lifecycle.test.ts` — harness process lifecycle > an idle timer armed for an old generation cannot kill a newer one: stale-timer/generation guard
- `shared/process-lifecycle.test.ts` — harness process lifecycle > concurrent first operations share one startup generation: admission: concurrent ensures share one generation
- `shared/process-lifecycle.test.ts` — harness process lifecycle > dispose forbids further starts: dispose ordering
- `shared/process-lifecycle.test.ts` — harness process lifecycle > parent loss disposes the lifecycle and detaches cleanly: signal-driven disposal
- `shared/process-lifecycle.test.ts` — harness process lifecycle > releasing a lease twice does not double-count: lease idempotence
- `shared/process-lifecycle.test.ts` — harness process lifecycle > the countdown starts only after the LAST lease is released: lease counting
- `shared/process-lifecycle.test.ts` — idle reaper > a lease suspends the countdown for its whole duration: lease-vs-idle ordering
- `shared/process-lifecycle.test.ts` — idle reaper > a timer that fires after a later touch does not reap: stale-timer epoch guard
- `shared/process-lifecycle.test.ts` — idle reaper > a touch during a lease does not start a countdown: ordering
- `shared/process-lifecycle.test.ts` — idle reaper > cancel is terminal: cancel ordering
- `shared/process-lifecycle.test.ts` — idle reaper > nested leases release in any order: lease nesting
- `shared/sdk-runtime-adapter.test.ts` — SdkRuntimeAdapter > Codex drops a provisional autonomous Goal queue when provider-turn admission is busy: admission-refusal path on provider-started turn
- `shared/sdk-runtime-adapter.test.ts` — SdkRuntimeAdapter > disposal awaits the full committing goal producer after its driver stops: ordering: dispose waits for the committing producer
- `shared/sdk-runtime-adapter.test.ts` — SdkRuntimeAdapter > disposal awaits the full committing prompt producer after its driver stops: ordering: dispose waits for the committing producer
- `shared/sdk-runtime-adapter.test.ts` — SdkRuntimeAdapter > dispose aborts and closes active turns: dispose ordering
- `shared/sdk-runtime-adapter.test.ts` — SdkRuntimeAdapter > does not acknowledge an abort until the adapter busy lock is retired: abort-ack ordering vs busy lock
- `shared/sdk-runtime-adapter.test.ts` — SdkRuntimeAdapter > forgets a deleted session's Goal publication so a reused id is not deduped away: dedupe reset across session delete
- `shared/sdk-runtime-adapter.test.ts` — SdkRuntimeAdapter busy lock > a second prompt is accepted once the turn has settled: admission ordering
- `shared/sdk-runtime-adapter.test.ts` — SdkRuntimeAdapter busy lock > a stale release cannot unlock a replacement turn generation: stale-release/generation guard
- `shared/sdk-runtime-adapter.test.ts` — SdkRuntimeAdapter busy lock > double release is a no-op, so the finally backstop cannot strand a session: idempotent release
- `shared/sdk-runtime-adapter.test.ts` — SdkRuntimeAdapter busy lock > releases the lock at the terminal event, before the generator finishes: admission release ordering
- `shared/sdk-runtime-adapter.test.ts` — usage of a child that never bound, rolled up after the turn stops reading > reaches the hub once, not the consumer: rollup-on-teardown ordering
- `shared/sdk-runtime-adapter.test.ts` — usage of a child that never bound, rolled up after the turn stops reading > reaches the hub when the consumer returns before the turn ends: consumer early-return timing
- `shared/sdk-runtime-interactions.test.ts` — all-question shutdown keeps an uncommitted rejection live: fault injection
- `shared/sdk-runtime-interactions.test.ts` — permission approval remains pending when the reply cannot be committed: fault injection: no release without commit
- `shared/sdk-runtime-interactions.test.ts` — permission cancellation remains retryable when persistence fails: fault injection
- `shared/sdk-runtime-interactions.test.ts` — permission replies from other-session in <work> cannot consume another pending request: foreign-reply refusal
- `shared/sdk-runtime-interactions.test.ts` — permission replies from session-1 in <other-workspace> cannot consume another pending request: foreign-reply refusal
- `shared/sdk-runtime-interactions.test.ts` — question cancellation commits rejection and only consumes the stopped session: scoped cancellation
- `shared/sdk-runtime-interactions.test.ts` — question cancellation preserves a pending request when persistence fails: fault injection
- `shared/sdk-runtime-interactions.test.ts` — question reject from other-session in <work> preserves another owner's request: foreign-reply refusal
- `shared/sdk-runtime-interactions.test.ts` — question reject from session-1 in <other-workspace> preserves another owner's request: foreign-reply refusal
- `shared/sdk-runtime-interactions.test.ts` — question replies remain retryable when persistence fails: fault injection: save before release under a failed write
- `shared/sdk-runtime-interactions.test.ts` — question reply from other-session in <work> preserves another owner's request: foreign-reply refusal
- `shared/sdk-runtime-interactions.test.ts` — question reply from session-1 in <other-workspace> preserves another owner's request: foreign-reply refusal
- `shared/spawn-env.secrets.test.ts` — harness spawn env never carries internal secrets > a newly invented internal secret is denied without any code change: env denylist pattern coverage
- `shared/spawn-env.secrets.test.ts` — harness spawn env never carries internal secrets > denial is case-insensitive: env denylist case rule
- `shared/spawn-env.secrets.test.ts` — harness spawn env never carries internal secrets > every secret-suffixed CLAXEDO_/WORKSPACE_RUNTIME_ name in the repo is unreachable: repo-scanning env denylist invariant
- `shared/spawn-env.secrets.test.ts` — harness spawn env never carries internal secrets > the specific keys-to-the-kingdom names are denied: env denylist
- `shared/spawn-env.secrets.test.ts` — harness spawn env never carries internal secrets > undefined values are dropped: env sanitize detail
- `shared/store-lifecycle.test.ts` — adapter store lifecycle > AcpHarnessAdapter closes adapter-created stores once: dispose-once ownership ordering
- `shared/store-lifecycle.test.ts` — adapter store lifecycle > AcpHarnessAdapter leaves caller-owned stores open: ownership
- `shared/store-lifecycle.test.ts` — adapter store lifecycle > CodexHarnessAdapter closes adapter-created stores once: dispose-once ownership ordering
- `shared/store-lifecycle.test.ts` — adapter store lifecycle > CodexHarnessAdapter leaves caller-owned stores open: ownership
- `shared/subagent-lifecycle.test.ts` — a child whose turn could not start does not keep the session's lease: fault injection: lease cleanup on failed start
- `shared/subagent-lifecycle.test.ts` — a child's turn claims the child session's own lease, not the parent's: lease scoping: child vs parent session
- `shared/subagent-lifecycle.test.ts` — a late settle against a replacement child generation is refused by the store fence: stale-generation refusal
- `shared/subagent-lifecycle.test.ts` — settleOpen interrupts a foreground child this turn still owns, and skips a background one: foreground/background settle ordering
- `shared/subagent-lifecycle.test.ts` — settling a child releases its lease, and a repeated terminal is a replay: settle-once ordering
- `shared/turn-authority.test.ts` — a domain that cannot claim the session's lease gets no authority to write with: turn-admission lease: single writer per session
- `shared/turn-authority.test.ts` — a finalization releases the lease so the session is admissible again: lease release ordering
- `shared/turn-authority.test.ts` — a finalization the store refuses still releases the lease: fault injection: lease release under a failed write
- `shared/turn-authority.test.ts` — a terminal presenting a lease the session has moved past is refused: stale-terminal refusal across generations
- `shared/turn-projection.test.ts` — createTurnEventProjector > does not publish live events when compat append does not return committed output: fault injection
- `shared/turn-projection.test.ts` — createTurnEventProjector > does not publish runtime events when compat append fails: fault injection: no publish without committed append
- `shared/turn-projection.test.ts` — createTurnEventProjector > does not publish terminalized tool errors when append fails: fault injection

## UNCOVERED fix commits

All 85 fix-subject commits touching the scoped paths are mapped in `sdk-cursor-pi-shared-fixes.tsv`. Exactly one is UNCOVERED:

- `5e503ddc41` chore(lint): apply oxlint safe autofixes and scope test-file type rules — mechanical lint pass; no behavior changed, so no regression test applies.

Two commits are covered by flows rather than existing tests because the guarding behavior only shows end-to-end: `3c2bd73322` (operation survives owner's restart → H8), `183ccbc157` (credential placeholder renewal → H20), `845879a8a7` (pasted image as file part → H11), `5385778e43` (create-time title survives rename → H12), `147feaf7b4` (Claude task progress across turns → H5), `fa1ae4940e`/`9ee4c57806` (continue across harnesses → H8).

## Surprising findings

- **111 of 322 cases (34%) must stay as focused tests.** The shared/ directory is dominated by lease, generation-fence, dedupe, buffer-bound, and fault-injection invariants that no real-stack flow can produce deterministically. The rebuild's "few focused tests" is a large suite, not a few.
- **Pi's `test.skipIf` cases are environment-gated.** `pi/rpc-process.test.ts` has two `PI_EXECUTABLE`-gated real-process tests and `pi/catalog.test.ts` one; `pi/executable.test.ts` and `pi/driver.test.ts` each have a platform/pin-gated case. These count as declared cases and are mapped, but a corpus must record whether the gate was taken.
- **The four OBSOLETE Pi rows hinge on defect H-6's scope.** The plan removes "Pi pin, `agent-dir.ts` override and title extension, *for owner sessions only*" — if the pin check survives for Claxedo-spawned Pi, two executable tests and two title-extension tests move back to KEEP or a credential-path flow instead of OBSOLETE.
- **`steer-conformance.live.test.ts` is already the shape the rebuild wants** — real harness, public runtime, opt-in via `CLAXEDO_LIVE_HARNESS`. Its four generated cases map straight to H7.
- **The recovery matrix is self-asserted, not just exercised.** `recovery-contract.test.ts` first proves each row's cleanup ceiling is reachable by its own evidence, then drives real cancels under it — the table is the spec H2 must reproduce.
- **Two "fix" commits are reverts or WIP checkpoints** (`414e646bf8`, `11044d6bb0`, `e99e57ff2b`, `bb1bab608e`, `903b2d4dec`) that match the `grep -i fix` filter only via "review-fix"/"fixes" wording; they're mapped to the test files they touched.
