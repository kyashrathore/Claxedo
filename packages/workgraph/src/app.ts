import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ulid } from "ulid";
import type { EventEnvelope } from "./orchestrator/events";
import { eventsRouter } from "./routes/events";
import { scratchpadRouter } from "./routes/scratchpad";
import { planningRouter } from "./routes/planning";
import { lifecycleRouter } from "./routes/lifecycle";
import { hydrationRouter } from "./routes/hydration";
import { repairRouter } from "./routes/repair";
import { agentRouter } from "./routes/agent";
import { dashboardRouter } from "./routes/dashboard";
import { orchestrateRouter } from "./routes/orchestrate";
import { mcpRouter } from "./routes/mcp";
import { acpRouter } from "./routes/acp";
import { workRouter } from "./routes/work";
import { initWorkGraph } from "./orchestrator/workgraph-bridge";
import { generateHash, insertEvent, getNextSeq } from "./db/helpers";

/**
 * Initialize all tables needed by the API server.
 * Uses raw SQL so we can work with bun:sqlite directly.
 */
export function initializeDb(db: any) {
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
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
      op_id TEXT NOT NULL UNIQUE,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS runs_current (
      run_id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS nodes_current (
      node_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'developer',
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      retry_count INTEGER NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS dependency_edges_current (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type TEXT NOT NULL
    );
  `);
}


/**
 * Create a Hono app wired to the given SQLite database.
 */
export function createApp(db?: any) {
  // If no db provided, create an in-memory one
  if (!db) {
    const { Database } = require("bun:sqlite");
    db = new Database(":memory:");
    initializeDb(db);
  }

  // Initialize WorkGraph singleton
  initWorkGraph();

  const app = new Hono();

  // --- POST /runs ---
  app.post(
    "/runs",
    zValidator(
      "json",
      z.object({
        goal: z.string().min(1),
      })
    ),
    async (c) => {
      const { goal } = c.req.valid("json");

      const runId = `run_${ulid()}`;
      const eventId = `evt_${ulid()}`;
      const seq = getNextSeq(db, runId);

      const event: EventEnvelope = {
        id: eventId,
        run_id: runId,
        stream_id: runId,
        stream_seq: seq,
        logical_ts: seq,
        schema_version: 1,
        type: "run_created",
        payload_json: JSON.stringify({ goal, status: "active" }),
        actor_type: "user",
        actor_id: "api",
        op_id: `op_${eventId}`,
        prev_hash: "00000000",
        hash: generateHash(),
        created_at: new Date().toISOString(),
      };

      insertEvent(db, event);

      db.run("INSERT INTO runs_current (run_id, goal, status) VALUES (?, ?, ?)", [
        runId,
        goal,
        "active",
      ]);

      return c.json(
        {
          run_id: runId,
          goal,
          status: "active",
        },
        201
      );
    }
  );

  // --- GET /runs/:run_id ---
  app.get("/runs/:run_id", async (c) => {
    const runId = c.req.param("run_id");
    const row = db
      .query("SELECT * FROM runs_current WHERE run_id = ?")
      .get(runId) as { run_id: string; goal: string; status: string } | null;

    if (!row) {
      return c.json({ error: "Run not found" }, 404);
    }

    return c.json(row);
  });

  // --- POST /runs/:run_id/nodes ---
  app.post(
    "/runs/:run_id/nodes",
    zValidator(
      "json",
      z.object({
        kind: z.string().min(1),
        role: z.string().min(1).default("developer"),
        title: z.string().optional(),
      })
    ),
    async (c) => {
      const runId = c.req.param("run_id");
      const { kind, role, title } = c.req.valid("json");

      const nodeId = `node_${ulid()}`;
      const eventId = `evt_${ulid()}`;
      const seq = getNextSeq(db, runId);

      const event: EventEnvelope = {
        id: eventId,
        run_id: runId,
        stream_id: runId,
        stream_seq: seq,
        logical_ts: seq,
        schema_version: 1,
        type: "node_created",
        payload_json: JSON.stringify({
          node_id: nodeId,
          kind,
          role,
        }),
        actor_type: "system",
        actor_id: "api",
        op_id: `op_${eventId}`,
        prev_hash: "00000000",
        hash: generateHash(),
        created_at: new Date().toISOString(),
      };

      insertEvent(db, event);

      db.run(
        "INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [nodeId, runId, role, kind, title || "", "pending", 0]
      );

      return c.json(
        {
          node_id: nodeId,
          run_id: runId,
          role,
          kind,
          title: title || "",
          status: "pending",
          retry_count: 0,
        },
        201
      );
    }
  );

  // --- POST /runs/:run_id/edges ---
  app.post(
    "/runs/:run_id/edges",
    zValidator(
      "json",
      z.object({
        source_id: z.string().min(1),
        target_id: z.string().min(1),
        type: z.string().min(1),
      })
    ),
    async (c) => {
      const runId = c.req.param("run_id");
      const { source_id, target_id, type } = c.req.valid("json");

      const edgeId = `edge_${ulid()}`;
      const eventId = `evt_${ulid()}`;
      const seq = getNextSeq(db, runId);

      const event: EventEnvelope = {
        id: eventId,
        run_id: runId,
        stream_id: runId,
        stream_seq: seq,
        logical_ts: seq,
        schema_version: 1,
        type: "edge_added",
        payload_json: JSON.stringify({
          id: edgeId,
          source_id,
          target_id,
          type,
        }),
        actor_type: "system",
        actor_id: "api",
        op_id: `op_${eventId}`,
        prev_hash: "00000000",
        hash: generateHash(),
        created_at: new Date().toISOString(),
      };

      insertEvent(db, event);

      db.run(
        "INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
        [edgeId, runId, source_id, target_id, type]
      );

      return c.json(
        {
          id: edgeId,
          run_id: runId,
          source_id,
          target_id,
          type,
        },
        201
      );
    }
  );

  // --- GET /runs ---
  app.get("/runs", async (c) => {
    const rows = db
      .query("SELECT * FROM runs_current")
      .all() as Array<{ run_id: string; goal: string; status: string }>;
    return c.json(rows);
  });

  // --- GET /runs/:run_id/nodes ---
  app.get("/runs/:run_id/nodes", async (c) => {
    const runId = c.req.param("run_id");
    const rows = db
      .query("SELECT * FROM nodes_current WHERE run_id = ?")
      .all(runId);
    return c.json(rows);
  });

  // --- GET /runs/:run_id/edges ---
  app.get("/runs/:run_id/edges", async (c) => {
    const runId = c.req.param("run_id");
    const rows = db
      .query("SELECT * FROM dependency_edges_current WHERE run_id = ?")
      .all(runId);
    return c.json(rows);
  });

  // --- PATCH /runs/:run_id/nodes/:node_id ---
  app.patch(
    "/runs/:run_id/nodes/:node_id",
    zValidator(
      "json",
      z.object({
        status: z.string().min(1),
      })
    ),
    async (c) => {
      const runId = c.req.param("run_id");
      const nodeId = c.req.param("node_id");
      const { status } = c.req.valid("json");

      const existing = db
        .query("SELECT * FROM nodes_current WHERE node_id = ? AND run_id = ?")
        .get(nodeId, runId) as any;

      if (!existing) {
        return c.json({ error: "Node not found" }, 404);
      }

      db.run("UPDATE nodes_current SET status = ? WHERE node_id = ?", [status, nodeId]);

      // Emit event
      const eventId = `evt_${ulid()}`;
      const seq = getNextSeq(db, runId);
      const event: EventEnvelope = {
        id: eventId,
        run_id: runId,
        stream_id: runId,
        stream_seq: seq,
        logical_ts: seq,
        schema_version: 1,
        type: "node_status_changed",
        payload_json: JSON.stringify({ node_id: nodeId, status, previous_status: existing.status }),
        actor_type: "user",
        actor_id: "api",
        op_id: `op_${eventId}`,
        prev_hash: "00000000",
        hash: generateHash(),
        created_at: new Date().toISOString(),
      };
      insertEvent(db, event);

      return c.json({ ...existing, status });
    }
  );

  // --- GET /runs/:run_id/ready ---
  app.get("/runs/:run_id/ready", async (c) => {
    const runId = c.req.param("run_id");

    // Get all pending nodes for this run
    const nodes = db
      .query("SELECT * FROM nodes_current WHERE run_id = ? AND status = 'pending'")
      .all(runId) as Array<{
      node_id: string;
      run_id: string;
      role: string;
      kind: string;
      status: string;
      retry_count: number;
    }>;

    // Get all edges for this run
    const edges = db
      .query("SELECT * FROM dependency_edges_current WHERE run_id = ?")
      .all(runId) as Array<{
      id: string;
      run_id: string;
      source_id: string;
      target_id: string;
      type: string;
    }>;

    // Get all nodes (to check completed status of dependencies)
    const allNodes = db
      .query("SELECT * FROM nodes_current WHERE run_id = ?")
      .all(runId) as Array<{
      node_id: string;
      status: string;
    }>;

    const nodeStatusMap = new Map<string, string>();
    for (const n of allNodes) {
      nodeStatusMap.set(n.node_id, n.status);
    }

    // Build dependency set: for each target, what source nodes must be completed
    const dependenciesOf = new Map<string, string[]>();
    for (const edge of edges) {
      const deps = dependenciesOf.get(edge.target_id) || [];
      deps.push(edge.source_id);
      dependenciesOf.set(edge.target_id, deps);
    }

    // A pending node is ready if all its source dependencies are completed
    const readyNodeIds: string[] = [];
    for (const node of nodes) {
      const deps = dependenciesOf.get(node.node_id) || [];
      const allDepsCompleted = deps.every(
        (depId) => nodeStatusMap.get(depId) === "completed"
      );
      if (allDepsCompleted) {
        readyNodeIds.push(node.node_id);
      }
    }

    return c.json({ ready: readyNodeIds });
  });

  // Mount sub-routers
  app.route("/", eventsRouter(db));
  app.route("/", scratchpadRouter());
  app.route("/", planningRouter());
  app.route("/", lifecycleRouter(db));
  app.route("/", hydrationRouter(db));
  app.route("/", repairRouter(db));
  app.route("/", agentRouter());
  app.route("/", orchestrateRouter(db));
  app.route("/", mcpRouter(db));
  app.route("/", acpRouter(db));
  app.route("/", workRouter());
  app.route("/", dashboardRouter()); // last so "/" doesn't shadow API routes

  return app;
}

// Default export for backward compatibility
const app = createApp();

export { app };
