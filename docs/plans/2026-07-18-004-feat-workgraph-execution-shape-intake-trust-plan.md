# 2026-07-18-004 — WorkGraph v2: the durable work ledger (charters, masters, evidence)

Status: PLANNED (design settled and validated 2026-07-18; no implementation started beyond the
running-spinner glyph noted in §6.0)
Owner intent: define WorkGraph from first principles as the durable ledger for AI work —
sessions do work, the graph holds it — with configuration expressed as plain-text charters,
per-stream coordinator agents ("masters"), and verifiable evidence attached to every agent
action. This document REPLACES the earlier same-numbered draft ("execution shape + intake
trust"), whose chip vocabulary, policy enums, and intake-lane emphasis were invalidated by
simulation and research (§2).

Relationship to other plans: builds on 2026-07-18-003 (approval gate / pause-as-launch-gate —
taken as landed ground truth; its `pending_approval` state now gates only agent-proposed work,
§3.6). The master's session surface aligns with 2026-07-18-002 (background agents steering).
Wakes (`@claxedo/wakes`, project_wakes_package) is the hibernation engine for masters.

Inherited operating principles (inlined; `docs/plans/goal.md` does not exist on `dev`):
one reactive data graph · UI + motion parity gate · strangler/additive rollout · TDD ·
make illegal states unrepresentable · per-slice vision-reviewed verification (green tests are
claims; vision-reviewed screenshots/video are evidence — a rule this plan promotes into the
product itself, §3.5).

Execution strategy: sized for parallel agents. Phase 0 (safety) has three independent slices —
run as parallel worktree agents. Phase 1 (charter + master) is the critical path and should be
one focused agent with an adversarial-verify workflow before merge; its guardrails (§4) are
review gates, not suggestions. Phases 2–3 parallelize after Phase 1. Use workflows with
adversarial verification on every phase; the checklist in §4 is the reviewer's rubric.

---

## 1. First principles — what WorkGraph solves and what it is not

### 1.1 The problem: sessions do work but cannot hold work

A session — a chat with a coding agent — is the best interface ever built for *doing* AI work,
and structurally incapable of *holding* it:

- A session's identity is an accident: its title is a summary of its first message. Finding
  "where was that auth work from Tuesday" across fifty sessions is archaeology.
- Subagents are transient. Real work happens inside them and evaporates into transcripts
  nobody re-reads.
- Nothing in a session outlives the conversation. Work that spans days or weeks needs an
  artifact whose lifetime matches the work, not the chat.

Users name this pain constantly — in their words, "context loss" and "drift", never "session
management" (demand research, §2.3). The 2026 loop doctrine (Ralph loops; Anthropic's
turn/goal/time/proactive ladder) reached the same conclusion from the execution side: durable
state must live *outside* the context window, and fresh context per task beats long degrading
sessions.

### 1.2 The thesis

**You think in streams and tasks; sessions are disposable workers that attach to them.**
The graph is durable memory; sessions are execution. The graph's value is not orchestration
mechanics — it is that AI work becomes *findable, resumable, delegable, and provable* at
week scale. Five capabilities follow, none of which any session-based workflow can provide:

1. **Discovered work is captured.** An agent doing task A that notices problem B files it into
   the stream as proposed work instead of scope-creeping or losing it in a transcript. Streams
   accrete their own backlog from the work itself.
2. **Coordination is owned by an agent, not by the human.** Each stream has a master (§3.3)
   that merges, lands, reports, and absorbs workers' questions.
3. **Landing is the system's job.** Merge-back, trunk rebase, and the fix-CI-until-green loop
   are standing agent duties, not human terminal chores.
4. **Sessions report structure into the graph** cheaply (create task / mark done via one tool
   call), so even fully interactive work leaves a durable, glanceable trail.
5. **Every agent action carries evidence** (§3.5) — the property that market research
   identified as the actual bottleneck of the agent-fleet era.

### 1.3 What WorkGraph is NOT (including the crowded-market don't-build list)

- **Not another worker-spawning orchestrator UI.** Vibe Kanban, Conductor, Claude Squad,
  FleetCode, GitHub Agent HQ — a saturated tier with identical value props. We do not compete
  on "spawn agents and watch a board"; we compete on the ledger + charter + evidence layer,
  which the competitive scan confirmed nobody occupies.
- **Not a human merge-queue product.** Graphite/Mergify/GitHub native own stacked-PR queueing
  for humans. Our master lands *its own stream's* work; it rides the git host, never replaces it.
- **Not an issue-triage product.** Demand research found triage the weakest, most-served pain
  (Dosu, Linear, Copilot). Triage exists here only as a flow-stream capability (§3.2), never a
  headline.
