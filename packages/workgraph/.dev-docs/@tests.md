# Workgraph Test Documentation

## 1. Test Architecture

- **Runner**: Bun native test framework (`bun:test`)
- **Language**: TypeScript
- **Database**: SQLite in-memory (`:memory:`) for isolation
- **No external config files needed** -- no `jest.config`, no `vitest.config`, no `bunfig.toml` for tests
- **Imports**: `describe`, `it`/`test`, `expect`, `beforeEach`, `afterEach`, `mock` from `"bun:test"`
- **DB layer**: `bun:sqlite` `Database` class for raw SQLite, `drizzle-orm/bun-sqlite` when ORM queries are tested
- **Current count**: 645 tests across 56 files, 0 failures

## 2. Running Tests

```bash
# Run all tests
bun run test

# Run a single file
bun run test test/reducer.test.ts

# Run tests matching a pattern
bun run test test/connectors/

# Run integration tests only
bun run test test/integration/

# Increase timeout for slower integration tests
bun run test --timeout 10000
```

The `package.json` script is `"test": "bun test"`.

## 3. Test Directory Structure

```
test/
├── *.test.ts                          # Unit tests (reducers, services, models, API routes)
├── connectors/                        # Connector adapter tests
│   ├── github.test.ts                 # GitHub connector (mocked Octokit)
│   ├── jira.test.ts                   # Jira connector (mocked fetch)
│   ├── linear.test.ts                 # Linear connector (mocked fetch)
│   └── integration/
│       └── connector-roundtrip.test.ts  # Connector roundtrip tests
├── integration/                       # Multi-component integration tests
│   ├── collaboration-flow.test.ts     # Collaboration flows (needs cleanup — stale team refs)
│   ├── e2e-mcp-orchestration.test.ts  # MCP-driven e2e: 35 tests covering full orchestration lifecycle
│   ├── e2e-pipeline.test.ts           # End-to-end pipeline tests
│   ├── event-replay.test.ts           # Event replay correctness
│   ├── hash-chain-integrity.test.ts   # Hash chain verification across events
│   ├── planning-pipeline.test.ts      # Decompose -> route -> dispatch pipeline
│   ├── repair-recovery.test.ts        # Repair and recovery flows
│   ├── scheduler-integration.test.ts  # Scheduler with real graph + leases
│   └── sync/
│       ├── conflict-resolution.test.ts  # Sync conflict resolution
│       └── sync-recovery.test.ts        # Sync recovery after failures
```

## 4. Test Categories

### Reducer tests
Pure `state -> event -> new state` transformations. One file per reducer domain.

| File | Domain |
|------|--------|
| `reducer.test.ts` | Core item/edge reducer (item_created, item_updated, edge_added, etc.) |
| `node_reducer.test.ts` | Node lifecycle (node_created, node_completed, node_failed) |
| `run_reducer.test.ts` | Run state machine (run_created, run_planned, run_completed) |
| `edge_reducer.test.ts` | Edge add/remove with graph consistency |
| `sync_reducer.test.ts` | Sync state tracking |
| `artifact_reducer.test.ts` | Artifact creation and linking |
| `root_reducer.test.ts` | Composed root reducer dispatching |

### Service tests
Business logic with side effects (DB, in-memory state, hashing).

| File | Domain |
|------|--------|
| `event-store.test.ts` | Append, retrieve, deduplicate, replay events via SQLite |
| `hash-chain.test.ts` | SHA-256 hash chain computation and tamper detection |
| `scratchpad.test.ts` | Ephemeral scratchpad: write, read, TTL cleanup, promote to artifact |
| `quality-gate.test.ts` | Quality gate pass/fail evaluation |
| `watchdog.test.ts` | Watchdog timeout and heartbeat monitoring |

### Model tests
WorkGraph class CRUD, dependency graph, hooks, persistence.

