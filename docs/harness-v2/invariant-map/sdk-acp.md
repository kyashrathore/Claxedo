# invariant-map: sdk-acp

Scope: `packages/agent-sdk-runtime/src/harnesses/acp/**/*.test.ts` (30 files) in
`/Users/yashvardhansingh/test/opencode-harness`, mapped against the rebuild plan
`docs/plans/2026-09-24-002-refactor-harness-rebuild-plan.md`.

## Reconciliation

- Declaration sites found: 214 (`test(`/`it(`/`test.each`/`it.each`/`test.skipIf`,
  including one `test(` inside a `for` in `lifecycle-regressions.test.ts` and one
  `test.skipIf` in `transport-retirement.test.ts`; the naive `^\s*(test|it)\(` grep
  reports 212 and misses both).
- Runtime-registered cases: **220** — four parameterized/loop sites expand:
  - `lifecycle-regressions.test.ts`: `for (const callback of ["onError","onExit"]) test(...)` → 2
  - `index.test.ts`: `for (const fails of [false, true])` draft-discovery test → 2
  - `subagent-runtime.test.ts`: `test.each([true,false])` → 2
  - `workspace-behavior.test.ts`: three `it.each` × 2 → +3 over sites
- `sdk-acp.tsv` rows: **220** (221 lines including header). Rows == cases.

## Counts per replacement class

| class | rows |
|---|---|
| FLOW(Hn) | 151 |
| KEEP | 46 |
| TRANSLATOR-CORPUS | 19 |
| WIRE-CORPUS | 3 |
| OBSOLETE | 1 |
| FLOW(NEW: …) | 0 |

No `FLOW(NEW)` was needed: every end-to-end behavior had a home in H1–H34 —
mostly H2/H3 (turns, permissions), H8 (restart/recovery), H10 (config),
H14 (MCP), H16 (custom ACP), H21 (session/process sharing), H23 (Windows),
H26/H27 (restoration, history after restart).

## KEEP rows (46) — focused invariants a real-stack flow cannot reach deterministically

Grant keys (permission-grants.test.ts, 5):
- `an absent kind is remembered as 'other', never as a wildcard` — grant key falls back to a fixed kind, never a wildcard match.
- `an untitled request yields no grant, so it can never be answered on the user's behalf` — titleless requests must not mint reusable grants.
- `a grant matches only the same kind and the same title` — grant matching is exact key equality.
- `saving keeps the rest of the permission state and never duplicates` — grant persistence is merge, not overwrite.
- `malformed persisted rows are ignored rather than trusted` — corrupt grant state is dropped, not honored.

Pattern-validation worker (pattern-validation.test.ts, 2):
- `Node and Bun terminate catastrophic native regex under an external watchdog` — runaway regex killed by watchdog; a flow cannot inject catastrophic backtracking reliably.
- `timeout and cancellation release the bounded worker slot` — worker-pool slot release under timeout/cancel races.

Transport/process retirement (transport-retirement, lifecycle-regressions, 5):
- `immediate adapter recreation waits for the old wrapper's resistant writer child` — descendant retirement fence: recreation blocks on a SIGTERM-ignoring child.
- `synchronous onError preserves launch failure and retires its transport` — sync-throw inside the transport factory ordering.
- `synchronous onExit preserves launch failure and retires its transport` — same ordering via sync onExit.
- `cancelling an intermediate child settles only its descendant interactions` — persistence failure mid-cancel: only descendants settle.
- `a synchronous error followed by constructor failure does not schedule death callbacks` — double-fault ordering at construction.

Probe timing (probe-options.test.ts, 2):
- `uses the session boot timeout when no probe timeout override is set` — hung-probe fault injection.
- `rejects when shared process startup hangs` — hung shared-process startup bound.

Goal projection persistence faults (goal-projection.test.ts, 2):
- `a Goal terminal the store refuses still leaves the session admissible` — fault-injected finishTurn refusal still releases the lease.
- `a Goal projection whose turn could not start does not keep the session's lease` — fault-injected startTurn refusal keeps no lease.

Elicitation races/persistence (elicitation.test.ts, elicitation-wire.test.ts, 3):
- `question cancellation defeats an in-flight validation and duplicate acceptance` — validation race named in the plan's kept list.
- `ACP shared question settlement retains its live resolver after a failed durable reply` — failed durable write must not drop the live resolver.
- `a sibling adapter cannot retire a live question, but disposal clears the pending row` — ownership across adapter instances.

Connection-state ordering (connection-state.test.ts, 1):
- `observations fence old generations, isolate directories, and never promote discovery readiness` — stale-generation writes fenced.

Quiet-countdown timing (process.test.ts, 6):
- `a turn longer than the countdown survives while the agent keeps streaming` — idle countdown resets on activity.
- `a permission left with the human holds the countdown open` — permission wait leases the idle bound.
- `a session waiting for permission does not block another session or accept a second prompt of its own` — per-session admission order on a shared process.
- `a pusher that answers on the spot releases the hold, so silence afterwards still times out` — hold release on instant reply.
- `silence requests cancellation while preserving the unresolved turn` — idle timeout yields provider_unreachable/uncertain, not a fabricated answer.
- `a disposal reason reaches the prompt still in flight` — exit-gate reason propagates to in-flight prompt.