- **Not a DAG-authoring tool, a per-task start button, a durable-execution engine (no
  Temporal — decision stands), or an autonomy free-for-all.** Approval of agent-proposed work
  remains human-only and no charter can override the hard envelope (§4).

---

## 2. Validation record — how this design was reached and tested

This plan is the survivor of an explicit falsification process run 2026-07-18 (full reports in
the design-session record):

- **v1 simulations (7 adversarial Sonnet personas)** killed the first draft: ~24 concepts hit
  in week one; Staged→Approve→Integrate a "flat tax" on trivial work; "approve my own request"
  breaking the chat contract; a frozen stream base with no trunk-sync story (migration persona
  abandoned at day 3–4); intake lane marginal vs GitHub's own list; power user dismissed
  outright; "Done ≠ correct" identified (confidently-wrong fix reads as success).
- **Redesign** (owner-driven): three nouns; charters replace typed configuration; per-stream
  master sessions; two stream shapes; conditional approval; intake demoted.
- **v2 simulations**: the junior persona now survives week 1 (5 concepts day one, ~12 for the
  week); the migration persona now *finishes inside the product* — the master's rebase +
  serial landing closes the staleness hole; residual risks are trust in silent conflict
  resolution and reward-hacked CI fixes, both answered by the evidence layer (§3.5).
- **Charter red-team**: charter-as-configuration judged sound *only* inside a hard authority
  envelope; produced the non-negotiable guardrails of §4 verbatim.
- **Demand research (HN, 8 threads, 2025-07→2026-07)**: strongest validated pains are
  parallel-agent chaos + the merge bottleneck (one continuous problem, in users' words:
  "orchestration buys parallelism, not coherence"); context-loss/drift is the users' name for
  the ledger problem; charters are normalized DIY practice (AGENTS.md is a Linux Foundation
  standard) — the burden to reduce is authoring/enforcement, not the concept. **The
  cross-cutting finding: review throughput and trust is the real bottleneck** — "10 agents =
  10 diffs/hour to review"; "compounded false affirmatives."
- **Competitive scan**: charter-enforced-at-runtime-by-a-manager-agent is confirmed
  unoccupied whitespace (the NLAH paper, arXiv 2603.25723, names the gap explicitly); the
  deferred/conditional-work ledger and cross-agent memory are the two adjacent whitespaces;
  the orchestrator-UI tier and human merge queues are the crowded traps.

Every evidence stream converged on one sentence: **the winning product is not the one that
runs the most agents; it is the one that makes agent work verifiable at human speed.**

---

## 3. The model

### 3.1 Three nouns

- **Stream** — a durable thread of work with a target repo + base revision. The unit of
  thinking, charter, and lifecycle.
- **Task** — the unit of execution inside a stream. One attempt = one fresh worker session.
- **Charter** — plain-text standing instructions on a stream (§3.4).

