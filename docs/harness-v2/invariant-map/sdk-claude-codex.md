# Invariant map — agent-sdk-runtime harnesses: Claude + Codex

Lane: `invariant-map-sdk-claude-codex` (plan P0.5). Scope: every test case in
`packages/agent-sdk-runtime/src/harnesses/claude/**/*.test.ts` and
`packages/agent-sdk-runtime/src/harnesses/codex/**/*.test.ts`, plus every commit touching
those source directories whose subject contains "fix" (case-insensitive).

## Counts

- Enumerated test cases: **239** (Claude 95, Codex 144, across 13 + 23 files)
- `sdk-claude-codex.tsv` data rows: **239** — counts match.
- Fix commits matching the filter: **73** — `sdk-claude-codex-fixes.tsv` data rows: **73**.

Cases were expanded beyond the literal `test(` count: `test.each` tables, `for`-loop-generated
tests (claude/permissions 2 loops × 4, codex/cancellation 2 × 2, codex/permission-state 4,
codex/server-request 4 × 2 + 2, codex/workspace-behavior 1 × 5), and `test.skipIf` sites all
count as individual cases.

### Cases per replacement class

| class | cases |
|---|---|
| FLOW(Hn / NEW) | 75 |
| TRANSLATOR-CORPUS | 43 |
| WIRE-CORPUS | 1 |
| KEEP (focused invariant) | 120 |
| OBSOLETE | 0 |
| **total** | **239** |

FLOW breakdown: H2 ×10, H3 ×5, H4 ×3, H5 ×1, H6 ×8, H7 ×4, H8 ×1, H9 ×1, H10 ×11,
H11 ×9, H12 ×5, H13 ×3, H14 ×5, H15 ×3, H23 ×2, H27 ×1, NEW ×3 (cross-harness
handoff transcript delivery, and handoff rollback archiving the prepared thread).

## KEEP list (120 focused invariants)

These stay as focused tests next to their code: spawn-env/credential confinement and
executable resolution (invisible on any wire), grant-key exactness across driver/process
restarts, stale/replay steering admission, persistence-failure-during-approval, descendant
retirement and process-ownership identity, inventory/deadline budgeting during stop,
publication ordering and failed-publication cleanup, canonical request-id uniqueness across
processes, request-parameter shapes (model/effort/tier naming), config-option provenance,
idle-reaper timing, bounded recovery retries, and fault-injected handler/startup failures.

