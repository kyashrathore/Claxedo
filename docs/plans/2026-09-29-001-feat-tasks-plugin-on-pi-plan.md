# Tasks: a hosted plugin whose runs are Pi sessions

Status: planned, not started. It replaces the native Tasks feature (`@claxedo/tasks` and its app, server and local hosts, 16.3k production lines) in one migration; nothing of the native path survives it.

This plan has three parts:
- **Principles** (§1): the rules every later decision is checked against.
- **PRD** (§2): what users get, the flows and the requirements.
- **HLD** (§3): the components, data, interfaces and failure handling that deliver it.

Phases, done criteria and execution follow in §4–§7.

## 1. Principles

### Product

- **P1. A task is a request plus what has happened since.**
  - Nothing stores a status or a type.
  - What the list shows is computed from facts other owners already hold: runs, pending questions, wakes and results.
  - The only lifecycle fact Tasks stores is the closed record.
- **P2. Capture never runs anything, and nothing repeats until the user accepts a plan.**
  - Saving a request costs nothing and interprets nothing.
  - An agent may propose a schedule, but a repeating wake exists only after the user accepts it.
- **P3. The user can always stop the work without the agent.**
  - Pause, Cancel and Close act on alarms and records directly.
  - They never depend on an agent understanding a message.
- **P4. Irreversible actions need approval, and happen at most once.**
  - Sending, buying, deleting, posting and paying need approval. It is given either in the moment or as a named rule inside the accepted plan.
  - Each irreversible action carries a receipt, so a retried turn never repeats it.
- **P5. One task, one conversation, and the task's folder is its memory.**
  - A wake resumes the task's session; it doesn't start a new one.
  - Facts that must survive compaction word for word live in the task's files.
- **P6. Show the truth.**
  - A run on a machine that can't be reached reads **Unknown**, never a stale **Working**.
  - A wake never falls back to another placement.
  - A failure is shown where the user looks.

### Engineering

- **P7. Hosted only, one implementation.**
  - Tasks exists when the app is signed in to the hosted control plane. A signed-in desktop gets it from hosted.
  - The plugin is the only Tasks, and the native feature is deleted.
- **P8. Layer over harnesses.**
  - A task's own agent is Pi's `AgentHarness`, which owns the loop, compaction, session format and built-in tools.
  - Claxedo implements only Pi's published `Storage`, `ExecutionEnv` and `CredentialStore` interfaces.
  - Code work and work that must spend a Claude plan run Claude Code or Codex on a machine.
- **P9. One session system.**
  - A run is a normal Claxedo session, carried by the runtime-neutral session core (LOC plan `2026-09-29-002`, D16).
  - The app shows it in the normal session view. Tasks adds no second event system.
- **P10. Storage rule (LOC plan D15).**
  - A task's state lives in its own Durable Object.
  - Global D1 holds only list rows and small shared facts.
  - Large files live in R2.
- **P11. The owner's accounts, direct to the provider.**
  - A run spends the task owner's credentials, whoever triggered it.
  - Model requests go straight from the task object to the provider, with no Claxedo proxy in that path.
  - The hosted credential store is the only party that refreshes an OAuth token.
- **P12. Cheap by construction.**
  - Nothing runs while a task is idle.
  - Repeated checks are code in a Dynamic Worker, not agent sessions.
  - Every task has a budget.
- **P13. Measured before promised.** The Durable Object SQLite gate, the facet gate and the real Codex-plan turn run first in their phases, and each can stop the plan.

## 2. PRD

### 2.1 Problem

- **Native Tasks is a to-do list that doesn't move.**
  - Its status is stored, and nothing but a click or an agent's tool call changes it.
  - Its presets and slots are a small workflow engine, built three times (desktop, self-hosted, hosted) on three databases: 16.3k production lines and ~13.7k test lines.
- **Saved prompts and tasks overlap.** Both are text you come back to, and neither knows when its work is done.
- **Users want to hand off work that continues without them:**
  - watch for tickets and stop when two are bought;
  - chase each overdue invoice until it's paid;
  - send a weekly report every Monday.

  Today that needs a person to restart a session every time.

### 2.2 Users and the kinds of work

**First release:** a single signed-in person who works with coding agents and also hands off errands. Teams come later (§2.11).

The six kinds of work come from the Sept 20 research's 60 real use cases. None of them is a stored type; each is recognised from facts, as §2.6 shows:

| Kind | What it is | Examples |
|---|---|---|
| One-off job | Do it, maybe ask once, done | Tailor a CV; research startups into notes; fix a flaky test |
| Errand that waits | One goal that pauses for someone else and resumes | Warranty claim waiting on the manufacturer; clinic voicemail → booking |
| Watch with a finish line | Checks repeatedly until something happens or a deadline passes | Ticket drop; flight price; flat search until Oct 1 |
| Recurring output | Same job every cycle, a result each time | Weekly revenue report; morning brief |
| Detector | A cheap scan that creates a task per item it finds | Overdue invoices; production errors → draft PRs |
| Project | Several pieces done in order | Research → writing handoff |

### 2.3 Goals and non-goals

**Goals for the first release:**
1. **Capture** a request in two seconds, with no agent involved.
2. **Start it anywhere:**
   - a work run in the cloud, needing no machine;
   - a machine run on any machine the user can reach: local, another enrolled machine, or a cloud sandbox.
3. **Accept or reject the agent's plan.** It proposes the finish condition, the wakes and the rules for irreversible actions.
4. **Keep going without clients.** Wakes, checks and deadlines run with every app closed.
5. **See what needs you at a glance**, and answer it inline.
6. **Spend the owner's Codex plan for work runs.** A Claude plan is spent by starting Claude Code on a machine.

