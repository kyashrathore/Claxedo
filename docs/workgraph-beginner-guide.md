# WorkGraph Beginner Guide and Test Journey

_For first-time users, product reviewers, and QA testers. Verified against the repository at commit `4ac28b735` on 2026-08-08._

## 1. WorkGraph in plain English

WorkGraph is Claxedo's durable workspace for work done with AI agents. It turns an intent such as “fix issue #101” into organized tasks, agent runs, decisions, evidence, and a permanent record of what happened.

The simplest comparison is an issue tracker where AI agents can do the assigned work. WorkGraph adds controls that an ordinary issue tracker usually does not have:

- agent-proposed work waits for human approval;
- tasks declare what proof is required before they count as complete;
- questions and consequential choices return to the owner as Decisions;
- agent runs, progress, evidence, and supervisory actions remain inspectable;
- work survives app reloads, process restarts, and the end of an agent chat.

WorkGraph is not the agent itself. The selected harness and model perform the work in a local worktree or hosted workspace. WorkGraph owns the plan, state, authority, history, and proof around that execution.

It is also not a replacement for GitHub, Linear, or Jira. Those systems remain authoritative for their issues. WorkGraph adds a personal execution layer over selected external work.

## 2. The five records to understand first

```text
Project
  └─ Stream
      ├─ Outcome (optional)
      │   └─ Task
      │       └─ Run
      └─ Task without an Outcome
```

| Term        | Meaning                                                                                                      | Example                             |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| **Project** | A UI grouping derived from a Stream's actual repository or local directory.                                  | `claxedo`                           |
| **Stream**  | A durable initiative with its own execution target, settings, charter, history, and supervisor.              | “Ship account recovery”             |
| **Outcome** | An optional goal that groups Tasks and carries success criteria.                                             | “Recovery flow is production-ready” |
| **Task**    | One concrete unit of work. The service contract calls it a Work Item.                                        | “Add recovery token expiry tests”   |
| **Run**     | One numbered execution attempt for a Task. Retrying creates another Run; it does not erase the previous one. | Run #2                              |

Other important terms:

- **Work Source** — the exact, immutable text from which work was planned, such as an issue body or pasted brief. Revisions are hashed so the system can prove which version produced the plan.
- **Needs you** — the human inbox for approvals, Decisions, failed work, proposals, configuration problems, and discovered work.
- **Decision** — a question that can block only the affected Tasks until the owner answers it.
- **Evidence** — typed proof attached to a Task, Outcome, or Stream. Examples include a test result, artifact, review, integration result, owner confirmation, or finding.
- **Completion contract** — the evidence requirements a Task must satisfy. A successful agent process alone does not necessarily complete the Task.
- **Master** — the long-lived supervisor for a Stream. Its status, actions, and audit receipts are visible, but it cannot approve its own proposed work.
- **Staged** — work proposed by an agent and waiting for owner approval. Owner-created Tasks are approved immediately unless deliberately saved as Drafts.

## 3. The normal user journey

```text
Configure execution
  → create a Stream
  → add or admit Tasks
  → WorkGraph launches ready, approved work
  → inspect progress and answer anything in Needs you
  → verify evidence and result
  → preserve, pause, close, or delete the Stream
```

### Step 1: Configure WorkGraph

Open **WorkGraph settings** and choose the default harness, agent, provider, model, effort, and allowed Connections. These defaults flow into Streams unless a Stream overrides them.

Settings are populated from a short-lived capability catalog reported by the server. If the catalog is unavailable or expired, WorkGraph blocks the save and shows the real error instead of inventing fallback choices.

### Step 2: Create a Stream

Select **New stream**, then provide:

- a title and optional description;
- a local Git project directory or hosted GitHub repository;
- the base revision from which its workspace should be created.

The Stream owns this execution target. The home screen groups Streams under Projects derived from that real target.

### Step 3: Add work

Use **Add task** on the Stream card or its **Tasks** panel. A simple inline Task gets an owner-confirmation completion requirement.

Work can also enter WorkGraph through:

- the Task Composer, including a Draft that is launched later with **Arm**;
- a Work Source planning proposal;
- GitHub, Linear, or Jira issue-source filters;
- meaningful AI sessions started outside WorkGraph;
- an agent creating necessary follow-up work during a Run.

### Step 4: Let ready work launch

There is no normal **Run** button for an already approved, ready Task. Active Streams automatically admit ready work using the resolved execution profile. A Task may instead show:

