# WS-D — Execution at scale: placement, parallelism, landing, subtasks, profiles, child streams

**Parent:** `2026-07-28-004` · implements A2/A4(partial)/A11/A13 + plan §2's placement/width from `2026-07-28-003`. Depends on WS-A; C1/C4 (autonomy+budget gates) should land first; B1 (cursor sharding) is a **hard prerequisite for real parallelism** (without it parallel runs serialize on the owner cursor).

## Non-goals
- No custom VCS, no master↔master channel, no recursive task nesting (one subtask level).
- The relay, sandbox drivers, and live-sync room are out of scope (their own tracks).
- Flow-stream triage/batched planning is 004 Phase 4 work — not here (only the substrate hooks).

## D1. Placement: per-run isolation (worktree | sandbox | shared)

**Grounding.** The seam ALREADY EXISTS and is unwired: `ChildIsolationID` is typed (`ports/workspace-execution.ts:16`), `markPlacing` accepts `childIsolationId` and stores it (`store.ts:5096` writes `?? null`; convex twin `workgraph_runs.child_workspace_id` `schema.ts:837`), but `execution-service.ts:85-89` never passes it. Local envelope = one worktree per stream (`local-execution.ts:104-148`, `git worktree add --detach`, path `worktreeRoot/<org>/<owner>/<streamId>/envelope`). Hosted envelope = one sandbox per stream (`workGraphWorkspaceId`, `hosted-runtime.ts:1548-1555`; `manager.ensure` at `:284`). Worktree machinery to reuse: `claxedo-server/src/worktree-service.ts:47-72`, fullest impl `packages/opencode/src/worktree/index.ts:224,341,384-431,539-605`; gateway shape `local-execution.ts:39-47`.

**Tasks:**
1. Placement resolution: `ResolvedExecutionProfile.environment` gains `placement: "shared" | "worktree" | "sandbox"` (default `shared` — today's behavior byte-identical). Resolved at admission through the existing defaults merge (root→stream→outcome→item, `workgraphCommands.ts:2443-2460` / `domain/execution-profile.ts:41`).
2. Local `worktree` placement: `provisionOrAdopt` keeps the stream envelope as the **base**; `launch` for an isolated run creates `worktreeRoot/<org>/<owner>/<streamId>/runs/<runId>` via the worktree gateway, branched from the envelope's base revision; `childIsolationId = runId` passed through `execution-service.ts:85-89` → `markPlacing`. `cleanup` removes run worktrees (extend `removeWorktree` `local-execution.ts:93-101`); the reaper leak-test covers orphans (004 Phase 5 DoD verbatim).
3. Hosted `sandbox` placement: isolated runs get `workspaceId = workGraphWorkspaceId(...) + ":run:" + runId` in `manager.ensure` — one sandbox per isolated run, same source spec; the lease reaper already keys per workspaceId so GC covers them **only after chip task_cc97c709 (driver.list) is fixed — hard gate: do not enable sandbox placement before that chip lands.**
4. Width + locks (relaxing one-per-stream, placement-aware): grounding — oracle `launch-readiness.ts:61` (`workspace_busy`), SQLite admit check `store.ts:5371-5382`, Convex stream-lease-as-lock `workgraphCommands.ts:2297-2306`, envelope serialization `local-execution.ts:61-76`. Change: the **stream lease** is acquired only for `shared`-placement runs (it is the shared-workspace lock, correctly); isolated runs take only their item lease. Width: count live run leases per stream (`by_tenant_stream` on leases) and block admission at compiled `maxParallel` (new oracle reason `width_exhausted`). The derived stream hold (`store.ts:1060-1070`, `workgraphCommands.ts:2509-2513`) and master exclusion (`store.ts:5386-5395`, convex `:2309-2311`) are unchanged.
5. Landing funnel: isolated runs never touch the envelope; completion records diffs; the **master's** land duty merges run branches back into the envelope serially (the `land` port exists on `WorkspaceExecutionPort:46-114`; local serialization already keyed per stream `local-execution.ts:61-76`), behind `landing-integrity` (consumed at `local-execution.ts:183`). Conflict → work item `integration_needed` (state exists) + master mailbox note. Hosted landing stays master-driven per 004 (hosted masters don't get raw merge tools — the land port is the only door).

**Positive controls:** two non-overlapping worktree runs execute concurrently and land serially with receipts; engineered conflict → `integration_needed`, not a stopped stream; width 2 with 5 runnable tasks → exactly 2 live leases; zero orphan worktrees/sandboxes after stream close (leak-test); `shared` placement behaves byte-identically to today (regression).

## D2. Subtasks: the execution stratum (A2)

**Grounding.** WS-A added `parent_task_id` + index. Roll-up precedent: `completeOutcome` requires children terminal (`domain/completion.ts:87-111`).

