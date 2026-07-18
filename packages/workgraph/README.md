# @claxedo/workgraph

A durable, event-sourced backend for organizing, executing, and remembering AI-assisted work.

WorkGraph is Claxedo's personal operating system for AI-assisted work: a durable place to organize goals, understand what agents are doing, preserve decisions and evidence, and resume work without reconstructing old conversations.

Each personal WorkGraph is physically scoped by a trusted `(organization, user)` tuple derived by the host. The organization supplies the security and Connection boundary; the WorkGraph remains the user's personal work structure inside that boundary.

## Install

```sh
npm install @claxedo/workgraph
```

`better-sqlite3` ships as a direct dependency for the local adapter; a Convex-backed host supplies its own adapter instead.

```text
Personal WorkGraph
  └─ Stream
      ├─ Task (Work Item in the service contract)
      │   └─ Attempt
      └─ Outcome (optional grouping for Tasks)
```

Streams also contain Work Sources, Decisions, artifacts, external issues, and agent discoveries. See [PRD.md](./PRD.md) for the current product contract.

## Typical flow

1. The user creates a Stream and adds Tasks, or asks an agent or authoring surface to organize exact source text.
2. “Turn into work” persists a durable planning record. A background Session V2 planner may publish ranked placement, duplicate evidence, optional Outcomes, Tasks, completion contracts, and execution defaults for compare-and-set confirmation against the exact rendered proposal version and source revision. Invalid or unavailable generation produces `planning_failed` and attention.
   A later-revision reset is a whole disposable-Stream operation: confirmation fences the exact reviewed nonterminal Task IDs and versions, rejects unrelated work or durable effects, and blocks replacement execution until durable Attempt interruption and envelope cleanup complete.
3. The Stream receives an isolated worktree or cloud VM; Tasks inherit its execution context and declare model, effort, tools, and completion contract.
4. WorkGraph launches every ready item and records each Attempt.
5. Agents update factual state, attach results, add necessary discovered work, and raise consequential Decisions for review.

Work started outside WorkGraph appears as a tenant-scoped candidate in the aggregated Unorganized AI work entry in the Needs you view of the existing app-global WorkspacePanel. Candidates use this shared attention surface rather than a separate intake, capture, or onboarding screen.

## Current delivery

The repository includes the WorkGraph application service embedded in `claxedo-server`, its backend-neutral HTTP and ordered-change contract, the SQLite local adapter, the Convex Cloud adapter, strict Session-backed source planning, Connections-backed candidates, MCP tools, and the main WorkGraph Stream tree with inline Add task. Focused package, server, Convex, and MCP verification is green in the working delivery branch. The Docs v2 adapter seam accepts exact immutable document revisions, while the current legacy Pages surface still lacks the durable revision action needed to trigger that journey.

Approved WorkspacePanel browser acceptance and the final integrated repository regression pass. The canonical real-local suite is 11/11, and an independent headless inspection confirms the accessible single-surface interaction and Add-task focus path. Real Cloud deployment evidence remains in progress. Staging has not been deployed because the GitHub staging environment does not yet contain the required Convex, Cloudflare, Clerk, control-plane, sandbox, relay, and smoke configuration. Cloud becomes release-accepted after Convex schema/functions, Worker, and app deploy in that order and the signed cross-tenant, exact capability-catalog, and canonical deployed browser journeys pass.

## Persistence

WorkGraph depends on backend-neutral storage ports.

| Composition                             | Default adapter                  |
| --------------------------------------- | -------------------------------- |
| Claxedo Cloud                           | Convex                           |
| Local Claxedo and single-node self-host | SQLite                           |
| OSS custom deployment                   | User-supplied conforming adapter |

The public atomic-store contract covers commands and queries bound to the trusted `(organization_id, owner_user_id)` tuple without depending on Convex or SQLite APIs. The versioned conformance surface below states exactly which persistence invariants are executable today.

SQLite is an adapter, not the architecture. The package exposes backend-neutral application services plus explicit SQLite and hosted adapter entry points; hosts choose the adapter when composing the service.

## Connections and external candidates

GitHub, Linear, Jira, and similar sources use organization-managed `@claxedo/connections` credentials and metadata. Each personal WorkGraph source view binds:

- an organization-owned Connection;
- the user's identity in the provider;
- saved assignment, repository, project, label, or other filters;
- sync-back policy.

