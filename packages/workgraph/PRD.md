# PRD: Claxedo WorkGraph

Last updated: 2026-07-14

## Vision

WorkGraph is a personal operating system for AI-assisted work: Linear for everything one person does with AI.

People begin with goals, branch into documents and sessions, discover more work during execution, and then forget what finished, what changed, what remains, and why decisions were made. WorkGraph gives that activity durable structure so the user can run many AI efforts in parallel without losing their state or recreating unnecessary work.

Each personal WorkGraph is physically scoped by a trusted `(organization, user)` tenant. The organization is an isolation and Connection boundary, while the user remains the owner of the Streams, Tasks, Decisions, source filters, and execution state. The server derives both identities from verified context; WorkGraph commands, queries, cursors, and MCP tools expose no tenant selector.

## Core promise

The user can return at any time and quickly answer:

- What am I trying to achieve?
- What are agents doing now?
- What is finished, blocked, missing, duplicated, or awaiting review?
- What should happen next?
- What changed the direction, and why?
- Which documents, sessions, artifacts, and external issues support the current state?

## Product model

- **Stream:** A durable context and isolated execution envelope for meaningful work. A Stream may be finite, such as “Ship Claxedo Cloud,” or ongoing, such as “Growth.”
- **Task:** The primary user-facing unit of work in a Stream. The service contract names it a Work Item and records its dependencies, completion contract, and execution profile.
- **Outcome:** An optional grouping for Tasks that together produce one shippable result. It carries success criteria and linked evidence; WorkGraph proposes closure when the criteria are satisfied and the user confirms it.
- **Work Source:** Exact source text captured from an agent, authoring surface, external issue, independent session, or explicit source action. Each edit creates a revision; confirmed work keeps the exact source revision that produced it.
- **Run:** One agent execution try. It preserves the resolved environment, model, effort, session, findings, artifacts, and terminal result.
- **Decision:** A durable choice containing its context, options, answer, rationale, provenance, and affected work.

## Main interaction

WorkGraph is one compact personal surface at `/workgraph`. Streams expand in place to show optional Outcomes and their Tasks, and **Add task** is the canonical manual work action.

The existing app-global WorkspacePanel is the single secondary panel and has one top-level toggle. WorkGraph contributes **Needs you** and **Settings** views to that same panel. The WorkGraph header controls select those views; they do not create another panel or toggle. A small dot on the existing top-level toggle indicates open attention. When no attention exists, WorkGraph renders no dot, contextual card, list, or empty attention state.

The Needs you view contains proposal review, Decisions, Task and Run attention, configuration requirements, and an aggregate for external-issue and independent-Session candidates. Selecting a domain item opens its focused dialog over the same WorkGraph surface. Candidates do not create a separate intake, capture, or onboarding screen. The top-level Settings view contains WorkGraph execution defaults only. A Stream settings control opens one tabless Stream-scoped dialog containing that Stream's execution overrides. Settings content is flush, descriptions and errors sit beside their fields, and the action footer remains pinned. The WorkspacePanel shell contains no WorkGraph domain state; WorkGraph supplies its tenant-scoped views and interactions.

## Creating and organizing work

Source-derived and candidate work enters the durable graph through explicit user admission. Within an already authorized Stream, agents may record sourced facts and add clearly necessary follow-up Tasks with provenance.

### From source text

When the user asks an agent or authoring surface to organize an idea, PRD, plan, notes, or other text, WorkGraph stores the exact text as a Work Source revision and creates a durable planning record. An ordinary background Claxedo agent session may then publish a review package containing ranked Stream placement, optional Outcomes with success criteria, Tasks with dependencies and completion contracts, execution defaults, possible duplicates, and a link to that exact revision.

Planning is version-fenced to the immutable revision and proposal. A lost admission response resumes the same durable session and message, and only valid structured output from that Session can make the proposal reviewable. Invalid or unavailable generation produces a visible `planning_failed` state with bounded retry and attention. The user edits and confirms the exact rendered proposal version before any Task is admitted.

When the Work Source changes, WorkGraph shows the revision diff and proposes a replan. The user can keep the existing plan, reset a wholly disposable Stream, or fork a new Stream. A reset is available only when every nonterminal Task belongs to the prior source revision and no durable external effect exists. Confirmation is bound to the exact reviewed Task IDs and versions. WorkGraph fences their Runs, preserves completed history, and holds replacement Tasks behind a durable reset barrier until Session interruption and envelope cleanup are acknowledged. Confirmed work is never rewritten silently.

