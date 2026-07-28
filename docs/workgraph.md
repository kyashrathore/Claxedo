# WorkGraph

**WorkGraph is the work engine inside Claxedo: the place where work lives, runs, and proves itself.** You put intent in — a GitHub issue, a thought, a pile of feedback — and WorkGraph turns it into structured tasks, executes them with AI agents under rules you set, and hands you back evidence instead of claims.

This document is the canonical description of the system: its purpose, its features, and its architecture. It assumes you're an engineer who has never seen the code. A build-status appendix at the end says which parts are live and which are in construction.

---

## 1. Purpose — the problem it solves

AI agents are good at *doing* work but terrible at *holding* it. A chat session can fix a bug, but it can't remember that there are nine more bugs, that three of them block a release, that one is waiting on your answer to a question, and that the fix from last Tuesday still has no proof it actually works. Sessions end; work persists.

Every existing tool holds half the problem. Issue trackers hold work but can't run it. Agent tools run work but can't hold it. And neither answers the question that actually matters once agents do most of the labor: **"can I trust what happened while I wasn't looking?"**

WorkGraph's answer is a durable ledger with three properties:

1. **Work outlives sessions.** Tasks, their history, their attempts, and their proof live in a permanent graph — agents come and go.
2. **You control how autonomous it is — per stream.** The default is supervised: nothing an agent invents runs without your click. A stream you designate as autonomous runs without approvals, inside a budget, with every safety rail still on.
3. **Done means proven.** Completion requires typed, mechanically-checkable evidence — a re-runnable test, a confirmable merge, a hashed artifact, or your own signature. Prose is a claim; evidence is a link.

The economic bet underneath: most moments in a large task don't need frontier intelligence. A strong model plans and collapses ambiguity; cheap models execute the collapsed instructions in parallel; machines verify. WorkGraph is the substrate that lets you run that shape — or ignore it entirely and just have a tracker whose assignees are agents.

---

## 2. The system in one picture

```
                    you                                 the world
                     │                                      │
              type intent /                        GitHub · Linear · Jira
              capture thought                        webhooks, issues
                     │                                      │
                     ▼                                      ▼
               ┌──────────────────────────────────────────────┐
               │                   INBOX                      │   candidates arrive
               └──────────────────────┬───────────────────────┘
                                      │ you stage what matters
                                      ▼
               ┌──────────────────────────────────────────────┐
               │                 PLANNING                     │   a strong model drafts
               │        (proposal — nothing exists yet)       │   streams/tasks from the
               └──────────────────────┬───────────────────────┘   frozen source text
                                      │ you confirm (the only door)
                                      ▼
   ┌───────────────────────────── STREAM ─────────────────────────────┐
   │  charter (your rules, prose)      master (supervisor agent)      │
   │                                                                  │
   │   task ──► task ──► task          each task, when runnable,      │
   │     │        │                    becomes a RUN: a real          │
   │  subtask  subtask                 agent session in a workspace   │
   │  subtask                                                         │
   │                                                                  │
   │  evidence ◄── every completion    decisions ──► questions to you │
   └────────────────────┬─────────────────────────────┬───────────────┘
                        ▼                             ▼
                 landing gate                    NEEDS-YOU
              (diff-checked merge)          (your single inbox:
                        │                approvals · questions ·
                        ▼                escalations · failures)
                   shipped work
```

Two doors involve a human by construction: **confirm** (intent becomes real work) and **Needs-you** (everything waiting on you). Everything between the doors can be supervised or autonomous — your choice, per stream.

---

## 3. Vocabulary — the nouns

Three nouns are the user's vocabulary. Everything else is machinery.

**Stream** — a durable thread of work with a goal and a target (a repo + base revision, or a directory). The unit of thinking, rules, and lifecycle. Two shapes: a **project stream** converges to done and ships; a **flow stream** never closes — work circulates through it (bug triage, feedback, support), each item resolved, promoted to a project stream, or dismissed.

