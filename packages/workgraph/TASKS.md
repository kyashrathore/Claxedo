# WorkGraph Implementation Ledger

Last updated: 2026-07-14

This ledger records delivery status against the personal-first contracts in [PRD.md](./PRD.md), [SPEC.md](./SPEC.md), and [ARCHITECTURE.md](./ARCHITECTURE.md).

## Delivered foundation

- Runtime-neutral contracts cover Streams, Tasks (`Work Item` in the service contract), optional Outcomes, Runs, Decisions, Work Sources, execution profiles, completion evidence, events, changes, and lifecycle commands.
- The host supplies a trusted `(organization_id, owner_user_id)` context. Public commands, queries, cursors, jobs, and archives carry no tenant selector.
- SQLite is the verified local and default single-node OSS adapter. Convex is the Claxedo Cloud default. Both adapters implement trusted tuple tenancy, bounded reads and workers, archive, cleanup, and deletion barriers in repository verification.
- `claxedo-server` is the embedding boundary for local and Worker-safe hosted composition. The full server, Convex, typecheck, Worker-safety, and package verification is green; deployed environment checks remain open.
- The approved app surface is one global WorkGraph destination after Marketplace. Streams expand inline and Add task is the canonical manual Task action.
- Local execution uses one Stream workspace, immutable Run profiles, Session V2 admission, reconciliation, cancellation, and deletion-time worktree removal. The harness or agent owns any branch or nested-worktree strategy. Hosted close/delete finalization interrupts active Sessions and releases workspace ownership on deletion while the sandbox manager owns idle compute lifecycle.
- Connections-backed GitHub, Linear, and Jira Source Views use organization-owned credentials and metadata plus user-owned provider mappings, allowlisted filters, WorkGraph bindings, and receipts.
- External-issue and independent-Session candidates share one tenant-scoped backend DTO and `unorganized` lifecycle. Staging freezes one immutable Work Source revision and starts the same strict Session-backed admission path.
- Session-scoped Connection tools let local and hosted Runs consume only their organization Connection and user binding; the callback is removed when the Session ends.
- Source admission begins in `planning`. A valid agent Session may publish placement alternatives, duplicate evidence, optional Outcomes, Tasks and dependencies, completion contracts, and execution defaults. Invalid or unavailable output records `planning_failed`; confirmation compares against the exact rendered proposal version before creating target or source-link records.
- Reviewable admission proposals support versioned dismiss and reopen commands. Reopen restores the exact unchanged Session-authored proposal while preserving its Work Source revision and candidate binding.
- Tenant-scoped bounded Attention pages unify reviewable proposals, Decisions, Task and Run attention, configuration requirements, and aggregated external-issue or independent-Session candidates without loading the full snapshot.
- Provider webhook paths use Connections-owned signing credentials, user-filtered Source View routing, durable delivery deduplication, bounded fan-out, and refresh enqueueing; hosted verification remains open.
- Core adapter conformance version 6 covers opaque tenant-and-filter-bound cursors, snapshot pagination and restart convergence, leases, Run runtime recovery, source-revision replacement fencing, Session-binding exact retry, and bounded Task-activity pagination across maintained repository compositions.
- Archive conformance version 1 covers canonical tenant export/restore and rejection semantics for SQLite and Convex.
- SQLite and Convex cover snapshot resume, archive, cleanup, owner deletion, and concurrent deletion/write barriers in repository verification.
- Targeted Evidence reads provide exact tenant/subject-bound paginated inspection in SQLite and Convex.
- Candidate staging transactionally rejects a proposal already bound to another candidate while preserving the rejected candidate's state and version in both maintained adapters.
- Targeted proposal, candidate, Task/Run, Decision, and Evidence reads are implemented locally and hosted. Background source planning requires an explicit configured profile and publishes only valid Session output.
- Candidate-v2 migration preserves tenant scope and the unified external-issue/independent-Session candidate contract while keeping `intake` as backend-only lifecycle vocabulary.
- Tenant-scoped execution capability discovery uses one exact server-attested catalog revision with observation and exclusive expiry timestamps. Its maximum lifetime is five minutes. GET is side-effect free and accepts no tenant or workspace selector; settings and execution admission reject stale, wrong-tenant, or unsupported selections explicitly.
- Signed hosted bootstrap schedules tenant owner activation as background work. Explicit refresh provisions the deterministic catalog workspace, attests its live runtime catalog, and destroys and releases the transient workspace on both successful and failed discovery. Concurrent owner activations and refreshes coalesce by trusted tenant.
- Run placement reserves durable compensation before external cancellation and cleanup. Reconciliation retries both operations across process restart and preserves each failure until compensation completes.
- Local embedded agent tools invoke WorkGraph directly in-process. The standalone stdio MCP uses authenticated northbound HTTP. Hosted embedded tools remain fail-closed until durable Session tenant provenance is available.
- Repository integration behavior is carried by Task instructions and completion contracts and executed by the selected harness; it is not an execution-catalog choice.
- The Docs v2 adapter seam admits exact immutable revisions into WorkGraph. The native document action sends only its persisted project, document, and revision identifiers into the strict planning path and opens WorkGraph Needs you for review.
- Full WorkGraph, Claxedo Server, Convex, Worker-safety, and MCP verification is green in the delivery branch. This is repository evidence, not deployed staging evidence.
- The canonical real-local WorkGraph browser suite passes 11/11 against file-backed SQLite and the embedded router. An independent headless agent-browser pass also verifies Stream creation, stable Add-task focus, durable Task submission, and the accessible single-surface tree.