Matching issues remain user-owned, tenant-scoped candidates and appear in Needs you as aggregated Unorganized AI work. **Add to WorkGraph** freezes the issue or independent AI-session discovery as one immutable Work Source revision and creates its exact admission proposal. The user reviews recent-first Stream suggestions, placement evidence, duplicate matches, optional Outcomes, and Tasks before compare-and-set confirmation.

Provider secrets and Connection metadata remain organization-owned in Connections. WorkGraph stores the user's Connection binding, provider identity mapping, filters, and sync receipts. Connectors obtain a live `CapabilityHandle` for each external operation and report authentication failure through it.

The external tracker remains authoritative for team issue state. WorkGraph owns the user's execution overlay: Attempts, Decisions, and evidence. Sync-back defaults to announcing meaningful results.

## Execution

Each Stream owns an execution workspace such as a worktree or cloud VM. Tasks run inside it, and the selected harness or agent may manage branches or nested worktrees when useful.

Execution configuration inherits through:

```text
WorkGraph defaults → Stream → optional Outcome → Task → Attempt snapshot
```

Autonomous execution launches every ready Task until the selected work completes, blocks, reaches an explicit user safety boundary, or requires a consequential Decision. Supervised execution pauses after one batch. WorkGraph has no product-level agent-capacity or work-in-progress limit.

An Attempt finishing does not complete its Task. The declared completion contract must be satisfied. Outcome closure similarly requires evidence against success criteria and user confirmation.

Before any result is integrated or published, deleting a Stream cancels Attempts and removes its WorkGraph-owned local workspace. Hosted deletion releases WorkGraph's workspace lease; the sandbox manager independently stops idle compute and reaps unowned infrastructure. Placement uses a durable compensation effect reserved before external cancellation and workspace reconciliation. Both operations retain failure history and reconcile across process restart before a stale Attempt becomes durable attention. After any durable external result, the Stream is non-deletable: closing preserves history, marks unfinished items abandoned, and stops future scheduling without destroying its workspace.

## Public surfaces

WorkGraph is embedded in `claxedo-server`. The Claxedo app uses one tenant-scoped HTTP/JSON contract with ordered change cursors mounted by that server. The server derives organization and user from trusted auth and exposes no tenant selectors. Local embedded agent tools and background workers call the same application services in-process. The standalone stdio MCP is a northbound client of the authenticated HTTP contract. Hosted in-process agent tools remain fail-closed until the invoking durable Session supplies verified organization-and-user provenance.

The embedded services are available through:

- the Claxedo app;
- TypeScript APIs for embedded hosts;
- the northbound HTTP/JSON and ordered-change API mounted by `claxedo-server`;
- scoped MCP tools for agents;
- webhook and scheduled candidate-admission workers.

Every operation is bound to an authenticated organization and owner user. Future read-only sharing uses explicit grants and never changes ownership implicitly.

## Local composition

Local hosts own the SQLite connection and compose the SQLite adapter explicitly:

```ts
import Database from "better-sqlite3"
import { createSqliteWorkGraphService } from "@claxedo/workgraph"
import { OperationIDSchema, StreamIDSchema, type WorkGraphContext } from "@claxedo/workgraph/contracts"

const database = new Database("./workgraph.db")
const workgraph = createSqliteWorkGraphService({ database }).service

const owner = {
  organizationId: "organization_demo",
  ownerUserId: "user_demo",
  actor: { type: "user", id: "user_demo" },
  requestId: "request_demo",
  access: { mode: "owner" },
} as WorkGraphContext

const created = await workgraph.execute(owner, {
  operationId: OperationIDSchema.parse("operation_demo"),
  command: { version: 1, type: "create_stream", title: "Ship Cloud" },
})
if (!created.ok) throw new Error(created.error.message)

const streamId = StreamIDSchema.parse((created.value as { streamId: string }).streamId)
const stream = await workgraph.query(owner, "streams", "read", { streamId })
console.log(stream?.title) // "Ship Cloud"
```

`claxedo-server` constructs this service with the deployment's storage, Connections, and workspace-execution adapters, mounts the standard HTTP router for app and standalone MCP clients, and supplies the service directly to local embedded agent tools and workers. Claxedo Cloud uses the same composition with Convex and hosted execution adapters.

### Execution capability discovery