**Task** — the unit of execution inside a stream: a title, a description, a priority, dependencies on other tasks, and a **completion contract** (what proof "done" requires). A task may carry **subtasks**: fully-collapsed instructions with no dependencies, no children, and no planning of their own — they just execute, in parallel, usually on cheaper models, and report back. If a subtask would need judgment, it should have been a task.

**Charter** — plain-text standing instructions on a stream. *"Each task in its own worktree. Run six wide on the cheap tier, budget $50, autonomous within that. Verify everything by test. One draft PR until I say otherwise. Message me only when blocked or done."* The charter is the one configuration surface — there is no settings tree. The system compiles it into typed limits it can enforce (see §6.4).

The machinery nouns you'll meet:

- **Run** — one execution of one task: a real agent session in a real workspace, linked to its execution config and stamped with a generation number. Transient trouble — a network drop, a rate limit, an evicted sandbox — never ends a run: the session resumes with its context intact, and the ledger records nothing but a parked interval. A *fresh* run (new session, generation up) happens only deliberately: a wrong path, a poisoned workspace, a different agent. Every run's record — its claims, spend, and outcome — stays in the ledger.
- **Master** — the stream's standing supervisor agent. It never really "runs continuously": it sleeps and wakes on events (a task settled, an agent messaged it, its schedule fired — and the schedule skips when nothing happened). Its duties: assign work — it reads each available profile's capability brief and decides which agent gets which task — merge finished work, keep the stream's notes, post status *with receipts*, resolve what the assigned agents can't, escalate what it can't. Its authority is clipped: it can never approve work, never touch protected branches, never make something public.
- **Agent profile** — a named agent identity: which harness it runs on, which model, which skills and MCP tools it carries, and its own **portable memory** that travels with it across streams and machines — a named agent accumulates competence instead of starting over. Each profile has a capability brief; the master reads the briefs and assigns profiles to tasks and subtasks. One rule governs the whole cast: **capability comes from the profile, authority comes from the seat.** Any profile executing a subtask has that seat's reduced surface (no task creation, no planning); any profile in the master seat has the master's clipped powers. The charter picks who sits where; it can never move authority between seats.
- **Evidence** — typed proof attached to work: a test result carrying the command that can be re-run, an integration reference an API can confirm ("PR #12 merged"), a content-hashed artifact, or an owner signature. Nothing else counts as proof.
- **Decision** — an agent's blocking question to you, with options. The tasks a decision names are frozen until you answer.
- **Needs-you** — the computed human inbox: staged work awaiting approval, decisions, escalations, failures, broken connections. Served by its own API; always legible; never a firehose, because the master absorbs the first bounce of everything.
- **Work source & revisions** — intent is stored as immutable, content-hashed snapshots. Work is always created from an *exact revision* of the text, never from "the issue" (which someone can edit tomorrow). When the source changes, you choose: **keep** your tasks, **replace** specific ones (named and version-pinned — never guessed), or **fork** a new stream.

---

## 4. What you can do with it — the features

