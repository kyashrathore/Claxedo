# Task automation: one-time and recurring tasks

Status: design proposal for review. This document records the product direction from the discussion; it does not claim that scheduling or automatic status updates are implemented.

## 1. Product model

Automation is a capability of an existing task. We do not introduce a separate automation entity for users to manage.

A task has a type:

- **One-time:** work that advances toward completion. It may need several execution attempts to finish.
- **Recurring:** instructions executed on a schedule. Each occurrence creates a new run; completing a run does not complete the recurring task.

The existing claxedo-mcp is the agent entrypoint for finding tasks, updating them, starting work, managing schedules, and inspecting runs. UI and MCP use the same authorized task operations.

Constraints from the discussion:

- Automation is available only in signed-in mode.
- Scheduling runs in the Cloudflare backend using Cron infrastructure; an open desktop app is not the scheduler.
- Reuse Tasks, Presets, and the existing session execution path.
- Task state and session activity must be understandable separately.

Proposed interpretation of signed-in mode: account-backed automation continues after the user closes the app. A browser session cookie is not its execution credential. Sign-out, account revocation, and unavailable execution targets need the explicit policies in section 10.

## 2. Current foundation and change boundary

The current contract in `packages/claxedo-tasks/src/contracts.ts` defines `backlog`, `todo`, `doing`, `needs_you`, and `done`. The status picker sends `task.set_status`; the command router calls `tasks.setStatus()` in `packages/claxedo-tasks/src/tasks/service.ts`. That service checks authorization and revision, refuses Done when nonarchived children are unfinished, and persists the task.

The [existing high-level design](2026-09-08-004-feat-tasks-high-level-design.md) specifies manual task status regardless of session outcomes. It describes linked sessions by configuration slot and attempt, with execution handled by the host. The [MCP design](2026-09-14-001-feat-tasks-mcp-tools.md) describes scoped task access and the existing preview/start path.

This proposal adds task type, recurrence, execution records, and explicit automatic transitions. It does not equate existing session links with completed runs or assume that the requested MCP operations already exist. Existing authorization, presets, session controls, and child-completion constraints remain authoritative.

## 3. Top-level task statuses

### One-time tasks

| Status | Meaning |
| --- | --- |
| Backlog | Saved work that is not ready to start; preserves the existing task concept |
| To do | Ready to start, including work scheduled for a future time |
| In progress | Work has started and the objective is not complete |
| Needs you | A structured input, approval, or review request is pending |
| Done | The task objective has explicitly been reported complete |

Schedule timing is supporting information, not another status. A one-time task can be `To do · Starts tomorrow at 9 AM`.

### Recurring tasks

| Status | Meaning |
| --- | --- |
| Active | The schedule can create future runs |
| Paused | The schedule cannot create future runs |

**Recurring tasks do not have top-level Running, Needs you, Done, or Failed statuses. Those describe runs.** An Active recurring task can have a run waiting for approval.

Archive uses the existing archive concept instead of becoming a third recurring status. Proposed behavior: archiving prevents future scheduled starts and retains history. Handling an already active run is explicit; archiving must not silently stop it.

Pausing prevents future scheduled starts. It neither stops the current run nor resolves its pending requests.

## 4. Execution and completion

Both task types need execution history internally. For one-time tasks, executions are attempts toward the same objective. For recurring tasks, each scheduled occurrence is a separate run.

Proposed execution states:

| State | Meaning |
| --- | --- |
| Queued | Start accepted; execution has not started yet |
| Running | Execution has started and is working |
| Needs you | Execution has one or more unresolved structured requests |
| Completed | An explicit successful outcome was recorded |
| Failed | Execution ended with a recorded failure |
| Stopped | Execution was explicitly stopped |

A session becoming idle, finishing one response, disconnecting, or closing does not establish task completion. Ordinary message text is not a status event.

For one-time tasks:

1. Creation leaves the task in Backlog or To do.
2. Accepting a start creates an execution; show Queued as execution information.
3. Confirmed execution start moves the task to In progress.
4. A structured request moves it to Needs you.
5. Confirmed request resolution and resumed execution move it back to In progress, provided no blocking request remains.
6. An explicit task-completion outcome moves it to Done, subject to the task service's completion rules.
7. Reopening completed work moves it to To do through an explicit task action.

An execution can complete its assigned step without completing the entire one-time task. A planning session finishing must not mark an implementation task Done. The outcome contract must distinguish execution completion from task-objective completion.

Failure and interruption belong to the execution. They must not invent a pending question. Proposed initial behavior: keep an unfinished one-time task In progress and surface `Latest attempt: Failed` or `Stopped`, with Retry or Resume. This policy remains a review decision.