| UI state           | Meaning                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| **Draft**          | Saved but not armed for execution.                                       |
| **Staged**         | Agent-proposed work waiting for approval.                                |
| **Waiting**        | Approved but blocked by dependencies or another explicit condition.      |
| **Ready / Queued** | Approved and eligible for automatic launch.                              |
| **Running**        | A Run is active.                                                         |
| **Needs you**      | A result, failure, verification problem, or Decision needs human action. |
| **Done**           | The completion contract has been satisfied.                              |

### Step 5: Inspect and intervene

Open a Task to see its status, dependencies, completion requirements, evidence, latest Run, and activity. When available, **Session** opens the underlying agent conversation.

Use the Stream and Task controls to:

- pause or resume admission of new work;
- optionally stop running work while pausing;
- stop one running Task;
- retry a failed or stopped Task;
- approve or reject Staged work, with a required rejection reason;
- answer a Decision or inspect a master escalation.

### Step 6: Finish safely

A Task becomes complete only after its completion contract is satisfied by matching evidence. Outcome closure also requires completed child work, success evidence, and owner confirmation.

When the initiative is over:

- **Delete** is available for a disposable Stream with no durable external effect. It removes the Stream's owned workspace and private work records.
- **Close** is required after a durable effect such as a published integration result. It preserves history and abandons unfinished work rather than destroying the audit trail.
- **Archive** is a separate visibility operation in the service contract; export and restore are advanced tenant-level storage operations.

## 4. Feature inventory

“Main UI” means the `/workgraph` surface or its shared Workspace panel. “Workflow/API” means the capability exists in the product contract but may require the Task Composer, an agent/MCP call, a connector flow, or direct API use.

| Area         | Feature                                | Surface                          | What to expect                                                                                                  |
| ------------ | -------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Organization | Project grouping                       | Main UI                          | Streams group by their real local directory or hosted repository.                                               |
| Organization | Streams and child Streams              | Main UI                          | Create an initiative; optionally promote a child with explicit autonomy confirmation and a parent budget carve. |
| Organization | Outcomes and success criteria          | Proposal + workflow/API          | Outcomes group Tasks; source planning can propose them.                                                         |
| Organization | Tasks, subtasks, and dependencies      | Main UI + workflow/API           | Add Tasks inline; dependency edges keep blocked work Waiting and cycles are rejected.                           |
| Organization | Draft Tasks                            | Task Composer + Main UI          | Save a Draft, select an agent profile, then Arm it from WorkGraph.                                              |
| Execution    | Local worktrees and hosted workspaces  | Main UI                          | Each Stream selects a real execution environment and base revision.                                             |
| Execution    | Inherited execution profiles           | Main UI + workflow/API           | Values resolve from WorkGraph → Stream → optional Outcome → Task → immutable Run snapshot.                      |
| Execution    | Supervised and autonomous modes        | Stream settings                  | Enabling autonomy requires explicit confirmation; budgets can constrain it.                                     |
| Execution    | Automatic launch                       | Runtime                          | Approved, ready work launches without a manual Run button.                                                      |
| Execution    | Pause, resume, stop, and retry         | Main UI                          | Pause stops new admissions; stopping a Run is separate; retry preserves previous attempts.                      |
| Execution    | Agent Session handoff                  | Main UI                          | Open the real Session associated with the latest usable Run.                                                    |
| Review       | Needs you                              | Main UI                          | One paged inbox for proposals, Staged work, Decisions, failures, escalations, and discovered candidates.        |
| Review       | Per-task and per-Stream approval       | Main UI                          | Approve or reject one Staged Task; bulk approval is scoped to one Stream and reports partial conflicts.         |
| Review       | Decisions                              | Main UI + agent workflow         | Answer a recommended option or enter a direct answer; only named Tasks are blocked.                             |
| Proof        | Completion contracts                   | Main UI + workflow/API           | Declares the evidence required for completion; successful execution cannot bypass it.                           |
| Proof        | Evidence                               | Main UI + agent workflow         | Typed proof is stored and shown against the relevant requirement.                                               |
| Proof        | Activity detail                        | Stream settings + Task dialog    | Choose milestones, progress, or detailed activity; lifecycle and blockers remain visible.                       |
| Supervision  | Stream master                          | Main UI + runtime                | Shows supervisor state, master actions, receipts, and owner escalations.                                        |
| Supervision  | First public PR confirmation           | Needs you                        | A master can hold the first public/non-draft PR for explicit owner confirmation.                                |
| Sources      | Immutable Work Sources                 | Proposal + workflow/API          | Planning and admission remain bound to the exact source revision and content hash.                              |
| Sources      | Admission review                       | Needs you                        | Review proposed Stream, Outcomes, Tasks, placement, and possible duplicates before confirmation.                |
| Sources      | Revised-source Keep / Replace / Fork   | Needs you                        | The owner explicitly chooses how a later source revision affects existing work.                                 |
| Sources      | GitHub, Linear, and Jira issue sources | Connections settings + Needs you | Save a filtered Source View, refresh it, then Add discovered issues to WorkGraph.                               |
| Sources      | Independent AI-session intake          | Needs you                        | Organize or dismiss meaningful work detected in an idle session.                                                |
| Memory       | Stream charter                         | Stream settings                  | Stores operating instructions that guide Stream execution and supervision.                                      |
| Memory       | Status and learnings notes             | Main UI when present             | Inspect durable notes associated with a Stream.                                                                 |
| Memory       | Run history and receipts               | Task/Run dialogs                 | Earlier attempts remain visible after retries.                                                                  |
| Operations   | Live refresh and reconnect recovery    | Main UI                          | Server change notifications trigger canonical reloads; focus or reconnect also revalidates state.               |
| Operations   | SQLite, Convex, and custom stores      | Deployment/API                   | Local/self-host uses SQLite; hosted uses Convex; custom adapters can run the conformance suite.                 |
| Operations   | Export and restore                     | Workflow/API                     | Portable tenant archive with isolation, validation, idempotency, and non-empty-target checks.                   |

