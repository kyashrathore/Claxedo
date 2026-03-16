# WorkGraph Architecture

## Overview

WorkGraph is an event-sourced AI orchestration engine. It decomposes a goal into a directed acyclic graph (DAG) of tasks, executes them with AI agents in dependency order, and streams progress back to callers.

## Dual Model

WorkGraph operates with two complementary models:

### 1. Orchestrator Model (append-only events + projections)

The core state machine lives in the orchestrator and uses an append-only event log (`events` table). Events are the source of truth; projections (`nodes_current`, `runs_current`, `dependency_edges_current`) are derived views.

```
Event Log (immutable)
    │
    ▼
Projections (rebuilt from events)
  ├── runs_current       — run phase, goal, metrics
  ├── nodes_current      — node status, retry count
  ├── dependency_edges_current — DAG edges
  └── scratchpad_entries — node context/output
```

### 2. WorkGraph Model (mutable work items)

A separate `WorkGraph` singleton tracks higher-level "work items" that can be linked to runs. It bridges external issue trackers (Linear, GitHub, Jira) with orchestration runs. Work items have their own status (`open`, `in_progress`, `done`) and dependency graph.

## MCP Tool Flow

Agents communicate with the orchestrator exclusively via MCP (Model Context Protocol) tools. This provides a stable, provider-agnostic interface:

```
Planner Agent                        Executor
     │                                  │
     │  create_node(title, kind, ...)   │
     │─────────────────────────────────►│
     │                                  │  INSERT nodes_current
     │  validate_graph()               │
     │─────────────────────────────────►│
     │                                  │  cycle check, orphan check
     │  finish_planning(summary)        │
     │─────────────────────────────────►│
                                        │  → onPlanningComplete()
                                        │  → spawn task agents

Task Agent (per node)
     │                                  │
     │  read_scratchpads()             │
     │─────────────────────────────────►│  upstream context
     │                                  │
     │  write_scratchpad(content)       │
     │─────────────────────────────────►│  store findings
     │                                  │
     │  update_status("completed")      │
     │─────────────────────────────────►│  → onNodeStatusUpdate()
                                        │  → cascade to next nodes
```

## Run Lifecycle

```
                 POST /runs
                     │
                     ▼
               [active / draft]
                     │
          startOrchestration(goal)
                     │
                     ▼
               [planning]  ◄─── planner calls create_node, validate_graph
                     │
          finish_planning(summary)
                     │
                     ▼
               [executing]  ─────────────────────────────────┐
                     │                                        │
           findReadyNodes()                         node completes/fails
                     │                                        │
           spawnTaskAgent() × N              onNodeStatusUpdate()
                     │                                        │
                     ▼                           cascadeFailure() / findReadyNodes()
             [blocked?] ─── hasBlockers ──► [blocked]         │
                     │                                        │
                     └──────────── all terminal ──────────────┘
                                        │
                                   [completed] or [failed]
                                        │
                              finalizeMetrics() → metrics_json
```

### Phase Descriptions

| Phase | Description |
|-------|-------------|
| `planning` | Planner agent is building the task graph |
| `planned` | Plan complete but auto_execute=false |
| `executing` | Task agents are running in parallel |
| `blocked` | Run is waiting on external work items |
| `completed` | All non-failed nodes are done |
| `failed` | All nodes failed (or deadlock detected) |
| `cancelled` | Manually cancelled |

## Executor: Key Functions

### `startOrchestration(db, runId, goal, spawnAgentFn, workItemId?, opts?)`

Entry point for goal-driven orchestration. Transitions the run to `planning`, stores in-memory state, and spawns the planner agent. Returns immediately (fire-and-forget planner).

**Flow:**
1. Allocate `OrchestratorRunState` in memory
2. Update run to `planning` in DB
3. Build planner prompt (includes source context if attached)
4. Call `spawnAgentFn(plannerPrompt, runId, "")`
5. Store planner agent ID; planner will call MCP tools asynchronously

### `buildPlannerPrompt(db, runId, goal)`

Constructs the prompt for the planning agent. Includes:
- The system instruction about cohesive task decomposition
- The goal
- The full source context (spec, doc, issue) if attached, truncated to 16K chars
- The current `run_id` so the planner can pass it to MCP tools

### `spawnTaskAgent(db, state, nodeId, spawnAgentFn)`

Spawns an execution agent for a ready node. The agent receives:
- Its role (developer, reviewer, etc.)
- The completion contract (varies by node kind)
- The node prompt from `scratchpad_entries`
- Instructions to use specific MCP tools

Agents are spawned for `workspace` kinds (code_gen, test) with an isolated worktree, and for `task` kinds (research, review, docs) in a shared sandbox.

