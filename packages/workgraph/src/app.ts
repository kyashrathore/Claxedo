import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ulid } from "ulid";
import { eventsRouter } from "./routes/events";
import { scratchpadRouter } from "./routes/scratchpad";
import { planningRouter } from "./routes/planning";
import { lifecycleRouter, openSqliteRunHealthStore } from "./routes/lifecycle";
import { hydrationRouter } from "./routes/hydration";
import { repairRouter } from "./routes/repair";
import { mcpRouter } from "./routes/mcp";
import { workRouter } from "./routes/work";
import { graphRouter } from "./routes/graph";
import { triggersRouter } from "./routes/triggers";
import { initWorkGraph } from "./orchestrator/workgraph-bridge";
import type { ExecutionAdapter } from "./execution";
import type { ProviderAuthResolver, ProviderFactory } from "./providers";
import type { RepoBindingResolver } from "./repo";
import { openSqliteEventStore } from "./orchestrator/core/services/event-store-sqlite";
import { openSqliteSliceStore } from "./sdk/slices";
import { openSqliteConnectionStore } from "./sdk/connections";
import { openSqliteRunStore } from "./sdk/runs";
import { openSqliteExecutionStore } from "./sdk/execution-store";
import { initializeDb } from "./db/schema";

export { initializeDb } from "./db/schema";

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

/**
 * Create a Hono app wired to the given SQLite database.
 */