For recurring tasks, execution transitions never overwrite Active/Paused. A completed run saves its result while the next occurrence remains governed by the schedule.

## 5. How an agent request reaches the task UI

1. Starting work creates a durable association between task, execution, and canonical session reference.
2. The session's authoritative request owner produces a structured permission, question, or review request with a stable request ID.
3. A backend integration records the pending request against the execution. It sets the execution to Needs you and, for a one-time task, applies the corresponding task transition.
4. The task read model includes the request kind, safe summary, execution/session references, and request ID. The UI updates from persisted task/execution changes.
5. **Review request** opens the exact session and request. Existing session controls submit the response to the authoritative request owner.
6. That owner confirms resolution. The execution leaves Needs you only when all blocking requests are resolved; Running requires confirmation that execution resumed. Denial, cancellation, or failure may lead elsewhere.

Example:

> **Needs you**  
> Approve running database migrations  
> **Review request**

Important rules:

- Do not parse “What do you think?” out of chat to create a request. Agents must use supported structured mechanisms.
- Resolving a UI dialog locally is not evidence that the request was resolved on the backend.
- A stale or unrelated session cannot change the current task's status. Validate the task/execution association and current execution ownership.
- Duplicate events must be idempotent. Reconnection must reconcile against authoritative pending requests, not synthesize missing events.
- Multiple pending requests remain visible; resolving one must not hide another.
- Child-agent requests need an explicit association to their owning execution before being surfaced. The exact runtime adapters require an implementation audit.

## 6. UI

### Task collection

Keep Tasks as the entrypoint. Provide **One-time** and **Recurring** views so their different top-level statuses do not share misleading board columns.

One-time list/board uses existing progress groups. Each row shows one prominent task status, with execution activity or failure as supporting information.

Recurring list separates the task status, schedule, and run information:

| Task | Status | Schedule | Run information |
| --- | --- | --- | --- |
| Daily competitor report | Active | Weekdays, 9 AM · Next tomorrow | Latest run: Completed |
| Review dependency updates | Active | Mondays, 10 AM | Current run: Needs you · Review request |
| Summarize support feedback | Paused | Daily, 6 PM | Latest run: Completed |
| Check deployment health | Paused | Every hour | Current run: Running · Open run |

Never replace the recurring task's Active badge with an unlabeled Needs you badge. Label the latter as run information. An attention filter may collect pending requests and failures across task types, while retaining their distinct reasons and actions.

### Task detail

- Shared: title, instructions, project, execution configuration, and origin/session context.
- One-time: prominent progress status, Start/Open session/Review request/View result as appropriate, and execution history.
- Recurring: prominent Active/Paused status, readable schedule and timezone, next occurrence, Pause/Resume, Run now, and run history.
- A run row opens its result, failure, pending request, and linked session. Schedule controls stay on the task, not on each historical run.

Example recurring detail header:

> **Daily competitor report** · Active  
> Every weekday at 9 AM · Asia/Kolkata  
> Next run tomorrow at 9 AM  
> **Current run: Needs you — approve source access** · Review request

### Create and edit

Choose One-time or Recurring. Recurring reveals schedule and timezone fields; One-time can optionally specify a future start time. Show a readable schedule and next occurrence before saving. Preserve the existing preset/configuration selection mechanism.

Signed-out users see the sign-in requirement before attempting to enable scheduling. Scope this gate to automation; changing availability of ordinary manual tasks is outside this proposal.

The [HTML prototype](../prototypes/tasks-recurrence.html) predates the final distinction between recurring task status and run status. It is an exploratory artifact and must be updated before being treated as the accepted UI specification.

## 7. Backend scheduling proposal

Cloudflare Cron wakes a backend scheduler. The scheduler reads due account-backed task schedules and requests execution through the existing task start path. Cron is the trigger; the task store owns the schedule and next occurrence.

Proposed sequence:

1. Find due, Active, nonarchived tasks.
2. Atomically claim the scheduled occurrence with a unique task/occurrence identity.
3. Recheck account authorization, schedule revision, execution configuration, and overlap policy.
4. Record the execution and durably dispatch the existing start operation.
5. Record canonical session references when start succeeds. Record a visible failure when it cannot start.
6. Advance the schedule according to the selected missed-occurrence policy.

Claiming and dispatch must recover after a crash without duplicating a run or losing a claimed occurrence. The concrete transaction/outbox or workflow mechanism is an implementation decision. Current credentials are resolved through existing account/runtime mechanisms; do not persist a browser login token as the automation credential.