**Capture everything, organize deliberately.** Connect GitHub, Linear, or Jira and your assigned issues arrive as inbox candidates; idle AI sessions with meaningful work surface there too; or just type. Staging a candidate freezes its text and asks a strong model to draft a plan — streams, tasks, contracts — which you review before anything exists. Related items can be planned together in batches (a flow stream's charter decides the cadence: continuous, batched, or only when you ask). You can also capture a task as a **draft** — recorded, visible, inert — for thoughts that aren't launch orders yet.

**Run work at the autonomy level you choose.** In a supervised stream (the default), everything an agent proposes is born **Staged** and waits for your approval — one click, or "approve all staged" per stream. In an **autonomous stream** — declared in the charter, confirmed once by you — agent-created work runs immediately: plan, execute, discover, spawn, continue, within a hard budget. Autonomy removes the approval step and nothing else; every rail in §7 still holds. Flip is per-stream; your other streams don't change.

**Parallelize when the work allows it.** Dependencies define what *can* run simultaneously; placement defines what *may*: tasks sharing a mutable workspace serialize automatically, tasks in isolated worktrees or sandboxes run in parallel up to the charter's width. A task fans its subtasks out in parallel to cheaper profiles; the master merges everything back through one gate.

**Supervise without babysitting.** The stream card shows live status; the activity feed shows agent checkpoints at the granularity you choose; every master action carries a one-click diff link. When something needs a human, it appears in Needs-you with the reason — a question with options, a staged proposal grouped for one decision, an escalation with the receipts attached. Agents can message the master; the master interrupts you only for what it cannot resolve.

**Trust the results.** Completion contracts are matched against verified evidence — a test that was re-run, a merge an API confirmed, an artifact whose hash matches. Landing is diff-gated: a merge that adds `any`, adds `@ts-ignore`, or weakens compiler strictness is rejected no matter how green CI looks and no matter what any agent says. PRs are drafts until *you* make one public. Outcomes close only over your signature.

**Program it.** The charter is where you build your own system: which agent profiles do what (who plans, who executes, who reviews — each a named agent with its own harness, model, tools, and memory), parallel width, placement, budget, verification requirements, autonomy, notification cadence, working style. One paragraph of prose turns a stream into a swarm; a blank charter degrades to conservative defaults, never to "best judgment."

---

## 5. The life of one piece of work, end to end

Say a GitHub issue lands in a repo you've connected.

1. **Arrive.** The webhook is deduplicated and claimed (retries and concurrent processors can't double-handle it), matched against your subscriptions, and written into the inbox as a candidate.
2. **Stage.** You glance at the inbox, dismiss the noise, stage this one. Its text is frozen into an immutable revision — the exact words your plan will be built from.
3. **Plan.** A strong model reads the revision and drafts a proposal: which stream this belongs to (or a new one), the tasks, their contracts, a charter if the stream is new. The draft is validated mechanically — it must plan from exactly that revision, honor your target, contain no duplicates. Still nothing exists.
4. **Confirm — the only door.** You review the proposal and confirm. Now the stream and tasks exist, each stamped with its source lineage. (If this was an *edit* to an already-planned issue, you'd instead choose keep / replace / fork, and replace would show you the exact version-pinned list of tasks it abandons.)
5. **Launch.** A scheduler continuously asks one boolean question per task: *runnable now?* — approved, dependencies done, no blocking question, workspace available, budget remaining. The moment a task passes, a run is placed: the master's chosen profile resolved into a session config, workspace provisioned (shared, worktree, or sandbox per the charter), session launched, lease-guarded so a half-launch becomes a Needs-you card instead of a ghost.
6. **Execute.** The assigned agent reports checkpoints (your activity feed), records findings, opens draft PRs through credential-less operations, asks you a decision if genuinely blocked — and if the task decomposes cleanly, fans subtasks out to cheaper profiles in parallel and integrates their results. If the plumbing hiccups — network, limits, an evicted sandbox — the session resumes where it left off with its context intact; nothing restarts from zero. Anything it *invents* (a discovered task) is born Staged in a supervised stream, or launches directly in an autonomous one.
7. **Prove.** The agent completes with evidence, or it doesn't complete. The contract checks the evidence kinds; verification re-runs what claims to be a passing test; the landing gate inspects the actual diff on merge.
8. **Supervise.** The master wakes when tasks settle: merges finished work into the stream's branch, rebases on schedule, keeps notes (which are injected, size-capped, into every subsequent run so settled questions stay settled), posts status with receipts, and escalates the irreducible to Needs-you — typed, with everything attached.
9. **Ship.** The stream's draft PR is ready; you make it public (only you can); the stream closes over your signature. The ledger keeps everything: every run, every claim, every receipt, forever answerable — *"why did it do that at 3am?"* has a lookup, not a vibe.

The same flow with an autonomous charter differs at exactly two points: step 6's discovered work launches without waiting for you, and step 8's master runs the loop to completion or budget — you watch the receipts instead of clicking the approvals.

---

## 6. Architecture — how it's built

### 6.1 Shape

WorkGraph is a self-contained domain service inside the Claxedo server. Its boundary is deliberately narrow:

- **One write door.** Every mutation in the product is a typed command through a single endpoint — create/update for each noun, approve/reject, cancel/retry, decisions, evidence, checkpoints, completion, lifecycle. Every command carries a durable operation id, so retries are exact no-ops. There is no second write path.
- **Reads are projections.** A snapshot route serves the board; detail routes serve entities; an attention route serves Needs-you. Clients never derive attention or launchability themselves — the server computes, the client renders.
- **Two interchangeable storage backends** implement one store contract: SQLite for local/self-host, Convex for hosted cloud. Business rules live identically in both — the actor-based born-state rule is literally the same line in each — and backend parity is a review gate, not an aspiration.
- **Schemas are the API.** Commands, reads, ids, and events are Zod contracts shared by server, app, and the agent-tool layer; nothing is stringly-typed across the boundary.

### 6.2 State machines as data, scheduling as a pure function

Task, attempt, stream, and decision lifecycles are literal transition tables — no scattered `if`s. The scheduler is a pure predicate over graph state: **runnable-or-not is a boolean**; the reason codes attached to "not" exist for the UI and telemetry, and nothing else consumes them. No model is ever in the launch path: launchability must be deterministic, near-free, and testable, because it runs constantly over every pending task. Notably, nothing transitions *into* `completed` through the tables — completion only passes through the evidence contract.

### 6.3 The execution substrate

A stream owns an **envelope**: its base repository + revision. Placement decides how runs touch it — `shared` (the envelope itself; such tasks form one serial lane), `worktree` (a git worktree per run off the base; parallel), or `sandbox` (an isolated VM; parallel, metered). The scheduler *derives* concurrency from placement and dependencies — parallelism is never a flag, it's a consequence of isolation the charter asked for. All parallel work funnels back through the master's merge queue and the landing gate; merge conflicts are a normal state on the task, not a crisis. Every provisioned thing — sandbox, worktree — has a reaper that runs from recorded truth, and a reaper that finds nothing to reap must say so loudly (a silent reaper is treated as an outage).

### 6.4 The charter compiler

Prose in, enforcement out. The user writes and edits *only* prose. At draft and every edit, the charter is compiled — by the same strong model that drafts plans — into the stream's typed envelope: autonomy, width, placement, agent-profile assignments, budget, verification requirements, landing patterns, notification caps. The compiled values are displayed diff-style at confirmation — side-effectful sentences become visible numbers before they bind. Agents read the prose for judgment; the scheduler, budgeter, and gates read only the compiled values; silence compiles to conservative defaults. Charters are versioned by hash, every agent records the hash it holds, and a stale-hash agent must resync before its next externally-visible action.

### 6.5 The motion layer — how change propagates

Three paths move the system, each with one job and a declared budget:

- **The write path.** A command commits its change plus an event and a per-stream cursor bump in one transaction. Cursors are sharded per stream precisely so parallel attempts under one owner don't contend on a single row — the write path must never be the thing that serializes a swarm.
- **The read path.** Clients hold one live stream; changes arrive as a doorbell **carrying the cursor**. A client that's current skips the refetch; a client that sees a gap knows it missed something and recovers — delivery loss is detectable by construction, and a slow poll floors it. Snapshot reads are bounded; no projection reads an unbounded set.
- **The drive path.** Nothing launches inline with a request. Commands write durable intent first (a wake row), then nudge a per-lane timer actor to act *soon*; per-stream lanes serialize master turns by construction (the lane key *is* the one-turn-per-stream lock). Recovery drains a **dirty set** — tenants flagged by the write path — on a cursor with an explicit per-tick budget; nothing ever enumerates all tenants, and every sweep declares the platform limit it respects (outbound-call caps, transaction read ceilings). A lost nudge degrades to sweep latency; it never loses work, because the row was durable before the nudge existed.

External failure is fenced the same way: webhooks are lease-claimed for exactly-once processing; outbound calls carry timeouts; a down dependency surfaces as *unavailable* (503), never as *unauthorized* (401) — an outage must never masquerade as a bad login.

### 6.6 Identity and tenancy

Everything is tenanted by (organization, owner); every index leads with that tuple. Past the authentication boundary exactly one identity namespace exists — the authority's internal ids — resolved once at the edge; auth-token claims never leak into routing or event scoping. Provider credentials never reach agents: external operations go through references the server exchanges server-side.

---

## 7. The safety model — what holds no matter what

The approval step is the *least* of the rails. Everything below is enforced by identity, arithmetic, or diff inspection — which is exactly why removing approvals (autonomy) removes no safety:

| Rail | Enforced by |
|---|---|
| Agent-created work is labeled with its creator and origin run, always | storage, from the authenticated actor — not from anything an agent claims |
| Content from public/untrusted sources cannot reach execution without a human — **in any mode; no charter sentence can open this** | provenance tags that survive summarization; checked at point of use |
| PRs are drafts; the first public/irreversible action of each kind per stream is held for confirmation | typed escalation to the owner |
| Merges pass the strictness gate (no new `any` / `@ts-ignore` / weakened compiler flags) | inspection of the actual diff |
| Protected branches are unpushable by agent credentials | git permission facts, not instructions |
| Closing a stream/outcome, publishing, approving — human only; **no agent can approve anything, ever, in any mode** (autonomy means nothing *requires* approval, not that agents grant it) | owner identity checks |
| Runaway loops die | attempt caps per failure signature, forced escalate-and-halt, wake coalescing, self-trigger filtering |
| Autonomous streams stop at the line | hard budget → stream held → Needs-you; overspend is impossible, not discouraged |
| Everything is answerable afterward | an atomic audit record on every externally-visible action: trigger, charter hash and cited clause, model, tools, diffs, outcome |

## 8. The economics

Work is unevenly hard, so agents shouldn't cost evenly: **collapsing ambiguity** (planning, supervision) justifies frontier models; **executing collapsed instructions** doesn't — cheap models follow explicit instructions reliably and can carry the large majority of tokens at a fraction of the cost. Profiles are how you express that: each bundles a model with a harness, tools, and memory, and the master assigns them to work by their capability briefs — expensive profiles where judgment lives, cheap profiles where instructions are already explicit. Subtasks exist precisely to be the cheap-profile unit. Budgets meter the whole stream from per-turn usage records, and the stream card shows spend per profile, because an economic system you can't see isn't one you can steer. Masters sleep whenever nothing happened — standing agents are standing *authority*, not standing compute.

## 9. Where recursion goes

Problems recurse; the data model doesn't. Depth of planning is represented laterally — tasks spawn tasks into the stream's dependency graph, generation after generation — and one level down, tasks fan subtasks. When a branch of work grows big enough to deserve its own rules, context, and supervisor, it is **promoted to its own stream**, linked to its parent. Strata stay fixed (stream → task → subtask) because every stratum is something a human can read; unbounded trees are where both issue trackers and agent swarms historically drown.

---

## Appendix A — build status

The design above is one system; construction proceeds in phases (decision log and definitions of done live in `docs/plans/`, which is internal history — the product never references it).

**Live today:** the ledger (commands, idempotency, dual backends), inbox → stage → plan → confirm with keep/replace/fork, the approval gate and Needs-you, runs with lease-guarded placement into a shared envelope (one at a time per stream), masters with receipts/mailbox/escalations, evidence kinds and completion contracts, the landing strictness gate, decisions, draft-PR + owner-only rails, activity checkpoints, archive.

**In construction, in order:** motion-layer hardening (sharded cursors, dirty-set recovery, timeouts, cursor-carrying doorbells) · resume-first run semantics · autonomous streams + draft capture + budgets · parallel placement (worktrees/sandboxes) with the master merge funnel · subtasks + agent profiles + batched planning · evidence verification (re-running claimed tests, confirming references) and review lenses · master wake economy.

**Deliberately absent:** recursive task nesting, per-task manual start buttons, an agent approval verb, LLMs in the scheduler, a settings tree beside the charter, attestation-only evidence kinds, role-typed agent classes (capability lives in profiles; authority lives in seats), custom VCS machinery.

## Appendix B — reading map

- This document — the system, complete.
- `docs/workgraph-primer.md` — a code-level tour of the current implementation with file/line anchors, for engineers working in the tree.
- `docs/plans/` — internal decision log (design history, reviews, phase DoDs). History lives there so it doesn't live in the code.