export function createApp(
  db?: any,
  opts?: { execution?: ExecutionAdapter; providers?: ProviderFactory; auth?: ProviderAuthResolver; repos?: RepoBindingResolver },
) {
  if (!db) {
    const { Database } = require("bun:sqlite");
    db = new Database(":memory:");
    initializeDb(db);
  }

  initWorkGraph(db.filename);

  const eventStore = openSqliteEventStore(db);
  const runStore = openSqliteRunStore(db);
  const sliceStore = openSqliteSliceStore(db);
  const connStore = openSqliteConnectionStore(db);
  const healthStore = openSqliteRunHealthStore(db);
  const executionStore = openSqliteExecutionStore(db, eventStore);

  const app = new Hono();

  // --- POST /runs ---
  app.post("/runs", zValidator("json", z.object({ goal: z.string().min(1) })), async (c) => {
    const { goal } = c.req.valid("json");
    const runId = `run_${ulid()}`;
    const eventId = `evt_${ulid()}`;
    await eventStore.append({
      id: eventId,
      run_id: runId,
      stream_id: runId,
      schema_version: 1,
      type: "run_created",
      payload_json: JSON.stringify({ goal, status: "active" }),
      actor_type: "user",
      actor_id: "api",
      op_id: `op_${eventId}`,
      created_at: new Date().toISOString(),
    });
    const run = runStore.createRun(runId, goal);
    return c.json({ run_id: run.run_id, goal: run.goal, status: run.status }, 201);
  });

  // --- GET /runs ---
  app.get("/runs", (c) => c.json(runStore.listRuns()));

  // --- GET /runs/:run_id ---
  app.get("/runs/:run_id", (c) => {
    const run = runStore.getRun(c.req.param("run_id"));
    if (!run) return c.json({ error: "Run not found" }, 404);
    return c.json(run);
  });

  // --- GET /runs/:run_id/source ---
  app.get("/runs/:run_id/source", (c) => {
    const runId = c.req.param("run_id");
    if (!runStore.getRun(runId)) return c.json({ error: "Run not found" }, 404);
    return c.json(runStore.getRunSource(runId));
  });

  // --- GET /runs/:run_id/metrics ---
  app.get("/runs/:run_id/metrics", (c) => {
    const runId = c.req.param("run_id");
    if (!runStore.getRun(runId)) return c.json({ error: "Run not found" }, 404);
    const metrics = runStore.getRunMetrics(runId);
    if (!metrics) return c.json({ error: "Metrics not yet available for this run" }, 404);
    return c.json(metrics);
  });

  // --- POST /runs/:run_id/nodes ---
  app.post(
    "/runs/:run_id/nodes",
    zValidator("json", z.object({ kind: z.string().min(1), role: z.string().min(1).default("developer"), title: z.string().optional() })),
    async (c) => {
      const runId = c.req.param("run_id");
      const { kind, role, title } = c.req.valid("json");
      const nodeId = `node_${ulid()}`;
      const eventId = `evt_${ulid()}`;
      await eventStore.append({
        id: eventId,
        run_id: runId,
        stream_id: runId,
        schema_version: 1,
        type: "node_created",
        payload_json: JSON.stringify({ node_id: nodeId, kind, role }),
        actor_type: "system",
        actor_id: "api",
        op_id: `op_${eventId}`,
        created_at: new Date().toISOString(),
      });
      const node = runStore.createNode(runId, nodeId, role, kind, title ?? "");
      return c.json(node, 201);
    },
  );

  // --- GET /runs/:run_id/nodes ---
  app.get("/runs/:run_id/nodes", (c) => c.json(runStore.listNodes(c.req.param("run_id"))));

  // --- PATCH /runs/:run_id/nodes/:node_id ---
  app.patch(
    "/runs/:run_id/nodes/:node_id",
    zValidator("json", z.object({ status: z.string().min(1) })),
    async (c) => {
      const runId = c.req.param("run_id");
      const nodeId = c.req.param("node_id");
      const { status } = c.req.valid("json");
      const node = runStore.updateNodeStatus(runId, nodeId, status);
      if (!node) return c.json({ error: "Node not found" }, 404);
      const eventId = `evt_${ulid()}`;
      await eventStore.append({
        id: eventId,
        run_id: runId,
        stream_id: runId,
        schema_version: 1,
        type: "node_status_changed",
        payload_json: JSON.stringify({ node_id: nodeId, status }),
        actor_type: "user",
        actor_id: "api",
        op_id: `op_${eventId}`,
        created_at: new Date().toISOString(),
      });
      return c.json(node);
    },
  );

  // --- POST /runs/:run_id/edges ---
  app.post(
    "/runs/:run_id/edges",
    zValidator("json", z.object({ source_id: z.string().min(1), target_id: z.string().min(1), type: z.string().min(1) })),
    async (c) => {
      const runId = c.req.param("run_id");
      const { source_id, target_id, type } = c.req.valid("json");
      const edgeId = `edge_${ulid()}`;
      const eventId = `evt_${ulid()}`;
      await eventStore.append({
        id: eventId,
        run_id: runId,
        stream_id: runId,
        schema_version: 1,
        type: "edge_added",
        payload_json: JSON.stringify({ id: edgeId, source_id, target_id, type }),
        actor_type: "system",
        actor_id: "api",
        op_id: `op_${eventId}`,
        created_at: new Date().toISOString(),
      });
      const edge = runStore.createEdge(runId, edgeId, source_id, target_id, type);
      return c.json(edge, 201);
    },
  );

  // --- GET /runs/:run_id/edges ---
  app.get("/runs/:run_id/edges", (c) => c.json(runStore.listEdges(c.req.param("run_id"))));

  // --- GET /runs/:run_id/ready ---
  app.get("/runs/:run_id/ready", (c) => c.json({ ready: runStore.getReadyNodes(c.req.param("run_id")) }));

  // Mount sub-routers
  app.route("/", eventsRouter(eventStore));
  app.route("/", scratchpadRouter());
  app.route("/", planningRouter());
  app.route("/", lifecycleRouter(healthStore));
  app.route("/", hydrationRouter(eventStore));
  app.route("/", repairRouter(eventStore));
  app.route("/", graphRouter(db, executionStore, sliceStore, connStore, opts?.execution, opts?.providers, opts?.auth, opts?.repos));
  app.route("/", mcpRouter(db, executionStore, opts?.execution));
  app.route("/", workRouter());
  app.route("/", triggersRouter(db));

  return app;
}

// Default export for backward compatibility
const app = createApp();
export { app };
