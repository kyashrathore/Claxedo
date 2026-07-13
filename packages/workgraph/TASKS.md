# WorkGraph Implementation Ledger

Last updated: 2026-07-14

This ledger records delivery status against the personal-first contracts in [PRD.md](./PRD.md), [SPEC.md](./SPEC.md), and [ARCHITECTURE.md](./ARCHITECTURE.md). The dependency-ordered long-running execution plan is [the WorkGraph end-to-end goal](../../docs/plans/2026-07-13-001-goal-execute-workgraph-end-to-end.md).

## Delivered foundation

- Runtime-neutral, owner-scoped contracts cover Streams, Tasks (`Work Item` in the service contract), optional Outcomes, Attempts, Decisions, Recaps, Work Sources, execution profiles, completion evidence, events, changes, and lifecycle commands.
- SQLite is the local and default single-node OSS adapter. Convex is the Claxedo Cloud default and supplies the hosted core graph, ordered changes, durable execution outbox, fenced leases, lifecycle cleanup, Recap jobs, and independent-session candidate jobs.
- `claxedo-server` embeds the application service locally and in its Worker-safe hosted composition. The app uses the northbound `/api/workgraph` contract; MCP tools and server workers call the same services in process.
- The approved app surface is one global WorkGraph destination after Marketplace. Streams expand inline and Add task is the canonical manual Task action.
- Local and hosted execution use one primary Stream envelope, optional child isolation, immutable Attempt profiles, Session V2 admission, reconciliation, cancellation, and two-phase close/delete cleanup.
- Eight-hour incremental Recaps run from durable local and hosted state. Only validated output from the exact tool-less Session V2 job can publish a Recap and actionable notification; failed generation retries from durable state and then creates attention.
- Connections-backed GitHub, Linear, and Jira Source Views use team-owned credentials plus personal provider mappings and allowlisted filters. WorkGraph persists Connection references, mappings, filters, and idempotent receipts without credential material.
- External-issue and independent-Session candidates share one owner-scoped backend DTO and `unorganized` lifecycle. Staging freezes one immutable Work Source revision and starts the same strict Session-backed admission path.
- Session-scoped Connection tools let local and hosted Attempts consume only their bound team Connection capabilities; the callback is removed when the Session ends.
- Source admission begins in `planning`. A valid agent Session may publish placement alternatives, duplicate evidence, optional Outcomes, Tasks and dependencies, completion contracts, and execution defaults. Invalid or unavailable output records `planning_failed`; confirmation compares against the exact rendered proposal version before creating target or source-link records.
- Reviewable admission proposals support versioned dismiss and reopen commands. Reopen restores the exact unchanged Session-authored proposal while preserving its Work Source revision and candidate binding.
- Owner-scoped bounded Attention pages unify reviewable proposals, Decisions, Task and Attempt attention, actionable Recaps, configuration requirements, and aggregated external-issue or independent-Session candidates without loading the full snapshot.
- Local and hosted provider webhooks use Connections-owned signing credentials, owner-filtered Source View routing, durable delivery deduplication, bounded fan-out, and refresh enqueueing.
- Actionable Recaps atomically publish exactly one durable owner-scoped in-app notification in SQLite and Convex. Notification acknowledgement uses versioned compare-and-set against the rendered delivery.
- Core adapter conformance version 3 covers snapshot pagination and convergence, leases, and Attempt runtime recovery. SQLite and Convex pass the core contract.
- Archive conformance version 1 covers canonical owner export/restore and rejection semantics. SQLite and Convex implement this archive surface.
- Snapshot resume is certified across SQLite process restart and reconstructed Convex service state. Owner deletion uses a durable read/write barrier, bounded physical cleanup, exact retry, and real hosted isolation cleanup.
- Targeted Evidence reads provide exact and owner/subject-bound paginated inspection in SQLite and Convex.
- SQLite candidate staging transactionally rejects a proposal already bound to another candidate, matching Convex and preserving the rejected candidate's state and version.
- Targeted proposal, candidate, Task/Attempt, Decision, Recap, and Evidence reads have SQLite and Convex parity. Background source planning and Recaps require explicit configured profiles and publish no substitute output.
- Candidate-v2 migration preserves owner scope and the unified external-issue/independent-Session candidate contract while keeping `intake` as backend-only lifecycle vocabulary.
- Owner-scoped execution capability discovery is composed locally and in hosted Claxedo Server. GET is side-effect free and accepts no workspace selector; local reads the configured repository/runtime, while hosted reads a deterministic control-plane catalog workspace distinct from Stream execution. Explicit owner-only refresh is agent/API-native and may provision the hosted catalog. Published choices come from enforceable adapter/runtime state.
- The integrated backend verification baseline is WorkGraph 248/248 and focused Claxedo Server 176/176. These are repository results, not deployed staging evidence.

