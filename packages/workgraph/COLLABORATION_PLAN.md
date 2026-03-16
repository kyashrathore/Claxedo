# Plan: Wire Collaboration and Handoff Features

## Current State

`CollaborationService` and `LeadLoop` exist as pure in-memory classes with no DB
persistence, no MCP tool exposure, and no connection to the executor or event store.
They are scaffolded but completely unwired.

`CollaborationService` provides:
- Typed inter-agent messages (`ask`, `answer`, `propose`, `challenge`, `blocker`)
- Handoff lifecycle: `pending → accepted | rejected`

`LeadLoop` provides:
- Gap detection: identifies active nodes with no `lastActivityAt` progress for >N seconds
- Reroute requests: propose reassigning a stalled node to another team

---

## Goal

Wire both services into the full stack so agents can:
1. Post structured messages to each other mid-run via MCP tools
2. Formally hand off work between teams/nodes
3. Be automatically rerouted by the LeadLoop when they stall

---

## Step 1: Persist collaboration state — DB schema

Add two tables to `src/orchestrator/core/db/schema.ts`:

```ts
export const collaboration_messages = sqliteTable("collaboration_messages", {
  id:         text("id").primaryKey(),
  run_id:     text("run_id").notNull(),
  team_id:    text("team_id").notNull(),
  sender_id:  text("sender_id").notNull(),
  type:       text("type").notNull(),       // ask | answer | propose | challenge | blocker
  content:    text("content").notNull(),
  reply_to:   text("reply_to"),
  created_at: text("created_at").notNull(),
});

export const collaboration_handoffs = sqliteTable("collaboration_handoffs", {
  id:           text("id").primaryKey(),
  run_id:       text("run_id").notNull(),
  from_team_id: text("from_team_id").notNull(),
  to_team_id:   text("to_team_id").notNull(),
  status:       text("status").notNull(),   // pending | accepted | rejected
  payload:      text("payload").notNull(),
  created_at:   text("created_at").notNull(),
  resolved_at:  text("resolved_at"),
});
```

Add `CREATE TABLE IF NOT EXISTS` blocks to `initializeDb()` in `src/app.ts`.

Update `CollaborationService` to accept a `db` param and write/read from these tables
instead of its in-memory arrays/map. Keep the same method signatures — callers do not
change.

---

## Step 2: Emit events for all collaboration actions

Every collaboration write goes through the event store so the audit trail is complete.

| Action | Event type |
|--------|-----------|
| `postMessage()` | `message_posted` |
| `requestHandoff()` | `handoff_requested` |
| `acceptHandoff()` | `handoff_accepted` |
| `rejectHandoff()` | `handoff_rejected` |

`CollaborationService` constructor receives `eventStore: IEventStore | undefined`.
Each write method calls `void eventStore?.append({...}).catch(console.error)` after
the DB insert (fire-and-forget, same pattern as executor).

---

## Step 3: Add MCP tools for agents

Add six new tools to `src/mcp/tools.ts`. Add `collaboration?: CollaborationService`
to `McpToolContext` — optional so existing tests and call sites that do not need
collaboration continue to work unchanged.

| Tool | What it does |
|------|-------------|
| `post_message` | Post a typed message to the run's message bus |
| `get_messages` | Fetch messages for this run, optionally filtered by type |
| `request_handoff` | Request work transfer to another team/node |
| `accept_handoff` | Accept a pending handoff (receiver calls this) |
| `reject_handoff` | Reject a pending handoff (receiver calls this) |
| `get_handoffs` | List handoffs for this run, optionally filtered by status |

Input schemas (zod):

```ts
post_message:     { team_id, type, content, reply_to? }
get_messages:     { team_id?, type? }
request_handoff:  { to_team_id, payload }
accept_handoff:   { handoff_id }
reject_handoff:   { handoff_id }
get_handoffs:     { status? }
```

Each tool handler calls `ctx.collaboration?.postMessage(...)` etc. If
`ctx.collaboration` is not set, return `{ error: "collaboration not configured" }`.

---

## Step 4: Wire CollaborationService into the app

In `src/app.ts` `createApp()`:

```ts
const collaboration = new CollaborationService(db, eventStore);
```

Thread `collaboration` into route constructors that need it:

```ts
mcpRouter(db, eventStore, execution, collaboration)
graphRouter(db, eventStore, collaboration, ...)
```

Inside `mcpRouter`, add `collaboration` to `McpToolContext`:

```ts
const ctx: McpToolContext = { db, eventStore, runId, nodeId, collaboration, ... }
```

---

## Step 5: Add HTTP routes for collaboration

New sub-router `src/routes/collaboration.ts` mounted at `/runs/:runId`:

| Method | Path | What |
|--------|------|------|
| `GET` | `/runs/:runId/messages` | All messages for a run (query: `?type=blocker&team_id=team_fe`) |
| `GET` | `/runs/:runId/handoffs` | All handoffs for a run (query: `?status=pending`) |
| `POST` | `/runs/:runId/handoffs/:id/accept` | Accept a handoff |
| `POST` | `/runs/:runId/handoffs/:id/reject` | Reject a handoff |

