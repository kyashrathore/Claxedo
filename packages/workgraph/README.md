# @claxedo/workgraph

WorkGraph is Claxedo's personal operating system for AI-assisted work: a durable place to organize goals, understand what agents are doing, preserve decisions and evidence, and resume work without reconstructing old conversations.

```text
Personal WorkGraph
  └─ Stream
      ├─ Task (Work Item in the service contract)
      │   └─ Attempt
      └─ Outcome (optional grouping for Tasks)
```

Streams also contain Work Sources, Decisions, Recaps, artifacts, external issues, and agent discoveries. See [PRD.md](./PRD.md) for the current product contract.

## Typical flow

1. The user creates a Stream and adds Tasks, or asks an agent or authoring surface to organize exact source text.
2. “Turn into work” persists a durable planning record. A background Session V2 planner may publish ranked placement, duplicate evidence, optional Outcomes, Tasks, completion contracts, and execution defaults for compare-and-set confirmation against the exact rendered proposal version and source revision. Invalid or unavailable generation produces `planning_failed` and attention.
3. The Stream receives an isolated worktree or cloud VM; Tasks inherit its execution context and declare model, effort, tools, completion contract, and integration expectations.
4. WorkGraph launches every ready item and records each Attempt.
5. Agents update factual state, attach results, add necessary discovered work, and raise consequential Decisions for review.
6. After eight quiet hours, WorkGraph generates a Stream Recap and surfaces only actionable attention.

Work started outside WorkGraph appears as an owner-scoped candidate in the aggregated Unorganized AI work entry in the Needs you view of the existing app-global WorkspacePanel.

## Current delivery

The repository includes embedded local and hosted service compositions, SQLite and Convex core adapters, strict Session-backed source planning and Recaps, Connections-backed candidate admission and webhooks, MCP tools, durable actionable notifications, and the main WorkGraph Stream tree with inline Add task. SQLite and Convex implement the portable archive, restart, cleanup, and permanent-deletion contracts. WorkGraph contributes top-level Needs you and Settings views to the existing app-global WorkspacePanel. WorkGraph Settings contains execution defaults only. Stream Settings is a tabless Stream-scoped dialog containing Stream execution and Recap configuration, and each Stream row exposes its latest Recap through a hover/focus Recap icon and popover. Proposal and candidate review, Task and Attempt results, and Decisions use focused dialogs over the main surface.

Core adapter conformance version 3 covers leases and Attempt runtime recovery. Snapshot resume across adapter restart, Convex archive parity, owner-level permanent deletion, bounded Attention, and candidate-v2 migration are implemented for the maintained adapters. The current backend baseline is WorkGraph 248/248 and focused Claxedo Server 176/176. Replacement browser acceptance and real Cloud deployment evidence remain open. Staging has not been deployed. Cloud becomes release-accepted after Convex schema/functions, Worker, and app deploy in that order and the signed cross-user and canonical browser journeys pass.

## Persistence

WorkGraph depends on backend-neutral storage ports.

| Composition | Default adapter |
|---|---|
| Claxedo Cloud | Convex |
| Local Claxedo and single-node self-host | SQLite |
| OSS custom deployment | User-supplied conforming adapter |

The public atomic-store contract covers owner-scoped commands and queries without depending on Convex or SQLite APIs. The versioned conformance surface below states exactly which persistence invariants are executable today.

SQLite is an adapter, not the architecture. The package exposes backend-neutral application services plus explicit SQLite and hosted adapter entry points; hosts choose the adapter when composing the service.

## Connections and external candidates

GitHub, Linear, Jira, and similar sources use team-managed `@claxedo/connections` credentials. Each personal WorkGraph source view binds:

- a team Connection identified within its organization;
- the user's identity in the provider;
- saved assignment, repository, project, label, or other filters;
- sync-back policy.

