# WorkGraph Service Specification

Status: implemented core contract; adapter-surface expansion and deployment validation are tracked in `TASKS.md`

## 1. Purpose

WorkGraph is a user-owned service for organizing AI-assisted work, executing it across Claxedo runtimes, and preserving enough state to resume without reconstructing documents and sessions.

Claxedo Cloud uses Convex by default. Local and single-node self-hosted Claxedo use SQLite. OSS deployments may supply conforming storage adapters.

### 1.1 Host composition

`claxedo-server` embeds one WorkGraph application-service composition. It mounts the backend-neutral HTTP/JSON and ordered-change router as the northbound contract used by the Claxedo app. MCP tools, webhooks, background workers, reconcilers, and other server modules receive the application services directly and invoke them in-process.

The host supplies verified identity, storage, Connections, and workspace-execution adapters. Cloud and local deployments preserve this service boundary while selecting Convex or SQLite respectively.

## 2. Request context

Every operation receives trusted context:

```ts
interface WorkGraphContext {
  ownerUserID: string
  actor: { type: "user" | "agent" | "system"; id: string }
  requestID: string
  access: { mode: "owner" | "shared_read" }
}
```

The host derives owner and access from verified identity. Public operations do not accept an arbitrary owner ID as resource selection.

## 3. Domain records

Every durable record includes `owner_user_id`, stable ID, creation time, and appropriate update/schema metadata.

### 3.1 Stream

A Stream is a finite or ongoing work context and the primary execution-isolation boundary. It contains purpose, lifecycle, pinned state, execution defaults, Recap defaults, memory card, activity marker, base repository/revision, primary isolation-envelope intent and identity, durable-effect state, and linked Outcomes and sources.

### 3.2 Outcome

An Outcome is a shippable result with success criteria, evidence, state, and optional execution defaults. Satisfied criteria produce `ready_to_close`; owner confirmation produces `completed`. New required work or contradictory evidence may reopen it with provenance.

### 3.3 Work Item

A Work Item is presented to users as a Task. It contains title, description, state, optional Outcome membership, dependencies, priority, source links, execution overrides, completion contract, and completion evidence.

Truthful states distinguish pending, active, result ready, review needed, integration needed, blocked, verification failed, completed, failed, and archived work.

### 3.4 Attempt

An Attempt is one execution try. It stores an immutable resolved execution profile including workspace/worktree/cloud VM, repository revision, harness, agent, model, effort, tools, Connection references, isolation, cleanup, and integration expectations.

Attempt state distinguishes admission, placement, running, attention, terminal execution result, and cancellation. A retry creates another Attempt.

### 3.5 Decision

A Decision stores its question, options, recommendation, rationale, answer, actor provenance, affected work, and state. Agents create Decisions when execution reaches a consequential owner choice. A pending Decision appears in attention and blocks only affected and dependent work.

### 3.6 Recap

A Recap stores the Stream activity range, previous Recap reference, generated summary, actionable references, model/effort profile, provenance, and generation result. Recaps are immutable timeline entries.

### 3.7 Work Source

A Work Source stores owner-entered text, title, immutable revisions, optional source metadata, and links to admission proposals and confirmed work. Editing appends a revision. Confirmed work binds the exact revision ID and content hash used to produce it. Confirmation compares against the exact proposal version rendered for review, so a background planner publication requires a new review before it can materialize work.

### 3.8 Source view and intake candidate

A personal source view binds a team Connection, provider integration, owner identity in that provider, filters, refresh/webhook settings, and sync-back policy.

Connector results and meaningful independent sessions create intake candidates. Candidates are not executable Work Items. Staging performs explicit admission.

### 3.9 External identity

An external identity stores provider, team connection reference, external ID/key/URL, normalized metadata, and observed revision. The unique identity includes owner, provider, connection, and external ID.

### 3.10 Event and receipt

Events include owner, stream, sequence, schema version, operation ID, actor, payload, correlation/causation, and timestamp. Connector receipts record external effects and idempotency without secret material. Durable-effect receipts identify merged or directly integrated code, published artifacts, accepted external writes, and equivalent results that make a Stream's history externally consequential.

## 4. Storage contract

The backend-neutral store covers Streams, Outcomes, Work Items, intake, Attempts, Decisions, Recaps, events, leases, idempotency, change cursors, and connector receipts.

Every core adapter provides:

1. Owner-scoped reads and writes.
2. Atomic domain command plus event/outbox append.
3. Monotonic per-stream event ordering.
4. Unique operation IDs.
5. Compare-and-set transitions.
6. Expiring lease acquisition and renewal.
7. Stable cursor pagination and reconnect cursors.
8. Ordered change feed with reconnect cursors.
9. Versioned migrations.

