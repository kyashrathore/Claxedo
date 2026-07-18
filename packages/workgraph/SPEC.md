# WorkGraph Service Specification

Status: core package contract verified; Convex/server completion, approved UI proof, Docs v2 activation, and Cloud deployment remain tracked in `TASKS.md`

## 1. Purpose

WorkGraph is a user-owned service for organizing AI-assisted work, executing it across Claxedo runtimes, and preserving enough state to resume without reconstructing documents and sessions.

Claxedo Cloud uses Convex by default. Local and single-node self-hosted Claxedo use SQLite. OSS deployments may supply conforming storage adapters.

### 1.1 Host composition

`claxedo-server` embeds one WorkGraph application-service composition. It mounts the backend-neutral HTTP/JSON and ordered-change router as the northbound contract used by the Claxedo app and standalone stdio MCP. Local embedded agent tools, webhooks, background workers, and reconcilers receive the application services directly and invoke them in-process. Hosted embedded agent tools are registered only when durable Session provenance supplies a verified organization and owner user.

The host supplies verified identity, storage, Connections, and workspace-execution adapters. Cloud and local deployments preserve this service boundary while selecting Convex or SQLite respectively.

## 2. Request context

Every operation receives trusted context:

```ts
interface WorkGraphContext {
  organizationID: string
  ownerUserID: string
  actor: { type: "user" | "agent" | "system"; id: string }
  requestID: string
  access: { mode: "owner" | "shared_read" }
}
```

The host derives organization, owner, and access from verified identity and authority. Public operations do not accept organization, owner, workspace, or tenant selectors. Every command, query, idempotency key, cursor, background record, and archive operation is bound to the trusted `(organizationID, ownerUserID)` tuple.

## 3. Domain records

Every personal durable record includes required `organization_id` and `owner_user_id`, stable ID, creation time, and appropriate update/schema metadata. Physical primary keys and indexes begin with the trusted tuple. Organization-owned Connection credentials and metadata use organization scope; personal Source Views and Attempt bindings retain the user dimension.

### 3.1 Stream

A Stream is a finite or ongoing work context and owns the primary execution workspace. It contains purpose, lifecycle, pinned state, execution defaults, activity marker, base repository/revision, workspace intent and identity, durable-effect state, and linked Outcomes and sources.

### 3.2 Outcome

An Outcome is a shippable result with success criteria, evidence, state, and optional execution defaults. Satisfied criteria produce `ready_to_close`; owner confirmation produces `completed`. New required work or contradictory evidence may reopen it with provenance.

### 3.3 Work Item

A Work Item is presented to users as a Task. It contains title, description, state, optional Outcome membership, dependencies, priority, source links, execution overrides, completion contract, and completion evidence.

Truthful states distinguish pending, active, result ready, review needed, integration needed, blocked, verification failed, completed, failed, and archived work.

### 3.4 Attempt

An Attempt is one execution try. It stores an immutable resolved execution profile including execution environment, repository revision, harness, agent, model, effort, tools, and Connection references.

Attempt state distinguishes admission, placement, running, attention, terminal execution result, and cancellation. A retry creates another Attempt.

### 3.5 Decision

A Decision stores its question, options, recommendation, rationale, answer, actor provenance, affected work, and state. Agents create Decisions when execution reaches a consequential owner choice. A pending Decision appears in attention and blocks only affected and dependent work.

### 3.6 Work Source

A Work Source stores owner-entered text, title, immutable revisions, optional source metadata, and links to admission proposals and confirmed work. Editing appends a revision. Confirmed work binds the exact revision ID and content hash used to produce it. Confirmation compares against the exact proposal version rendered for review, so a background planner publication requires a new review before it can materialize work.

### 3.7 Source view and intake candidate

A personal source view binds an organization-owned Connection, provider integration, user identity in that provider, filters, refresh/webhook settings, and sync-back policy.

Connector results and meaningful independent sessions create intake candidates. Candidates are not executable Work Items. Staging performs explicit admission.

### 3.8 External identity

An external identity stores provider, organization Connection reference, external ID/key/URL, normalized metadata, and observed revision. The unique identity includes organization, owner user, provider, Connection, and external ID.

### 3.9 Event and receipt

Events include organization, owner user, Stream, sequence, schema version, operation ID, actor, payload, correlation/causation, and timestamp. Connector receipts record external effects and idempotency without secret material. Durable-effect receipts identify merged or directly integrated code, published artifacts, accepted external writes, and equivalent results that make a Stream's history externally consequential.

## 4. Storage contract

