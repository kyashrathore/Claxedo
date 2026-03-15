# WorkGraph

WorkGraph is an AI orchestration engine that decomposes goals into task graphs and executes them with parallel AI agents. It exposes an HTTP API, an MCP (Model Context Protocol) server for agent-to-orchestrator communication, and a `wg` CLI for running tasks from the command line.

## Quick Start

### CLI

```bash
# Dry-run mode (no real agents — for testing)
wg "implement login feature" --dry-run

# With a specific directory
wg "write tests for auth module" --dir /path/to/repo --dry-run

# Show help
wg --help
```

**CLI output:**

```
[WorkGraph] Starting run...
[WorkGraph] Goal: implement login feature
[WorkGraph] Mode: dry-run (no real agents)
[WorkGraph] Planning...
[WorkGraph] Executing...
  ✓  Dry run task

[WorkGraph] Done in 45ms
  Tasks:        1 completed, 0 failed
  Max parallel: 1
  Wall time:    45ms
  Tokens:       unknown
  Cost est.:    unknown
```

### Embedded Server

```typescript
import { createApp, initializeDb } from "@opencode-ai/workgraph";
import { Database } from "bun:sqlite";

const db = new Database("workgraph.db");
initializeDb(db);
const app = createApp(db, { execution: myExecutionAdapter });

Bun.serve({ port: 3000, fetch: app.fetch });
```

## Running Tests

```bash
cd packages/workgraph
bun test
```

Tests use `bun:sqlite` in-memory databases — no external dependencies needed.

### Test Layout

```
test/
├── helpers/
│   ├── mock-agent.ts       # Deterministic SpawnAgentFn for E2E tests
│   └── mock-connector.ts   # Deterministic ConnectorInterface for connector tests
├── unit/
│   ├── executor-cascade.test.ts    # Retry, failure cascade, blocked state, metrics
│   ├── mcp-tools.test.ts           # Each MCP tool handler
│   ├── connector-linear.test.ts    # Linear connector (mock HTTP)
│   ├── connector-github.test.ts    # GitHub connector (mock HTTP)
│   ├── routes.test.ts              # HTTP route handlers
│   └── scratchpad.test.ts          # ScratchpadService
└── e2e/
    ├── spec-flow.test.ts        # Full spec → plan → execute flow with MockAgent
    └── individual-task.test.ts  # Individual task execution (startExecution)
```

## HTTP API

### Runs

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/runs` | Create a run with `{ goal }` |
| `GET` | `/runs` | List all runs |
| `GET` | `/runs/:id` | Get run by ID |
| `GET` | `/runs/:id/metrics` | Get run metrics (available after completion) |
| `GET` | `/runs/:id/nodes` | List nodes for a run |
| `GET` | `/runs/:id/edges` | List edges for a run |
| `GET` | `/runs/:id/ready` | Get nodes ready to execute |
| `GET` | `/runs/:id/source` | Get attached source context |
| `POST` | `/runs/:id/nodes` | Create a node |
| `POST` | `/runs/:id/edges` | Create a dependency edge |
| `PATCH` | `/runs/:id/nodes/:nodeId` | Update node status |

### MCP Tools

All MCP tools are available at `POST /mcp/tools/call` with `{ tool, args }`.

**Planning tools** (used by planner agents):
- `create_node` — Create a task node
- `add_edge` / `remove_edge` — Manage dependencies
- `validate_graph` — Check for cycles and orphans
- `finish_planning` — Trigger execution cascade

**Task agent tools**:
- `update_status` — Mark node completed or failed
- `write_scratchpad` — Write context for downstream nodes
- `read_scratchpads` — Read own + upstream context
- `create_artifact` — Publish a deliverable

**Query tools**:
- `get_graph` — Get full node/edge graph
- `get_run_status` — Get run phase and node counts
- `get_run_source` — Get attached spec/source

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for a detailed description of the event sourcing model, dual model, MCP tool flow, and run lifecycle.