Docs v2 is the first authoring adapter target for this contract. A user will brainstorm and draft freely in a document, then ask WorkGraph to turn an exact document revision into work. Later document revisions append equivalent Work Source revisions and enter the same diff, replan, and confirmation flow; the document remains the authoring surface while WorkGraph remains execution truth. The repository has the adapter seam, but the current Documents feature is still legacy Pages and has no durable Docs v2 revision model, so this document-triggered journey remains pending.

### From external trackers

GitHub, Linear, Jira, and similar sources use organization-owned Claxedo Connections. The organization owns credential and Connection metadata; each user owns their provider identity mapping, saved filters, candidate state, and Run bindings over those credentials. Matching issues remain personal candidates until the user chooses **Add to WorkGraph** from Needs you.

The external tracker remains authoritative for team issue state. WorkGraph owns personal execution state, Runs, and Decisions. Sync-back defaults to announcing meaningful results, with silent and fuller synchronization available per source view.

### From independent AI sessions

Sessions started outside WorkGraph remain unassigned. When a session becomes idle after producing meaningful work, it appears in Needs you with a summary and suggested Streams. The user attaches it, creates a Stream, or dismisses it. A dismissed candidate stays hidden until it changes meaningfully or the user restores it.

### Stream suggestion and duplicate prevention

Each Stream is matched from its title, description, purpose, repositories, active Outcomes, and recent activity. Placement searches pinned and recent Streams first, then older Streams only when the first pass has no convincing match.

Before admission, WorkGraph compares proposed work with active and recent Outcomes and Tasks. When overlap exists, it shows the match, state, reason, and evidence. The user can link, merge, or create separately. WorkGraph never silently places or merges uncertain work.

## Execution

Each Stream owns an execution workspace: a local worktree, cloud VM, or equivalent environment. Tasks execute inside that workspace, while the selected harness or agent manages any branch or nested-worktree strategy.

Execution configuration inherits through:

```text
WorkGraph defaults → Stream → optional Outcome → Task → immutable Run snapshot
```

The Stream defines the environment, repository, and starting revision. Each Task resolves its harness and agent, model, effort, tools, and Connections. Branch, worktree, and repository integration behavior is part of the Task instructions and harness execution. The user edits only execution overrides. Every selectable value comes from the exact server-attested capability catalog for the trusted tenant; unavailable or stale capability state remains explicit and cannot authorize execution. One versioned settings save commits the complete scope-specific patch atomically: WorkGraph Settings writes execution defaults, while Stream Settings writes Stream execution overrides. Clearing a field removes that override, and conflicts preserve the user's unsaved input for an explicit retry.

A Stream or Outcome runs in one of two modes:

- **Autonomous:** Launch every ready Task and continue until the selected work completes, becomes blocked, reaches an explicit user safety boundary, or requires a consequential Decision.
- **Supervised:** Launch one visible batch and pause before selecting more work.

“Execute this Stream” defaults to autonomous. WorkGraph has no product-level agent-capacity or work-in-progress limit. Every item whose blockers and required Decisions are resolved and whose execution profile is valid is ready to launch.

Pause stops new Runs; active Runs continue unless the user explicitly cancels them. Transient infrastructure and provider failures retry automatically. Semantic, repeated, or ambiguous failures require attention.

## Truthful state

An agent finishing does not complete its Task. The completion contract must be satisfied—for example, code integrated with checks passing, a pull request merged, an artifact delivered, research supported by evidence, or a document accepted. Until then, the Task remains result ready, review needed, integration needed, or verification failed.

Completing all known Tasks does not complete an Outcome. WorkGraph evaluates its success criteria, assembles evidence, and moves it to ready to close. The user confirms completion. New required work or contradictory evidence reopens it with provenance.

Agents may directly update factual execution state, record sourced findings, attach artifacts, and add clearly necessary follow-up work. Scope expansion, removal or reprioritization of confirmed work, changed success criteria, and consequential tradeoffs create reviewable Decisions. Pending Decisions appear in Needs you for the owner to inspect, answer, or dismiss. A Decision blocks only affected and dependent work; unrelated work continues.

Users can correct any state while preserving history and provenance.

## Lifecycle and sharing

Before a Stream produces an integrated or externally durable result, it is disposable. Deleting it cancels Runs, destroys its worktree or VM, and discards unmerged partial work.

Integrated code, a merged pull request, a published artifact, or another accepted external write is a point of no return. The Stream can no longer be deleted because its history explains durable effects outside WorkGraph. The user closes it instead.

Closing preserves Runs, Decisions, evidence, and references to integrated results. Unfinished Tasks become abandoned with a reason, and the isolated environment is cleaned up after retained results are recorded. Archive hides a closed Stream while preserving that history.