Route handlers call `collaboration.getMessages(runId, ...)` etc. directly — no MCP
context needed at the HTTP layer.

---

## Step 6: Wire LeadLoop as a background watchdog

`LeadLoop` needs to run on a periodic timer, not just be called manually.

### 6a — Add `lastActivityAt` tracking

`attempts_current` already has `last_heartbeat_at`. Add a DB query in
`updateNodeStatus()` to touch `last_heartbeat_at = NOW()` whenever a node is marked
active or when an agent calls any MCP write tool (scratchpad, artifact, message).

### 6b — LeadLoop timer

In `OrchestratorRunState` add `leadLoop?: LeadLoop`.

In `startExecution()` / `beginExecution()`, after spawning nodes:

```ts
state.leadLoop = new LeadLoop();
const interval = setInterval(() => runLeadLoopTick(db, state, collaboration), 30_000);
state.leadLoopInterval = interval;
```

`runLeadLoopTick()`:

```ts
function runLeadLoopTick(db, state, collaboration) {
  const activeNodes = db.query(
    "SELECT node_id, last_heartbeat_at FROM attempts_current WHERE run_id = ? AND status = 'running'"
  ).all(state.run_id);

  const nodes = activeNodes.map(n => ({
    id: n.node_id,
    status: "active",
    lastActivityAt: new Date(n.last_heartbeat_at).getTime(),
  }));

  const gaps = state.leadLoop.detectGaps(state.run_id, nodes, 120_000);

  for (const gap of gaps) {
    // Post a blocker message automatically
    collaboration?.postMessage({
      id: `gap_msg_${gap.id}`,
      runId: state.run_id,
      teamId: "lead",
      senderId: "lead_loop",
      type: "blocker",
      content: gap.reason,
    });

    // Emit event for observability
    void emitRunEvent(state.run_id, "node_stalled", {
      node_id: gap.nodeId,
      reason: gap.reason,
    }).catch(console.error);
  }
}
```

### 6c — Clean up on run completion

In `checkRunCompletion()` when run reaches terminal state:

```ts
if (state.leadLoopInterval) clearInterval(state.leadLoopInterval);
```

---

## Step 7: Add `run_blockers_current` integration

`run_blockers_current` already exists in the schema (run_id, target_node_id, reason,
created_at). When a `blocker` message is posted OR a LeadLoop gap is detected, insert
a row:

```ts
db.run(
  "INSERT OR IGNORE INTO run_blockers_current (id, run_id, target_node_id, reason, created_at) VALUES (?,?,?,?,?)",
  [ulid(), runId, nodeId, reason, new Date().toISOString()]
);
```

Blockers are cleared when the node completes or is rerouted.

---

## Step 8: Tests

### Unit tests

`test/unit/collaboration.test.ts`
- DB-backed postMessage / getMessages round-trips
- requestHandoff → acceptHandoff lifecycle
- rejectHandoff idempotency (can't accept after reject)
- Event emission for each action

`test/unit/lead-loop.test.ts` (extend existing)
- `runLeadLoopTick()` with fake DB rows
- Gap produces blocker message in collaboration service
- Stale threshold respected (120s default)

### Integration tests

`test/integration/collaboration-flow.test.ts` (rewrite the deleted one)
- Full flow: agent posts ask → another agent answers → handoff → accepted
- Blocker message appears in DB and `run_blockers_current`
- LeadLoop detects stall → blocker message auto-posted

`test/integration/e2e-pipeline.test.ts` (extend)
- Run with collaboration enabled — agents exchange messages
- Handoff between nodes visible in GET routes

---

## Critical Files

| File | Action |
|------|--------|
| `src/orchestrator/core/db/schema.ts` | Add `collaboration_messages`, `collaboration_handoffs` tables |
| `src/app.ts` | Add `CREATE TABLE` blocks, instantiate `CollaborationService`, thread into routes |
| `src/orchestrator/core/services/collaboration.ts` | Accept `db` + `eventStore`, persist to DB instead of memory |
| `src/mcp/tools.ts` | Add 6 new tools, add `collaboration?` to `McpToolContext` |
| `src/routes/collaboration.ts` | New HTTP sub-router for messages + handoffs |
| `src/orchestrator/executor.ts` | `runLeadLoopTick()`, `leadLoopInterval` in state, heartbeat touches |
| `src/orchestrator/types.ts` | Add `leadLoop?: LeadLoop`, `leadLoopInterval?: Timer` to `OrchestratorRunState` |

---

## What this unlocks

Once wired, agents can:
- Ask another node for information mid-run without blocking their own execution
- Formally signal when they're done with their slice and hand off to the next team
- Surface blockers that the LeadLoop or a human can act on
- Have stalled nodes auto-detected and flagged without manual monitoring

The audit trail (via events + DB tables) means every message and handoff is
queryable after the fact for debugging or replay.