The backend-neutral store covers Streams, Outcomes, Work Items, intake, Attempts, Decisions, events, leases, idempotency, change cursors, and connector receipts.

Every core adapter provides:

1. Trusted organization-and-user-scoped reads and writes with no caller-selectable tenant fields.
2. Atomic domain command plus event/outbox append.
3. Monotonic per-stream event ordering.
4. Unique operation IDs.
5. Compare-and-set transitions.
6. Expiring lease acquisition and renewal.
7. Stable cursor pagination and reconnect cursors.
8. Ordered change feed with reconnect cursors.
9. Versioned migrations.

Portable tenant export and restore use a separate versioned archive port and conformance contract. SQLite and Convex implement archive, restart, workspace cleanup, and permanent deletion in repository verification. The staged deployment exercises the Convex path again under signed tenant authority before Cloud release acceptance.

Core conformance version 6 distinguishes the opaque `SnapshotResumeCursor` used only to continue one page chain from the `ChangeCursor` watermark returned as `snapshotCursor`. Collection cursors bind organization, owner, collection or filter, and keyset position. Snapshot resume cursors additionally bind the snapshot watermark and capture time; malformed, cross-tenant, cross-filter, and snapshot-relevant-mutation-invalidated cursors fail with `cursor_invalid`. Checkpoint and Session-binding changes that do not alter snapshot records preserve the current page chain and are consumed afterward through ordered changes. App and standalone MCP consumers validate and aggregate the full page chain and may discard one invalidated partial chain for one clean restart before surfacing failure.

### 4.1 Convex adapter

Convex is the hosted default. Its contract uses required `(organization_id, owner_user_id)` fields and tuple-leading indexes for every personal record, cursor, queue, archive, attention, and deletion path. Authenticated server queries/mutations, ordered changes, and scheduled functions support multi-instance operation without process-local correctness state. The app remains on the server-mounted HTTP/change contract and does not depend directly on Convex APIs. Repository verification covers the hosted implementation, migrations, bounded workers, archive, cleanup, and deletion barriers. Cloud acceptance requires the real staged deployment and signed cross-tenant journey.

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

The planning job uses a caller-owned stable Session/message identity. Lost admission responses retry that exact identity; strict result validation, immutable source binding, proposal-version compare-and-set, lease fencing, and dependency-cycle validation prevent stale or malformed output from materializing work. Agent publication appends an ordered tenant change so connected clients refetch the proposal.

The owner edits and confirms the exact rendered package version. A later Work Source revision presents the source diff and a reviewable replan with three choices:

- keep confirmed work and admit selected additions;
- reset a wholly disposable Stream, cancelling obsolete Attempts and discarding its partial workspace state;
- fork a new Stream from the revision while preserving the existing Stream.

The reset selection carries the exact reviewed nonterminal Task IDs and versions. Confirmation requires that set to equal every current nonterminal Task in the Stream and requires every Task to reference the proposal's previous source revision. Any version drift, added unrelated work, or durable-effect receipt rejects reset and directs the owner to keep or fork. The adapter atomically abandons only the fenced set, fences active Attempt leases and launches, and records a durable reset barrier plus cleanup control effect. Replacement Tasks remain ineligible for execution until ordered Session interruption and whole-envelope cleanup are acknowledged. Completed Tasks, Attempt history, source lineage, Decisions, and evidence remain durable.

The selected action is recorded with the exact old and new source revisions. Confirmed work changes only after owner approval. The Documents adapter creates and pins a content-hash snapshot from the canonical workspace file at intake, then passes those exact bytes and provenance through the same proposal, compare-and-set confirmation, and replan contract. Agent-driven and explicit source capture use the same contract without depending on a separate revision-table service.

## 6. Connections and external intake

All provider credentials and Connection metadata remain in `@claxedo/connections` under organization ownership. Each personal source view separately records the WorkGraph user's provider identity and filters, and each Attempt binding records only the exact authorized Connection references and tools. A source view resolves an organization-scoped `CapabilityHandle` after verifying the user still has access to that Connection.

The connector receives a live token supplier and authentication-failure reporter. WorkGraph stores the organization Connection reference, provider user mapping, and filters but no token or API key.

Saved filters produce personal candidates. Staging checks external identity idempotency, duplicate matches, and Stream placement before creating or linking a Work Item.

The external tracker remains authoritative for team issue state. WorkGraph's default sync-back policy announces meaningful results. Silent and full policies are explicit source-view choices.

Webhook handlers verify signatures, resolve affected source views, apply each owner's filters, deduplicate deliveries, and enqueue candidate refresh.