`GET /api/workgraph/execution-capabilities` is the tenant-scoped, side-effect-free catalog used by WorkGraph Settings. It returns one server-attested snapshot containing a content revision, observation time, exclusive expiry, supported environments and policy values, the active runtime harness, agents, models and efforts, tools, repository choices, and connected Connection metadata. Catalog lifetime is capped at five minutes. Settings writes, Attempt admission, and autonomous execution validate the exact catalog tenant, freshness, and selected values; an expired or mismatched catalog fails explicitly. The request accepts no tenant or workspace selector. Clients render only values present in that exact snapshot. A typed `503 execution_capabilities_unavailable` identifies the unavailable catalog and whether retry is meaningful.

Local discovery reads the configured repository and live OpenCode runtime and advertises local worktrees with required repository context. Hosted discovery reads a deterministic, per-tenant catalog runtime managed by the control plane and advertises hosted workspaces with optional repository input. Attempt-level branch and worktree strategy belongs to the selected harness or agent rather than the execution profile. Compute stop, sleep, resume, and physical garbage collection are sandbox-manager concerns. Repository integration behavior is expressed through the Task prompt and completion contract and performed by the selected harness. A Stream execution workspace is created later from its resolved repository and immutable Attempt profile; an execution-profile `presetId` is a reserved adapter configuration reference and is not a workspace identifier.

`POST /api/workgraph/execution-capabilities/refresh` is the explicit tenant-authorized agent/control-plane operation that may provision or refresh the hosted catalog runtime. WorkGraph Settings consumes only the side-effect-free GET. Cloud deployment provisions this runtime during user setup or through background control-plane work so opening Settings never creates infrastructure.

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

Core conformance version 6 proves tenant isolation, operation idempotency, compare-and-set writes with append rollback, ordered tenant and Stream change cursors, stable snapshot pagination, tenant-bound resume cursors, snapshot-relevant mutation invalidation, exact snapshot-to-change convergence across adapter restart, Stream lifecycle validation, immutable Work Source revisions, evidence-backed completion, atomic arbitration between Stream deletion and durable-effect receipts, lease acquisition/renewal/expiry, Attempt runtime recovery, source-revision replacement fencing, Session-binding isolation and exact retry, and bounded Task-activity pagination across restart. Checkpoint-only changes preserve an in-progress snapshot page chain while remaining visible after its `snapshotCursor`. Cursors are opaque client continuation tokens bound to the trusted tenant and their collection or filter. `SnapshotResumeCursor` is distinct from the `ChangeCursor` watermark returned as `snapshotCursor`. A conforming Convex adapter uses bounded keyset pagination beyond the first 100 records. The app and standalone MCP aggregate every page and perform one clean restart when a snapshot-relevant tenant mutation invalidates a partial page chain. The harness imports neither SQLite nor Convex and can be registered with any test runner that accepts async test functions.

Archive conformance version 1 separately defines canonical tenant-scoped export/restore, cross-tenant and non-empty-target rejection, exact retry idempotency, conflicting-operation rejection, and malformed or secret-bearing archive rejection. SQLite and Convex implement the archive, restart, cleanup, and permanent-deletion contract in repository verification; deployed Cloud acceptance remains a separate release gate.

The maintained public package surfaces are `@claxedo/workgraph`, `/contracts`, `/domain`, `/hosted`, `/matching`, `/ports`, `/connectors`, and `/conformance`. Production entrypoints compose the V2 runtime. The retained legacy migration reader and dependency-free schema fixture are explicit migration-window inputs rather than application entrypoints.

## Boundaries

- WorkGraph owns personal work structure, backend candidate admission state, Attempts, Decisions, events, and sync receipts.
- WorkGraph owns exact Work Sources captured through agents, explicit source actions, and authoring adapters, together with their revision history. The Docs v2 adapter seam exists; a durable Docs v2 authoring surface must invoke it before the user journey is complete. The current legacy Pages surface does not provide that invocation.
- Workspace runtimes own files, processes, terminals, worktrees, cloud VMs, and agent sessions.
- Connections owns provider credentials, refresh, capability grants, and authentication health.
- The hosted control plane owns identity, team membership, entitlement, and workspace access.
- Compatibility is an explicit SQLite migration surface: the retained reader maps provable legacy records into V2 and places ambiguous records into migration intake.

See [ARCHITECTURE.md](./ARCHITECTURE.md), [SPEC.md](./SPEC.md), [COMPATIBILITY.md](./COMPATIBILITY.md), and [TASKS.md](./TASKS.md).

## License

MIT