Matching issues remain owner-scoped candidates and appear in Needs you as aggregated Unorganized AI work. **Add to WorkGraph** freezes the issue or independent AI-session discovery as one immutable Work Source revision and creates its exact admission proposal. The user reviews recent-first Stream suggestions, placement evidence, duplicate matches, optional Outcomes, and Tasks before compare-and-set confirmation. SQLite and Convex finalize the linked candidate atomically with that reviewed proposal, and both reject binding one proposal to a second candidate without mutating it.

Provider secrets remain in Connections. WorkGraph stores connection references, provider identity mappings, filters, and sync receipts. Connectors obtain a live `CapabilityHandle` for each external operation and report authentication failure through it.

The external tracker remains authoritative for team issue state. WorkGraph owns the user's execution overlay: Attempts, Decisions, Recaps, and evidence. Sync-back defaults to announcing meaningful results.

## Execution

Each Stream owns a disposable execution envelope such as a worktree or cloud VM. Tasks run inside it and may create child isolation for concurrent work.

Execution configuration inherits through:

```text
WorkGraph defaults → Stream → optional Outcome → Task → Attempt snapshot
```

Autonomous execution launches every ready Task until the selected work completes, blocks, reaches an explicit user safety boundary, or requires a consequential Decision. Supervised execution pauses after one batch. WorkGraph has no product-level agent-capacity or work-in-progress limit.

An Attempt finishing does not complete its Task. The declared completion contract must be satisfied. Outcome closure similarly requires evidence against success criteria and user confirmation.

Before any result is integrated or published, deleting a Stream cancels Attempts and destroys its isolated environment and unmerged work. After any durable external result, the Stream is non-deletable: closing preserves history, marks unfinished items abandoned, and cleans up isolation.

## Public surfaces

WorkGraph is embedded in `claxedo-server`. The Claxedo app uses one owner-scoped HTTP/JSON contract with ordered change cursors mounted by that server. MCP tools, background workers, connector reconciliation, and other server features call the same application services in-process rather than making HTTP requests back into the server.

The embedded services are available through:

- the Claxedo app;
- TypeScript APIs for embedded hosts;
- the northbound HTTP/JSON and ordered-change API mounted by `claxedo-server`;
- scoped MCP tools for agents;
- webhook, scheduled candidate-admission, and background Recap workers.

Every operation is bound to an authenticated owner. Future read-only sharing uses explicit grants and never changes ownership implicitly.

Actionable Recaps create one durable owner-scoped notification in the same atomic write as the Recap. The notification carries the exact Stream and Recap identifiers, and acknowledgement uses the rendered notification version so retries, newer Recaps, and stale tabs do not mark the wrong delivery as read. Needs you opens the exact Recap in its focused inspector before acknowledging that rendered notification version.

## Local composition

Local hosts own the SQLite connection and compose the SQLite adapter explicitly:

```ts
import Database from "better-sqlite3"
import { createSqliteWorkGraphService } from "@claxedo/workgraph"

const database = new Database("./workgraph.db")
const workgraph = createSqliteWorkGraphService({ database }).service
```

`claxedo-server` constructs this service with the deployment's storage, Connections, and workspace-execution adapters, mounts the standard HTTP router for app clients, and supplies the service directly to its MCP and worker modules. Claxedo Cloud uses the same composition with Convex and hosted execution adapters.

### Execution capability discovery

`GET /api/workgraph/execution-capabilities` is the owner-scoped, side-effect-free catalog used by WorkGraph Settings. It returns schema version, observation time, supported environments and policy values, the active runtime harness, agents, models and efforts, tools, repository choices, and connected Connection metadata. The request accepts no workspace selector. A typed `503 execution_capabilities_unavailable` identifies the unavailable catalog and whether retry is meaningful; clients keep that state explicit.