## 7. Stream matching and duplicates

Each Stream is matched from a compact title, description, and purpose summary. Placement searches pinned and recent Streams first and expands to older Streams only on low confidence. The response includes best match, alternatives, confidence explanation, and create-new choice.

Duplicate review compares compact active/recent Outcome and Work Item representations. A match offers link, merge, or create separately. No uncertain placement or merge occurs without owner confirmation.

## 8. Execution profiles

Execution settings resolve in this order, skipping the Outcome layer for an ungrouped Task:

```text
WorkGraph → Stream → optional Outcome → Task → Attempt
```

The Work Item exposes resolved values and their source. Attempt admission stores the immutable resolved snapshot.

WorkGraph and Stream settings use one versioned atomic command per save. WorkGraph Settings applies execution-default changes only. Stream Settings applies Stream execution changes. Each command appends one ordered change and rejects a stale aggregate version without a partial write. An omitted execution field remains unchanged; an explicit clear removes the override so inheritance is recalculated from persisted parent settings.

### 8.1 Capability discovery

`GET /execution-capabilities` returns one server-attested, tenant-bound schema-version-1 observation and accepts no organization, user, tenant, or workspace identifier. The response contains a content-addressed `catalogRevision`, `observedAt`, exclusive `expiresAt`, supported environment inputs and policy values, harnesses, agents, models with supported efforts, tools, repository metadata, and connected Connection metadata. Catalog lifetime is at most five minutes. Settings writes and Attempt admission validate the exact catalog tenant, freshness, and selections. Discovery failure returns `execution_capabilities_unavailable` with a typed capability, reason, message, and retryability; unavailable, stale, wrong-tenant, and unsupported catalog state cannot authorize execution.

The GET operation is side-effect free. Local composition reads the configured Git repository and live local runtime. Hosted composition reads a deterministic per-tenant catalog workspace that the control plane manages independently of Stream execution. `POST /execution-capabilities/refresh` is an explicit tenant-bound agent/control-plane operation that may provision or refresh that catalog. Hosted background setup invokes it before the app requires the catalog; the app consumes GET only.

The catalog workspace supplies live runtime choices and has no execution repository. Hosted repository remote and base revision remain validated inputs when the Stream execution workspace is later provisioned. Execution-profile `presetId` is reserved for adapter configuration and represents neither the catalog workspace nor a Stream workspace.

Current local capabilities are `local_worktree` with required repository context. Current hosted capabilities are `hosted_workspace` with optional repository input. Adapters publish only values their placement implementations enforce. Branch, worktree, and repository integration behavior belongs to the Task prompt, completion contract, and selected harness rather than the execution profile.

Execution first provisions or adopts the Stream's logical workspace: a dedicated worktree for local repository work or a workspace identity that can be placed on ephemeral remote compute. Work Items and Attempts execute inside that workspace. The selected harness or agent may manage branches or nested worktrees within its available tools. Remote compute may stop between Attempts and is resumed or recreated by the sandbox manager; durable Stream state does not depend on a VM remaining alive.

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

Dispatch acquires a durable execution lease before placement inside the Stream envelope. The workspace execution port hides local, user-hosted, and cloud placement and returns stable Stream-envelope, child-workspace, and session identities. Before external cancellation or cleanup, WorkGraph reserves a durable placement-compensation effect. Reconciliation attempts cancellation and cleanup independently, records each failure, and retries the effect across process restart. A stale admitted or placing Attempt becomes durable attention only after compensation completes.

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

## 12. Attention

The tenant-scoped Attention query returns bounded, stable cursor pages covering reviewable proposals, pending Decisions, Task and Attempt attention, configuration requirements, and one aggregate for unorganized external-issue and independent-Session candidates. Candidate drilldown uses a separate bounded tenant-bound cursor. These candidates appear only through Needs you and focused dialogs; WorkGraph has no separate intake, capture, or onboarding screen. Ordered changes trigger bounded refresh; Attention and candidate failures are explicit and never cause a full-snapshot substitute read.

The existing app-global WorkspacePanel and its top-level toggle are the only panel instance and panel control. WorkGraph contributes top-level Needs you and Settings views. WorkGraph header controls select those views in that same panel. WorkGraph Settings is a tabless execution-defaults view. Stream Settings is a tabless Stream-scoped dialog containing Stream execution settings; settings fields are flush, descriptions and errors are adjacent to their fields, and the footer is pinned. A non-empty Attention page places an accessible dot on the existing toggle. Zero attention renders no WorkGraph dot, contextual card, list, or empty body content.