## 5. Recommended manual test sequence

Use a throwaway repository, test provider accounts, and unique names such as `WG-QA-<date>-<case>`. Keep the Stream supervised until the autonomy test. Do not test deletion against work you may need later.

The order matters: each phase builds data needed by the next phase, while network-dependent, autonomous, and destructive checks are left until the deterministic foundation is proven.

### Phase A — deterministic foundation

#### WG-01: Empty state and capability discovery

1. Open `/workgraph` as an authenticated user in the intended organization.
2. Confirm the page title is **Streams** and the stats show Active, Agents working, and Needs you.
3. Open **Needs you** and confirm the same shared Workspace panel contains **Needs you** and **Settings** tabs.
4. Open **WorkGraph settings** and confirm harness, agent, model, effort, and Connection choices come from the environment.
5. Save valid defaults, reload, and confirm they persist.
6. Temporarily test an unavailable capability catalog if the environment supports fault injection.

Expected: no duplicate panel appears; valid defaults persist; unavailable capabilities show an explicit error and Save remains blocked.

#### WG-02: Stream creation, grouping, and persistence

1. Create `WG-QA-Stream` against the throwaway local repository or hosted repository and a known base revision.
2. Confirm it appears under the Project derived from that exact directory or repository.
3. Reload at desktop width, then at a narrow/mobile width.
4. Open Stream settings, add a charter, change activity detail, save, reopen, and verify persistence.

Expected: one Stream remains visible after each reload; its target, charter, and settings are unchanged.

#### WG-03: Manual Task and automatic launch

1. Add `WG-QA-Task-1` with **Add task**.
2. Observe its progression from Ready/Queued to Running without looking for a manual Run action.
3. Open the Task and inspect its completion requirement, latest Run, and Activity.
4. Open **Session** when it becomes available.
5. Let the Run finish and observe whether the Task becomes Done or Needs you because owner-confirmation evidence is still required.

Expected: one Run is created, the real project Session opens, activity is ordered, and process success does not falsely bypass the completion contract.

#### WG-04: Draft, dependency, and full task list

1. In the Task Composer, save `WG-QA-Draft` as a Draft with a non-default agent profile.
2. Return to WorkGraph and confirm the Draft label.
3. Arm it and verify the admitted Run uses the selected profile.
4. Create dependent Tasks through a proposal or API test fixture: Task B depends on Task A.
5. Open **More** / **Tasks** and confirm B is Waiting until A is completed or abandoned.

Expected: Draft does not run before Arm; execution uses its immutable profile; dependency order is enforced.

### Phase B — owner controls and recovery

#### WG-05: Pause, stop, resume, and retry

1. Start a deliberately long-running Task.
2. Pause the Stream without stopping active work.
3. Add or prepare another ready Task and confirm no new Run starts while paused.
4. Resume and confirm ready work is admitted again.
5. Pause again with **stop running work** selected, or stop the Task directly.
6. Confirm the row shows **Stopped · Retry**, then Retry it.

Expected: pause controls new admissions, stop controls the active Run, and Retry creates a later Run without deleting prior history.