Everything else (attempts, envelopes, wakes, provenance) is machinery, not user vocabulary.
Deleted as user-facing concepts: Outcomes/success-criteria objects, workspace chips, intake
policy enums, confidence percentages, "Integrate" (renamed: the master's merge queue), the
two pause verbs (one Pause control; a checkbox extends it to stop running work; paused streams
say so inline on every affected task row).

### 3.2 Two stream shapes

- **Project stream** — converges to done. Card shows progress toward completion. Provisioned
  with a shared envelope worktree; the master merges finished work toward one branch/PR and
  the stream closes when it ships.
- **Flow stream** — never closes; work circulates through it (bug triage, feedback, support,
  dependency alerts). Card shows queue depth and throughput (arrived · resolved · oldest
  waiting), resolved items age out of view. No envelope worktree: each executed task branches
  fresh off current trunk (which sidesteps staleness for this shape entirely), PR per task.
  Three dispositions per item: resolve in place · promote to a project stream · dismiss with
  reason. The old intake-candidate machinery (source views, unorganized/staged/dismissed,
  receipts) becomes a flow stream's feed, not a separate UI lane.

Shape is inferred by the planner from what the stream is for; it is a stored field but never a
menu the user must understand up front.

### 3.3 Standing agents — one mechanism, two lifetimes

A standing agent = a session + a charter + a mailbox + wake subscriptions + bounded authority.

| Agent | Scope | Lifetime | Wakes on | Authority |
|---|---|---|---|---|
| **Worker** | one task | minutes–hours | launched once | edit code in its workspace; `call_master`; file proposed tasks |
| **Master** | one stream | stream lifetime | task settled · `call_master` · schedule · charter events | merge/land, rebase, open PRs, notify, maintain notes doc, fix CI, file proposed tasks — **never approve, never mutate protected refs** |

"Always on" = never closes, not always running: masters hibernate (wakes package) and wake on
events. The intake/triage desk is **not a third agent type** — it is simply the master of a
flow stream, permanent because its stream never closes.

`call_master(message)` is the single inter-agent primitive: enqueue into the master's mailbox
and wake it. No richer agent-to-agent protocol in v1.

The master absorbs the first bounce of every worker question and ordinary merge conflict;
only what it cannot resolve escalates to the human (Needs-you). This is what converts
Needs-you from a per-task interrupt tax (v1 simulation finding) into a filtered queue.

### 3.4 The charter

Plain-text standing instructions, drafted by the planner during scoping, edited by the human,
interpreted at runtime by workers (in their prompts) and the master (as its duty list):

> "Each task in its own worktree. Merge back as each lands; rebase on main every morning and
> after every landing; keep CI green. One PR for the stream, draft until I say otherwise.
> Write learnings to the stream doc. Telegram me only when blocked or done."

Charters replace the typed configuration surface entirely (workspace chips, policy enums,
notification settings, PR granularity) — one text field instead of a settings tree. Three
rules from the red-team make this safe:

1. **Defaults behind the charter, always.** A blank or vacuous charter degrades to
   conservative defaults (draft PRs, capped notification rate, ask before first
   externally-visible action) — never to unbounded "best judgment."
2. **The charter is versioned.** Every agent records the charter hash it holds; any agent with
   a stale hash must re-sync before its next externally-visible action (kills the
   drift-during-flight failure class).
3. **The charter is never the last line of defense.** Hard limits live in the envelope (§4);
   natural language governs sequencing, cadence, tone, and working style — the things it is
   actually good at.

### 3.5 The evidence layer — the product's spine

Every stream of validation converged here, so it is a design law, not a feature:
**prose is a claim; evidence is a link.** Concretely:

- **Receipts on every master action.** Every merge, conflict resolution, rebase, PR, and CI
  fix in the master's plain-English status carries an inline one-click diff/artifact link.
  An affordance, never a gate — it costs no new concept and answers "can I trust the
  narrator" (the v2 junior simulation's residual killer).
- **Structured audit record, atomic with every externally-visible action**:
  `{timestamp, wake_trigger, charter_version_hash, model_version, cited_charter_clause,
  reasoning_summary, tool_calls[], resulting_diffs}`. This is what makes "why did it do that
  at 3am" answerable, and what makes every other guardrail verifiable after the fact.
- **Structural anti-reward-hacking gates.** "Fix CI until green" and merge-landing get
  mechanical guards that the master cannot argue with — e.g., a landing that introduces new
  `any`/`@ts-ignore`/`@ts-expect-error` or loosens tsconfig strictness fails the gate
  regardless of green CI (the migration simulation's reward-hacking finding, generalized:
  charter-configurable per stream, but enforced as a check, not a prompt).
- **Verification stays a claim hierarchy.** Task Done means the worker's contract passed;
  master landing means gates passed; nothing in the UI ever conflates "completed without
  error" with "correct" (v1's "Done ≠ correct" finding is answered by naming what each state
  is evidence *of*, with the artifact linked).

### 3.6 Approval — conditional, human-only

