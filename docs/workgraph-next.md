# WorkGraph — after the swarm substrate lands

This is `docs/workgraph.md`'s counterpart written from the other side of the build: the same kind of document — purpose, mechanics, architecture, present tense — describing the system once the work in `docs/plans/2026-07-28-003` has landed. §1 is the delta against today's implementation; everything after it describes the landed system on its own terms.

---

## 1. What goes, what comes

| Today | After landing |
|---|---|
| **Attempt**: a 7-state entity; every retry is a fresh session with empty context | **Run**: a link row — session + execution config + generation. Transient failure (network, limits, eviction) resumes the same session; a fresh run is a deliberate act. States shrink to crash-recovery breadcrumbs: intent → placing → running ⇄ parked → terminal |
| One execution at a time per stream, unconditionally | Concurrency is derived: tasks sharing a mutable workspace serialize; tasks placed in worktrees or sandboxes run in parallel up to the charter's width |
| Model/harness picked per task, raw | **Agent profiles**: named identities — harness, model, skills, MCP tools, portable memory, capability brief. The master assigns profiles to work. Capability comes from the profile; authority comes from the seat |
| Role vocabulary (planner/worker) implied in prompts and docs | Gone. There are profiles and seats. "Master" is the only named seat |
| Approval is the only mode: all agent-created work is Staged | Approval is the **default** mode. A stream's charter may declare it autonomous: agent-created work runs immediately, inside a hard budget, all other rails unchanged. Untrusted-source work stays Staged in every mode |
| No budgets; spend invisible | Per-stream budget compiled from the charter; enforcement is arithmetic (budget exhausted ⇒ stream held ⇒ Needs-you); spend shown per profile on the stream card |
| Tasks are the only execution stratum | **Subtasks**: one level below a task. No dependencies, no children, no planning — a fully-collapsed instruction that executes (typically on a cheap profile, in parallel) and reports up. Roll-up completion |
| Evidence includes agent-attested kinds; nothing is checked | Evidence kinds are only those the system can check: re-runnable test, API-confirmable integration, hashed artifact, owner signature. Claimed test results are actually re-run; evidence carries `verified / failed / unverified`. Review requires an external reference; findings are knowledge, not proof |
| Admission planning runs once per staged inbox item | Planning batches. Intake is a flow stream's feed; its charter sets the cadence (continuous, batched-N, on demand) and one proposal can cover many sources |
| Human-created tasks always launch when runnable | Creation carries intent: default is run; a **draft** flag captures a task without arming it |
| Charter is prose the master reads | Charter is still the only thing you write — and it **compiles** to the stream's typed envelope (autonomy, width, placement, profile assignments, budget, verification), shown diff-style before it binds. Prose steers agents; compiled values steer the machine |
| Master wakes daily regardless of activity | Schedule wakes are dirty-gated: no events since the last turn ⇒ no turn |
| One global WorkGraph page | WorkGraph is a per-project pane beside Sessions and Terminals. The header's creators (session / terminal / task) land on the current project's page; the project switcher moves the context. Home remains the cross-project pulse: stream cards grouped by project + the Needs-you card |
| "New session" button as the entry point to agent work | The **Task Composer**: two tabs. *Compose* — the session-composer bones with a profile picker in place of model/harness, placement, optional target stream, draft toggle. *Streams* — this project's streams, live-filtered, so filing into existing work is one click |
| Change feed: one cursor row per owner; contentless doorbell; snapshot rebuilt from 8 unbounded reads | Cursors sharded per stream (parallel runs don't contend); the doorbell carries the cursor (current clients skip the fetch, gapped clients detect loss); snapshot reads are bounded |
| Recovery sweep reads the first 500 tenants, unbounded fan-out | Recovery drains a **dirty set** on a cursor with a declared per-tick budget; wake rows are durable before any nudge |

Unchanged, deliberately: the three user nouns (Stream, Task, Charter), the single command write door with durable idempotency, immutable source revisions with keep/replace/fork, the master's receipts and clipped authority, the landing diff gate, draft-first PRs, owner-only irreversibles, Needs-you as the one inbox, the flat UI.

---

## 2. Execution model

**Runs.** A task executes as a run: `{session, execution config, generation, outcome}`. The scheduler is unchanged in kind — a pure boolean per task (approved-or-autonomous, dependencies terminal, no blocking decision, seat available, budget remaining); reason codes exist for the UI and telemetry only. When a task passes, placement resolves the assigned profile into a session config, provisions the workspace, and launches — with a durable intent row written first, so a crash between provisioning and launch is findable by the reaper instead of becoming an orphaned, billing sandbox.

**Resume-first.** Infrastructure failure is an in-run event. The workspace is re-placed if needed (sandbox checkpoints restore state), the session reattaches with full history, execution continues; the ledger records a parked interval. A fresh run — new session, generation incremented — happens on explicit restart, a poisoned workspace, or a charter policy (e.g. escalate to a stronger profile after two verification failures). Every runtime callback carries the generation; writes from a superseded generation are rejected, which is what makes a resurrected zombie sandbox harmless.

**Placement and parallelism.** A stream's envelope is its base repo + revision. Placement per run: `shared` (the envelope itself — such tasks form one serial lane), `worktree` (git worktree per run — parallel), `sandbox` (isolated VM — parallel, metered). Width is capped by the compiled charter. All parallel work re-enters through the master's merge queue and the landing gate; conflicts are a task state, not an incident.

**Subtasks.** A task's run may fan its plan into subtasks — each an explicit instruction with no further degrees of freedom. Subtask runs execute in parallel on their assigned (typically cheap) profiles inside the parent's placement context, record evidence, and report up. The subtask seat's surface is reduced for any profile: no task creation, no proposals, no planning. A subtask that turns out to need judgment escalates; it does not think.

**Autonomy.** `supervised` (default): agent-created work is born Staged and waits in Needs-you. `autonomous` (charter-declared, confirmed once with hold-and-confirm): agent-created work is born pending and launches when runnable; discovery, spawning, and continuation proceed without approvals until the work is done or the budget is not. The approval *verb* does not exist for agents in either mode — autonomy means nothing requires approval, not that agents grant it.

**Budgets.** Usage is metered per turn and attributed per run and profile. The compiled budget is enforced before launch and during settlement; exhaustion holds the stream and surfaces Needs-you. Spend per profile is visible on the stream card.

## 3. How a swarm runs

A swarm is not a separate mode or engine — it is what §2's pieces do when one charter turns them all on together: autonomy, width, isolated placement, profiles, a budget. The loop, end to end:

1. **Intent enters once.** You confirm a goal into a stream whose charter compiled to `autonomous`, a profile set, and a width. That is the last required human action until the work is done, the budget stops it, or something earns Needs-you.
2. **Ambiguity collapses at the top.** A planning-shaped task runs on a strong profile and emits the task graph: tasks, dependency edges, completion contracts. In an autonomous stream they are born `pending` — the scheduler sees them the moment they exist.
3. **The frontier launches in parallel.** The scheduler launches every task whose dependencies are terminal, up to the compiled width, each in its own worktree or sandbox with its assigned profile. There is no dispatcher beyond the boolean oracle — **the dependency graph is the execution plan**, and the runnable frontier is recomputed continuously as tasks settle.
4. **Leaves fan out.** A task whose plan is fully collapsed fans subtasks — explicit instructions executed in parallel by cheap profiles inside the parent's placement. Their evidence rolls up; the parent integrates and completes against its contract.
5. **Everything re-enters through one point.** Finished work joins the master's merge queue. The master is single-threaded by construction (its wake lane is the lock), so integration stays serial while execution runs wide: rebase, merge, re-validate against the moving head, landing gate on the diff. A conflict is a task state the master resolves or bounces back as work — never a stopped world.
6. **The graph grows to fit the problem.** Runs discover work and file it; in an autonomous stream it enters the frontier immediately — generation after generation, the graph widens until it covers the problem. Settled questions land in stream notes, injected size-capped into every subsequent run, so parallel lanes don't re-decide them; when two lanes converge on the same question anyway, arbitration is the master's coordination duty, steered by charter prose.
7. **The loop closes on settlement.** Every completion wakes the master; its turn merges, updates the graph and notes, and the next frontier launches. The swarm breathes in cycles: wide execution, narrow integration, repeat — compute scaling with the problem's actual shape, not a fixed topology.
8. **It stops for exactly four reasons.** No runnable work remains (done — the stream's draft PR waits for your publish). The budget exhausts (stream held, Needs-you). Repeated failure trips the halt (escalation with receipts). Or a rail demands a human — a public PR, untrusted-source work, a real decision — in which case *those lanes freeze and the rest keeps running*.

Why parallel agents don't collide is three mechanisms, not etiquette: dependency edges own **ordering**, placement isolation owns **write conflicts**, and the single-threaded master owns **integration**; stream notes are the shared memory that keeps decided questions decided. During all of it, the stream page shows the frontier as live run indicators, spend per profile against budget, and the master's receipts accumulating. The human's part of a healthy swarm is zero actions per cycle.

### Scale: when the goal is "port SQLite to Rust"

A goal that size is not planned upfront and does not live in one stream. Two mechanisms carry it:

**Planning depth is generations, not a document.** No planner emits three thousand tasks on day one — not here, not anywhere. The first planning task emits the *spine*: the component map written into an architecture source, the test oracle as the first real work (port the harness — it is what keeps every cheap execution honest later), and a first generation of coarse tasks in dependency order. Each coarse task's run is itself ambiguity-collapsing: it reads the architecture notes and emits either subtasks (its scope is now fully explicit) or further tasks (still ambiguity left). Every generation has a smaller ambiguity radius than the last. The "deep tree" exists — as generations over time in a flat graph, each generation planned by the run that discovered the need for it, with full context, at the moment it matters.

**Structural depth is child streams.** One stream has one serial integrator, one size-capped notes doc, one page a human can read — so a component that is a project in its own right (the pager, the B-tree engine, the VM) is **promoted to a child stream**: its own charter (which states its interface contract with siblings), its own master, notes, budget slice, and a branch off the parent's envelope. The parent stream keeps what is genuinely cross-cutting: architecture tasks, interface decisions, and **integration tasks — merging child branches into the trunk is ordinary work in the parent's graph**, gated by the same landing rules and the ported test suite, not a new mechanism. A child that needs an interface changed files a task into the parent; the parent's master triages it like anything else. Coordination between components is work, visible in the ledger — never a side channel.

The shape is deliberately the shape of an engineering org: components get teams (child streams), teams get leads (masters), integration is explicit work, and the person at the top reads status and decides interfaces — because that is the only shape of large-scale coordination with a track record. What the human touches, over weeks: the spine confirmation, a handful of interface decisions, and publishes.

## 4. Agents

**Profiles.** An agent profile is a named identity: harness, model, skills, MCP toolset, portable memory, and a capability brief. Memory belongs to the profile and travels with it across streams and machines. Profiles live in a library; a stream's charter names which profiles it uses and for what shape of work.

**Assignment.** The master holds the briefs of the stream's profiles and assigns them: who plans a scoping task, who executes collapsed instructions, who reviews. Assignment is the master's judgment steered by charter prose; the compiled envelope constrains it (width, budget, placement).

**Seats.** Authority is a property of the seat, never the profile: master seat — merge, rebase, PR, notes, escalate; never approve, never touch protected refs, never publish. Task seat — full work surface; discovered work is filed per stream policy. Subtask seat — execute and report only. Review seat — read and judge with a restricted view (output-only or code-only), producing evidence. The charter chooses seating; no charter sentence moves authority between seats.

## 5. Planning and intake

External work arrives through flow streams: webhook deliveries are lease-claimed exactly-once, matched to subscriptions, and land as feed items. The flow stream's master triages per its charter — dismiss with reason, fix in place (PR per item), or propose promotion into a project stream — at the cadence the charter sets, over batches when the charter says so. Staging freezes source text into an immutable revision; a proposal (one or many sources) is drafted by a strong model and validated mechanically; only your confirm materializes work, with keep/replace/fork on revisions of already-admitted sources, replace being version-pinned and server-computed. Draft-flagged tasks skip none of this — they are ordinary tasks that are not armed.

## 6. Verification

Completion requires evidence; evidence kinds are exactly the checkable ones. A `test_result` carries its command and is re-run in a clean context before it counts. An `integration` carries a reference confirmed against the provider. An `artifact` carries its hash. `owner_confirmation` is signed by your identity. Contracts may require `verified` status — autonomous streams default to it. The landing gate remains independent of all of this: it inspects the actual diff and rejects new `any`/`@ts-ignore`/strictness loss regardless of evidence, CI color, or any agent's account of events. Review-seat runs add decorrelated judgment where the charter asks for it; their output is evidence like any other, subject to the same rules.

## 7. Motion layer

Writes: one transaction per command — change + event + per-stream cursor bump. Reads: one live stream per client; the doorbell carries the cursor; a current client does nothing, a stale client fetches, a gapped client knows it gapped; snapshots are bounded reads. Drive: durable wake rows first, per-lane single-threaded timers second (the lane key is the serialization guarantee — one master turn per stream by construction); recovery drains dirty-flagged tenants on a persisted cursor with a declared per-tick budget. Every outbound call has a timeout; dependency outages surface as 503, never 401. One identity namespace exists past the auth boundary.

## 8. Surfaces

- **Home** — cross-project pulse: stream cards grouped by project; the Needs-you card (staged batches grouped for one decision, questions with options, escalations with receipts, the confirmations only you can give).
- **Project** — Sessions · Terminals · WorkGraph as sibling panes. Header creators land on the current project's pages; switching project moves the context.
- **Task Composer** — *Compose*: intent, profile, placement, optional stream, draft toggle. *Streams*: the project's streams, live-filtered.
- **Project WorkGraph page** — flat stream cards; stat strip (active · agents working · needs you).
- **Stream page** — charter prose with its compiled chips (`autonomous · ≤6 wide · worktrees · $40/day · verify: test`); flat task list with one level of subtask indentation; live run indicators; the master's status line with inline receipts; spend per profile against budget.
- **Task page** — the run's session (resumable, full history); checkpoints at chosen granularity; evidence with verification state; seat controls: stop, park, fresh run, reassign profile.

## 9. Deliberately absent

Recursive task nesting (lateral growth and child-stream promotion instead) · role-typed agent classes · an approval verb for agents · LLMs in the scheduler · a settings tree beside the charter · attestation-only evidence · per-task mandatory start steps · custom VCS machinery · a master→running-run push channel (deferred; coordination is between runs, via the master and stream notes).