## Event Sourcing

Every state change emits an event to `events`:

```typescript
interface EventEnvelope {
  id: string;          // unique event ID
  run_id: string;      // scope
  stream_id: string;   // stream (usually == run_id)
  stream_seq: integer; // monotonic per-stream sequence
  logical_ts: integer; // logical timestamp
  type: string;        // e.g. "node_status_changed"
  payload_json: string;
  actor_type: string;  // "user" | "agent" | "system"
  op_id: string;       // idempotency key
  prev_hash: string;   // hash chain
  hash: string;
  created_at: string;
}
```

Key event types:
- `run_created`, `run_planned`, `execution_started`
- `node_created`, `node_status_changed`, `node_cancelled`
- `edge_added`, `edge_removed`
- `scratchpad_written`, `artifact_created`
- `planning_failed`, `run_blocked`, `run_cancelled`

## RunMetrics

Metrics are computed when a run reaches a terminal phase (`completed` or `failed`) and stored as `metrics_json` in `runs_current`.

```typescript
interface RunMetrics {
  wall_time_ms: number;         // clock time from execution start to finish
  task_count: number;           // total nodes (excluding planner)
  completed_count: number;      // nodes that completed successfully
  failed_count: number;         // nodes that exhausted retries and failed
  max_parallelism: number;      // peak concurrent active nodes
  avg_parallelism: number;      // weighted average parallelism
  total_tokens_used: number | null;  // null until token tracking is implemented
  estimated_cost_usd: number | null; // null until cost tracking is implemented
}
```

Parallelism is tracked in-memory via a `ParallelismTracker`:
- On `spawnTaskAgent`: increment `current`, update `max`, flush integral
- On `onNodeStatusUpdate`: decrement `current`, flush integral
- At completion: `avg = integral / wall_time_ms`

Metrics are accessible via `GET /runs/:run_id/metrics`.

## Database Schema

```sql
-- Append-only event log
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_seq INTEGER NOT NULL,
  logical_ts INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  op_id TEXT NOT NULL UNIQUE,  -- idempotency
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Run projection (current state)
CREATE TABLE runs_current (
  run_id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,   -- planning | executing | completed | failed | ...
  source_id TEXT,
  runtime_type TEXT NOT NULL DEFAULT 'task',
  metrics_json TEXT,      -- RunMetrics JSON, set at completion
  created_at TEXT,
  updated_at TEXT
);

-- Node projection
CREATE TABLE nodes_current (
  node_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'developer',
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  node_type TEXT NOT NULL DEFAULT 'task',  -- task | mission | synthesis
  parent_node_id TEXT,
  status TEXT NOT NULL,   -- pending | active | completed | failed | blocked | cancelled
  retry_count INTEGER NOT NULL,
  runtime_type TEXT NOT NULL DEFAULT 'task'
);

-- Dependency edges
CREATE TABLE dependency_edges_current (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  type TEXT NOT NULL      -- depends_on | ...
);

-- Per-node context (agent output, prompts)
CREATE TABLE scratchpad_entries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  size_bytes INTEGER NOT NULL
);

-- Execution attempt tracking
CREATE TABLE attempts_current (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  runtime_type TEXT NOT NULL,
  session_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  last_heartbeat_at TEXT NOT NULL
);
```

## Retry Logic

Each node tracks a `retry_count`. On failure:
- If `retry_count < MAX_RETRIES (2)`: increment count, re-spawn agent
- If `retry_count >= MAX_RETRIES`: mark node `failed`, cascade failure to dependents

## Cascade Failure

When a node fails (after exhausting retries), `cascadeFailure()` walks the dependency graph and marks all downstream `pending` nodes as `failed`. This is then reflected in `findReadyNodes()` which skips nodes with failed dependencies.

## Connector Architecture

External issue trackers are integrated via the `ConnectorInterface`:

```typescript
interface ConnectorInterface {
  provider: string;
  validate?(): Promise<{ label?: string }>;
  queryIssues?(mode, params): Promise<ProviderPreview[]>;
  hydrateIssue(params): Promise<NormalizedIssue>;
  updateIssue(params, updates): Promise<void>;
  addComment(params, comment): Promise<void>;
  createIssue(params, data): Promise<NormalizedIssue>;
}
```

Supported providers: `github`, `linear`, `jira`

Each connector normalizes provider-specific data to `NormalizedIssue`:
```typescript
interface NormalizedIssue {
  id: string;
  title: string;
  description: string;
  status: "open" | "closed" | "in_progress";
  provider_url: string;
  external_key?: string;
  parent_external_key?: string | null;
  child_external_keys?: string[];
  aggregate_only?: boolean;
}
```