## Repository-completable launch gaps

### Approved interaction and browser proof

- Keep the existing main WorkGraph screen and Add task interaction intact.
- Reuse the existing app-global WorkspacePanel and top-level toggle. WorkGraph contributes top-level Needs you and Settings views; its header controls select those views in the same panel. Zero attention renders no dot, card, list, or empty body content.
- Keep WorkGraph Settings tabless and limited to execution defaults. Keep Stream Settings tabless and Stream-scoped for execution overrides and Recap configuration, with flush content, adjacent descriptions/errors, and a pinned footer. Expose the latest Recap from each Stream row through a hover/focus icon and popover.
- Present external-issue and independent-session candidates as aggregated Unorganized AI work in Needs you, with **Add to WorkGraph** as the user action; `intake` remains backend lifecycle vocabulary.
- Open focused proposal, candidate, Task/Attempt, Decision, and actionable-Recap inspectors as dialogs over the single `/workgraph` surface.
- Align component and browser tests with the single `/workgraph` surface and dialog-based interaction.
- Run a new real local browser journey and independent Browser Use pass against the approved single-surface interaction.
- Make WorkGraph Settings consume the side-effect-free execution-capabilities GET and render typed unavailable state. Hosted setup/background work establishes the owner catalog runtime; the UI does not provision it and does not select a catalog or Stream workspace.

### Compatibility cleanup

- [x] Remove the legacy process-global graph, raw-token provider routes, Composio bridge, scheduler vocabulary, and compatibility exports from production and published entrypoint reachability while retaining migration inputs.
- [x] Complete the repository dead-code audit and remove the unreachable V1 source, direct V1 tests, development server, and compatibility-only dependencies. The explicit migration reader, legacy SQLite schema fixture, and migration verification remain available for the migration/read window.

## External credential and deployment gates

- Deploy in strict order: additive Convex schema/functions, Worker-safe Claxedo Server composition, then the Claxedo app. Staging has not been deployed and requires real Convex, Cloudflare, Clerk, control-plane, sandbox, relay, and smoke credentials.
- Provision or refresh each owner's deterministic execution catalog runtime during hosted setup/background work, and verify Settings GET observes it without invoking sandbox ensure.
- Run signed cross-user hosted policy checks and the canonical browser journey against the deployed Cloud app, Convex persistence, and hosted workspace runtime.
- Exercise production rollout, rollback/roll-forward, secret rotation, telemetry, alerts, stuck-Attempt/Recap dashboards, and migration observation in the real environment.
- Retain deployment identifiers, browser traces, screenshots/video, and smoke output as release evidence.

## Later product scope

- Owner-controlled read-only grants for a Stream or full WorkGraph.
- Additional authoring adapters beyond the initial Docs v2 integration.
- Collaborative mutation, shared ownership, organization planning, and portfolio allocation.
- Additional notification delivery channels and maintained storage adapters beyond SQLite and Convex.

## Documentation completion criteria

README, PRD, architecture, specification, public docs, MCP guidance, retained plans, and deployment docs describe the same contract: one personal WorkGraph surface; inline Streams and canonical Add task; optional Outcomes; the existing app-global WorkspacePanel with WorkGraph Needs you and execution-only Settings views; Stream-owned Recap configuration and row-level Recap access; atomic settings; bounded Attention and candidate pages; explicit errors without substitute reads or generated content; backend-only candidate/intake vocabulary; strict Session-generated planning and Recaps; an embedded `claxedo-server` application service; team credentials through Connections with personal mappings and filters; Stream-owned isolation; SQLite as the local/default OSS adapter; Convex as the Cloud default; custom adapter portability; and private-by-default access. Status documents distinguish the WorkGraph 248/248 and focused-server 176/176 repository baseline from undeployed staging evidence and report core, archive, deletion, migration, and deployment gates separately.