**Tasks:**
1. `CreateWorkItemCommandSchema` gains `parentTaskId?`. Validation (both backends): parent exists, parent is not itself a child (one level), parent's run is live OR actor is user; **a subtask may not have `dependencies`, may not be a parent, may not carry admission-planning provenance** — reject with typed codes.
2. Seat authority: run-operation callbacks from a subtask run (identity carries the run; run→item→parent_task_id) reject `create_work_item`/`propose_*` server-side with `forbidden_for_subtask` — enforced in the command layer by actor+run context, NOT by profile (plan A11 seat rule). Grounding for the check site: the run-identity fence already resolves the run row on every callback (`fenced()`, `workgraphRuntime.ts:1593-1646`; sqlite `store.ts:3182+`).
3. Roll-up: `completeWorkItem` for a parent requires all children terminal (mirror `completeOutcome`'s shape, `completion.ts:87`); child completion nudges the parent's run (mailbox-style via the settle lane — the parent's agent polls its children's evidence through existing reads).
4. Launchability: subtasks pass the oracle like tasks (they're born per stream policy; typically created born-pending by the parent's run **in autonomous streams**; in supervised streams they stage like any agent-created work). Width counts them.
5. UI flat rendering (chip + one indent level) is WS-E.

**Positive controls:** subtask attempting `create_work_item` via run-operation → `forbidden_for_subtask` regardless of profile; parent cannot complete with a live child; subtask with dependencies rejected at create; fan-out of N subtasks under width W runs ≤W concurrently.

## D3. Agent profiles v0 (A11)

**Grounding.** The proto-profile exists: `ResolvedGenerationProfileSchema` `{harness, agent, model, effort, tools, connectionIds}` (`contracts/execution.ts:63-66`, comment "session generation selects a harness/model but does not own Task placement"). Consumption sites: claim emit `workgraphRuntime.ts:504` (`profile: run.resolved_execution`), hosted launch `hosted-runtime.ts:294,364-370,408-413`, master `:745-802`, `model_version` stamp `:901`. WS-A added `AgentProfileSchema` + `agents`/`assignments` on defaults.

**Tasks:**
1. Resolution: `resolveCanonicalAttemptExecutionDefaults` (convex `:2443-2460`) and `domain/execution-profile.ts:41` learn profile indirection — if the merged defaults name an assignment for the work shape (`execution` for tasks/subtasks, `planning` for planning-shaped, `review` reserved), the named profile's `generation` fields fill the resolved profile (explicit per-item fields still win). Unknown profile name → typed `unknown_agent_profile` rejection at admission (fail closed, before spend).
2. Master briefs: `buildMasterPrompt` (`application/master-prompt.ts:17-45`) appends a "Your agents" section — name + brief per profile from the stream's compiled defaults; the master's assignment verb is simply setting `execution_defaults.assignments` overrides on items it files (no new command).
3. Charter compiled envelope: `set_stream_charter` gains optional `compiled?: ExecutionProfileDefaults` — validated by schema + hard caps (`maxParallel ≤ 16`, budget required if `autonomy: autonomous` — the guardrail floor); the server never parses prose. The drafting agent (admission/master session) produces `compiled` alongside the text; UI shows the values diff-style at confirm (WS-E). Charter hash covers text only (unchanged semantics); compiled values live in `execution_defaults` as today.
4. `memoryRef` is carried, not implemented — resolution to a MemoryBackend mount is explicitly deferred (single TODO-free stub: unknown ref = ignored, documented in the schema comment).

**Positive controls:** item admitted under a named profile launches with that profile's harness/model (assert launch params); unknown profile fails admission closed; master prompt contains the briefs; per-profile spend split visible in usage rows (C4 attribution carries `run_id` → profile derivable from resolved_execution).

## D4. Child streams (A13)

**Grounding.** WS-A added `parent_stream_id` + index. Budget carve = C4 budgets. Envelope branch: local base revision is per stream already (`local-execution.ts:129-137` `--detach <baseRevision>`); hosted source spec per stream (`hosted-runtime.ts:298-308`).

**Tasks:**
1. `CreateStreamCommandSchema` gains `parentStreamId?`, `budgetCarve?` (subtracted from parent's compiled budget at creation — parent budget re-check in C4's fold includes children's spend? **No** — carve is a split: parent's enforceable budget -= carve; child gets its own. Implement as: creation writes child's `budget` and patches parent's compiled `budget` down; arithmetic asserted in tests), and envelope base = parent's envelope head (local: parent envelope revision; hosted: same repo + parent branch).
2. First-promotion hold: creating a child stream from agent context requires the parent's compiled `may_promote: true` AND (first time per parent) a human confirmation — reuse C1's `confirmAutonomy` mechanism shape (`promotion_confirmation_required`).
3. Closure roll-up: `close_stream` on a parent with open children → typed rejection `children_open` (list ids). Cross-filing needs no new mechanism (commands already address any owned stream by id — verify the MCP ledger tool passes streamId through; grounding says it does).
4. Needs-you labeling: attention entries for child streams carry the parent chain for the UI (`parent › child` — compute at read via `parent_stream_id`, no denormalization).

**Positive controls:** promotion yields child with carved budget + branched base; parent close blocked while child open; agent promotion without `may_promote` → rejected; second promotion needs no re-confirm.

## Leave it better
- Populate/propagate `childIsolationId` end-to-end (it's currently a typed dead field — this WS makes it real; remove the `?? null` shrug at `store.ts:5096`).
- `local-execution.ts` worktree code and `worktree-service.ts` overlap — route both through the gateway shape (`local-execution.ts:39-47`) rather than a third copy.
- Convex `cancellation: v.any()` (`schema.ts:840`) gets a typed validator while the file is open.

## DoD
Positive controls above, each a named test; 004 Phase 5 DoD items covered verbatim (overlap flags deferred to a follow-up — file a chip if not done here); width/lock changes covered by conformance additions (placement-aware leases) on both backends; a 4-wide worktree swarm fixture in the WS-F headless e2e completes end-to-end with all work landed through the gate.