| File | Domain |
|------|--------|
| `workgraph.test.ts` | Full WorkGraph class: create/get/update/remove, deps, cycles, events, persistence |
| `hooks.test.ts` | `onComplete` hook: comment push, status unblock, error resilience |
| `graph.test.ts` | GraphEngine: adjacency, traversal, topology |
| `gates.test.ts` | Gate conditions and evaluation |
| `hydration.test.ts` | Hydration from external providers |
| `lifecycle.test.ts` | Item lifecycle state machine |

### MCP and orchestration tests

| File | Domain |
|------|--------|
| `planner.test.ts` | buildPlannerPrompt + MCP planning tools (create_node, add_edge, validate_graph, finish_planning) |
| `orchestrator.test.ts` | findReadyNodes, onPlanningComplete, onNodeStatusUpdate, MCP task tools, route endpoints |
| `mcp-route.test.ts` | HTTP bridge: GET /mcp/tools/list, POST /mcp/tools/call |
| `backends.test.ts` | Backend abstraction (SessionBackend, SubprocessBackend) |
| `acp-backend.test.ts` | ACP backend adapter |
| `acp-event-translator.test.ts` | ACP event translation |
| `acp-registry.test.ts` | ACP capability registry |
| `workgraph-bridge.test.ts` | Bridge between WorkGraph and orchestrator |

### Connector tests
Adapter tests for external issue trackers. Mock the transport layer (Octokit, fetch).

| File | Domain |
|------|--------|
| `connectors/github.test.ts` | GitHub: hydrate, update, comment, create via mocked Octokit |
| `connectors/jira.test.ts` | Jira: REST API mocking |
| `connectors/linear.test.ts` | Linear: GraphQL API mocking |
| `connectors/integration/connector-roundtrip.test.ts` | Full roundtrip: create -> hydrate -> update -> verify |

### Integration tests
Multi-component pipelines exercising the full stack.

| File | Domain |
|------|--------|
| `integration/e2e-mcp-orchestration.test.ts` | **Primary e2e suite** — 35 tests: linear chain, diamond DAG, wide parallel, deep chain, retry+success, cascading failure, mixed branches, scratchpad communication, cancel, cycles, deadlock, event audit, status queries, WorkGraph integration, HTTP API, ACP endpoints, complex 8-node graph, artifacts, concurrent runs |
| `integration/planning-pipeline.test.ts` | Decompose goal -> route to capabilities -> dispatch |
| `integration/e2e-pipeline.test.ts` | End-to-end pipeline tests |
| `integration/event-replay.test.ts` | Replay all events -> verify state matches live |
| `integration/hash-chain-integrity.test.ts` | Build chain -> tamper -> verify detection |
| `integration/scheduler-integration.test.ts` | Scheduler with graph engine, leases |
| `integration/repair-recovery.test.ts` | Repair flows after node failures |
| `integration/collaboration-flow.test.ts` | Collaboration flows (stale — references deleted team model) |
| `integration/sync/conflict-resolution.test.ts` | Sync conflict resolution strategies |
| `integration/sync/sync-recovery.test.ts` | Recovery from sync interruptions |

### API tests
HTTP route testing using Hono's `app.request()` (no real HTTP server needed).

| File | Domain |
|------|--------|
| `runs.test.ts` | `POST /runs`, `GET /runs/:id`, nodes, edges, ready endpoint |
| `planning-api.test.ts` | `POST /runs/:id/plan`, `GET /runs/:id/plan`, dispatch, route preview |
| `scratchpad-api.test.ts` | Scratchpad HTTP endpoints |
| `work-routes.test.ts` | Work item CRUD routes |

### Other tests

| File | Domain |
|------|--------|
| `events.test.ts` | Event type definitions and serialization |
| `event-types.test.ts` | Event type enum validation |
| `schema.test.ts` | Zod schema validation |
| `routing.test.ts` | Capability routing and scoring |
| `planning.test.ts` | Planning question generation |
| `repair.test.ts` | Repair strategies (unit level) |
| `sync.test.ts` | Sync protocol (unit level) |
| `conflict.test.ts` | Conflict detection and resolution logic |
| `reactions.test.ts` | Reaction system |
| `lead-loop.test.ts` | Lead agent loop execution |
| `db_projection.test.ts` | DB projection/materialized view tests |