Session creation timing (create-session.test.ts, index.test.ts, 3):
- `fails promptly when ACP newSession hangs` — hung session/new bound.
- `initialization timeout disposes the process` — hung initialize retires the process it spawned.
- `session creation timeout disposes the process before storing a session` — ordering: retire before persisting.

Startup elicitation (startup-elicitation.test.ts, 6):
- `concurrent session/new requests own isolated durable questions before upstream IDs exist` — pre-id question ownership under concurrency.
- `newSession countdown pauses while the human considers startup elicitation` — human wait suspends the deadline.
- `process loss retires startup questions and never revives their resolvers` — process death during startup elicitation.
- `unattended startup still times out without inventing an executable session` — newSession timeout with a pending question.
- `startup process idle lifetime survives human wait and releases after final creation` — idle reaper accounting across pending questions.
- `initialize questions use the reserved creation owner and suspend its deadline` / `disposing initialization cancels its question without fabricating a session` — initialize-scoped ownership and disposal ordering.

Shared restoration (session-isolation.test.ts, 1):
- `simultaneous session options and prompt share one authoritative restoration` — concurrent resume single-flight.

Index adapter guards (index.test.ts, 6 more):
- `requires a workspace directory at cwd-dependent boundaries` — boundary guard unreachable through the flows' real routes.
- `registers direct ACP harness, probe, and MCP lifecycles without launch secrets` — process-observer registration contract.
- `resume timeout quarantines its session without disposing the process` — per-session quarantine instead of process kill.
- `a prompt failure leaves the shared process intact` — provider inactivity bound ends the turn; process survives for siblings.
- `config apply defers restart while a turn is active` — deferred restart ordering.
- `concurrent draft discovery shares one session creation (failure=false/true)` — probe dedup single-flight, both legs.

Cold-start stalls (workspace-behavior.test.ts, 2):
- `fails the turn instead of hanging forever when cold-start resume stalls` — stalled resume bounded.
- `fails the turn instead of hanging forever when cold-start sync stalls` — stalled sync bounded.

## OBSOLETE rows (1)

- `acp/index.test.ts > builds ACP processes through the injected transport factory` —
  OBSOLETE(ACPTransportFactory injection seam; v2 transports own spawn via
  services.spawn). Pure plumbing the new contract removes; the spawn path it fed
  is covered by the connection/transport rows.

## UNCOVERED fixes

- `fde747c235` fix(runtime): resolve review findings on the generic harness cutover —
  acp side swapped a local `modelSelection` validator in `connection-provider.ts`
  for the shared `decodeModelSelection`. No acp test feeds a malformed
  `modelSelection` through the provider.
  Suggested: connecting with a malformed `modelSelection` in the connection
  config rejects with the decode error before spawn.
- `17e2bc83b1` fix(sdk): kill shimmed harness process trees on Windows — mapped
  to `FLOW(H23)` rather than UNCOVERED, but flagged: if H23's Windows lane does
  not land a tree-kill assertion, add "disposing a .cmd-launched transport leaves
  no surviving grandchild holding the fixture dir".

Everything else on the fix list maps to a named test in `sdk-acp.tsv` or, for
three commits whose acp-side diff is test-only (`5504273fcd`, `e289842f37`,
`5b45b1cb0f`) or comment-only (`32090eb565` acp hunk), to the suites they repaired.

## Surprising findings

- The grep headline "212 cases" undercounts two ways: it misses a `test.skipIf`
  (`transport-retirement.test.ts`) and a `test(` hidden inside a `for` header
  (`lifecycle-regressions.test.ts`), while four `.each`/loop sites expand to nine
  cases. Real count is 220.
- 46 of 220 cases (~21%) are KEEP — far above the plan's named minimum. The acp
  suite carries most of the package's timing/race surface: quiet-countdown,
  startup-elicitation suspension, probe dedup, retirement fencing.
- The entire `startup-elicitation.test.ts` file is KEEP-shaped: all nine cases
  are countdown-suspension, pre-id ownership, or disposal-ordering invariants —
  none reduce to a real-stack flow.
- `9823fdd75c` ("a turn is bounded by the agent going quiet, never by the clock")
  is the single most test-dense fix: it created the quiet-countdown suite
  (6 KEEP rows) and permission-grants.test.ts (5 KEEP rows) in one commit.
- Only one test in scope is genuinely OBSOLETE; every other unit test protects a
  live invariant. The suite is not the "bloat" the plan's framing might suggest —
  it is dense fault-injection coverage that mostly must survive as focused tests.
- Three fix commits touch only acp test files (their runtime fix is elsewhere in
  the tree); one commit's acp hunk is comment-only. Both kinds are listed for
  completeness with notes, not treated as uncovered.