A WorkGraph is private and personally owned by default. Later sharing begins with owner-controlled, read-only access to a Stream or whole WorkGraph. Collaborative mutation and shared ownership are separate future capabilities; organization goals and top-down allocation are outside the product’s core identity.

## User journeys

### 1. Turn a goal into organized work

The user creates “Ship Claxedo Cloud” and adds the necessary Tasks. They may group related Tasks into an Outcome when a shippable result benefits from shared success criteria. WorkGraph exposes missing, duplicate, blocked, and active work so the goal can proceed without repeatedly reconstructing its plan.

### 2. Brainstorm or draft, then execute

The user asks an agent or, once the Docs v2 revision model is available, a document action to organize a PRD, plan, or notes from an exact revision. “Turn into work” proposes the Stream, optional Outcomes, Tasks, execution defaults, and source links. The proposal appears in the Needs you view of the existing global WorkspacePanel. The user edits and confirms it, preserving the exact source text as reasoning evidence and WorkGraph as execution truth. The agent/source-text path is the current executable path; the legacy Pages UI is not evidence of the Docs v2 journey.

If the source later changes direction, WorkGraph shows the diff and a replan proposal. The user replaces disposable work, keeps the current plan, or forks another Stream without disturbing integrated results.

### 3. Execute a long goal

The user selects autonomous execution. Every ready Task launches with its resolved worktree or cloud VM, model, effort, and tools. WorkGraph shows current agent activity, results awaiting integration, blockers, and required Decisions without requiring the user to inspect each session.

### 4. Capture discoveries and changed direction

An agent discovers necessary follow-up work and adds it with provenance. A discovery that changes scope or success criteria becomes a Decision. Only the affected branch pauses while other ready work continues.

### 5. Stage personally relevant external work

A saved user filter finds a team issue through a shared Connection. The candidate appears in the aggregated Unorganized AI work entry in Needs you. **Add to WorkGraph** checks for duplicates, proposes a Stream and optional Outcome, and creates the Task after confirmation. Results can sync back through the same team credential with user and agent provenance.

### 6. Recover work started outside WorkGraph

A meaningful independent AI session appears in the aggregated Unorganized AI work entry in Needs you after becoming idle. WorkGraph suggests recent Streams without assigning it automatically. The user attaches, creates, or dismisses it.

### 7. Discard or close a Stream

The user abandons a partially implemented Stream whose work remains isolated. Deleting the Stream cancels its Runs and destroys its worktree or VM. If any result has already been integrated or published, deletion is unavailable; closing preserves the history and marks unfinished Tasks abandoned.

## Success criteria

WorkGraph succeeds when the user can:

- understand an active Stream in under one minute;
- run many independent AI efforts without losing their state;
- see current agent activity without opening individual sessions;
- identify missing, duplicated, blocked, and integration-pending work before it delays an Outcome;
- resume from a clear next action rather than reconstructing conversations;
- trace scope changes to discoveries and Decisions;
- convert source text into confirmed execution structure without re-entering its context;
- recover personally relevant external and independent AI work without importing everything.

## Initial scope

- One personal WorkGraph surface with inline Stream expansion, canonical Add task, and WorkGraph Needs you and Settings views in the existing app-global WorkspacePanel.
- WorkGraph application services embedded in `claxedo-server`, with authenticated HTTP/JSON plus ordered change cursors for the app and standalone stdio MCP, direct in-process access for local embedded agent tools and workers, and hosted embedded tools gated on durable Session tenant provenance.
- Streams, Tasks, optional Outcomes, Runs, agent-created Decisions, and attention.
- Versioned Work Sources and durable Session-backed “Turn into work” planning with explicit planning and failure states.
- Organization-credential, user-filtered external sources.
- Unorganized AI work capture.
- Recent-first Stream suggestion and duplicate review.
- Inherited execution profiles and autonomous/supervised execution.
- Stream-owned logical workspaces, with branch/worktree strategy and compute lifecycle delegated to the harness and execution environment.
- Diff-driven Work Source replanning with keep, replace, or fork actions.
- Evidence-based completion and agent discovery policy.
- Disposable deletion before integration and close/abandon after durable effects.

## Later scope

- Read-only Stream and whole-WorkGraph sharing.
- A triggerable Docs v2 exact-revision journey through the existing authoring-adapter seam, followed by additional authoring-surface adapters.
- Collaborative mutation and shared ownership.
- Additional notification delivery channels.
- Organization planning, company goals, and top-down work allocation.