#### WG-06: Staged approval and rejection

1. Ask a running agent to add a necessary follow-up Task.
2. Confirm the new Task appears as Staged in **Needs you** and does not execute.
3. Approve one Staged Task and verify it becomes eligible to run.
4. Create another agent-proposed Task and reject it with a reason.
5. If several Staged Tasks exist in one Stream, use **Approve all staged**.

Expected: agent-created work cannot self-approve; rejection requires a reason; bulk approval affects only the selected Stream and surfaces any stale-row conflict.

#### WG-07: Decision blocking

1. Have an agent raise a Decision with at least two options and name one affected Task.
2. Confirm the Decision appears in **Needs you** and the affected Task does not launch or continue past the boundary.
3. Confirm an unrelated ready Task can still proceed.
4. Open the Decision, inspect the recommendation and rationale, close it without answering, then reopen and answer it.

Expected: merely opening the Decision does not resolve it; answering removes it from attention and unblocks only the affected work.

#### WG-08: Attention acknowledgement and recovery

1. Produce at least two attention items.
2. Test **Mark all read**, reload, and confirm acknowledgement persists.
3. Test **Clear**, reload, and confirm cleared acknowledgement persists without deleting the underlying domain records.
4. Disconnect and reconnect the app or simulate one missed change notification.

Expected: attention state persists; reconnect/focus refreshes canonical data; the UI never fabricates a snapshot-based substitute when an Attention request fails.

### Phase C — sources and integrations

#### WG-09: Manual Work Source admission

1. Create a Work Source from a short launch brief through the available authoring, agent, or API entrypoint.
2. Request planning and wait for **Review proposed work** in Needs you.
3. Inspect proposed placement, Outcomes, Tasks, completion requirements, and duplicate hints.
4. Confirm the proposal.

Expected: no Stream or Task is materialized before Confirm; after Confirm, the records preserve the exact source revision.

#### WG-10: Source revision handling

1. Revise the admitted Work Source.
2. Review the diff and test **Keep** with a disposable fixture.
3. Repeat with separate fixtures for **Fork** and **Replace**.

Expected: Keep preserves existing work, Fork creates a new Stream, and Replace lists and version-pins the exact Tasks that will be superseded. No uncertain replacement happens silently.

#### WG-11: GitHub, Linear, and Jira intake

For each configured provider:

1. Connect a test account in Settings.
2. Add an issue source with the provider identity, stable filter, target project, base revision, and result-sync policy.
3. Refresh the source and confirm only matching issues appear under **Unorganized AI work**.
4. Dismiss one candidate and Add another to WorkGraph.
5. Review and confirm its generated proposal.
6. Allow execution and verify the configured sync-back action occurs once.

Expected: credentials never appear in WorkGraph responses or UI; refresh is deduplicated; the external issue remains authoritative; the external effect uses its idempotency key and is not repeated.

#### WG-12: Independent AI-session intake

1. Start meaningful work outside WorkGraph and let the Session become idle.
2. Open **Unorganized AI work**.
3. Dismiss one candidate and organize another.

Expected: meaningful independent work becomes a tenant-scoped candidate; dismissal suppresses it until meaningful change or explicit restore; organizing it enters the same proposal review flow.

### Phase D — autonomy, supervision, and proof

#### WG-13: Completion evidence

1. Create a Task with a test-result or integration completion requirement.
2. Let its Run succeed without recording matching evidence.
3. Confirm the Task remains result-ready or Needs you.
4. Record matching positive evidence, then record newer contradictory evidence if the fixture supports it.

Expected: matching evidence completes the requirement; newer contradictory evidence reopens it; evidence of the wrong kind does not satisfy the contract.

#### WG-14: Master, receipts, and public action gate

1. Complete two serialized Tasks so the Stream master is woken by settled work.
2. Inspect master status, its update, and linked receipts.
3. Trigger the first public/non-draft PR path in a safe test repository.
4. Confirm the master escalates instead of making the PR public by itself.
5. Approve the explicit owner confirmation and verify the action continues once.

Expected: master actions are serialized and auditable; receipts identify the action; the public action waits for the owner.

#### WG-15: Autonomous child Stream and budget

1. Give a parent Stream a small test budget.
2. Promote a child Stream and carve part of the parent budget.
3. Explicitly confirm autonomy.
4. Verify the child has a standing master, stays within the configured budget, and escalates when it cannot continue safely.

Expected: promotion never silently enables autonomy; the carve cannot exceed or consume the entire parent budget; a budget or safety boundary becomes Needs you work.