- Work the human directly asked for **just runs**. No approve step on your own request
  (v1's worst first-run failure, deleted).
- Work an *agent* proposes — planner fan-outs, discovered tasks, flow-stream promotions —
  arrives `pending_approval` ("Staged") with "Approve & run", per-item or bulk. Proposals
  show **file scope per task and overlap flags** so a 45-row proposal reads as ~6–8 groupable
  decisions (the v2 migration fix).
- No agent can approve. Not the master, not via MCP (2026-07-18-003 decision stands), not via
  any charter sentence.

### 3.7 Scheduling law

Dependencies express ordering; workspace expresses the write-conflict domain; the scheduler is
derived, never declared: tasks sharing a mutable workspace form one serial lane; isolated
(worktree/flow) tasks run whenever dependencies allow. Default with no charter: one running
task per stream. Parallelism is something a charter *asks for* (worktree isolation) and file
scopes make reviewable — never a flag the user toggles.

---

## 4. Hard guardrails — non-negotiable in v1 (red-team output)

1. **Protected-ref mutation is a permission fact, not an instruction.** Master credentials
   structurally cannot push/merge/force-push to main or protected refs, regardless of charter
   text or model reasoning. Conflicting directives ("fix CI" vs "never touch main") can
   therefore resolve at worst into an *open revert PR* a human merges.
2. **Provenance survives derivation; execution checks the tag at point of use.** Content
   originating from public/untrusted sources stays execution-blocked even after summarization
   or paraphrase (the notes-doc two-hop injection). External content is stored as structurally
   fenced quotation with source, never flattened into trusted prose.
3. **Atomic audit records** (§3.5) on every externally-visible action — the record is emitted
   as part of taking the action, not reconstructed later.
4. **Loop-breakers on masters**: attempt cap per distinct failure signature before forced
   escalate-and-halt; wake coalescing (N settlements in a window → one invocation); a master's
   own authored actions are filtered out of its own trigger stream.
5. **Hold-and-confirm on first instances** of externally-visible, hard-to-reverse action
   types per stream (first non-draft PR to a public repo, first notification to a new
   channel); auto-proceeds thereafter within the stream.
6. **Defaults behind every charter** (§3.4).

These are review gates for every phase in §6: an implementation that satisfies the feature
list but misses a guardrail fails review.

---

## 5. Grounded current state (verified 2026-07-18, file:line)

- Approval gate, pause-as-launch-gate, Staged UI: landed per 2026-07-18-003 (uncommitted).
- Running-task glyph is an animated spinner (landed 2026-07-18, uncommitted):
  [work-item-rows.tsx:74](../../packages/claxedo-app/src/features/workgraph/work-item-rows.tsx).
- **No stop surface**: `cancelAttempt` exists end-to-end
  ([api.ts:388](../../packages/claxedo-app/src/features/workgraph/api.ts)) but no UI invokes
  it; attempt machine supports `running → cancelled`
  ([transitions.ts:65](../../packages/workgraph/src/domain/transitions.ts)).
- **No concurrency guard inside a stream**: launchability blocks only same-item relaunch
  ([launch-readiness.ts:60](../../packages/workgraph/src/domain/launch-readiness.ts)); all
  attempts share one envelope worktree
  ([local-execution.ts:100-165](../../packages/claxedo-server/src/workgraph-host/local-execution.ts)) —
  silent clobbering is possible today.
- **No master exists**; the drain is mechanical. Wakes package implemented but unwired
  (project_wakes_package). Vestigial per-attempt child-worktree cleanup remains
  ([workspace-execution.ts:94](../../packages/workgraph/src/ports/workspace-execution.ts)) —
  useful prior art for worktree-per-task in flow streams and charter-requested isolation.
- **Ingestion bypasses planning**: regex structurer with hardcoded empty dependencies
  ([matching-service.ts:103-126](../../packages/workgraph/src/application/matching-service.ts));
  intake pipeline (source views, candidates, receipts) is solid and becomes flow-stream feed.
- Session opening is full-navigation only
  ([first-party-content-surfaces.tsx:136-146](../../packages/claxedo-app/src/app/integrations/first-party-content-surfaces.tsx)).

---

## 6. Delivery phases with definitions of done

### Phase 0 — Safety and honesty (three parallel slices; ship this week)

**0a. Stop controls.** Stop on running rows wired to `cancelAttempt`; stopped rows read
"Stopped · Retry". One Pause control (default: pause launches; checkbox: also stop running);
paused streams announce themselves inline on every affected task row.
**0b. One running task per stream.** New launchability reason (`workspace_busy`); the domain
oracle and the SQL mirror share one predicate (the 2026-07-18-003 divergent-copies lesson).
**0c. Honest copy.** "Approve & run" on agent-proposed work; direct human asks skip approval;
placement line on the card (`worktree · from dev @ <rev>`); session + workspace identity in
the task inspector.
**DoD:** unit tests for the launchability reason in oracle + SQL mirror; E2E — two approved
tasks in one stream never hold two live attempts; Stop E2E from card and panel; E2E — a
human-created task launches with no approval step while an agent-proposed task requires one;
vision-reviewed screenshots (both themes) of Stop, Stopped · Retry, the Pause control, the
inline paused-row message, and the placement line.

### Phase 1 — Charter + master v1 (critical path)

Charter field on streams (planner-drafted, settings-editable, versioned by hash, injected
into worker prompts and master duties; conservative defaults behind it). Master session per
stream on the wakes engine: wakes on task-settled and `call_master`; v1 duties — merge
finished work into the envelope (serial), write learnings/status to the stream notes doc,
post plain-English status *with receipts*, escalate what it cannot resolve. Guardrails §4
items 1, 3, 4, 6 land in this phase as part of v1, not after.
**DoD:** E2E — two-task project stream completes end-to-end with zero human merge actions;
master's status message contains working diff links for every merge it performed; audit
records exist for every master action and include charter hash + cited clause; wake-storm test
(6 tasks settle in one window → one coalesced master invocation); attempt-cap test (engineered
repeated merge failure → escalate-and-halt, not a loop); master credential cannot push to a
protected ref (integration test against a real git host fixture); blank-charter stream behaves
per documented defaults; vision-reviewed status-with-receipts UI in both themes.

### Phase 2 — Landing and evidence completion

Master duties extended per charter: scheduled trunk rebase of the envelope; landing-time
re-validation against current envelope head; "fix CI until green" with the structural
anti-reward-hacking gate (configurable pattern set; default: no new `any`/`@ts-ignore`/
strictness loosening); open PRs (draft by default; hold-and-confirm on first non-draft to a
public repo — guardrail 5); Telegram/notify via channels with rate caps.
**DoD:** the migration stress rides in a fixture repo — teammate commit lands on trunk
mid-flight, morning rebase absorbs it, landing re-validates, CI break triggers a master fix
that the escape-hatch gate rejects when gamed (test both: honest fix passes, `@ts-ignore` fix
fails the gate); PR appears with correct draft state and receipts; first-instance
hold-and-confirm E2E.

### Phase 3 — The ledger skill + dogfood gate

One tool/skill callable from any session: create task / mark done / file discovered work into
a stream (writes are free — no approval to *record*; approval gates only execution of
agent-proposed work). Provenance tags (guardrail 2) land here, on every graph write.
**DoD:** from a plain session, one tool call files a task and it appears on the stream card
live; discovered-work E2E (worker files a proposal mid-task → Staged); provenance test —
content quoted from a public source into the notes doc remains execution-blocked downstream
(the two-hop injection fixture must fail safe). **Dogfood gate:** the team runs its own launch
backlog through WorkGraph for one week; the phase-4 go/no-go is whether we check the graph
instead of scrolling session history. This gate is the point of the whole plan — schedule it,
run it honestly, record the verdict in this doc.

### Phase 4 — Flow streams (gated on Phase 3's verdict)

Stream `shape` field; flow-stream card face (queue metrics, aging-out resolved rows);
per-task branches off trunk; promote-to-project-stream mechanic; intake candidates feed a
flow stream; the flow master triages per its charter (planner replaces the regex structurer
here); public-source ceilings enforced in domain (no execution without human approval —
charter cannot override).
**DoD:** triage E2E across the quality spectrum (junk → dismissed with reason; small bug →
fixed in place, PR per task; feature-sized → promoted, staged in target stream); hostile
issue fixture cannot reach execution through any path including the notes doc; flow card
vision-reviewed in both themes; regex structurer deleted.

### Phase 5 — Parallel isolation at scale

Charter-requested per-task worktrees in project streams; proposals show file scope + overlap
flags; overlapping tasks auto-serialize; master's merge queue re-validates each landing
against the moving envelope head.
**DoD:** two non-overlapping worktree tasks run concurrently and land serially with receipts;
engineered overlap is flagged at proposal time and serialized at run time; engineered conflict
escalates with both diffs linked, resolution happens via "Open in project" (no bespoke merge
UI); worktree lifecycle leak-test (no orphan directories after stream close/delete).

---

## 7. Out of scope

- Full tracker write-back beyond the master's PR/notify duties (status sync into
  Linear/GitHub) — channels-layer work, hangs off the same master events later.