Selecting an Attention item uses targeted tenant-scoped reads for the proposal, candidate, Task, Attempt, evidence, or Decision. Each inspector opens as a dialog over `/workgraph`; domain resolution occurs only through the corresponding versioned command.

## 13. Independent sessions

An outside session that becomes idle after producing meaningful work creates an Unorganized AI work candidate. WorkGraph proposes Streams and exposes the candidate through the main attention surface. Dismissal suppresses the candidate until meaningful change or manual restore.

## 14. Stream closure, deletion, and sharing

A Stream with no durable-effect receipts may be deleted. Deletion atomically prevents new launches, cancels active Attempts, destroys its worktree or VM, discards unmerged partial work, and removes its private records according to the adapter deletion contract.

Once a durable-effect receipt exists, the Stream is closed instead of deleted. Closure abandons unfinished Work Items with an owner-visible reason, cancels active Attempts, stops future scheduling, and preserves the workspace, Outcomes, Decisions, Attempt history, evidence, and external references.

Stream visibility can be archived to hide inactive work while preserving its records and lifecycle. Portable WorkGraph export/restore is a separate tenant-level storage operation.

Initial sharing is owner-controlled and read-only for a Stream or full WorkGraph. Sharing does not transfer ownership or Connection authority. Collaborative mutation is deferred.

## 15. Ordered changes and recovery

Clients subscribe by authenticated tenant and optional resource filters. Reconnect supplies a durable cursor and receives current projections plus subsequent changes.

Workers reconcile admitted Attempts, expired leases, due source refresh, and connector outbox work from durable storage. Correctness does not depend on process memory.

## 16. Acceptance criteria

1. One `(organization, user)` tenant cannot access another tenant's private WorkGraph records, including the same user represented in two organizations.
2. Cloud composition uses Convex without SQLite or Node-native database imports.
3. Local composition uses SQLite without a hosted dependency.
4. A custom adapter passes core conformance version 6, including tenant-bound cursor pagination, snapshot-relevant mutation invalidation, exact snapshot-to-change convergence across adapter restart, leases, Attempt runtime recovery, source-revision replacement fencing, Session-binding exact retry, and bounded Task-activity pagination. An adapter offering portable tenant migration also passes archive conformance version 1.
5. WorkGraph persistence, events, logs, and responses contain no provider credentials.
6. Organization Connections can produce user-filtered personal candidates without transferring credential or Connection-metadata ownership into WorkGraph.
7. Intake candidates cannot execute before staging.
8. Source admission binds exact Work Source revisions, binds each admission proposal to at most one intake candidate, rejects cyclic Work Item dependencies, publishes planner changes through the ordered feed, and atomically confirms the exact reviewed proposal version.
9. Recent-first Stream matching expands to older Streams only when the bounded recent set has low confidence.
10. Duplicate review never silently merges work.
11. Every ready Work Item may launch with its immutable resolved profile.
12. Attempt completion does not bypass the Work Item completion contract.
13. Outcome closure requires success evidence and owner confirmation.
14. Agent scope changes create Decisions that block only affected work.
15. Retry, reconnect, and worker restart do not duplicate execution ownership or external effects.
16. A Stream provisions one worktree or VM workspace; harnesses and agents own any branch or nested-worktree strategy inside it.
17. Replanning from a later Work Source revision records the revision diff and applies only an owner-confirmed keep, replace, or fork action.
18. A Stream without durable external effects can be deleted together with its workspace and unmerged work.
19. A Stream with a durable external effect can only be closed, preserving history while abandoning unfinished work with provenance.
20. The Claxedo app presents one main WorkGraph surface with inline Stream expansion and Add task as the canonical manual Task action. The app and standalone stdio MCP use the authenticated HTTP/JSON and ordered-change contract mounted in `claxedo-server`; local embedded agent tools and server workers invoke the same application services in-process; hosted embedded tools require durable Session tenant provenance.
21. Manual or pasted Work Source text supports initial source admission without an external document service.
22. WorkGraph reuses the existing app-global WorkspacePanel and top-level toggle for its Needs you and Settings views, and all Stream interaction remains inline on `/workgraph`.
23. Zero attention renders no WorkGraph indicator, card, list, or empty attention state.
24. Attention and candidate navigation remain bounded and cursor-paged, and a failed query never substitutes snapshot or fabricated data.
25. One versioned settings command atomically applies the scope-appropriate patch, including explicit override clearing: execution defaults for WorkGraph and execution settings for a Stream.