Portable owner export and restore use a separate versioned archive port and conformance contract. SQLite and Convex implement archive conformance version 1, restart recovery, workspace cleanup, and owner-level permanent deletion.

Core conformance version 3 distinguishes the branded `SnapshotResumeCursor` used only to continue one page chain from the `ChangeCursor` watermark returned as `snapshotCursor`. Resume cursors bind owner, snapshot watermark, capture time, and keyset position; malformed, cross-owner, and owner-mutation-invalidated cursors fail with `cursor_invalid`. Convex serves bounded keyset pages beyond 100 records. App and MCP consumers validate and aggregate the full page chain and may discard one invalidated partial chain for one clean restart before surfacing failure.

### 4.1 Convex adapter

Convex is the hosted default. Owner-first indexes, authenticated server queries/mutations, ordered changes, and scheduled functions support multi-instance operation without process-local correctness state. The app remains on the server-mounted HTTP/change contract and does not depend directly on Convex APIs.

### 4.2 SQLite adapter

SQLite is the local default and implements the same domain semantics and conformance suite in one Node host.

### 4.3 Custom adapters

An OSS adapter implements the published ports, migrations, export/delete behavior, and conformance suite without changing domain services.

## 5. Source admission

“Turn into work” reads an exact Work Source revision, persists a bounded durable proposal record, and schedules an ordinary durable Session V2 planner. The planner proposes:

- existing or new Stream;
- optional Outcomes and success criteria;
- initial Work Items and completion contracts;
- source-section links;
- duplicate matches;
- inherited execution settings.

The planning job uses a caller-owned stable Session/message identity. Lost admission responses retry that exact identity; strict result validation, immutable source binding, proposal-version compare-and-set, lease fencing, and dependency-cycle validation prevent stale or malformed output from materializing work. Agent publication appends an ordered owner change so connected clients refetch the proposal.

The owner edits and confirms the exact rendered package version. A later Work Source revision presents the source diff and a reviewable replan with three choices:

- keep confirmed work and admit selected additions;
- replace affected unmerged work, cancelling obsolete Attempts and discarding its partial isolation state;
- fork a new Stream from the revision while preserving the existing Stream.

The selected action is recorded with the exact old and new source revisions. Confirmed work changes only after owner approval. Docs v2 is the initial authoring adapter: it appends a Work Source revision carrying an exact external document revision and then invokes the same proposal, compare-and-set confirmation, and replan contract. Agent-driven and explicit source capture use the same contract without depending on an external document service.

## 6. Connections and external intake

All provider credentials remain in `@claxedo/connections`. One team Connection is canonical within its organization; each personal source view separately records the WorkGraph owner's provider identity and filters. A source view resolves a team-scoped `CapabilityHandle` after verifying the owner still has access to that team Connection.

The connector receives a live token supplier and authentication-failure reporter. WorkGraph stores the team connection reference, provider user mapping, and filters but no token or API key.

Saved filters produce personal candidates. Staging checks external identity idempotency, duplicate matches, and Stream placement before creating or linking a Work Item.

The external tracker remains authoritative for team issue state. WorkGraph's default sync-back policy announces meaningful results. Silent and full policies are explicit source-view choices.

Webhook handlers verify signatures, resolve affected source views, apply each owner's filters, deduplicate deliveries, and enqueue candidate refresh.

## 7. Stream matching and duplicates

Each Stream has a compact memory card. Placement searches pinned and recent cards first and expands to older cards only on low confidence. The response includes best match, alternatives, confidence explanation, and create-new choice.

Duplicate review compares compact active/recent Outcome and Work Item representations. A match offers link, merge, or create separately. No uncertain placement or merge occurs without owner confirmation.

## 8. Execution profiles

Execution settings resolve in this order, skipping the Outcome layer for an ungrouped Task:

```text
WorkGraph → Stream → optional Outcome → Task → Attempt
```

The Work Item exposes resolved values and their source. Attempt admission stores the immutable resolved snapshot.

WorkGraph and Stream settings use one versioned atomic command per save. WorkGraph Settings applies execution-default changes only. Stream Settings applies Stream execution and Recap changes together. Each command appends one ordered change and rejects a stale aggregate version without a partial write. An omitted field remains unchanged; an explicit clear removes the override so inheritance is recalculated from persisted parent settings. Missing required generation configuration produces a configuration requirement and does not select a substitute model, effort, or result.

### 8.1 Capability discovery

`GET /execution-capabilities` returns one owner-scoped schema-version-1 observation and accepts no workspace identifier. The response contains `observedAt`, supported environment inputs and policy values, harnesses, agents, models with supported efforts, tools, repository metadata, and connected Connection metadata. Discovery failure returns `execution_capabilities_unavailable` with a typed capability, reason, message, and retryability.