- Cross-stream/organization memory ("compounding context") — identified whitespace, but gated
  on the evidence layer proving itself; a junk-drawer of unverified findings is worse than
  nothing.
- Speculative execution on ambiguity (build both interpretations, human picks a result) —
  strongest novelty candidate from the design exploration; revisit after Phase 3's dogfood
  verdict with real usage data.
- Auto-run intake tiers, per-task manual starts, human DAG authoring, Temporal-style engines,
  an MCP approve tool — permanently out, per prior decisions and this validation round.

## 8. Open questions for the owner

1. Master identity on the git host: dedicated bot account/App per workspace (clean permission
   fact, guardrail 1) vs the user's own credential with client-side enforcement (weaker)?
   Plan assumes a dedicated identity; needs a decision before Phase 1.
2. Charter surfacing at scoping time: the red-team showed rubber-stamped planner boilerplate
   is how silent overreach ships ("ping me on Telegram" nobody wrote). Minimal fix in Phase 1:
   the planner must show the charter diff-style at stream creation with side-effectful lines
   highlighted. Sufficient, or should side-effectful clauses require explicit per-line
   acknowledgment?
3. Notes-doc format: free markdown the master maintains vs structured findings with provenance
   fields. Guardrail 2 needs at least fenced quotations; how much more structure before it
   stops being a doc the human wants to read?