### Phase E — destructive lifecycle checks last

#### WG-16: Task removal and disposable Stream deletion

1. Create a Stream and Task that produce no durable external effect.
2. Remove an idle Task.
3. Delete the Stream and confirm the warning.
4. Verify its owned local worktree or hosted workspace lease is cleaned up.

Expected: no live Run can be removed as an idle Task; the disposable Stream and owned workspace disappear.

#### WG-17: Durable Stream close

1. In a separate fixture, create a durable external effect such as a recorded merged integration result.
2. Confirm deletion is no longer offered or the backend rejects it with `close_required`.
3. Close the Stream.

Expected: history, evidence, receipts, and workspace provenance remain; unfinished Tasks become abandoned; no new work launches.

## 6. Test coverage map

| Feature group                                  | Manual cases               |
| ---------------------------------------------- | -------------------------- |
| Settings and capability safety                 | WG-01, WG-02               |
| Streams, Projects, child Streams, and budgets  | WG-02, WG-15, WG-16, WG-17 |
| Tasks, Drafts, dependencies, and Runs          | WG-03, WG-04, WG-05        |
| Approval and human authority                   | WG-06, WG-07, WG-14        |
| Needs you and recovery                         | WG-06, WG-07, WG-08        |
| Sources, proposals, and revisions              | WG-09, WG-10               |
| GitHub, Linear, Jira, and independent Sessions | WG-11, WG-12               |
| Evidence and completion                        | WG-03, WG-13               |
| Master supervision and receipts                | WG-14, WG-15               |
| Cleanup and retained history                   | WG-16, WG-17               |

## 7. Automated verification order for developers

Run from the repository root. The root `test` script intentionally fails, so use package-scoped commands.

```sh
# 1. Core contracts, state machines, SQLite behavior, and conformance
bun run --cwd packages/workgraph test

# 2. WorkGraph source typecheck
bun run --cwd packages/workgraph typecheck

# 3. WorkGraph UI component and client tests
bun run --cwd packages/claxedo-app test:vitest -- src/features/workgraph

# 4. Embedded server smoke test
bun run --cwd packages/claxedo-server smoke:workgraph

# 5. Real SQLite + real WorkGraph router + browser journey
bun run --cwd packages/claxedo-app test:e2e:workgraph
```

For a release candidate, follow with the repository's normal filtered package tests and typechecks. The deployed WorkGraph browser gate requires a live app, control plane, Clerk credentials, smoke users and organizations, and a test repository:

```sh
bun run --cwd packages/claxedo-app test:e2e:deployed-workgraph
```

Do not treat the deployed gate as a substitute for the real-local journey. The local journey covers richer domain behavior; the deployed gate proves authentication, tenant claims, hosted persistence, responsive reloads, and cleanup against deployed services.

## 8. Current boundaries and incomplete journeys

These are important when deciding whether a failed manual step is a defect or a capability that is not yet delivered end to end:

- The Docs v2 adapter can accept exact immutable document revisions, but the current legacy Pages surface does not yet provide the durable authoring action that triggers that journey.
- Initial read-only sharing is part of the intended contract, but the current package documentation describes it as future work rather than a completed primary UI journey.
- Cloud uses the Convex adapter and hosted workspace placement, but release acceptance still depends on the target environment having its required Convex, Cloudflare, Clerk, control-plane, sandbox, relay, and smoke configuration.
- WorkGraph deliberately has no general product WIP queue. Scheduling follows Task readiness, Stream lifecycle, dependencies, execution settings, and runtime safety boundaries.
- Provider secrets belong to Connections, never WorkGraph. Any WorkGraph payload, event, log, or UI that exposes a provider token is a security defect.

## 9. Where to go deeper

- [Complete WorkGraph primer](./workgraph-primer.md) — detailed lifecycle and architecture background.
- [WorkGraph package README](../packages/workgraph/README.md) — package installation, public surfaces, adapters, and current delivery notes.
- [WorkGraph specification](../packages/workgraph/SPEC.md) — normative product rules and acceptance criteria.
- [WorkGraph architecture](../packages/workgraph/ARCHITECTURE.md) — service boundaries, ownership, persistence, execution, and security.
- [Canonical real-local browser journey](../packages/claxedo-app/e2e/playwright/core-workgraph.spec.ts) — executable UI acceptance coverage.
- [Deployed WorkGraph browser gate](../packages/claxedo-app/e2e/playwright/deployed-workgraph.spec.ts) — authenticated hosted persistence and cleanup acceptance.