Local discovery reads the configured repository and live OpenCode runtime. It advertises local worktrees, required repository context, Stream or child isolation, destroy-on-close or retain cleanup, and manual integration. Hosted discovery reads a deterministic, per-owner catalog runtime managed by the control plane. It advertises hosted workspaces, optional repository input, Stream isolation, destroy-on-close cleanup, and manual integration. The catalog runtime exists only to observe executable choices. A Stream execution workspace is created later from its resolved repository and immutable Attempt profile; an execution-profile `presetId` is not a workspace identifier.

`POST /api/workgraph/execution-capabilities/refresh` is the explicit owner-authorized agent/control-plane operation that may provision or refresh the hosted catalog runtime. WorkGraph Settings consumes only the side-effect-free GET. Cloud deployment provisions this runtime during owner setup or through background control-plane work so opening Settings never creates infrastructure.

## Custom adapters and conformance

OSS adapters use the public contracts, ports, and runner-neutral conformance entry points:

```ts
import { describe, test } from "vitest"
import { workGraphAdapterConformance } from "@claxedo/workgraph/conformance"
import { createWorkGraphService } from "@claxedo/workgraph/hosted"
import { defineAtomicWorkGraphStore } from "@claxedo/workgraph/ports"

const factory = async (input) => {
  const store = defineAtomicWorkGraphStore({
    commands: createCommands(input),
    queries: createQueries(input),
  })
  return { service: createWorkGraphService(store), faults: createFaultControls() }
}

describe("my WorkGraph adapter", () => {
  workGraphAdapterConformance(factory).forEach((testCase) => test(testCase.name, testCase.run))
})
```

Core conformance version 3 proves owner isolation, operation idempotency, compare-and-set writes with append rollback, ordered owner and Stream change cursors, stable snapshot pagination, owner-bound resume cursors, mutation invalidation, exact snapshot-to-change convergence, Stream lifecycle validation, immutable Work Source revisions, evidence-backed completion, atomic arbitration between Stream deletion and durable-effect receipts, lease acquisition/renewal/expiry, and Attempt runtime recovery. `SnapshotResumeCursor` is a branded page-continuation token distinct from the `ChangeCursor` watermark returned as `snapshotCursor`. Convex uses bounded keyset pagination beyond the first 100 records. The app and MCP aggregate every page and perform one clean restart when owner mutation invalidates a partial page chain. The harness imports neither SQLite nor Convex and can be registered with any test runner that accepts async test functions.

Archive conformance version 1 separately proves canonical owner-scoped export/restore, cross-owner and non-empty-target rejection, exact retry idempotency, conflicting-operation rejection, and malformed or secret-bearing archive rejection. SQLite and Convex implement this surface together with snapshot resume across adapter restart, workspace cleanup, and owner-level permanent deletion.

The maintained public package surfaces are `@claxedo/workgraph`, `/contracts`, `/domain`, `/hosted`, `/matching`, `/ports`, `/connectors`, and `/conformance`. Production entrypoints compose the V2 runtime. The retained legacy migration reader and dependency-free schema fixture are explicit migration-window inputs rather than application entrypoints.

## Boundaries

- WorkGraph owns personal work structure, backend candidate admission state, Attempts, Decisions, Recaps, events, and sync receipts.
- WorkGraph owns exact Work Sources captured through agents, explicit source actions, and authoring adapters, together with their revision history. Docs v2 is the initial authoring adapter; additional authoring systems supply exact external revisions through the same source contract.
- Workspace runtimes own files, processes, terminals, worktrees, cloud VMs, and agent sessions.
- Connections owns provider credentials, refresh, capability grants, and authentication health.
- The hosted control plane owns identity, team membership, entitlement, and workspace access.
- Compatibility is an explicit SQLite migration surface: the retained reader maps provable legacy records into V2 and places ambiguous records into migration intake.

See [ARCHITECTURE.md](./ARCHITECTURE.md), [SPEC.md](./SPEC.md), [COMPATIBILITY.md](./COMPATIBILITY.md), and [TASKS.md](./TASKS.md).

## License

MIT
