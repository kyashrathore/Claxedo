# invariant-map: sdk-core

Scope: `packages/agent-sdk-runtime/src/**/*.test.ts` excluding `src/harnesses/**`, as enumerated at lane start (39 files). During the lane, P0.1 landed in the worktree: `launch/*`, `process-observer.test.ts` and friends were renamed to `packages/process-ownership/src/` unchanged (their rows keep the enumeration-time paths). One process-observer test moved to `src/harnesses/claude/launch.test.ts` — out of this lane's scope now — so its row was removed.

## Counts

- Cases enumerated: **411** (35 files now in scope + the 4 moved files' current contents; `test.each` rows expanded: first-turn-error 19+10, runtime.test.ts 2+2+2, recovery.test.ts 2, session-model.test.ts 4; `test.skipIf` counted as a case)
- TSV rows: **411** — equal.

| replacement | rows |
|---|---|
| KEEP | 225 |
| FLOW(NEW: …) | 62 |
| WIRE-CORPUS | 61 |
| FLOW(Hn) | 55 |
| OBSOLETE | 6 |
| TRANSLATOR-CORPUS | 2 |

New flows the map asks for (the FLOW(NEW) labels):

- a harness switch hands the transcript to the target harness, marks handoff pending, and releases the source (largest NEW flow — 18 cases across runtime.test.ts and session-handoff.test.ts)
- per-turn options reach the harness's turn input unchanged (permissionMode, variant/effort, serviceTier, author, connection-harness default model)
- session create refuses an id bound to another scope / malformed binding before the harness is asked
- session instructions reach the harness through its declared instruction channel and persist across restart
- session model resolution defaults per harness and an explicit selection is authoritative
- a turn requesting an effort the model doesn't offer is refused rather than silently dropped
- turns execute only through the canonical store binding, history read from the store never the provider
- calls naming an unknown session / an unimplemented operation are refused with a typed error

## UNCOVERED fixes (12)

| sha | subject | note / suggested regression |
|---|---|---|
| 90ef036b56 | one owner for the Claxedo data and state directories | paths.ts is live and untested; suggested: data/state directory resolution returns one canonical root |
| dbb05a9c44 | a configured data directory must be absolute | suggested: create/config with a relative data directory is refused before any store write |
| cc304f2f88 | give the harness lint residuals owners instead of silencing them | lint/async repair; no behavior to guard |
| a2178e8268 | P-40 own-property lookups, file-part url schemes, binding ownership | no in-scope file touched; suggested: a file-part with a non-https url scheme is refused at admission |
| a5b9b03ea3 | one module instance of the OpenCode core, refusals answered 502 | guards the embedded engine the plan deletes |
| 414e646bf8 | revert transcript skill-row fix | app-side revert; in-scope touch is the Pi fake only |
| 4c4cd31526 | align runtime and sandbox pins with 0.85.1 | version-pin bump in fixtures; nothing to guard |
| b4e7af1e4c | let the engine refuse an unusable account | embedded-engine credential path; engine is deleted |
| 5e503ddc41 | oxlint safe autofixes | mechanical lint pass |
| 5cbc0f5e52 | complete the embedded SDK cutover on Node | embedded engine; deleted by the plan |
| a2fc67aa1b | stabilize signed session contracts | CI/flake stabilization; not a runtime behavior |
| 5b45b1cb0f | clear run 354's unmasked layers | test-infrastructure/CI repair |

## Surprising

- The worktree moved under this lane: P0.1 renamed `launch/*` and `process-observer.*` into `packages/process-ownership/` while the map was being written. Row paths keep the enumeration-time spelling.
- `first-turn-error.test.ts` is a pure string-classifier table (33 cases) — none of its inputs is reachable through a real-stack flow without scripting broker error bodies; classified KEEP so the taxonomy stays pinned next to `first-turn-error.ts`.
- Two commits whose subjects name other lanes are the same in-scope bugs: `da4acdafb4` (completion after cleanup) and `77425a57fa`/`80be5590b2` (turn author) are guarded by runtime.test.ts rows.
- `stores/*` tests are test-store internals per the plan, but most of them guard the *shared store contract* (lease fencing, receipt auth, durability) that the production store must satisfy too — mapped as KEEP/WIRE-CORPUS, not OBSOLETE. The genuinely implementation-only rows (schema-version gates, corruption reporting) are marked KEEP with "moves with the test store".
- Only 2 TRANSLATOR-CORPUS rows: subagent provider-observation round-trips. Everything else provider-facing lives in `src/harnesses/**`, another lane.

## Every KEEP and its reason

- `architecture-ratchets.test.ts` — agent-sdk-runtime architecture ratchets > high-churn orchestration owners cannot grow — structural ratchet, not a behavior a flow reaches; ceilings re-measure on the new owners at P0.4
- `architecture-ratchets.test.ts` — agent-sdk-runtime architecture ratchets > runtime core does not depend on a concrete harness — structural ratchet, not a behavior; re-points at workspace-runtime's host and the packages/harness core
- `architecture-ratchets.test.ts` — agent-sdk-runtime architecture ratchets > concrete harness implementations do not import one another — structural ratchet, not a behavior; becomes the transports-import-only-the-contract check
- `compat-events.session-id.test.ts` — eventSessionId > returns undefined for partial/malformed frames instead of throwing — malformed-frame tolerance: a wire corpus only contains well-formed frames, so the no-throw path is unreachable there
- `compat-events.session-id.test.ts` — eventSessionId > reads the session off a type it does not name, so a new kind is never workspace-wide by omission — forward-compat invariant for event kinds that do not exist yet; a corpus cannot contain them
- `first-party-mcp.secrets.test.ts` — first-party MCP bearer never leaves the header > a Claude launch keeps it out of the child environment and every log line — absence assertion over the whole env and all log output; a flow asserts one fact at a boundary and cannot sweep logs
- `first-party-mcp.secrets.test.ts` — first-party MCP bearer never leaves the header > a Cursor send carries it only in the server headers and logs none of it — absence assertion over send options and all log output
- `first-party-mcp.secrets.test.ts` — first-party MCP bearer never leaves the header > an ACP session/new logs the directory and ids, never the server headers — absence assertion over all log output
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "401 Unauthorized: invalid API key" as credential — pure error-taxonomy table; a flow reaches only the classes its fault injection produces
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "OAuth token expired" as credential — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "the claude credential selected for this workspace cannot be used: revoked" as credential — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "Claude Code returned an error result: You've reached your Fable 5 limit..." as usage_limit — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "You've reached your Codex rate limit. It will reset in about 5 hours." as usage_limit — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "You've reached your Codex usage limit." as usage_limit — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "rate_limit_reached" as usage_limit — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "Claude assistant message failed: rate_limit" as usage_limit — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "workspace_owner_usage_limit_reached" as usage_limit — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "ACP harness process failed to start" as harness — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "unsupported adapter capability" as harness — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "harness_switch_not_supported" as harness — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "Model claude-missing was not found" as model — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "provider/model selection is required" as model — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "workspace is not ready" as workspace — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "ENOENT: repository directory does not exist" as workspace — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "thread not found: 019f73fb-..." as session — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "session not found" as session — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies "no such thread" as session — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > reads the broker's own verdict out of "403 {binding_unavailable}" as credential — pure error-taxonomy table; requires a scripted broker error body
- `first-turn-error.test.ts` — first-turn error taxonomy > reads the broker's own verdict out of "401 {runtime_token_invalid}" as credential — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > reads the broker's own verdict out of "503 {credential_unavailable}" as credential — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > reads the broker's own verdict out of "403 {binding_not_permitted}" as harness — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > reads the broker's own verdict out of "401 {runtime_token_required}" as harness — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > reads the broker's own verdict out of "403 {request_outside_policy}" as harness — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > reads the broker's own verdict out of "503 {broker_authority_unavailable}" as harness — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > reads the broker's own verdict out of "502 {upstream_unavailable}" as model — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > reads the broker's own verdict out of "502 {upstream_redirect_refused}" as model — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > reads the broker's own verdict out of "403 {loopback_required}" as harness — pure error-taxonomy table
- `first-turn-error.test.ts` — first-turn error taxonomy > the code in the body outranks an earlier one in the prose around it — pure error-taxonomy precedence rule
- `first-turn-error.test.ts` — first-turn error taxonomy > the broker's verdict outranks the status the harness echoed beside it — pure error-taxonomy precedence rule
- `first-turn-error.test.ts` — first-turn error taxonomy > classifies unrecognized failures as unknown — pure error-taxonomy default
- `harness-effort.test.ts` — harnessEffortLevels > copies the harness's level list so a later mutation cannot rewrite the catalog — defensive-copy invariant internal to the catalog builder; no wire surface observes the mutation
- `live-model-source.test.ts` — createLiveModelSource > serves the live list and caches it within the TTL — TTL caching: whether a second read refetches is timing a flow cannot assert
- `live-model-source.test.ts` — createLiveModelSource > keeps serving the last good list when a refetch fails — fault injection: a failing model endpoint
- `live-model-source.test.ts` — createLiveModelSource > an empty live list never replaces a cached list — degenerate-response guard: an empty fetch must not erase the cache
- `live-model-source.test.ts` — createLiveModelSource > propagates the failure rather than naming models the harness never served — fault injection: a failing model endpoint with cold cache
- `live-model-source.test.ts` — createLiveModelSource > serves the last good list on failure — fault injection: duplicate of the refetch-failure case under another harness
- `live-model-source.test.ts` — createLiveModelSource > isolates cached and in-flight lists by directory — concurrency: in-flight dedup per directory key
- `process-observer.test.ts` — agent process observer > publishes only the explicitly safe process descriptor — absence assertion over descriptor fields; the descriptor is diagnostics metadata a flow cannot read back
- `process-observer.test.ts` — agent process observer > fails invalid action, PID, and executable capabilities closed — boundary validation of internally-produced descriptors; no flow can produce a bad descriptor
- `process-observer.test.ts` — agent process observer > observer failures never alter the harness lifecycle — fault injection: a failing diagnostics observer
- `process-observer.test.ts` — agent process observer > sentinel secrets cannot enter through command-shaped fields — absence assertion over descriptor keys
- `process-observer.test.ts` — process attribution catalog > has an explicit root, probe, and MCP scenario for every harness definition — catalog-completeness check; re-keys from AGENT_HARNESS_DEFINITIONS to the one registry
- `runtime-event-hub.test.ts` — createRuntimeEventHub > isolates subscriber failures from later global subscribers — fault injection: a throwing subscriber
- `runtime-event-hub.test.ts` — createRuntimeEventHub > rejects explicit runtime envelopes from another contract version — contract-version refusal; the corpus only ever holds current-version envelopes
- `launch/identity.test.ts` — the Windows boot token > is the BootId value as reg.exe prints it, in decimal — pure parser for the Windows boot token; exercised only on Windows
- `launch/identity.test.ts` — the Windows boot token > a query that names no BootId is a failure, never an empty token — fail-closed parse; a flow cannot make reg.exe omit BootId
- `launch/identity.test.ts` — a creation identity read back out of a record > accepts what this platform's own probe produced — probe/platform contract for process identity
- `launch/identity.test.ts` — a creation identity read back out of a record > accepts a complete row and keeps its fields — validation of a stored identity row
- `launch/identity.test.ts` — a creation identity read back out of a record > refuses a pid that names a process group rather than a process — validation fail-closed on malformed stored rows; no real launch produces them
- `launch/identity.test.ts` — a creation identity read back out of a record > refuses a source no build of this probe produces — validation fail-closed
- `launch/identity.test.ts` — a creation identity read back out of a record > refuses a row missing a verification key, and a non-record — validation fail-closed
- `launch/identity.test.ts` — identityFromSpawn > a process that began after the spawn is the one this launcher started — start-time identity matching; timing
- `launch/identity.test.ts` — identityFromSpawn > a pid whose process began before the spawn is a stranger the launcher never started — start-time identity matching; protects against signalling a recycled pid
- `launch/identity.test.ts` — identityFromSpawn > a darwin start floored to the spawn's second is accepted — platform second-flooring tolerance; timing
- `launch/identity.test.ts` — identityFromSpawn > a Linux start that reads a whole second before the spawn's second is accepted — platform second-flooring tolerance; comment: 42.076 reads as 41.000
- `launch/identity.test.ts` — verifying a recorded identity > a probe that cannot run is an unknown verdict, never an exit — fault injection: the probe itself is broken
- `launch/launch-gate.test.ts` — (launch-gate) > the gate child resolves to a file this process can execute — launch-gate packaging; resolved path must survive packaging, asserted per packaging site in P0.1
- `launch/launch-gate.test.ts` — (launch-gate) > an acknowledged launch owns a group the payload is inside — process-group ownership invariant; also reconciles to execution:"started"
- `launch/launch-gate.test.ts` — (launch-gate) > ownership is durable before the payload can run — ordering invariant: ownership is durable before the payload may run
- `launch/launch-gate.test.ts` — (launch-gate) > a store that refuses to prepare refuses the launch and spawns nothing — fault injection: ownership store refuses
- `launch/launch-gate.test.ts` — (launch-gate) > a store that fails after the gate reports leaves no payload running — fault injection: store failure after the gate reports
- `launch/launch-gate.test.ts` — (launch-gate) > the gate exits on its activation deadline without running a payload — timing: activation deadline
- `launch/launch-gate.test.ts` — (launch-gate) > the gate refuses a nonce it did not mint — nonce refusal; a flow cannot mint a bad nonce through the real path
- `launch/launch-gate.test.ts` — (launch-gate) > the gate exits when the private channel closes before activation — fault injection: owner disconnect before activation
- `launch/launch-gate.test.ts` — (launch-gate) > a prepared launch that never reported reconciles as no execution — reconciliation of a half-started launch
- `launch/launch-gate.test.ts` — (launch-gate) > a prepared direct launch stays unknown, because its spawn precedes its record — reconciliation ordering; protocol-specific
- `launch/launch-gate.test.ts` — (launch-gate) > retirement escalates to KILL for a payload that ignores TERM — signal escalation; also covered end-to-end by H2/H9
- `launch/launch-gate.test.ts` — (launch-gate) > a descendant that leaves the group leaves cleanup unknown — descendant retirement — named in the plan's kept-tests list; measured escape, not assumed
- `launch/launch-gate.test.ts` — (launch-gate) > retirement refuses to signal a recorded identity another process now holds — pid-reuse guard; fault injection on the recorded identity
- `launch/launch-gate.test.ts` — (launch-gate) > retirement refuses a recorded process that does not lead its group — group-leader verification
- `launch/launch-gate.test.ts` — (launch-gate) > an identity probe that fails reports unknown rather than clear — fault injection on the identity probe
- `launch/launch-gate.test.ts` — (launch-gate) > retiring an already exited leader reports its surviving group as owned — retirement verdict for orphaned group members; needs_action territory in H2
- `launch/launch-gate.test.ts` — (launch-gate) > a second retirement of a settled launch is idempotent — idempotent retirement
- `launch/launch-gate.test.ts` — (launch-gate) > closeNative runs between TERM and KILL — ordering invariant in the signal escalation
- `launch/launch-gate.test.ts` — (launch-gate) > an owner that dies before using the identity leaves no payload — fault injection: owner crash mid-protocol, run in a real throwaway process
- `launch/launch-gate.test.ts` — (launch-gate) > an owner that dies before the acknowledgement leaves a reacquirable launch — fault injection: owner crash at acknowledgement
- `launch/launch-gate.test.ts` — (launch-gate) > the payload cannot run while authorization is still being recorded — ordering: authorization recorded before the payload runs
- `launch/launch-gate.test.ts` — (launch-gate) > an owner that dies after authorizing leaves a running payload and an unknown row — fault injection: owner crash at authorization
- `launch/launch-gate.test.ts` — (launch-gate) > a boot identity that differs is a mismatch, not a live process — cross-reboot identity; cannot be induced by a flow
- `launch/launch-gate.test.ts` — (launch-gate) > a gate whose parent dies before activation does not survive it — fault injection: parent death before activation
- `launch/launch-gate.test.ts` — (launch-gate) > an activated gate outlives its parent, and its record is what finds it — fault injection: parent death after activation
- `launch/retirement.test.ts` — (launch retirement) > only an exited leader over a group that holds nothing settles — retirement verdict table; drives the succeeded/needs_action outcome H2 asserts
- `launch/retirement.test.ts` — (launch retirement) > a refused signal keeps the resource, except the refusal that means it was already gone — retirement verdict table for signal refusals
- `launch/retirement.test.ts` — (launch retirement) > every combination of leader and descendants agrees with the rule it states — retirement verdict truth table; a flow cannot enumerate it
- `launch/retirement.test.ts` — (launch retirement) > a launch whose payload never ran owns nothing — verdict for a never-ran payload
- `launch/retirement.test.ts` — (launch retirement) > a transient group EPERM is not read as the group being gone — fault injection: EPERM on the group probe; darwin killpg quirk named in the test
- `launch/retirement.test.ts` — (launch retirement) > a group that answers EPERM throughout never counts as retired — fault injection: persistent EPERM
- `runtime.test.ts` — (top level) > disposing a runtime leaves its injected store open for its owner — ownership: the injected store is caller-owned; a flow cannot observe who closes it
- `runtime.test.ts` — createAgentRuntime > disposal initiates owned adapter teardown to unblock a pending create — disposal vs in-flight create race
- `runtime.test.ts` — createAgentRuntime > disposal initiates owned adapter teardown to unblock a pending turn — disposal vs in-flight turn race
- `runtime.test.ts` — createAgentRuntime > borrowed adapters survive disposal after lazy handoff resolution — ownership: caller-owned adapter lifetime
- `runtime.test.ts` — createAgentRuntime > disposal waits for admitted producer finalization and refuses later work — ordering: shutdown drains admitted work before refusing more
- `runtime.test.ts` — createAgentRuntime > serializes concurrent Goal starts per session — concurrency: serialized goal admission
- `runtime.test.ts` — createAgentRuntime > resolves one lazy adapter for concurrent callers — concurrency: single lazy resolution
- `runtime.test.ts` — createAgentRuntime > ends a slow subscription with an explicit overflow notice — backpressure: slow-subscriber overflow is signalled then ended
- `runtime.test.ts` — createAgentRuntime > rejects a bound session whose canonical runtime config is missing — fail-closed on a store state no flow produces: bound session without config
- `runtime.test.ts` — createAgentRuntime > never derives a runtime config for a session the store has not bound — fail-closed on an unknown session; no config is materialized behind the store
- `runtime.test.ts` — createAgentRuntime > rejects session operations when no adapter can be named for the session — fail-closed ambiguity refusal
- `runtime.test.ts` — createAgentRuntime > holds the session against new turns until a harness switch lands — admission ordering: the session is held against new turns mid-switch
- `runtime.test.ts` — createAgentRuntime > refuses a harness switch while a turn holds the session — admission ordering: a busy session refuses a switch
- `runtime.test.ts` — createAgentRuntime > rejects a turn without an execution binding before recording it as busy — fail-closed on a missing binding before any busy write
- `runtime.test.ts` — createAgentRuntime > applies the selected runtime model before creating a session — ordering: model application precedes native session creation
- `runtime.test.ts` — createAgentRuntime > a create that names no model clears the previous create's model — ordering/state: model selection is per-create, cleared when absent
- `runtime.test.ts` — createAgentRuntime > event subscriptions close immediately when returned while idle — timing: a subscription on an idle session drains nothing and ends
- `runtime.test.ts` — createAgentRuntime > publishes the authoritative busy status before a slow native harness yields — ordering: authoritative busy precedes any harness yield
- `runtime.test.ts` — createAgentRuntime > rejects a concurrent turn before persisting any part of it — admission order — the plan's named kept class
- `runtime.test.ts` — createAgentRuntime > publishes completion only after adapter cleanup releases next-turn admission — ordering: completion waits on admission release
- `runtime.test.ts` — createAgentRuntime > rejects a committing adapter terminal write after a durable fence takeover — fencing: a stale token's write is refused after takeover
- `runtime.test.ts` — createAgentRuntime > a failed cancellation (error) keeps admission until the executing turn finishes — fault injection: cancel fails; admission must not release
- `runtime.test.ts` — createAgentRuntime > a failed cancellation (not_found) keeps admission until the executing turn finishes — fault injection: cancel reports unknown execution
- `runtime.test.ts` — createAgentRuntime > a persisted unfinished turn is inspectable but cannot be cancelled by an owner that never admitted it — generation fencing across restart; the stale-generation refusal needs an injected old generation
- `runtime.test.ts` — createAgentRuntime > keeps a cancelled outcome when a late stream completion arrives — ordering: late terminal events are fenced by the recorded outcome
- `runtime.test.ts` — createAgentRuntime > memory store starts the same active assistant turn exactly once — idempotency: replayed turn-start returns the committed record
- `runtime/subscription.test.ts` — createRuntimeSubscription > an event buffered before the subscriber closes still drains to its reader — ordering: buffered events drain before the closed stream ends
- `runtime/turn-admission.test.ts` — (top level) > committed turn events publish once without an HTTP request subscription — ordering: exactly-once publish independent of subscribers
- `runtime/turn-admission.test.ts` — (top level) > steering after the target ended does not silently start a new turn — stale steering — the plan's named kept class
- `runtime/turn-admission.test.ts` — (top level) > a steer suspended in adapter resolution cannot attach to a replacement turn — stale steering — the named kept test at turn-admission.test.ts:135
- `runtime/turn-admission.test.ts` — (top level) > a failed host admission hook releases the runtime turn claim — fault injection: admission-hook failure must release the claim
- `runtime/turn-admission.test.ts` — prompts for a session that is already running a turn > prompts queued for one session start in the order they were queued — ordering: FIFO waiter queue per session
- `runtime/turn-admission.test.ts` — prompts for a session that is already running a turn > a prompt queued while an earlier queued one runs still starts behind it — ordering: FIFO waiter queue per session
- `runtime/turn-admission.test.ts` — prompts for a session that is already running a turn > a session with nothing running is idle at once, so a queued prompt starts immediately — timing: an idle session resolves waiters immediately
- `runtime/turn-admission.test.ts` — prompts for a session that is already running a turn > a prompt with no delivery still takes the admission conflict — admission order — the plan's named kept class
- `runtime/turn-admission.test.ts` — handing an idle session to the prompts waiting for it > a prompt that starts waiting after the turn ended still waits behind the queue — ordering: release wakes the queue head only
- `runtime/turn-admission.test.ts` — handing an idle session to the prompts waiting for it > a woken prompt that cannot start hands the session to the next waiter — ordering: abandoned handoffs advance the queue
- `runtime/turn-admission.test.ts` — handing an idle session to the prompts waiting for it > giving the session up after it was claimed hands nothing on — generation fencing of the waiter queue
- `runtime/turn-admission.test.ts` — handing an idle session to the prompts waiting for it > a session handed to a waiter is still busy to a prompt that arrives before it claims — ordering: claimed-but-unclaimed handoff stays busy
- `runtime/turn-admission.test.ts` — handing an idle session to the prompts waiting for it > a session whose last waiter has run is idle again to the next prompt — ordering: drained queue returns to immediate idle
- `runtime/turn-admission.test.ts` — handing an idle session to the prompts waiting for it > a release from a generation that no longer owns the session wakes nobody — generation fencing of releases
- `runtime/turn-admission.test.ts` — handing an idle session to the prompts waiting for it > disposal releases every prompt still waiting — shutdown drains the waiter queue
- `runtime/turn-admission.test.ts` — scoping a cancellation to the turn the caller was looking at > a cancellation naming a turn that already ended leaves the running one alone — generation fencing of cancellations
- `runtime/recovery.test.ts` — cancelling a turn across an asynchronous boundary > a cancellation that settles after its turn was replaced cannot finalize or release the replacement — race: late-settling cancellation fenced by the replacement's generation
- `runtime/recovery.test.ts` — cancelling a turn across an asynchronous boundary > a harness that ends the turn's stream before answering the cancellation reports the turn saved — race: stream end vs cancel answer ordering
- `runtime/recovery.test.ts` — cancelling a turn across an asynchronous boundary > a cancellation naming the turn a lease loss was observed for is refused once that turn ended — generation fencing of cancellations
- `runtime/recovery.test.ts` — cancelling a turn across an asynchronous boundary > a harness that never answers yields a bounded operation whose error is inspectable — bounded waiting: an unanswered cancel can't hold the operation open
- `runtime/recovery.test.ts` — cancelling a turn across an asynchronous boundary > evidence arriving after the deadline corrects the facts without rewriting the attempt — ordering: late evidence corrects facts, never rewrites the attempt
- `runtime/recovery.test.ts` — a finalization the store refused > a reconciliation that names a different generation is refused — generation fencing of reconciliation
- `runtime/recovery.test.ts` — finalizing a turn this owner did not admit > a capture with no generation cannot end a turn the runtime has since admitted — fencing: a generation-less capture can't end an admitted turn
- `runtime/recovery.test.ts` — reading an owner that is shutting down > inspection still answers while disposal drains a turn that has not ended — timing: inspection stays answerable through shutdown
- `runtime/recovery.test.ts` — one operation per intent > the same request id twice reads one operation, and a different intent under it conflicts — idempotency: one operation per request id, intent conflicts refused
- `runtime/recovery.test.ts` — one operation per intent > two callers asking for the same action on the same turn share one operation — concurrency: operation coalescing across callers
- `runtime/recovery.test.ts` — the queue a recovery operation holds > a recovering session neither wakes its own waiters nor touches another session — ordering: the admission gate isolates a recovering session
- `runtime/recovery.test.ts` — the queue a recovery operation holds > a waiter whose lease acquisition fails hands the session to the next one — fault injection: lease-acquisition failure inside the handoff
- `runtime/recovery.test.ts` — the queue a recovery operation holds > shutdown settles parked prompts as unavailable instead of handing out a token — shutdown drains the waiter queue
- `runtime/recovery.test.ts` — disposal > reports an immediately failing teardown without waiting for a task that never drains — ordering: teardown failure is reported without blocking on undrained work
- `runtime/recovery.test.ts` — disposal > a clean teardown drains first and then cleans up — ordering: drain precedes cleanup
- `runtime/recovery.test.ts` — the authority a finalization must hold > a capture whose generation was replaced is refused as superseded, not as a lost lease — fencing: in-process generation check precedes the store fence
- `runtime/recovery.test.ts` — the authority a finalization must hold > a store turn this owner holds no lease for is refused rather than written unfenced — fencing: no lease, no write
- `runtime/recovery.test.ts` — the authority a finalization must hold > a store turn this owner does hold the lease for is finalized and the lease released — fencing: the lease is the finalization's authority
- `runtime/recovery.test.ts` — the authority a finalization must hold > a finalization the store accepted but recorded nothing for does not claim a commit — fencing: a no-op write never claims a commit
- `runtime/recovery.test.ts` — a lease that moved to another owner > is terminal for this owner: the admission is given up and no retry is advertised — fencing: a lost lease is terminal, never retried
- `runtime/recovery.test.ts` — an operation that throws > answers its caller, closes, and does not capture the next request for that turn — fault injection: a throwing operation can't poison later requests
- `runtime/recovery.test.ts` — receipts the store already holds > an operation another owner already accepted is adopted instead of run again — idempotency: stored receipts are adopted across owners
- `runtime/recovery.test.ts` — receipts the store already holds > a stored receipt under the same request id but a different intent conflicts — fencing: stored intent conflict
- `runtime/recovery.test.ts` — who may read and act > an operation is only readable by a caller it was accepted for — authorization: receipt-scoped reads
- `runtime/recovery.test.ts` — who may read and act > a session-scoped caller cannot act on a machine — authorization: scope boundaries
- `runtime/recovery.test.ts` — what a session's inspection lists > operations this owner never recorded, and a store that cannot answer — fault injection: inspection degrades on an unreadable store
- `runtime/recovery.test.ts` — a Goal mutation that outlives the turn it stops > finalizes the turn it was asked about across the harness await — race: goal stop vs turn replacement, harness-await stage
- `runtime/recovery.test.ts` — a Goal mutation that outlives the turn it stops > finalizes the turn it was asked about across the provider await — race: goal stop vs turn replacement, provider-await stage
- `runtime/recovery.test.ts` — two callers naming one turn > meet on the same operation even when their write authority differs — concurrency: coalescing ignores renewed-lease authority values
- `runtime/recovery.test.ts` — an operation that outlives the owner that issued it > is read back by the callers holding its receipt, and by nobody else — authorization: durable receipt-scoped reads across owners
- `runtime/recovery.test.ts` — an operation that outlives the owner that issued it > an unreadable store answers nothing and reports why, rather than throwing — fault injection: read degrades on an unreadable store
- `runtime/recovery.test.ts` — the lease a finalization must carry > an admission that still owns the session cannot finalize without the lease behind it — fencing: the durable lease, not the admission, authorizes the write
- `runtime/recovery.test.ts` — a containment attempt that never became an operation > is retained against the session, and finishing that turn does not clear it — retention: an unmet containment obligation survives the turn
- `runtime/recovery.test.ts` — a containment attempt that never became an operation > a caller that could not act on the target reports nothing — authorization: containment reports are scoped
- `runtime/recovery.test.ts` — how long a settled operation stays readable > for the contract's retention, not for whatever this caller's deadlines were — timing: receipt retention follows the contract, not caller budgets
- `stores/memory.test.ts` — MemoryRuntimeStore turn authority > a finish carrying a lease the session no longer holds is refused — fencing: the durable turn lease rejects a superseded writer; moves with the test store
- `stores/memory.test.ts` — MemoryRuntimeStore turn authority > a finish carrying a lease on a session that holds none is refused — fencing: foreign lease on an unleased session
- `stores/memory.test.ts` — MemoryRuntimeStore turn authority > the held lease is readable and disappears when it is released — fencing: lease authority readback
- `stores/memory.test.ts` — MemoryRuntimeStore turn evidence > a turn nobody started, a turn still running, and a turn with a recorded outcome — store contract: evidence reports only what was recorded, never inferred
- `stores/memory.test.ts` — MemoryRuntimeStore turn evidence > a turn that the replacement superseded is still reported against its own id — store contract: superseded turns keep their own evidence
- `stores/memory.test.ts` — MemoryRuntimeStore recovery receipts > one caller's request id creates one operation and reads it back — idempotency + authorization of recovery receipts
- `stores/memory.test.ts` — MemoryRuntimeStore recovery receipts > request ids are scoped to the caller, and listing is scoped to the session — authorization: caller-scoped request ids, session-scoped listing
- `stores/memory.test.ts` — MemoryRuntimeStore recovery receipts > an update replaces the stored operation without creating a second receipt — receipt contract: update-in-place
- `stores/memory.test.ts` — MemoryRuntimeStore recovery receipts > a caller that joined an operation reads it back; one that never did cannot — authorization: joined-caller receipts
- `stores/memory.test.ts` — MemoryRuntimeStore write authority > a finish carrying no lease is refused while the session holds one — fencing: unfenced write refused under a held lease
- `stores/memory.test.ts` — MemoryRuntimeStore write authority > a finish carrying no lease is refused even when the session granted none — fencing: null never equals null for write authority
- `stores/memory.test.ts` — MemoryRuntimeStore snapshots > a restored snapshot keeps the lease, and the writer that lost it is still fenced out — fencing: leases survive snapshot restore
- `stores/memory.test.ts` — MemoryRuntimeStore snapshots > a snapshot naming no leases restores a session that holds none — ordering: snapshot restore replaces, never merges
- `stores/session-start.test.ts` — (top level) > pending creation has immutable ownership but no executable or visible session — fencing: a pending create can't be hijacked by a competing operation
- `stores/session-start.test.ts` — (top level) > terminal creation cannot be promoted by stale or competing completion — fencing: creation completions are fenced to their operation
- `stores/session-start.test.ts` — (top level) > a retired creation frees the id and a stale operation cannot reach its replacement — fencing: retirement is fenced to the exact binding
- `stores/session-start.test.ts` — (top level) > SQLite retirement compares binding fields, not the stored record, and outlives the process — fencing + durability: field-compared retirement survives restart
- `stores/sqlite.test.ts` — SqliteRuntimeStore > restores the in-memory projection when a SQL transaction fails — fault injection: SQL failure rolls the memory projection back
- `stores/sqlite.test.ts` — SqliteRuntimeStore > preserves active turn leases when an unrelated SQL transaction fails — fault injection: a failed write can't corrupt unrelated lease state
- `stores/sqlite.test.ts` — SqliteRuntimeStore > rolls back memory and SQLite when a message projection write fails — fault injection: failed writes roll back both projections
- `stores/sqlite.test.ts` — SqliteRuntimeStore > rejects the removed whole-snapshot schema — fail-closed persisted-schema gate; moves with the test store
- `stores/sqlite.test.ts` — SqliteRuntimeStore > reports the exact table and key for corrupt persisted JSON — fail-closed corruption reporting; moves with the test store
- `stores/sqlite.test.ts` — SqliteRuntimeStore > upgrades a version 2 store in place and keeps its rows — schema migration guard; moves with the test store
- `stores/sqlite.test.ts` — SqliteRuntimeStore > refuses a schema version this build has no upgrade for — fail-closed persisted-schema gate; moves with the test store
- `stores/sqlite.test.ts` — SqliteRuntimeStore > one caller's repeated recovery request joins its own operation — idempotency + authorization of stored receipts; durability checked across reopen
- `stores/sqlite.test.ts` — SqliteRuntimeStore > finishTurn refuses a writer whose turn lease was replaced — fencing: durable lease rejects a superseded writer
- `stores/sqlite.test.ts` — SqliteRuntimeStore > a minted operation id already held under another claim is refused, not merged — fencing: operation-id collisions refuse, never merge
- `stores/sqlite.test.ts` — SqliteRuntimeStore > a schema version this build cannot read is refused before any table is created — fail-closed persisted-schema gate; moves with the test store
- `stores/sqlite.test.ts` — SqliteRuntimeStore > a writer carrying no lease is refused, whether or not the session granted one — fencing: null never equals null for write authority
- `stores/subagent-store.test.ts` — runtime subagent admission stores > memory snapshots preserve terminal status after a late active observation — ordering: a late active observation never regresses a terminal status
- `subagent-admission.test.ts` — subagent host admission > keeps one Cursor synthetic key whether provider identity arrives late or never — correlation: key stability whether provider identity arrives late or never
- `subagent-admission.test.ts` — subagent host admission > keeps one Claude host key when provider kind precedes the late agent id — correlation: provider-kind match holds the row open for a late providerId
- `subagent-admission.test.ts` — subagent host admission > retries both sides of publication with the same persisted key and revision — fault injection: crash mid-publish replays the persisted admission
- `subagent-admission.test.ts` — subagent host admission > exact replay is idempotent and conflicting observation-id reuse fails closed — idempotency + fail-closed conflict on observation-id reuse
- `subagent-admission.test.ts` — subagent host admission > allows immutable bindings once and rejects later conflicts for an explicit host key — fencing: immutable provider/child bindings per host key
- `subagent-admission.test.ts` — subagent host admission > rejects partial role-bearing tool-call edges before persistence — validation: fail-closed on malformed edges
- `subagent-admission.test.ts` — subagent host admission > a harness tool edge naming a claxedo key the host never minted is refused as unknown and leaves no row — grant keys — the plan's named kept class: harness edges attach only to host-minted keys
- `subagent-admission.test.ts` — subagent host admission > the host's own create mints the claxedo row; the harness tool edge then attaches to it — grant keys: only the host mints; harness edges attach
- `subagent-admission.test.ts` — subagent host admission > a harness tool edge naming the host's key with a different child is the immutable-binding conflict — fencing: host-key binding conflicts refuse
- `subagent-admission.test.ts` — subagent host admission > child identity is the strongest correlator: an observation naming an owned child resolves to the owning row — correlation precedence: child identity outranks stable keys
- `subagent-admission.test.ts` — subagent host admission > an observation matching two rows joins the stronger key instead of opening a third — correlation precedence: stronger key wins, no third row
- `subagent-admission.test.ts` — subagent host admission > admission allocates the child once and reuses the binding for later child-less observations — idempotency: child allocation is once-per-row
- `subagent-admission.test.ts` — subagent host admission > a duplicate delivery lacking the allocated child dedupes instead of conflicting — dedup vs conflict on replayed observations
- `sse.test.ts` — attachSseFanout > unsubscribes and clears heartbeat on cleanup — lifecycle ordering: cleanup stops writes and the heartbeat
- `sse.test.ts` — attachSseFanout > bounds pending writes for slow consumers — backpressure: bounded pending writes under a stalled consumer
- `sse.test.ts` — attachSseFanout > preserves terminal pending events when slow consumers overflow — backpressure: terminal events survive overflow
- `sse.test.ts` — attachSseFanout > a shed frame raises one gap notice at the head of the queue, and a fresh one after it is written — backpressure: gap-notice coalescing rules
- `sse.test.ts` — attachSseFanout > drops pending heartbeats before real events for slow consumers — backpressure: heartbeats shed first
- `sse.test.ts` — attachSseFanout > subscribes before replay and deduplicates setup-gap live events — ordering: subscribe-before-replay dedup of the setup gap
- `test-utils/isolated-home.test.ts` — (top level) > CLI-spawning tests leave a stand-in for the developer's home untouched — test-infrastructure guard: harness-spawning tests must not touch the real HOME; runs only when a Claude executable exists