Backend scheduling does not guarantee that a local execution target is online. Never silently substitute a cloud or local target. Account eligibility, credential revocation, and target availability are checked at execution time.

Store schedule timezone and explicit occurrence identity. Validate timing, timezone behavior, precision, and missed occurrences before promising exact execution timing in the UI.

## 8. MCP parity and state ownership

Desired operations through the existing claxedo-mcp:

- Find/read/create/edit an authorized task.
- Set or edit its schedule; pause/resume recurrence.
- Start now and inspect execution history and results.
- Report a structured execution outcome and, separately, completion of a one-time objective.
- Find pending requests and open their session context. Responses continue through the authoritative request mechanism.

These are capabilities, not final tool names. Audit the existing tool surface and extend it rather than implementing another task service. “From any session” means any session with the appropriate account, project, and operation grants; it does not bypass scope restrictions.

Ownership:

| Fact | Authoritative owner |
| --- | --- |
| Task type, task status, schedule, archive state | Task backend |
| Occurrence identity and execution lifecycle | Proposed task execution service using canonical host outcomes |
| Session activity and pending agent requests | Existing session/runtime owners |
| Permission/question response | Existing request owner |
| Displayed task and run information | UI projection of persisted backend state |

Manual UI changes and agent changes must use the same revision-checked commands. Exact transition guards for manual completion while a run/request is active need agreement before implementation.

## 9. Proposed first-release boundary

- Reuse tasks and presets; no new bot catalog or automation builder.
- Simple time-based schedules and Run now.
- Explicit task/run status separation, results, failures, and input requests.
- Proposed overlap policy: one unresolved execution per recurring task. Skip a due occurrence while the previous run is queued, running, or waiting for input; record why it was skipped. Do not count a skipped occurrence as a successful run.
- Paused schedules retain history and current requests.
- No automatic inference of completion from assistant prose or session idle state.

The overlap policy is a recommendation, not an agreed constraint. It should be selected explicitly before implementation.

## 10. Decisions still needed

1. **Completion authority:** can the agent mark a one-time task Done directly, or do some tasks require user review? Define required outcome evidence and the interaction with unfinished children.
2. **Interrupted one-time work:** confirm the proposed In progress + Failed/Stopped attempt presentation and manual transition rules.
3. **Overlap and missed occurrences:** confirm skip versus queue, retry behavior, outage catch-up, and how the UI reports skipped occurrences.
4. **Execution targets:** cloud-only scheduling for the first version, or explicit offline behavior for local machines?
5. **Account lifecycle:** distinguish closing/signing out of a client from disabling automation or revoking account access. Define pause behavior for lost authorization.
6. **Existing sessions and slots:** choose how multiple configuration slots contribute to one execution, which execution can update one-time task status, and whether an existing session may be attached.
7. **Editing:** define task-type conversion, active-run instruction snapshots, recurring subtasks, and manual completion while a request is pending.
8. **Scheduling details:** supported frequencies, timezone/DST rules, timing expectations, automatic retry limits, and usage limits.

The companion [60-use-case research matrix](../research/2026-09-20-task-automation-usecase-matrix.md) examines public reports for Grok Bot, Meta Muse, Instinct, and squad.so. It distinguishes direct user reports, reproduced posts, and vendor examples. Its proposed additions—durable waits, bounded watches, context, and independent related cases—remain review recommendations rather than silently changing the decisions here.

## 11. Acceptance scenarios

- Normal one-time execution progresses from To do to In progress and reaches Done only on an accepted task-completion outcome.
- Planning completion and ordinary session idle do not complete a task.
- A structured approval request appears on the correct task/run and opens the exact request. Confirmed resolution resumes the appropriate state.
- A second unresolved request remains visible after the first is answered.
- Failure and Stop show execution outcomes without fabricating Needs you.
- A recurring run completes while its task remains Active.
- An Active task with a pending request shows both schedule state and run attention clearly.
- Pausing during execution prevents new scheduled starts and preserves the current run/request.
- Duplicate scheduler delivery and request events do not duplicate runs or corrupt state.
- A stale execution cannot overwrite a newer one; unauthorized sessions cannot inspect or modify another task.
- Closing the desktop does not stop the backend scheduler. Offline targets and revoked capabilities produce the chosen explicit behavior.
- Reopening the UI reconstructs task status, run history, and outstanding requests from authoritative persisted state.

Implementation should begin only after resolving the state-transition and execution-ownership decisions above. The next design artifact is an updated HTML prototype that demonstrates these exact distinctions.