## Repository-completable launch gaps

### Approved interaction and browser proof

- Keep the existing main WorkGraph screen and Add task interaction intact.
- Reuse the existing app-global WorkspacePanel and top-level toggle. WorkGraph contributes top-level Needs you and Settings views; its header controls select those views in the same panel. Zero attention renders no dot, card, list, or empty body content.
- Keep WorkGraph Settings tabless and limited to execution defaults. Keep Stream Settings tabless and Stream-scoped for execution overrides, with flush content, adjacent descriptions/errors, and a pinned footer.
- Present external-issue and independent-session candidates as aggregated Unorganized AI work in Needs you, with **Add to WorkGraph** as the user action; `intake` remains backend lifecycle vocabulary.
- Open focused proposal, candidate, Task/Run, and Decision inspectors as dialogs over the single `/workgraph` surface.
- Align component and browser tests with the single `/workgraph` surface and dialog-based interaction.
- Preserve the passing real-local browser journey and independent headless inspection as repository acceptance evidence; the deployed Cloud journey remains an external release gate.
- Make WorkGraph Settings consume the side-effect-free execution-capabilities GET and render typed unavailable state. The UI does not provision a catalog runtime and does not select a catalog or Stream workspace.
- Cover the visible Docs v2 exact-revision admission and later-revision replan journey in browser acceptance.

### Integrated backend verification

- Keep the final generated Convex API aligned with the tuple-scoped schema and hosted WorkGraph functions.
- Run the full Claxedo Server regression after the focused WorkGraph, Convex, Worker-safety, and process-restart gates; resolve unrelated deterministic failures without weakening their assertions.
- Re-run package typechecks, builds, generated-artifact checks, and archive/export/restore coverage on the integrated tree.

### Compatibility cleanup

- [x] Remove the legacy process-global graph, raw-token provider routes, Composio bridge, scheduler vocabulary, and compatibility exports from production and published entrypoint reachability while retaining migration inputs.
- [x] Complete the repository dead-code audit and remove the unreachable V1 source, direct V1 tests, development server, and compatibility-only dependencies. The explicit migration reader, legacy SQLite schema fixture, and migration verification remain available for the migration/read window.

## External credential and deployment gates

- Deploy in strict order: additive Convex schema/functions, Worker-safe Claxedo Server composition, then the Claxedo app. Staging has not been deployed and requires real Convex, Cloudflare, Clerk, control-plane, sandbox, relay, and smoke credentials.
- Provision or refresh each tenant's deterministic execution catalog runtime during hosted setup/background work, and verify Settings GET observes it without invoking sandbox ensure.
- Run signed cross-tenant hosted policy checks and the canonical browser journey against the deployed Cloud app, Convex persistence, and hosted workspace runtime.
- Exercise production rollout, rollback/roll-forward, secret rotation, telemetry, alerts, stuck-Run dashboards, and migration observation in the real environment.
- Retain deployment identifiers, browser traces, screenshots/video, and smoke output as release evidence.

## Later product scope

- Owner-controlled read-only grants for a Stream or full WorkGraph.
- Additional authoring adapters beyond the delivered Docs v2 journey.
- Collaborative mutation, shared ownership, organization planning, and portfolio allocation.
- Additional notification delivery channels and maintained storage adapters beyond SQLite and Convex.

## Documentation completion criteria

README, PRD, architecture, specification, public docs, MCP guidance, retained plans, and deployment docs describe the same contract: one personal WorkGraph physically scoped by trusted organization and user; no tenant selectors; inline Streams and canonical Add task; optional Outcomes; the existing app-global WorkspacePanel with WorkGraph Needs you and execution-only Settings views; no separate intake/onboarding surface; atomic settings; bounded Attention and candidate pages; exact capability catalogs with explicit unavailable state; backend-only candidate/intake vocabulary; strict Session-generated planning; an embedded `claxedo-server` application service; organization-owned Connection credentials and metadata with user-owned mappings, filters, and bindings; Stream-owned workspaces with harness-owned branch/worktree strategy; SQLite as the local/default OSS adapter; Convex as the Cloud default; custom adapter portability; harness-owned repository integration guided by Task instructions and completion contracts; and private-by-default access. Status documents keep deployed browser, hosted smoke, and Cloud release evidence pending until executed.