**Non-goals for the first release:**
- teams, and assigning or sharing tasks. When sharing arrives, it follows the page rule (LOC plan §7.1.2): private to the owner, shared with a person or a team in the org, and outside the org only by a view-only link;
- search across tasks;
- a browser tool that drives websites;
- a bot concept separate from tasks;
- memory shared across tasks;
- local-only (unsigned) Tasks;
- migrating native Tasks data.

### 2.4 Concepts

| Concept | Meaning | Stored by |
|---|---|---|
| **Request** | The user's words and attachments, who asked, when, an optional project and preset | `TaskObject` |
| **Plan** | The finish condition, the wakes, the placement for machine runs and the approval rules, as proposed by the agent and accepted by the user | `TaskObject` |
| **Run** | One execution: a **work run** (a turn of the task's Pi session) or a **machine run** (a linked Claxedo session on a machine) | Pi session and session-core journal (work); the machine's runtime (machine) |
| **Wake** | When the task acts without you: a time, a schedule in a time zone, a deadline, or a watched reply | `TaskObject` alarm schedule |
| **Check** | Agent-written JavaScript that a wake runs before any agent; it reports a change or nothing | The task's files; executed in a Dynamic Worker |
| **Receipt** | The record that an irreversible action happened, keyed so a retry never repeats it | `TaskObject` |
| **Headline** | The agent's one-line progress note | `TaskObject` |
| **Closed record** | Done, dropped or expired, with the reason, who closed it, and evidence | `TaskObject` |
| **Preset** | Reusable how and where: the harness and model for machine runs, the model for work runs, instructions, a default machine | `TasksIndex` |
| **Files** | The task's folder: `GOAL.md`, `NOTES.md`, `ledger/`, `reports/`, `checks/` | `@cloudflare/shell` `Workspace` in the `TaskObject` (SQLite; R2 above its threshold) |
| **Attention** | What the list shows, computed on read (§2.6) | Never stored |

### 2.5 Flows

**A. Capture.**
1. The user presses **N** or **New task**, types the request, and optionally picks a project, attachments and schedule chips.
2. **Save** stores the request only. The row shows **Not started**.
3. Nothing is interpreted and nothing runs.

**B. Start a work run.**
1. The user presses **Start** and picks a preset.
2. The task's session opens with the request as its first message, plus the preset's instructions and the contents of `GOAL.md` and `NOTES.md`.
3. The first turn reads the request, asks anything unclear, and writes `GOAL.md`.
4. It then calls `task.propose_plan`. The plan is a **Needs you** item, and nothing repeats until it is accepted.

**C. Start a machine run.**
1. The user presses **Start**, picks a machine preset, and picks a machine, or accepts the remembered one.
2. The backend asks the platform to start a normal Claxedo session on that placement, with the request as its first message. The run is linked to the task.
3. The agent reads and writes the task's files through the `task.files.*` tools.
4. A Claude-plan preset always takes this path.

**D. Accept a plan.**
1. The plan card lists:
   - the finish condition ("2 tickets bought, or Dec 31");
   - each wake ("daily 09:00 Asia/Kolkata, hourly from Nov 1");
   - where machine runs go;
   - the approval rules ("may spend up to ₹20,000 on tickets without asking").
2. **Accept** writes the plan and schedules the first alarm. **Reject** keeps the task with no wakes.
3. The agent can propose again at any time, and each proposal needs a new acceptance.

**E. Wake.**
1. An alarm fires in the task's object.
2. If the wake has a check, the check runs in a Dynamic Worker against the task's files. "No change" ends the wake, and the Runs tab counts it.
3. On a change, or for a wake without a check, the object resumes the task's session with the wake's message, or starts a machine run on the plan's placement.
4. It then schedules the next alarm.
5. A deadline closes the task as **Expired**.

**F. Needs you.** A pending question, permission request, plan proposal or approval shows in the list and in the drawer's Status tab. The user answers inline, and the answer reaches the run exactly as in any session.

**G. Change a task.**
1. A message typed in the drawer goes to the task's session. It is queued behind a running turn and never interrupts one.
2. The agent changes the plan only through `task.propose_plan`.
3. Pause and Cancel on a wake act on the alarm directly.

**H. Close.**
1. A task closes in one of three ways:
   - the agent calls `task.close` with evidence;
   - the user presses **Close as done** or **Drop**;
   - a deadline expires.
2. A closed task folds away and stays readable, and the user can reopen it.

**I. Detector children.**
1. A run calls `task.create` for each item it finds.
2. Each child is a task with its own session, files and wakes, linked to its parent.
3. The parent's Status tab counts children that need you.

**J. Delete and export.**
1. Delete removes the task's object storage, its R2 prefix, its index row and its session list rows.
2. Export downloads the task's files and its transcript as a zip.

### 2.6 What the list shows

The attention level is computed on every read, and the first match wins:

| Shown | Rule |
|---|---|
| **Closed** (done, dropped, expired) | The task has a closed record |
| **Needs you** | A run has a pending question or permission, a plan awaits acceptance, an approval is pending, or a child needs you |
| **Stuck** | The latest run failed, a check threw twice in a row, or the budget is spent, and no wake is set |
| **Working** | A run is mid-turn; **Unknown** when its machine can't be reached |
| **Waiting** | A wake is set: "Next check 09:00 · ends Oct 1" |
| **Not started** | No run and no wake |

The kind of work shows in the row's secondary text, from facts, never from a field:

| Facts | The row says |
|---|---|
| no wake | "One-off" |
| a watched reply on the same work | "Waiting on <who>" |
| a repeating wake and a finish condition | "Watch · until <condition>" |
| a repeating wake and no finish | "Every <schedule>" |
| a repeating wake that creates children | "Detector · N open" |

### 2.7 Requirements

**Capture and start:**
- FR-1. Saving a request writes one index row and one task object, and starts no model call.
- FR-2. Start lets the user choose a preset. For a machine run, it also offers every machine and cloud workspace the user can reach, with each one's reachability shown.
- FR-3. A Claude-plan preset can only be a machine-run preset.
- FR-4. A task can exist without a project.

**Plans, wakes and checks:**
- FR-5. No repeating wake exists before a plan is accepted. A test proves that a proposed but unaccepted schedule fires nothing.
- FR-6. Schedules are stored with an IANA time zone and computed across daylight-saving changes. A missed wake runs once on recovery, however many were missed.
- FR-7. A check has a time budget, a memory limit and an outbound host allowlist. A check that reports no change starts no run. A check that throws is shown on the task and retried at the next wake. Two failures in a row make the task **Stuck**.
- FR-8. Pause and Cancel on a wake take effect without any model call.

**Runs:**
- FR-9. A wake resumes the same session. A new session starts only when the user asks for one, when the run moves to another harness (a machine run), or when Pi reports that compaction can't continue.
- FR-10. A message sent during a running turn is queued (Pi's follow-up), never dropped.

**Approvals and budgets:**
- FR-11. Irreversible tool calls are classified by kind. Each needs an approval or an accepted plan rule that covers it, and records a receipt before its side effect is confirmed.
- FR-12. Each task has a budget in tokens and in wakes per day. Crossing it pauses the wakes and shows **Stuck · budget reached**.

**Tools and files:**
- FR-13. The task tools are `task.get`, `task.note`, `task.propose_plan`, `task.close`, `task.create`, `task.files.list`, `task.files.read` and `task.files.write`. The same tools are served to Pi in-process and to machine sessions through Claxedo MCP.
- FR-14. A task's files never contain a credential. A write that matches a known secret shape is refused with a typed error.

**Delete and export:**
- FR-15. Delete and export behave as in flow J.

**Non-functional requirements:**

| Area | Requirement |
|---|---|
| Capture latency | Save is acknowledged in ≤ 300 ms p95 from the hosted Worker |
| Start latency | First streamed token of a work run in ≤ 3 s p95 plus the model's own latency |
| Wake precision | An alarm fires within 60 s of its due time |
| Idle cost | An idle task costs storage only, with no compute |
| Cost at scale | ≤ $0.30 of Cloudflare cost per active user per month at the §3.12 usage |
| Isolation | No request, check or run of one organization can read another's data; no task can read another task's files |
| Durability | An accepted plan, a receipt and a closed record survive eviction, deploys and crashes |
| Availability | A failed wake is visible on the task within one wake interval; nothing fails silently |

### 2.8 Interface

**The Tasks page.**
- The list is grouped by attention, in the order of §2.6. Each group label says why a task is in it.
- Closed tasks are folded at the bottom.
- A row shows:
  - the request's first line;
  - the headline;
  - the secondary text from §2.6;
  - on the right, in small monospace, the next wake or the machine.
- **N** or **New task** opens the New task dialog.
- Phone (390 px): the list is full width, the drawer is a sheet, and every control is at least 44 px.

**The drawer.**
- **Header:** the project, the title, and one status line, for example "● Needs you · tickets found and held for 9 minutes".
- **Tabs,** as in the reviewed prototype `~/test/claxedo-prototypes/tasks-requests.html`:

| Tab | Shows |
|---|---|
| **Status** | Waiting on you, with inline answers; a failed run with Retry; tasks it created; Next (upcoming wakes and deadlines); Progress (a headline per run) |
| **About** | The request (editable); how it finishes; when it wakes (each wake with Pause and Cancel); runs with (preset, machine, project, creator). For a task not yet started, **Start** lives here. |
| **Runs** | Agent runs, each with **Open session**. A toggle shows the checks too: "412 checks · 3 woke the agent". |
| **Results** | Delivered (what reached the outside world, with receipts) and Files (the task's folder) |

- **Footer:** the "Tell this task…" box, **Close as done** and **Drop**.
- A new drawer opens on **Status**, or on **About** for a task not yet started. A tab the user picks stays picked across tasks.

**The New task dialog.**
- Save only records the request.
- **Start now** reveals the preset and machine choices.
- Schedule chips ("Every Monday 10:00", "Until Oct 1") set simple wakes without a planning run. The first run still proposes any change to them.

### 2.9 Success metrics

- **Hand-off:** at least 30% of active users have a task with an accepted repeating wake after 4 weeks.
- **Trust:** zero duplicated irreversible actions. Every receipt conflict is an incident.
- **Attention:** the median time from Needs you to the user's answer is under 2 hours, measured per task.
- **Cost:** the §2.7 cost target holds on the staging dashboard at 1,000 simulated users.
- **Quality:** on the evaluation set of 20 real tasks, work runs on the Codex plan finish at least 80% as often as Claude Code on a machine (P13; §6.4).

### 2.10 Release scope

| Release | Contains |
|---|---|
| **v1** | Capture; work runs and machine runs; plan acceptance; time wakes (at, schedule, deadline); checks; approvals and receipts; budgets; close and reopen; the list and the tabbed drawer; delete and export; Codex plan and API keys |
| **v1.1** | Reply wakes (email in and webhooks); notifications by email and push; detector children with parent roll-up; the web search and fetch tool |
| **Later** | Teams and shared tasks; search across tasks; a browser tool with human takeover; memory shared across tasks |

### 2.11 Decisions (recommended defaults)

1. **Who closes a task:** the agent (with evidence) or the user, and the user can reopen. *Default: both.*
2. **Detector finds:** they become child tasks. *Default: yes.*
3. **Presets vs bots:** a preset is how and where to run; a standing responsibility is a task with a repeating wake. *Default: no separate bot.*
4. **Memory:** a task's memory is its own files. *Default: nothing shared across tasks in v1.*
5. **Plugin UI:** today's plugin API, in the app's JavaScript. *Default: yes; revisit when `2026-09-25-001` ships.*
6. **Machine placement:** ask on the first machine run, and remember it per preset. *Default: yes.*
7. **Missed wakes:** run once on recovery. *Default: yes.*
8. **A message during a turn:** queue it, never steer. *Default: queue.*
9. **Task sessions in the rail:** open from Tasks only, not listed in the project rail. *Default: Tasks only.*
10. **Notifications:** in-app and desktop notifications in v1, with email and push in v1.1. *Default: yes.*
11. **Budgets:** on by default, at 200k tokens and 48 wakes a day per task, editable. *Default: yes.*
12. **Teams:** single owner in v1, and sharing later follows the page rule. *Default: yes.*

## 3. HLD

### 3.1 Architecture

```
App (web, or signed desktop through Electron main)
  └─ Tasks plugin app (plugins/tasks/app)
       │  plugin.request(pluginId, path, body)   — web: same-origin HTTP; desktop: hosted operation through main
       ▼
Hosted Worker (claxedo-server)
  ├─ Plugin-backend platform (src/plugin-backends/)
  │    ├─ Loader: Worker Loader binding, loads plugins/tasks/backend by content hash, one per organization
  │    ├─ Supervisor Durable Object: authenticates the caller, checks the manifest route, scopes every id to the organization
  │    └─ Platform API as RPC stubs: sessions.start/status, placements.list, credentials.access, notify, sessions.register
  ├─ LiveSyncRoom (existing): fans task events to /api/cp/events for web SSE and desktop stream IPC
  └─ Session reads (existing routes): outline/page/part for a task session are served by its TaskObject
       ▼
Tasks backend (Dynamic Worker, per organization)
  ├─ TasksIndex (Durable Object, one per organization): list rows, presets, attention inputs
  └─ TaskObject (Durable Object, one per task): request, plan, receipts, alarms, Workspace, session-core, Pi AgentHarness
         ├─ Pi in-process transport → session-core journal → the same frames any session emits
         ├─ execute tool / checks → Dynamic Worker with state.* and git.*, outbound allowlist
         └─ model calls → provider directly, with the owner's token from credentials.access
Machines (local, enrolled, cloud sandbox)
  └─ machine runs: normal Claxedo sessions started by sessions.start; task tools through Claxedo MCP
```

### 3.2 Components and owners

| Component | Package / path | Owns |
|---|---|---|
| Tasks plugin app | `plugins/tasks/app/` | The list, the drawer, the New task dialog, preset settings |
| Tasks backend entry | `plugins/tasks/backend/index.ts` | Routes the platform forwards; the Durable Object class exports |
| `TasksIndex` | `plugins/tasks/backend/index-object.ts` | List rows, presets, attention inputs pushed by task objects |
| `TaskObject` | `plugins/tasks/backend/task-object/` | One task: request, plan, wakes, receipts, budget, closed record, files, session |
| Pi adapters | `plugins/tasks/backend/pi/` | `storage.ts` (Pi `Storage` over the object's SQLite), `environment.ts` (`ExecutionEnv` over the `Workspace`), `credentials.ts` (`CredentialStore` over `credentials.access`), `execute.ts` (the `execute` tool) |
| Task tools | `plugins/tasks/tools/` | One declaration of the eight task tools, served in-process to Pi and through Claxedo MCP |
| Plugin-backend platform | `claxedo-server/src/plugin-backends/` | Manifest check, loader, supervisor, facets or namespaced ids, platform API |
| Manifest schema | `claxedo-plugin-api` | `claxedo.backend` and the tools a plugin serves |
| Desktop path | `account-contract`, `claxedo-desktop/src/main/account/` | The `plugin.request` hosted operation |
| MCP bridge | `claxedo-mcp/src/plugins/` | Plugin-declared tools for sessions whose owner has the plugin enabled |
| Session core | `packages/session-core` (LOC plan Phase 3) | The store, journal, projection, broker ports and session routes the `TaskObject` hosts |

### 3.3 The plugin-backend platform

**The manifest.**
- `claxedo.backend` gives the entry module, the Durable Object classes, the allowed outbound hosts, and the tools the plugin serves.
- It is validated at install and at activation, and `app_plugin.check` covers it.

**The loader.**
- The hosted Worker binds a Worker Loader and loads a backend by content hash from the R2 artifact bucket that plugin artifacts already use.
- There is one load per plugin version per organization. After Cloudflare's beta, each unique Worker costs $0.002 per day.

**The supervisor.**
- It authenticates the caller: a signed user, or a session's user-scoped credential from Claxedo MCP.
- It checks that the route is in the manifest and that the caller belongs to the organization with the plugin enabled.
- It forwards to the plugin's objects, with ids built only inside the caller's organization. It uses the one `Principal`/`may()` path from the LOC plan (D1, D2).

**Storage.**
- **Preferred:** the plugin's classes run as facets of the supervisor, keyed by organization.
- **Gate:** 50 task facets under one organization must run Pi turns concurrently within memory. If they can't, `TaskObject` becomes a top-level namespace with ids `org:task`, and only the supervisor's stub factory can mint them.

**The platform API**, passed to the backend as RPC stubs:

| Call | Does |
|---|---|
| `sessions.start(placement, { firstMessage, preset, taskId })` | Starts a Claxedo session on a machine or cloud workspace the owner can reach; returns its `SessionRef` |
| `sessions.status(refs)`, `sessions.subscribe(refs)` | Running, waiting for input, failed, idle, unreachable, for linked machine runs |
| `sessions.register(ref, row)` | Writes a task session's list row (title, status, last turn) into D1 |
| `placements.list(user)` | The machines and cloud workspaces the user can reach, with reachability |
| `credentials.access(owner, provider)` | A current access token for the owner, refreshed only by the hosted credential store, single-flight |
| `notify(user, message)` | An in-app and desktop notification (v1); email and push in v1.1 |

**The desktop path.** `plugin.request(pluginId, path, body)` is one new hosted operation in `@claxedo/account-contract`, crossing Electron main. An unsigned app has no route to it.

**MCP.** Claxedo MCP serves the plugin's declared tools to a machine session whose owner has the plugin enabled. It forwards each call to the supervisor with the session's user-scoped credential.

### 3.4 Inside a `TaskObject`

**The session.**
- The object hosts session-core with Durable Object ports:
  - SQLite over `ctx.storage.sql` with `transactionSync`;
  - a single-task placement;
  - an instance-owned event hub;
  - no document hydration hook.
- Pi's `AgentHarness` runs in-process as a harness transport. Its events go through the Pi translator that the `pi-rpc` transport already uses, so the journal and frames are identical to any Pi session.
- **Two records, two owners:**
  - Pi's session storage owns the model conversation.
  - The session-core journal owns what clients read.
- One session per task, resumed by every wake (FR-9).

**Files.**
- The files are an `@cloudflare/shell` `Workspace` in the object's SQLite, with large files in R2 under `tasks/<org>/<task>/`.
- `GOAL.md` and `NOTES.md` load into every run's context.
- Pi's `read`, `write` and `edit` tools run over the `Workspace` through `environment.ts`. `exec` answers `shell_unavailable`.

**The `execute` tool and checks.**
- Model-written and check JavaScript runs through `@cloudflare/codemode`'s `DynamicWorkerExecutor` with `stateTools(workspace)` and `gitTools(workspace)`.
- Limits: a time budget, a memory limit, and an outbound allowlist from the plan's approved hosts.

**Wakes.**
- There is one alarm per object, set to the earliest due wake.
- An alarm handler:
  1. marks the wake fired;
  2. runs its check;
  3. resumes the session or starts a machine run;
  4. computes the next due time in the wake's IANA time zone;
  5. sets the next alarm.
- Alarms are at-least-once. Each firing has an id and is recorded, so a repeated firing is a no-op.

**Receipts.**
- Before an irreversible tool call runs, the object records a receipt keyed by (task, action kind, target, idempotency key) as pending.
- The side effect is performed with that key, and the receipt is marked done.
- A retried turn that finds a receipt already done returns its result without acting again.

**The budget meter.** It sums the token usage reported by each turn and counts wakes per day. It stops the wakes at the limit (FR-12).

**Attention inputs.** After every state change, the object pushes one compact row to `TasksIndex`: open requests, whether a turn is live, last run failed, next wake, closed, children needing you. The list computes attention from these rows; nothing stores a status.

### 3.5 Data model

**`TasksIndex` (per organization, SQLite):**
- `tasks(task_id, owner_id, project_id?, title, created_at, updated_at, closed_kind?, closed_at?)`
- `attention_inputs(task_id, needs_you_count, live_turn, last_run_failed, next_wake_at?, children_needing_you)`
- `presets(preset_id, owner_id, name, run_kind, harness?, model, instructions, default_placement?)`

**`TaskObject` (per task, SQLite):**
- `request(text, attachments_json, created_by, created_at)`
- `plan(version, finish_condition?, placement?, approval_rules_json, proposed_at, accepted_at?, accepted_by?)`
- `wakes(wake_id, kind at|schedule|deadline|reply, spec_json, time_zone, next_due_at, paused, check_path?)`
- `firings(firing_id, wake_id, due_at, fired_at, outcome no_change|ran|failed|skipped_budget)`
- `receipts(receipt_key, kind, target, state pending|done|failed, result_json, created_at)`
- `runs(run_id, kind work|machine, session_ref, started_at, ended_at?, outcome?)`
- `budget(day, tokens, wakes)`
- `closed(kind, reason, evidence_json, closed_by, closed_at)`
- `headline(text, updated_at)`
- `children(child_task_id)`
- Pi `Storage` tables, session-core tables (a namespace agreed in Phase 1), and the `Workspace` tables.

**Global D1:** only the session list rows written by `sessions.register`, and plugin activation and configuration. No task body, file or transcript.

### 3.6 Key sequences

**Start a work run.**
1. The app sends `plugin.request("tasks", "POST /tasks/:id/start", { presetId })`.
2. The supervisor authenticates the caller and checks the route.
3. `TasksIndex` confirms the owner and forwards to the `TaskObject`.
4. The `TaskObject`:
   1. opens its session (session-core);
   2. registers the list row;
   3. builds Pi's context from `GOAL.md` and `NOTES.md`;
   4. gets the owner's Codex token from `credentials.access`;
   5. runs the turn.
5. Frames stream to the owner's `LiveSyncRoom`, and from there to `/api/cp/events` on web and desktop.

**Wake with a check.**
1. The alarm fires, and the object records a firing.
2. The check runs in a Dynamic Worker.
3. **No change:** the firing records `no_change`, the next alarm is set, and nothing else happens.
4. **Change:** the object resumes the session with the check's report as the message.

**Machine run.**
1. The `TaskObject` calls `sessions.start(plan.placement, …)` and records the run.
2. `sessions.subscribe` feeds the run's status into the attention inputs.
3. **The machine is offline:** the run shows **Unknown** and the wake waits ("Waiting for MacBook Pro"), never moving elsewhere (P6).

**Irreversible action.**
1. A tool call is classified as `buy`.
2. The object checks the accepted plan's rules.
   - **Covered:** it proceeds with a receipt.
   - **Not covered:** it raises a permission request. The task shows **Needs you**, and the turn waits.

**Read a task session.**
1. The app opens the run through the normal session view.
2. Outline, page and part requests for a session registered as a task session are forwarded by the hosted routes to its `TaskObject`, which answers from session-core.

### 3.7 Interfaces

**Backend routes** (behind `plugin.request`):

| Method and path | Purpose |
|---|---|
| `GET /tasks`, `GET /tasks/:id` | List rows and one task's detail |
| `POST /tasks` | Capture |
| `POST /tasks/:id/start` | Start a work or machine run |
| `POST /tasks/:id/messages` | A message to the task's session |
| `POST /tasks/:id/plan/:version/accept` and `/reject` | Answer a plan proposal |
| `POST /tasks/:id/wakes/:wakeId/pause`, `/resume`, `/cancel` | Direct wake control |
| `POST /tasks/:id/close`, `/reopen` | Closing |
| `DELETE /tasks/:id` | Delete |
| `GET /tasks/:id/export` | Export |
| `GET /tasks/:id/files/*`, `GET /tasks/:id/runs` | Files and runs |
| `GET /presets`, `PUT /presets/:id`, `DELETE /presets/:id` | Presets |

**Task tools.** Their schemas are declared once in `plugins/tasks/tools/`:

| Tool | Input | Effect |
|---|---|---|
| `task.get` | — | The request, plan, wakes, headline and children |
| `task.note` | `text` | Sets the headline |
| `task.propose_plan` | finish condition, wakes, placement, approval rules | Creates a plan proposal; Needs you |
| `task.close` | kind, reason, evidence | Writes the closed record |
| `task.create` | request, optional project and preset | Creates a child task |
| `task.files.list`, `task.files.read`, `task.files.write` | path, content | The task's files, with the secret-shape refusal |

### 3.8 Security and isolation

- **Loading:** one Dynamic Worker per organization, holding only that organization's stubs.
- **Ids:** only the supervisor mints object ids, and only inside the caller's organization.
- **Callers:** every request carries a signed user or a session's user-scoped credential. The supervisor checks membership, plugin activation and route.
- **Credentials:**
  - They are fetched per call through `credentials.access` for the task owner, and never stored in task files or Pi's session.
  - The object holds no refresh token; the hosted credential store is the only refresher.
- **Checks and `execute`:** they run in a separate Dynamic Worker with only `state.*` and `git.*` capabilities, an outbound allowlist, and time and memory limits.
- **Web content:**
  - Untrusted content can't grant itself permission. An irreversible action needs an approval or a plan rule the user accepted, whatever the content says.
  - Tool results from the web are marked as untrusted in the context.
- **Files:** a write matching a known secret shape is refused (FR-14).
- **Privacy:** a task is private to its owner, even inside its project. Project access (owner, member grant, team grant, org role) doesn't reach it.
- **Deletion:** removes every trace (flow J).

### 3.9 Reliability

| Event | Handling |
|---|---|
| Eviction or deploy mid-turn | Pi's open operations resume or seal the turn on the next request or alarm. Receipts make a replayed irreversible action a no-op. |
| Alarm fires twice | The firing id is already recorded, so the second firing is a no-op |
| Missed wakes during an outage | One catch-up firing; the rest are recorded as skipped |
| Check throws | Recorded on the task and retried next wake; two in a row make it **Stuck** |
| Machine unreachable | The run shows **Unknown** and the wake waits; no fallback placement |
| Token refresh race | `credentials.access` is single-flight in the hosted store: one refresh, both callers get the new token |
| Budget reached | Wakes pause; **Stuck · budget reached**; the user raises the budget or closes the task |
| Durable Object memory pressure | One task per object; large files move to R2; Phase 1 measures memory per turn |

### 3.10 Cost

Estimated from Cloudflare's published prices; the unit durations are assumed, not measured:

| Unit | Cost |
|---|---|
| Pi turn (60 s wall time, 128 MB) | ~$0.00015 |
| Check (2 s wall time, one alarm) | ~$0.000004 |
| A distinct check script's daily load (after the beta) | $0.002 per day |
| 1 MB of task files | $0.0002 per month |
| For comparison: a sandbox machine run of 15 minutes | $0.01–0.02 |

**Per active user:** 150 turns, two watches every 10 minutes, one daily report and 30 MB of files come to **~$0.25 per month**. Model tokens are extra and go on the owner's plan or key.

**Unpriced:** browser rendering, and the load fee once the Dynamic Workers beta ends (the largest line at scale).

### 3.11 Observability and operations

- **Per task:** the `firings`, `runs` and `receipts` tables are the event log the Runs tab reads.
- **Admin view** (operators only, through the supervisor): a task's object state, next alarm, budget, and last errors.
- **Metrics:** alarms fired, fire lag, check outcomes, turn duration, memory per turn, refreshes, receipt conflicts, and cost per organization.
- **Kill switch:** deactivating the plugin for an organization stops its alarms at the next firing and refuses its routes.

### 3.12 Testing

- **Pi storage:** `storage.ts` passes Pi's `createStorageConformance` on the object's SQLite under workerd.
- **Session core:** the session-core store suite passes on Durable Object SQLite (LOC plan Phase 3).
- **Backend:** runs on local workerd with a scripted model for every flow in §2.5, including eviction mid-turn, a double alarm, a missed wake, receipt replay, and budget exhaustion.
- **App e2e** (the app's rules: a real stack, one spec per flow, a recorded red run, 20 runs in a row):
  - capture → start work run → propose plan → accept → wake → check → close;
  - machine run on a local machine;
  - detector with two children;
  - pause and cancel without an agent;
  - delete.
- **Evaluation set:** 20 real tasks, run on the Codex plan in Pi and on Claude Code on a machine, and scored for completion.

## 4. Dependencies

| Needs | From | Blocks |
|---|---|---|
| Runtime-neutral session core (store port with `transaction(fn)`, instance-owned hub) | LOC plan Phase 3 | Phase 3 here (runs as sessions) |
| Turn row and one journal sequence | LOC plan Phase 3 | Phase 3 here, so the recovery ledger never ships into objects |
| Org membership, teams and the canonical project-role query | LOC plan Phase 1A | The supervisor's organization check (Phase 2 here) |
| `Principal` and `may()` | LOC plan Phase 5 | The supervisor (Phase 2 here) |
| Transcripts off D1, session list rows only | LOC plan Phase 2 | `sessions.register` (Phase 2 here) |
| Native Tasks deletion | this plan, Phase 5 | LOC plan's control-plane and app targets |

## 5. Phases

Each phase ends only when its criteria pass through real entry points. Tests exercise the implementation, never a fake that agrees with itself.

### Phase 1: Pi work run in a Durable Object (no platform yet)

A standalone Worker in `plugins/tasks/backend` proves one `TaskObject` end to end.

- [ ] `storage.ts` passes `createStorageConformance` on the object's SQLite under workerd. Progress:
- [ ] `environment.ts`: Pi's `read`, `write` and `edit` pass a suite that writes, edits, reads back in a later request, and finds nothing from another task's object. Progress:
- [ ] `execute.ts` runs in a Dynamic Worker:
  - it reads and writes task files through `state.*`;
  - a fetch to a host outside the allowlist is blocked;
  - an over-budget script is stopped.

  Progress:
- [ ] `gitTools` shallow-clones a public repository into the `Workspace`. Progress:
- [ ] **Gate:** a real Codex-plan turn from workerd with a stored login streams an answer after a tool call. An expired token is refreshed through `credentials.ts` without the object holding the refresh token. Progress:
- [ ] Eviction mid-turn resumes or seals the turn through Pi's open operations, verified by the session entries. Progress:
- [ ] Measured and recorded in the plugin README: cold object start, first token, memory per object during a 20-tool-call turn, bundle size. Progress:
- [ ] Exit gate: all of the above on local workerd **and** in a deployed staging Worker. Progress:

### Phase 2: Plugin-backend platform

- [ ] The `claxedo.backend` manifest: schema, validation, `app_plugin.check`. Progress:
- [ ] Loader by content hash, cached per organization. Progress:
- [ ] Supervisor:
  - a request with no credential, another organization's credential, or a route outside the manifest is refused;
  - a valid request reaches the object;
  - it uses the one `Principal`/`may()` path.

  Progress:
- [ ] **Gate:** facets, or the `org:task` namespace. 50 task objects under one organization run Pi turns concurrently within memory, each with its own SQLite and alarms. If facets fail, the namespace fallback is built and recorded. Progress:
- [ ] Platform API: `sessions.start` on a local machine, another enrolled machine and a cloud sandbox; `sessions.status`/`subscribe` report all five states; `sessions.register` writes list rows. Progress:
- [ ] `credentials.access`: two concurrent refreshes produce one refresh, and both callers get the new token. Progress:
- [ ] `plugin.request` from a signed desktop through Electron main works, and an unsigned app has no route. Progress:
- [ ] Claxedo MCP serves plugin tools to the plugin user's machine session and refuses another user's session. Progress:
- [ ] A trivial counter plugin with a backend exercises every item above end to end. Progress:

### Phase 3: Tasks backend

- [ ] `TasksIndex` and `TaskObject` storage and commands, with a state-machine test for each row of §2.6. Progress:
- [ ] Task runs are session-core sessions: the transcript opens in the normal session view, live frames arrive through `/api/cp/events`, and outline/page/part reads are served by the object. Progress:
- [ ] Wakes: schedules with time zones across a daylight-saving change, deadlines closing as Expired, one catch-up firing after an outage, a double firing as a no-op. Progress:
- [ ] Checks: no change starts no run; a change resumes the session; a throw is shown and retried; two throws make the task **Stuck**. Progress:
- [ ] Plan acceptance: no wake fires before acceptance, and rejecting leaves no wakes. Progress:
- [ ] Receipts: a replayed turn after eviction doesn't repeat an irreversible action, and a plan rule covers exactly what it names. Progress:
- [ ] Budgets: crossing a limit pauses wakes and shows **Stuck · budget reached**. Progress:
- [ ] Machine runs: a started session is linked; its status drives Needs you, Working and Stuck; an unreachable machine shows Unknown. Progress:
- [ ] The owner's accounts: a run triggered by anyone spends the task owner's credential. Progress:
- [ ] Delete removes object storage, R2, index and list rows; export produces the zip. Progress:

### Phase 4: Tasks app

- [ ] The list grouped by attention, with the rules shown, the closed fold and the secondary kind text. Progress:
- [ ] The drawer: Status, About, Runs and Results, with the tab persistence rules of §2.8. Progress:
- [ ] New task saves without running. Start now opens the preset and machine choices. Schedule chips create wakes. Progress:
- [ ] Every Needs-you item answers inline and matches the backend's state after reload. Progress:
- [ ] Phone layout at 390 px (flow 33 extended). Progress:
- [ ] The e2e flows of §3.12, each with a recorded red run and 20 runs in a row. Progress:

### Phase 5: Remove the native Tasks feature

- [ ] Deleted:
  - `packages/claxedo-tasks`;
  - `claxedo-app/src/tasks` and `src/server/tasks.ts`;
  - `claxedo-server-core/src/tasks-host` and `claxedo-server/src/tasks`;
  - `claxedo-local-server/src/tasks`;
  - `claxedo-mcp/src/tools/tasks.ts`;
  - `hosts/workspace-runtime/tasks-grant.ts` and `hosted-workerd/tasks-contributions.ts`;
  - the Tasks SQLite and D1 migrations, and their tests.

  Progress:
- [ ] Removed from shared files:
  - the Tasks grants in `local-app.ts`, `agent-plugins/hosted-composition.ts`, `cloud-root-environment.ts` and `workspace-runtime/env.ts`;
  - the built-in `tasks` tool group;
  - `registry.ts` and the rail page.

  Progress:
- [ ] `encodeAttachmentData` moves to its remaining owner (`plugins/bindings/data.ts`) before the package goes. Progress:
- [ ] A repository search finds no `@claxedo/tasks`, `tasks-host`, `TASKS_CAPABILITY`, `BUILTIN_TASKS_TOOL_GROUP` or `WORKSPACE_RUNTIME_TASKS_` outside this plan. Progress:

## 6. Risks and open questions

1. **Durable Object limits.** Memory is 128 MB per object, CPU time per request is capped, and every deploy interrupts a running turn. Phase 1 measures a realistic turn; receipts cover the replay.
2. **At-least-once everywhere.** Pi's recovery, alarms and retries can repeat work. Receipts and firing ids are the design answer. A receipt conflict is an incident (§2.9).
3. **Codex login refresh.** OpenAI rotates refresh tokens. The hosted store needs its own Codex login, not a copy of the laptop's, and must be the only refresher, or one device signs the other out.
4. **Quality of work runs.** Pi on the Codex plan may complete less than Claude Code. The evaluation set measures it before v1 ships, and a preset can always choose a machine run.
5. **Young dependencies.** `@cloudflare/shell` is experimental, Dynamic Workers is in beta, and Pi moves quickly (0.85.1 pinned, 0.87.1 out). Versions are pinned, and an upgrade gate runs Pi's conformance suite and the backend suite.
6. **Websites that block agents.** Ticket and shopping sites use bot protection. v1 has no browser tool, and "you take over this step" arrives with it (later).
7. **Untrusted content.** A page tells the agent to email someone. The approval rules by action kind are the defense, not the model's judgment.
8. **Lost notifications.** A watch that fires at 3 a.m. is useless if nobody hears it. v1 has only in-app and desktop notifications, so email and push are the first v1.1 item.
9. **Facets.** If facets can't host concurrent Pi turns, the `org:task` namespace replaces them (the Phase 2 gate).
10. **Load fees after the beta.** The Dynamic Worker load fee is the largest cost line at scale. Check scripts that share code count once per day, so the platform should reuse loads where it can.

## 7. Definition of done

- [ ] A signed-in user on the web and on the desktop captures, starts, watches, answers and closes tasks through the Tasks plugin. An unsigned desktop shows no Tasks.
- [ ] A work run on the owner's Codex plan completes in the task's object with its files persisted. A Claude-plan preset starts Claude Code on a machine.
- [ ] Wakes, checks and deadlines run with every client closed, and a repeated alarm or turn repeats no irreversible action.
- [ ] No status or type is stored anywhere in the Tasks backend.
- [ ] Task runs open in the normal session view, from session-core in the task's object.
- [ ] The native Tasks feature is gone (Phase 5), and `bun run test:architecture-ratchets`, typecheck and the affected packages' tests pass on the merge tip.
- [ ] The plugin's README describes the architecture in present tense, and this plan is deleted from `docs/plans`.

## 8. Execution

Run phases as parallel lanes with disjoint file ownership. Each lane is an Opus agent in its own worktree, and the orchestrator reviews each lane's diff on the merge tip before merging.

| Lane | Owns | Starts |
|---|---|---|
| Pi runtime | `plugins/tasks/backend/pi/**` | Phase 1, immediately |
| Platform: loader, supervisor, storage | `claxedo-server/src/plugin-backends/**`, hosted Worker config | Phase 2, immediately; the supervisor after `Principal`/`may()` |
| Platform: desktop and MCP | `account-contract`, `claxedo-desktop/src/main/account/**`, `claxedo-mcp/src/plugins/**` | Phase 2, immediately |
| Tasks backend | `plugins/tasks/backend/**` except `pi/` | After the Phase 1 exit gate and the LOC plan's session-core move |
| Tasks app | `plugins/tasks/app/**` | Against the backend's route contract, in parallel with the backend |
| Removal | the Phase 5 file lists | After Phase 4's e2e flows pass |

The facet gate (Phase 2) and the Codex-plan turn (Phase 1) are the two findings that can change this plan, and both are scheduled first in their lanes.