The GET operation is side-effect free. Local composition reads the configured Git repository and live local runtime. Hosted composition reads a deterministic per-owner catalog workspace that the control plane manages independently of Stream execution. `POST /execution-capabilities/refresh` is an explicit owner-only agent/control-plane operation that may provision or refresh that catalog. Hosted background setup invokes it before the app requires the catalog; the app consumes GET only.

The catalog workspace supplies live runtime choices and has no execution repository. Hosted repository remote and base revision remain validated inputs when the Stream execution workspace is later provisioned. Neither the catalog workspace nor a Stream workspace is represented by execution-profile `presetId`.

Current local capabilities are `local_worktree`, required repository context, Stream and child isolation, destroy-on-close and retain cleanup, and manual integration. Current hosted capabilities are `hosted_workspace`, optional repository input, Stream isolation, destroy-on-close cleanup, and manual integration. Adapters publish only values their placement and reconciliation implementations enforce.

Execution first provisions or adopts the Stream's primary isolation envelope: a dedicated worktree for local repository work or a dedicated VM/workspace for remote execution. Work Items and Attempts execute inside that envelope. A Work Item may request a child worktree or session when its work benefits from narrower isolation, while the Stream remains the ownership and cleanup boundary.

Ready means explicit blockers and required Decisions are resolved and the execution profile is valid. WorkGraph launches every ready Work Item; it has no agent-capacity or product WIP queue.

Autonomous execution continues until completion, blocking, explicit owner safety boundary, or consequential Decision. Supervised execution pauses after one batch.

Pause prevents new launches. Cancel is a separate action for active Attempts.

## 9. Attempt lifecycle

```text
admitted → placing → running → result
                       ├──────→ attention
                       ├──────→ failed
                       └──────→ cancelled
```

Dispatch acquires a durable execution lease before placement inside the Stream envelope. The workspace execution port hides local, user-hosted, and cloud placement and returns stable Stream-envelope, child-workspace, and session identities.

Runtime liveness and semantic result are separate. Session stop without a clear result creates attention. Transient infrastructure/provider failures retry automatically; semantic, repeated, and ambiguous failures require attention.

## 10. Completion

An Attempt result is evaluated against the Work Item completion contract. Unsatisfied requirements produce result-ready, review-needed, integration-needed, or verification-failed state and may create necessary follow-up work.

Outcome evaluation assembles linked evidence against success criteria. Satisfied criteria produce ready-to-close and require owner confirmation. Reopening retains prior closure evidence and provenance.

## 11. Agent authority

Agents may directly:

- update factual execution state;
- record sourced findings;
- attach artifacts;
- add clearly necessary follow-up Work Items.

Agents create reviewable Decisions before expanding confirmed scope, removing or deprioritizing confirmed work, changing success criteria, or accepting consequential tradeoffs.

MCP tools bind the caller to owner, Attempt, and permitted work. Tool arguments cannot select another owner's records.

## 12. Recaps and attention

New Stream activity resets its quiet window. After eight quiet hours, a durable worker reads changes since the prior Recap, current Stream state, and previous memory. It does not reread complete history.

Recap model and effort come from the Stream's explicit Recap configuration. Local and hosted generation uses ordinary tool-less Session V2 jobs with stable identity, exact activity-range binding, strict output validation, and publication fencing. Only valid output from that Session can publish a Recap. Missing Stream configuration creates a configuration requirement. Transient failures retry from durable state; repeated failure or inaccessible sources create attention without publishing a substitute Recap or notification.

Recaps update visible Stream memory. An actionable Recap atomically creates exactly one owner-scoped unread notification carrying the exact Stream and Recap identifiers. Acknowledgement compares against the rendered notification version and cannot mark a newer delivery read. The Needs you view opens the exact Recap in a focused dialog before acknowledging that rendered notification version. Non-actionable Recaps and retries do not create duplicate deliveries.

The owner-scoped Attention query returns bounded, stable cursor pages covering reviewable proposals, pending Decisions, Task and Attempt attention, actionable Recaps, configuration requirements, and one aggregate for unorganized external-issue and independent-Session candidates. Candidate drilldown uses a separate bounded owner-bound cursor. Ordered changes trigger bounded refresh; Attention and candidate failures are explicit and never cause a full-snapshot substitute read.

The existing app-global WorkspacePanel and its top-level toggle are the only panel instance and panel control. WorkGraph contributes top-level Needs you and Settings views. WorkGraph header controls select those views in that same panel. WorkGraph Settings is a tabless execution-defaults view. Stream Settings is a tabless Stream-scoped dialog containing Stream execution and Recap configuration; settings fields are flush, descriptions and errors are adjacent to their fields, and the footer is pinned. Each Stream row exposes its latest Recap through a hover/focus icon and popover. A non-empty Attention page places an accessible dot on the existing toggle. Zero attention renders no WorkGraph dot, contextual card, list, or empty body content.

