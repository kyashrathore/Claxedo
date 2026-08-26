# WorkGraph — A Complete Primer

*Written 2026-07-28 from the code on `security/pre-launch-remediation-2026-07-28`. Assumes zero prior knowledge of the code or architecture. File references are anchors, not required reading.*

---

## 1. What WorkGraph is, in one paragraph

WorkGraph is Claxedo's **work ledger and agent-orchestration layer**: the system that turns "things that should get done" — GitHub/Linear/Jira issues, idle AI sessions, your own typed intent — into structured, human-approved, agent-executed work with machine-checkable proof that it actually happened. The closest familiar analogy: **an issue tracker where the assignees are AI agents**, wrapped in three things a normal tracker doesn't have — an *approval gate* (nothing an agent invents runs without your click), an *evidence system* (tasks can't be "done" without typed proof matching a contract), and a *supervisor agent per initiative* (the "master") whose every action leaves an audit receipt.

Technically it is a self-contained domain service (`packages/workgraph/`) embedded in the Claxedo server: **38 typed commands through a single write endpoint**, an event-sourced change ledger, snapshot-style reads, pure-function state machines, and **two interchangeable storage backends** (SQLite for local/self-host, Convex for hosted cloud) that implement the same store contract — the important business rules are literally the same line of code in both.

---

## 2. The vocabulary — every entity, top-down

The data model is a hierarchy. Each level answers one question:

```
WorkGraph            "whose board is this?"        one per (org, user) — personal-first
│
├─ Work Source       "what was the intent?"        immutable, versioned text (an issue body,
│   └─ Revisions     "which version exactly?"      a doc, a typed request) — SHA-256 hashed
│
├─ Source View       "what do I subscribe to?"     a saved filter on a provider connection
│                                                  ("my assigned Linear issues in team X")
├─ Intake Candidate  "what arrived?"               inbox rows: external issues + idle AI sessions
│
├─ Admission         "what's the plan?"            an LLM-drafted proposal you review
│   Proposal                                       before ANY work exists
│
└─ Stream            "what initiative?"            the big unit: has a charter (mission text),
    │                                              a shared workspace (the "envelope"),
    │                                              and a supervising master agent
    ├─ Outcome       "what goal?"                  success criteria + evidence; only YOU can close it
    │   └─ Work Item "what task?"                  state machine + completion contract + priority
    │       │                                      + dependency edges (a DAG) + the approval gate
    │       └─ Run "which agent run?"              one numbered execution: a real agent session
    │                                              in the stream's workspace
    ├─ Decision      "agent asks human"            a blocking question with options; freezes
    │                                              the tasks it names until answered
    └─ Evidence      "what's the proof?"           six typed kinds (test result, artifact, review,
                                                   integration, owner confirmation, finding)
```

Around that hierarchy sit three cross-cutting systems:

- **Attention ("Needs you")** — a computed inbox of everything waiting on a human: staged tasks, decisions, master escalations, stalled attempts, broken connections. Served by its own API (`/attention`), never derived client-side.
- **The change ledger** — every command appends events + a change row and bumps a per-tenant cursor; this drives live UI updates (a "doorbell" ping that tells clients to re-fetch).
- **Sessions binding** — agent sessions are explicitly bound to streams (`workgraph_session_bindings`), which is how an agent knows its "current work" and earns the right to call the master.

In Convex this is 31 tables (`convex/schema.ts:568-1190`); locally it's the mirror-image SQLite schema.

### Name decoder (code ↔ UI)

| Code says | UI says | Meaning |
|---|---|---|
| `pending_approval` | **Staged** | agent-created work awaiting your approval |
| attention | **Needs you** | the human inbox |
| envelope | (stream workspace) | the shared git workspace all of a stream's attempts run in |
| master | Master / stream supervisor | the per-stream long-lived agent |
| admission | (inbox → plan → confirm) | turning intent into actual work records |
| drain / settle | (invisible) | the background loops that launch work and do bookkeeping |

---

## 3. The life of one GitHub issue (the full lifecycle, end to end)

This is the single most useful thing to internalize — every feature hangs off one of these nine steps.

**① Arrival.** A GitHub webhook lands. It's deduped and lease-claimed in `workgraph_webhook_deliveries` (so retries and concurrent processors can't double-handle it), then fanned out to every matching **Source View** — capped at 32 views per delivery. Matching only uses stable routing keys (repo for GitHub, team for Linear, JQL project for Jira). Each matched view refreshes and writes an **Intake Candidate** with status `unorganized`. *(Wired providers today: GitHub, Linear, Jira — nothing else yet. The other candidate kind is an idle local AI session judged "meaningful".)*