## 5. Testing Conventions

### Setup and teardown

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

describe("MyService", () => {
  let service: MyService;

  beforeEach(() => {
    service = new MyService();
  });

  afterEach(() => {
    service.close(); // if needed
  });
});
```

### In-memory SQLite per test

Two patterns are used depending on the abstraction level:

**Pattern A -- Raw `bun:sqlite` with manual schema:**
```ts
import { Database } from "bun:sqlite";

beforeEach(() => {
  const sqlite = new Database(":memory:");
  sqlite.run(`CREATE TABLE events ( ... )`);
  db = drizzle(sqlite);
});
```

**Pattern B -- App-level `initializeDb`:**
```ts
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../src/app";

beforeEach(() => {
  db = new Database(":memory:");
  initializeDb(db);
  app = createApp(db);
});
```

**Pattern C -- WorkGraph constructor:**
```ts
const wg = new WorkGraph(":memory:");
```

### Factory helpers

Tests define local factory functions at the top of each file:

```ts
function makeEvent(seq: number, type: string, payload: any): WorkEvent {
  return { id: `evt-${seq}`, seq, type, payload: JSON.stringify(payload), ... };
}

function makeItem(overrides?: Partial<WorkItem>): WorkItem {
  return { id: "item-1", title: "Test", status: "open", ...overrides };
}

function mockConnector(overrides?: Partial<ConnectorInterface>): ConnectorInterface {
  return { provider: "mock", hydrateIssue: async () => ..., ...overrides };
}
```

### MCP tool testing (e2e pattern)

The e2e tests simulate agent behavior by calling MCP tools directly:

```ts
// Build graph via MCP tools (simulating planner agent)
const node = await handleToolCall(ctx, "create_node", {
  title: "Task A", kind: "code_gen", role: "developer", prompt: "Do A",
});

// Trigger execution cascade
await onPlanningComplete(db, runId, "Plan summary", spawnFn);

// Simulate task agent completing (via MCP update_status)
await handleToolCall(
  { db, runId, nodeId: node.node_id, onNodeCompleted: ... },
  "update_status",
  { node_id: node.node_id, status: "completed" },
);
```

### API route testing

Uses Hono's built-in `app.request()` -- no HTTP server, no ports, no fetch mocking.

```ts
const res = await app.request("/runs", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ goal: "Fix the login bug" }),
});
expect(res.status).toBe(201);
const body = await res.json();
expect(body).toHaveProperty("run_id");
```

### Mocking external services

- **GitHub**: Mock the Octokit object shape (`{ rest: { issues: { get: mock(...) } } }`)
- **Jira/Linear**: Mock `fetch` or inject mock HTTP client
- **Connectors**: Use `mockConnector()` factory with partial overrides

## 6. Coverage Gaps (Known)

- **No automatic scratchpad injection test**: executor auto-injecting upstream scratchpad content into spawned agent prompts (TASK-14)
- **No skill file loading test**: role → skill file → agent prompt construction (TASK-15)
- **No concurrency limit test**: exceed `maxActivePerRun` → verify queuing behavior
- **Stale collaboration test**: `test/integration/collaboration-flow.test.ts` references deleted team model (TASK-18)

## 7. Adding New Tests

1. **Place unit tests** in `test/` root, named `{feature}.test.ts`
2. **Place integration tests** in `test/integration/`, or `test/integration/sync/` for sync-specific flows
3. **Place connector tests** in `test/connectors/`, roundtrip tests in `test/connectors/integration/`
4. **Use `:memory:` SQLite** for DB isolation -- never use a shared file path
5. **Prefer integration tests over unit tests** for orchestrator logic (reducers + services + graph together)
6. **Test behavior, not implementation** -- assert on observable state, not internal data structures
7. **Keep factories local** to each test file rather than sharing across files
8. **Use `mock()` from `bun:test`** for function mocks, not third-party mocking libraries
9. **For API tests**, use `app.request()` -- it is synchronous from the test's perspective and needs no server setup
10. **For MCP tool tests**, use `handleToolCall()` directly with in-memory DB -- no HTTP server needed