Selecting an Attention item uses targeted owner-scoped reads for the proposal, candidate, Task, Attempt, evidence, Decision, or Recap. Each inspector opens as a dialog over `/workgraph`; domain resolution occurs only through the corresponding versioned command.

## 13. Independent sessions

An outside session that becomes idle after producing meaningful work creates an Unorganized AI work candidate. WorkGraph proposes Streams and exposes the candidate through the main attention surface. Dismissal suppresses the candidate until meaningful change or manual restore.

## 14. Stream closure, deletion, and sharing

A Stream with no durable-effect receipts may be deleted. Deletion atomically prevents new launches, cancels active Attempts, destroys its worktree or VM, discards unmerged partial work, and removes its private records according to the adapter deletion contract.

Once a durable-effect receipt exists, the Stream is closed instead of deleted. Closure abandons unfinished Work Items with an owner-visible reason, cancels active Attempts, cleans up the isolation envelope, and preserves Outcomes, Decisions, Recaps, Attempt history, evidence, and external references. A closed Stream may be reopened into a newly provisioned envelope while retaining provenance.

Stream visibility can be archived to hide inactive work while preserving its records and lifecycle. Portable WorkGraph export/restore is a separate owner-level storage operation.

Initial sharing is owner-controlled and read-only for a Stream or full WorkGraph. Sharing does not transfer ownership or Connection authority. Collaborative mutation is deferred.

## 15. Ordered changes and recovery

Clients subscribe by authenticated owner and optional resource filters. Reconnect supplies a durable cursor and receives current projections plus subsequent changes.

Workers reconcile admitted Attempts, expired leases, due source refresh, connector outbox work, and pending Recaps from durable storage. Correctness does not depend on process memory.

## 16. Acceptance criteria

1. One user cannot access another user's private WorkGraph records.
2. Cloud composition uses Convex without SQLite or Node-native database imports.
3. Local composition uses SQLite without a hosted dependency.
4. A custom adapter passes core conformance version 3, including owner-bound snapshot pagination, mutation invalidation, exact snapshot-to-change convergence, leases, and Attempt runtime recovery. An adapter offering portable owner migration also passes archive conformance version 1.
5. WorkGraph persistence, events, logs, and responses contain no provider credentials.
6. Team Connections can produce user-filtered personal candidates.
7. Intake candidates cannot execute before staging.
8. Source admission binds exact Work Source revisions, binds each admission proposal to at most one intake candidate, rejects cyclic Work Item dependencies, publishes planner changes through the ordered feed, and atomically confirms the exact reviewed proposal version.
9. Recent-first Stream matching expands to older memory cards only when the bounded recent set has low confidence.
10. Duplicate review never silently merges work.
11. Every ready Work Item may launch with its immutable resolved profile.
12. Attempt completion does not bypass the Work Item completion contract.
13. Outcome closure requires success evidence and owner confirmation.
14. Agent scope changes create Decisions that block only affected work.
15. Eight quiet hours schedule an incremental Recap; actionable output creates one notification carrying the exact Stream and Recap identifiers, while non-actionable output creates none.
16. Retry, reconnect, and worker restart do not duplicate execution ownership or external effects.
17. A Stream provisions one primary worktree or VM envelope, with optional child isolation for individual Work Items.
18. Replanning from a later Work Source revision records the revision diff and applies only an owner-confirmed keep, replace, or fork action.
19. A Stream without durable external effects can be deleted together with its isolation and unmerged work.
20. A Stream with a durable external effect can only be closed, preserving history while abandoning unfinished work with provenance.
21. The Claxedo app presents one main WorkGraph surface with inline Stream expansion and Add task as the canonical manual Task action. It uses the HTTP/JSON and ordered-change contract mounted in `claxedo-server`, while MCP tools and server workers exercise the same application services in-process.
22. Manual or pasted Work Source text supports initial source admission without an external document service.
23. WorkGraph reuses the existing app-global WorkspacePanel and top-level toggle for its Needs you and Settings views, and all Stream interaction remains inline on `/workgraph`.
24. Zero attention renders no WorkGraph indicator, card, list, or empty attention state.
25. Attention and candidate navigation remain bounded and cursor-paged, and a failed query never substitutes snapshot or fabricated data.
26. One versioned settings command atomically applies the scope-appropriate patch, including explicit override clearing: execution defaults for WorkGraph, and execution plus Recap configuration for a Stream.