**② Staging.** In the inbox UI you either **Dismiss** the candidate or **Stage** it. Staging freezes the issue's text into an immutable **Work Source revision** (content-hashed — work is always admitted from an *exact version* of the text, never from "the issue" in general) and opens an **Admission Proposal**.

**③ Planning (an LLM works for you here).** A background job claims the proposal and runs a *real agent session* against a planning prompt. The output — proposed stream/outcomes/tasks — is schema-validated defensively: the plan must echo the exact source revision it planned from, must honor your target stream if you set one, and must have no duplicate keys, or it's rejected (`adapters/sqlite/source-planning-runtime.ts:197-205`). The result is a reviewable proposal — **still zero work records exist**.

**④ Confirmation — the only door into real work.** "Analysis creates a reviewable proposal; only confirm may materialize work" (`application/source-admission-service.ts:54`). When you confirm, you pick a disposition: `create` a new stream, add to an `existing` one — or, if this is a *new revision of an already-admitted source* (the issue got edited), one of three explicit choices:
- **Keep** — ignore the edit; existing tasks stand.
- **Replace** — abandon specific tasks and supersede them. Safety: you must name each task with a version pin (`{workItemId, expectedVersion}`), and the UI gets that list only from a server-truth `replacement-review` endpoint — it is *never* reconstructed from an LLM's guess (`waiting/waiting-source.ts:72-81`).
- **Fork** — branch a new stream; the original is untouched.

**⑤ The approval gate.** Every work item is born in a state decided by *who created it*:

```ts
const bornState = context.actor.type === "user" ? "pending" : "pending_approval"
```

That line exists **identically in both backends** (`adapters/sqlite/store.ts:1858`, `convex/workgraphCommands.ts:840`). Human-created tasks are born approved (`pending`); anything an agent creates — including follow-up tasks invented mid-run — is born **Staged** and cannot launch until you approve it in the Needs-you panel (per-item, or "Approve all staged" scoped to one stream). If an agent later *edits* an approved task, it drops back to Staged for re-approval; your own edits don't.