| file | test | reason |
|---|---|---|
| claude/auth.test.ts | claudeAuthEnv > an api-key projection sends the placeholder in the API-key variable | KEEP(spawn env credential mapping; a flow cannot read the child's env) |
| claude/auth.test.ts | claudeAuthEnv > a bearer projection sends the placeholder in the auth-token variable | KEEP(spawn env credential mapping; a flow cannot read the child's env) |
| claude/auth.test.ts | claudeAuthEnv > a api-key projection leaves the placeholder as the only credential a populated parent hands down | KEEP(spawn env hygiene; operator credentials must be scrubbed, invisible on the wire) |
| claude/auth.test.ts | claudeAuthEnv > a bearer projection leaves the placeholder as the only credential a populated parent hands down | KEEP(spawn env hygiene) |
| claude/auth.test.ts | claudeAuthEnv > no projection sets no variables, so the CLI uses its own login | KEEP(spawn env credential mapping) |
| claude/auth.test.ts | harnessProjection > prefers the native SDK binding over a bare vendor provider id | KEEP(credential projection selection; pure lookup a flow cannot distinguish) |
| claude/auth.test.ts | harnessProjection > a stored vendor account binds the harness that answers to it | KEEP(credential projection selection) |
| claude/auth.test.ts | harnessProjection > another harness's binding decides nothing | KEEP(credential projection selection) |
| claude/driver.test.ts | Claude SDK driver > accepts a mid-turn steer only once the CLI replays it | KEEP(stale steering: replay-matched admission, a named kept invariant) |
| claude/driver.test.ts | Claude SDK driver > declines a steer the CLI took from stdin but never replayed before the query ended | KEEP(stale steering) |
| claude/driver.test.ts | Claude SDK driver > scrubs the local document installation secret from the child environment | KEEP(spawn env secret scrubbing; invisible on the wire) |
| claude/driver.test.ts | Claude SDK driver > offers no model until a live probe answers | KEEP(model list provenance; requires scripted SDK probe) |
| claude/driver.test.ts | Claude SDK driver > marks the SDK's default row, so the picker shows the model an unset session runs | KEEP(model list provenance; requires scripted SDK probe) |
| claude/driver.test.ts | Claude SDK driver > sends the default row rather than letting the CLI resolve a model of its own | KEEP(spawn option: explicit model; invisible on the wire) |
| claude/driver.test.ts | Claude spawns against the broker, never a credential > the spawn env carries the base URL and the placeholder | KEEP(spawn env credential mapping) |
| claude/driver.test.ts | Claude spawns against the broker, never a credential > an operator's own credentials in this process do not reach the spawned harness | KEEP(spawn env hygiene) |
| claude/driver.test.ts | Claude spawns against the broker, never a credential > an auth map that is not projections is refused rather than run on nothing | KEEP(config validation; refuses to silently run on machine login) |
| claude/driver.test.ts | a brokered turn withholds the operator's Claude account > the mirrored config dir carries configuration and no account | KEEP(brokered config dir scrubbing; filesystem shape a flow cannot read) |
| claude/driver.test.ts | a brokered turn withholds the operator's Claude account > an entry Claxedo does not name stays out of the brokered dir | KEEP(brokered config dir scrubbing) |
| claude/driver.test.ts | a brokered turn withholds the operator's Claude account > state Claude Code wrote into the dir survives, a stale mirror does not | KEEP(brokered config dir scrubbing) |
| claude/driver.test.ts | a brokered turn withholds the operator's Claude account > an operator's later settings edit reaches the next brokered launch | KEEP(brokered config dir scrubbing) |
| claude/driver.test.ts | a brokered turn withholds the operator's Claude account > the spawn env points at it only while a projection is held | KEEP(spawn env credential mapping) |
| claude/driver.test.ts | Claude turn effort is never dropped silently > a cold model list is loaded, so the first turn still sends its effort | KEEP(spawn option: effort resolution requires scripted supportedModels) |
| claude/driver.test.ts | Claude turn effort is never dropped silently > a session saved under the full model id finds its alias row | KEEP(spawn option: model-id alias resolution) |
| claude/driver.test.ts | Claude turn effort is never dropped silently > a level the model does not take fails the turn instead of vanishing | KEEP(config validation: unsupported effort fails the turn by name) |
| claude/executable.test.ts | resolveClaudeExecutable > finds `claude` on PATH | KEEP(spawn executable resolution; flows exercise only the installed happy path) |
| claude/executable.test.ts | resolveClaudeExecutable > uses the native-installer location when PATH misses it | KEEP(spawn executable resolution) |
| claude/executable.test.ts | resolveClaudeExecutable > an explicit override wins over PATH | KEEP(spawn executable resolution) |
| claude/executable.test.ts | resolveClaudeExecutable > a broken explicit override resolves to undefined | KEEP(spawn executable resolution) |
| claude/executable.test.ts | resolveClaudeExecutable > requireClaudeExecutable throws an actionable error when absent | KEEP(spawn executable resolution) |
| claude/first-party-mcp.test.ts | Claude first-party MCP injection > keeps the bearer out of the harness child environment | KEEP(secret confinement; invisible on the wire) |
| claude/goal-lifecycle.test.ts | Claude native Goal lifecycle > drains cancellation before clearing the native hook and rejects late Goal updates | KEEP(goal stop ordering: cancellation drains before the clear; ordering a flow cannot force) |
| claude/goal-lifecycle.test.ts | Claude native Goal lifecycle > does not accept a model response as confirmation that the native hook was cleared | KEEP(fault: unconfirmed clear; guards bound-the-Goal-stop fix 32090eb565) |
| claude/goal-lifecycle.test.ts | Claude native Goal lifecycle > hands every Goal turn an empty mirror so the CLI resumes from its own transcript | KEEP(spawn-time sessionStore mirror plumbing; not visible on the wire) |
| claude/goal-lifecycle.test.ts | Claude native Goal lifecycle > settles the Goal as blocked when the Goal query dies instead of leaving it active | KEEP(fault-injected query death mid-goal) |
| claude/launch.test.ts | - > a launch whose pid was recycled records no identity, so its retirement signals nothing | KEEP(pid-reuse safety; fault-injected identity read) |
| claude/launch.test.ts | - > a launch whose identity matches the spawn is recorded and retirable | KEEP(ownership identity recording) |
| claude/permission-mode-parity.test.ts | Claude SDK PermissionMode parity > the parity assertions are present and hold | KEEP(permission-mode set pin; catches upstream SDK rename) |
| claude/permission-mode-parity.test.ts | Claude SDK PermissionMode parity > documents the SDK's current mode set | KEEP(permission-mode set pin) |
| claude/permission-mode-parity.test.ts | Claude SDK PermissionMode parity > mode ids are unique | KEEP(permission-mode set pin) |
| claude/permissions.test.ts | - > allow_always carries only accepted grants into a recreated driver and isolates other sessions | KEEP(grant keys per harness: allow-always persistence + session isolation) |
| claude/permissions.test.ts | - > allow_once carries only accepted grants into a recreated driver and isolates other sessions | KEEP(grant keys per harness) |
| claude/permissions.test.ts | - > deny carries only accepted grants into a recreated driver and isolates other sessions | KEEP(grant keys per harness) |
| claude/permissions.test.ts | - > storage-failure carries only accepted grants into a recreated driver and isolates other sessions | KEEP(fault-injected persistence failure during approval — a named kept invariant) |
| claude/permissions.test.ts | - > native rule replacements and removals remain scoped to their behavior and preserve exact rule contents | KEEP(grant key exactness: rule contents preserved verbatim, e.g. parens) |
| claude/permissions.test.ts | - > allow_always only reuses the exact accepted Bash request after driver reconstruction | KEEP(grant keys per harness: exact-match grant identity) |
| claude/permissions.test.ts | - > allow_once only reuses the exact accepted Bash request after driver reconstruction | KEEP(grant keys per harness) |
| claude/permissions.test.ts | - > deny only reuses the exact accepted Bash request after driver reconstruction | KEEP(grant keys per harness) |
| claude/permissions.test.ts | - > reject_always only reuses the exact accepted Bash request after driver reconstruction | KEEP(grant keys per harness) |
| claude/projection-expiry.test.ts | - > a live placeholder is the token the spawn carries | KEEP(spawn env credential mapping) |
| claude/turn-input.test.ts | the Claude turn input > a steer resolves only when the CLI replays its uuid | KEEP(stale steering: replay-uuid matching) |
| claude/turn-input.test.ts | the Claude turn input > ignores user messages that are not replays | KEEP(replay matching) |
| claude/turn-input.test.ts | the Claude turn input > an unreplayed steer is declined when the query ends and unknown when it fails | KEEP(stale steering: settle-outcome mapping) |
| claude/turn-input.test.ts | the Claude turn input > refuses a steer once stdin is closed, and still delivers one written before | KEEP(steer ordering around stdin close) |
| codex/driver-env.test.ts | Codex app-server environment > scrubs the local document installation secret from the child environment | KEEP(spawn env secret scrubbing; invisible on the wire) |
| codex/driver-env.test.ts | Codex app-server environment > registers the app-server PID and safe MCP identities | KEEP(process-observer descriptor hygiene; MCP command/env must not leak) |
| codex/executable.test.ts | Codex executable resolution > resolves the executable from PATH on Posix | KEEP(spawn executable resolution) |
| codex/executable.test.ts | Codex executable resolution > follows a Windows npm cmd shim to the official native binary | KEEP(spawn executable resolution; Windows shim traversal) |
| codex/executable.test.ts | Codex executable resolution > uses a native codex.exe directly on Windows | KEEP(spawn executable resolution) |
| codex/executable.test.ts | Codex executable resolution > throws an actionable error when Codex is absent | KEEP(spawn executable resolution) |
| codex/app-server-process.test.ts | - > failed approval requests receive a valid JSON-RPC error and the transport remains usable | KEEP(fault-injected handler failure; real spawned process) |
| codex/app-server-process.test.ts | - > dispose stops a descendant that outlives the app-server | KEEP(descendant retirement — a named kept invariant) |
| codex/app-server-process.test.ts | - > a request that never answers rejects at its deadline and the transport survives | KEEP(request deadline; timing) |
| codex/app-server-process.test.ts | - > a launch is refused when ownership cannot be recorded | KEEP(launch refusal on unrecordable ownership; fault) |
| codex/app-server-process.test.ts | - > a request to an app-server that already exited is refused, not left to its deadline | KEEP(post-exit refusal; timing) |
| codex/app-server-process.test.ts | - > a retained unresolved launch stops refusing once its recorded pid is no longer that launch | KEEP(retained-retirement re-read; guards 425cbc39e6) |
| codex/app-server-process.test.ts | - > a request during the TERM grace is still sent, because a signalled process can still answer | KEEP(TERM-grace request admission; timing/ordering) |
| codex/auth-file.test.ts | Codex auth file > writes auth.json owner-only and readable back | KEEP(credential file write: owner-only mode; guards P-32 bf5f5230a5/b7d9578ecf) |
| codex/auth-file.test.ts | Codex auth file > repairs the mode on a pre-existing permissive auth file | KEEP(credential file write) |
| codex/auth-file.test.ts | Codex auth file > narrows a permissive home directory | KEEP(credential file write) |
| codex/auth-file.test.ts | Codex auth file > refuses a symlinked home instead of writing through it | KEEP(credential file write: symlink refusal) |
| codex/auth-file.test.ts | Codex auth file > replaces a symlink at auth.json instead of writing through it | KEEP(credential file write: symlink replacement) |
| codex/auth-file.test.ts | Codex auth file > answers undefined for a missing auth file | KEEP(credential file read) |
| codex/dynamic-agent.test.ts | spawnDynamicCodexAgent > removes the child listener after turn-start failure | KEEP(listener cleanup on failure; resource invariant) |
| codex/goal-lifecycle.test.ts | Codex Goal lifecycle > deletes a session without spawning an app-server when the Codex binary is broken | KEEP(fault: delete must not depend on a spawnable harness) |
| codex/idle-reaping.test.ts | Codex app-server idle reaping > reaps the app-server after a quiet period and respawns for the next turn | KEEP(idle reaper timing; real spawned process) |
| codex/idle-reaping.test.ts | Codex app-server idle reaping > does not reap a turn that is still inside a long silent tool call | KEEP(idle reaper must not kill a live turn; timing) |
| codex/idle-reaping.test.ts | Codex app-server idle reaping > a turn whose app-server never starts leaves no lease behind | KEEP(lease cleanup on startup failure; fault) |
| codex/permission-state.test.ts | - > a failed durable grant write never returns approval to Codex | KEEP(persistence failure during approval — a named kept invariant; save-before-release) |
| codex/permission-state.test.ts | - > allow_always survives native callback replacement only when explicitly persistent | KEEP(grant keys per harness: Codex acceptForSession persistence across process restart) |
| codex/permission-state.test.ts | - > allow_once survives native callback replacement only when explicitly persistent | KEEP(grant keys per harness) |
| codex/permission-state.test.ts | - > deny survives native callback replacement only when explicitly persistent | KEEP(grant keys per harness) |
| codex/permission-state.test.ts | - > reject_always survives native callback replacement only when explicitly persistent | KEEP(grant keys per harness) |
| codex/protocol.test.ts | - > every inventory read carries its own budget, so a paged stop cannot expire partway through | KEEP(per-call deadline budgeting during paged stop; timing) |
| codex/server-request.test.ts | - > command approval can be answered during publication | KEEP(ordering: pending entry registered before the frame projects) |
| codex/server-request.test.ts | - > command approval cleans up a failed publication | KEEP(fault: failed publication cleanup) |
| codex/server-request.test.ts | - > question can be answered during publication | KEEP(ordering: pending entry registered before projection) |
| codex/server-request.test.ts | - > question cleans up a failed publication | KEEP(fault: failed publication cleanup) |
| codex/server-request.test.ts | - > MCP form can be answered during publication | KEEP(ordering: pending entry registered before projection) |
| codex/server-request.test.ts | - > MCP form cleans up a failed publication | KEEP(fault: failed publication cleanup) |
| codex/server-request.test.ts | - > MCP approval can be answered during publication | KEEP(ordering + kind routing: approval-kind elicitation is a permission, not a question) |
| codex/server-request.test.ts | - > MCP approval cleans up a failed publication | KEEP(fault: failed publication cleanup) |
| codex/server-request.test.ts | - > separate native processes reusing RPC id zero receive distinct canonical question IDs | KEEP(concurrency: canonical request-id uniqueness across processes sharing RPC id space) |
| codex/server-request.test.ts | - > separate native processes reusing RPC id zero receive distinct canonical permission IDs | KEEP(concurrency: canonical request-id uniqueness) |
| codex/thread-recovery.test.ts | isThreadNotFound > matches the app-server's message | KEEP(protocol error classification) |
| codex/thread-recovery.test.ts | isThreadNotFound > does not match unrelated failures | KEEP(protocol error classification) |
| codex/thread-recovery.test.ts | startTurnWithThreadRecovery > does not resume when the turn starts cleanly | KEEP(retry orchestration: no resume on clean start) |
| codex/thread-recovery.test.ts | startTurnWithThreadRecovery > never retries a failure that is not a missing thread | KEEP(fault: retry reserved for the missing-thread error) |
| codex/thread-recovery.test.ts | startTurnWithThreadRecovery > surfaces a resume failure instead of hiding it | KEEP(fault: resume failure surfaces) |
| codex/thread-recovery.test.ts | startTurnWithThreadRecovery > recovers on the second resume cycle when the first retry still misses | KEEP(bounded retry: at most two resume cycles; fault-injected) |
| codex/thread-recovery.test.ts | startTurnWithThreadRecovery > goes terminal with a classified session error once recovery is exhausted | KEEP(exhausted recovery -> classified session error) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > shares one app-server startup across concurrent session creation and model discovery | KEEP(concurrency: single shared startup; guards d66ce05183) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > a projection for another harness leaves Codex on the operator's own login | KEEP(credential/home selection per harness) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > a bound Codex account launches on a Claxedo home carrying the placeholder | KEEP(brokered CODEX_HOME composition; guards H-4's home-composition seam) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > disposes an app-server whose startup is still pending | KEEP(race: dispose during pending startup; real process) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > omits Codex app-server default model from provider requests | KEEP(request param shape: default model omitted) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > passes explicit Codex app-server models through to provider requests | KEEP(request param shape) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > uses prompt session model before workspace-global model for Codex app-server turns | KEEP(request param shape: thread vs turn model precedence) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > exposes each Codex model's supported reasoning efforts as a config option | KEEP(config option provenance; scripted model/list) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > options describe the model they are asked for, never the last-created session's | KEEP(config option correctness per model; cross-session isolation) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > passes the selected reasoning effort to Codex turn/start | KEEP(request param shape: effort) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > a turn that arrives before any options probe still names its effort and tier | KEEP(cold-start ordering: model list loaded on demand for the first turn) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > every turn names a concrete model and effort, so nothing carries over from the last one | KEEP(request param shape: default resolves concretely) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > a hidden model still has its effort confirmed | KEEP(request param shape: hidden models) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > refuses a level the model does not offer instead of running without it | KEEP(config validation: unsupported effort fails the turn by name) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > exposes the selected Codex model's fast tier as a service_tier option | KEEP(config option provenance) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > a requested tier "priority" reaches turn/start as "priority" | KEEP(request param shape: serviceTier) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > a requested tier null reaches turn/start as null | KEEP(request param shape: serviceTier always present) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > a requested tier "flex" reaches turn/start as null | KEEP(request param shape: unknown tier null-squashed) |
| codex/workspace-behavior.test.ts | CodexHarnessAdapter > an approval storage failure replies to the provider and does not strand the public turn | KEEP(persistence failure during approval — save-before-release; fault-injected write) |

## UNCOVERED fixes (12)

| sha | subject | suggested regression (full text in fixes.tsv) |
|---|---|---|
| 7affdc4bec | fix(test): run harness CLIs in tests under a temporary home | every real-harness flow launches the CLI with HOME pointed at a per-test temp dir |
| c104b05bff | fix(recovery): the packaged app can find its launch gate, and a wedged fence can be released | adapter start behind a wedged gate left by a dead pid releases the fence and launches |
| 289142b4b0 | fix(recovery): the launches a previous owner left behind are found and finished | restart against a recorded launch whose owner pid is dead retires it instead of refusing forever |
| 13601da859 | fix(lint): drop a dead type import and two needless assertions | lint-only; no behavioral regression needed |
| ac106c3a3c | fix: clear every test that was red on dev before this branch | branch-wide test repair; replacement suite must be green on dev |
| 0a308bfa2d | fix(claude): route questions through answerable session prompts | feed a Claude elicitation request, assert it surfaces as an answerable session prompt and the reply reaches the CLI |
| 2917ecdf2d | fix(runtime): advertise only the interactions each SDK driver raises | per harness, advertised interaction set equals exactly the kinds the driver raises |
| 5e503ddc41 | chore(lint): apply oxlint safe autofixes and scope test-file type rules | lint-only chore; the lint gate covers it |
| 11044d6bb0 | wip(review-fixes): phases 2-3 — restored fallbacks, dedup refactors, and branch-wide test repair | WIP repair snapshot; covered indirectly by the suite it repaired |
| e99e57ff2b | wip(review-fixes): phase 1 — driver, adapter, runtime-store, and app-seam repairs | WIP repair snapshot; covered indirectly by the suite it repaired |
| bb1bab608e | wip(goal-mode): snapshot before automated review-fix pass | WIP snapshot; superseded by the goal lifecycle tests that followed |
| 5b45b1cb0f | fix(tests): clear run 354's unmasked layers — Windows agent-sdk-runtime, port leases, transient desktop fetch | CI test repair; the Windows lane runs are the check |

Of the 12, five are genuinely uncovered product behavior worth a new regression
(7affdc4bec's temp-home isolation, c104b05bff's wedged-gate release, 289142b4b0's
orphan-launch adoption, 0a308bfa2d's Claude question routing, 2917ecdf2d's per-driver
interaction advertising); the rest are lint/test-repair/WIP commits with no behavior to pin.

## Surprising findings

- **Only one WIRE-CORPUS row.** In this lane, stored-message and projection-shape
  assertions almost always ride inside a larger real-stack or translator case, so they
  classify under those. The lone pure wire-shape case is Codex's native image reference
  (tool-file attachment that survives source deletion). The wire corpus still needs to
  carry the stored/replayed message shapes the FLOW rows' notes point at.
- **KEEP is the largest class (120/239).** Both harnesses push huge amounts of behavior
  into spawn-time state — child env vars, brokered config dirs, CODEX_HOME/auth.json file
  modes, argv resolution, model/effort/tier request params — that neither corpus records
  and a real-stack flow cannot observe without instrumenting the child. These are focused
  unit-level guards, not races; they should live next to the code that produces them.
- **Two lanes of grant-key tests.** Claude (`permissions.test.ts`, 9 cases) and Codex
  (`permission-state.test.ts`, 5 cases) each pin grant identity across driver/process
  reconstruction with subtly different decision sets — worth keeping parallel when the
  focused tests are rewritten.
- **Generated cases hid 55 extra rows.** Literal `test(` sites number 184; expanding
  loops/`test.each`/`skipIf` yields 239. Claude/permissions alone is 9 cases from 3 sites.
- **Broad commits can't name one test.** Merge commits, lint sweeps, WIP snapshots and
  "reconcile with dev" fixes are mapped to FLOW(H1)/(H13) as their aggregate coverage or
  marked UNCOVERED with an honest "no behavior" note rather than a fake citation.
- **Codex cancellation is the densest defect seam.** Ten generated cases pin terminal
  enumeration across per-thread inventories, surviving terminals, and the "unreadable
  inventory is never clear" rule — five separate recovery fixes landed here.