**⑥ Launch.** A background "drain" continuously evaluates `pending` items against a **launchability predicate** (the ready-items SQL in `adapters/sqlite/store.ts`, mirrored in the Convex store) that blocks on ~10 concrete conditions: `not_approved`, `deps_incomplete` (its DAG parents aren't done), `blocking_decision` (an open question names it), `workspace_busy` (a stream runs **one run at a time** in its shared envelope), `stream_held`, `capability_invalid`, etc. When an item passes, a **Run** is admitted and placed: provision-or-adopt the stream's workspace → mark placing → launch a real agent session → mark running — with an ownership lease re-checked at four points, and a **compensation path** on any failure (cancel the half-launched session, surface the run as "needs attention" with the reason) so you get a Needs-you card instead of a ghost process.

**⑦ During the run.** The agent (via ~50 MCP tools plus run-scoped callback routes) can: report **checkpoints** (milestone/progress/detail — this is the Activity feed you see), record **evidence** and findings, create follow-up work (born Staged), open **Decisions** — a question with options that *freezes the tasks it names* until you answer — and post to the master's mailbox. External actions (comment on the issue, open a PR) go through connection operations that are idempotency-keyed, **default to draft PRs**, and never hand the agent credentials (it holds secret-free references; the server exchanges them).

**⑧ Completion — proof, not vibes.** `complete_attempt` requires **at least one evidence record** by schema. A work item can only reach `completed` from a review-ish state *and* only if its **completion contract** is satisfied — the contract's requirements are matched against the *latest* typed evidence per requirement (`domain/completion.ts:22,55`). Two more gates sit above that:
- **Landing integrity** (`domain/landing-integrity.ts`): a merge whose diff adds an `any`, adds `@ts-ignore`/`@ts-expect-error`, or weakens any of 10 tsconfig strict flags is rejected. A stream's charter can *extend* this floor, never lower it.
- **Outcome closure is owner-only**: closing an outcome demands every child task be terminal *and* an `owner_confirmation` evidence record signed by you. An agent literally cannot close an outcome (`domain/completion.ts:100-111`).

**⑨ Supervision — the master.** Each stream has a long-lived supervisor agent, woken by three triggers: mailbox messages, `task_settled` (something finished), and a daily 06:00Z schedule. Concurrency is guaranteed by construction: its wake lane key `workgraph-master:{org}:{owner}:{stream}` *is* the one-turn-per-stream lock. Its authority is deliberately clipped — the shared prompt envelope forbids it from approving agent-proposed work and from pushing/merging protected refs, and if it wasn't granted the landing tool it is explicitly told "landing runs elsewhere; never merge by hand." Every master turn writes a **receipt** (`RecordMasterAudit`): which wake triggered it, which charter clause it cited, model version, tool calls, resulting diffs, and outcome — that's the "Master activity / Receipts" section in the run view. When it's stuck it **escalates** on a typed discriminant (`public_pr_confirmation` — making a PR public needs your click; `failure_halt` — repeated failures stopped the lane), which becomes a Needs-you card.

---

## 4. What the user actually sees (the UI surface)

All in `packages/claxedo-app/src/features/workgraph/`:

| Screen | What you do there |
|---|---|
| **Home ("Streams")** | Stat strip (Active / Agents working / Needs you) + stream cards grouped by project (grouping = the stream's real execution target — a local dir or repo URL — never invented). Each card previews 4 tasks. "New stream." |
| **Needs-you card → panel** | The attention inbox. Staged tasks lead, grouped per stream with scoped "Approve all staged (N)"; inline Approve / Reject-with-reason; decisions; master escalations; broken-connection fixes; mark-read/clear. |
| **Task rows / stream panel** | Per-task status glyph, inline start/stop/retry, live-run indicator, inline add-task; full task list per stream. |
| **Task dialog** | Detail + latest run + the Activity feed (checkpoint granularity: milestones / progress / detailed) + approve/reject. |
| **Decision dialog** | The agent's question, its options and recommendation, or answer free-text. |
| **Run detail** | Run state, Master activity, Receipts (linked). |
| **Proposal / replacement review** | The admission review: what changed, the proposed plan, **Keep / Replace / Fork**, with the exact server-computed list of tasks a Replace would abandon. |
| **Intake** | "Unorganized AI work" — external issues + idle sessions; Stage or Dismiss. |
| **Settings / notes** | WorkGraph defaults, per-stream charter and settings, stream status+learnings notes. |

---

## 5. Who may do what (the authority model)

This is the part of the design with real teeth, enforced server-side in both backends:

| Action | Agent | You |
|---|---|---|
| Create sources/streams/outcomes/tasks | ✅ but **born Staged** | ✅ born approved |
| Approve / reject work items | ❌ `forbidden` | ✅ |
| Answer / propose decisions | ✅ both | ✅ |
| Record evidence, checkpoints, findings | ✅ | ✅ |
| Complete a run | ✅ (must attach evidence) | — |
| Close an outcome | ❌ (needs your signed confirmation) | ✅ |
| Make a PR public | ❌ (typed escalation to you) | ✅ |
| Merge / land | ❌ unless explicitly granted the landing tool (hosted masters never are) | ✅ |
| Touch provider credentials | ❌ ever (secret-free references only) | — |

Plus the re-approval rule: an agent editing an approved task knocks it back to Staged.

---

## 6. How it's built (the technical architecture)

**Package shape** (`packages/workgraph/src/`): `contracts/` — Zod schemas that *are* the API (38 commands, all reads, all ids); `domain/` — pure functions only: the state machines, completion contracts, landing integrity; `application/` — services (webhook intake, admission, execution placement, session intake); `adapters/` — the two store implementations (SQLite + the Convex functions at repo-root `convex/workgraph*.ts`); `connectors/` — GitHub/Linear/Jira; `http/` — the router; `hosted.ts` — the Cloudflare-hosted wiring.

**One write door.** Every mutation in the product is `POST /api/workgraph/commands` with one of 38 command types (create/update for each entity, the admission verbs, approve/reject, cancel/retry, decisions, evidence, checkpoints, completion, lifecycle/visibility, archive/delete). Each command carries a durable `operationId` — replays are detected in the store, so retries are safe. Everything else is reads: `/snapshot` (the big board read), `/attention`, per-entity detail routes, `/archive`, `/sources`.

**State machines as data.** Transitions are literal lookup tables (`domain/transitions.ts`): work items have 11 states (`pending_approval → pending → active → result_ready/review_needed/integration_needed/verification_failed/failed/blocked/completed/abandoned`), attempts have 7 (`admitted → placing → running → result/attention/failed/cancelled`, where `attention` is recoverable), streams `active ⇄ paused → closed → reopened`, plus an orthogonal `visible ⇄ archived` axis. Notably, *nothing* transitions to `completed` through the table — completion only happens through the evidence-contract gate.

**Event ledger + doorbell.** Every command writes its entity change plus rows to `workgraph_events`/`workgraph_changes` and bumps a per-tenant cursor. Clients hold one SSE stream; on any change they get a contentless "something changed" ping and re-fetch. (The scaling problems with this exact mechanism — cursor-row contention, unbounded snapshot reads, missed-ping staleness — are analyzed in `docs/cf-reliability-scalability-review-2026-07-28.md`, Part A5/B3.)

**Execution drive.** Nothing launches "inline." Commands *nudge* a per-tenant settlement lane (a Durable Object timer on hosted; in-process locally) whose job is: claim launchable items, place attempts, drain intake, process control effects — with a periodic sweep as the backstop. The master has its own per-stream wake lane. (This is the "motion layer" the reliability review found to be the weak half.)

**Dual backend as a design discipline.** The SQLite and Convex stores implement one contract, and the invariants that matter (born-state gate, owner-only verbs, replacement version pins) exist symmetrically in both — which is what makes local/self-host and hosted cloud behave identically at the rules level.

---

## 7. What's deliberately good here (worth protecting)

- **Nothing agent-invented runs without a human click**, enforced at the storage layer, in both backends, with provenance (`created_by_actor_type`, `origin_attempt_id`) for the audit trail.
- **Work is admitted from immutable, hashed revisions with full lineage** — the system can always answer "this task exists because of revision 3 of that issue," and destructive re-imports require you to version-pin exactly what gets destroyed.
- **"Done" is machine-checked**: evidence typed six ways, matched against a per-task contract; outcome closure requires your signature; merges pass a strictness floor charters can raise but not lower.
- **The master is auditable and clipped**: one turn per stream by construction, every turn receipted with the charter clause it acted on, no self-approval, no credential access, draft-first PRs, typed escalations.
- **The whole API is schema-first** (Zod contracts shared by server, app, and MCP tools) with durable idempotency on every mutation.

## 8. Where it's weak

The weaknesses are *not* in this domain model — they're in the delivery mechanics underneath it (how changes propagate, how the drain/sweep scale, identity seams, capacity budgets). That analysis lives in `docs/cf-reliability-scalability-review-2026-07-28.md` (Parts A5, B3, and the six design constraints in the session's design critique). The planned **v2** ("durable work ledger", plan `docs/plans/2026-07-18-004`, Stream/Task/Charter with the evidence layer as the spine) evolves the naming and deepens the evidence system; what this primer describes is what is implemented today.
