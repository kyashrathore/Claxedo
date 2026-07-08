import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ulid } from "ulid";
import Database from "better-sqlite3";
import { eventsRouter } from "./routes/events";
import { scratchpadRouter } from "./routes/scratchpad";
import { lifecycleRouter } from "./routes/lifecycle";
import { openSqliteRunHealthStore } from "./sdk/health-store";
import { mcpRouter } from "./routes/mcp";
import { workRouter } from "./routes/work";
import { graphRouter } from "./routes/graph";
import { triggersRouter } from "./routes/triggers";
import { decisionsRouter } from "./routes/decisions";
import { loadoutRouter } from "./routes/loadout";
import { intakeRouter, type IntakeRouterOptions } from "./routes/intake";
import { triageModesRouter } from "./routes/triage-modes";
import { activityRouter } from "./routes/activity";
import { getWorkGraph, initWorkGraph } from "./model/registry";
import { createTriageDebouncer, runTriage } from "./captain/triage-runner";
import { runCaptain } from "./captain/runner";
import type { ExecutionAdapter } from "./execution";
import type { ProviderAuthResolver, ProviderFactory } from "./providers";
import type { RepoBindingResolver } from "./repo";
import { openSqliteEventStore } from "./substrate/event-store-sqlite";
import { openSqliteSliceStore } from "./sdk/slices";
import { openSqliteConnectionStore } from "./sdk/connections";
import { openSqliteRunStore } from "./sdk/runs";
import { openSqliteExecutionStore } from "./sdk/execution-store";
import { openSqliteTriggerStore } from "./triggers/trigger-store";
import { initializeDb } from "./db/schema";
import { sqlite, type SqliteInput } from "./sqlite";

export { initializeDb } from "./db/schema";

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

/**
 * Create a Hono app wired to the given SQLite database.
 */
export function createApp(
  input?: SqliteInput,
  opts?: {
    execution?: ExecutionAdapter
    providers?: ProviderFactory
    auth?: ProviderAuthResolver
    repos?: RepoBindingResolver
    intake?: IntakeRouterOptions
  },
) {
  const source = input ?? new Database(":memory:");
  const db = sqlite(source);
  initializeDb(db);

  initWorkGraph(db.filename);

  const eventStore = openSqliteEventStore(db.raw() ?? db);
  const runStore = openSqliteRunStore(db);
  const sliceStore = openSqliteSliceStore(db);
  const connStore = openSqliteConnectionStore(db);
  const healthStore = openSqliteRunHealthStore(db);
  const executionStore = openSqliteExecutionStore(db, eventStore);
  const triggerStore = openSqliteTriggerStore(db);
  const triage = opts?.execution
    ? createTriageDebouncer(async (intakeItemId) => {
        try {
          await runTriage(getWorkGraph(), intakeItemId, {
            spawn: async (input) => {
              const handle = await opts.execution!.launch({
                run_id: input.agentRunId,
                node_id: input.workItemId,
                prompt: input.prompt,
                role: "developer",
                kind: "triage",
                title: input.intake.title ?? "WorkGraph Triage",
                directory: process.cwd(),
              })
              return {
                sessionId: handle.session_id ?? handle.id,
                agentRunId: input.agentRunId,
              }
            },
          }, {
            runCaptain: async (workGraph, agentRunId) => {
              await waitForWorkGraphScratchpad(workGraph, agentRunId);
              return runCaptain(workGraph, agentRunId, {
                run: async (input) => {
                  const handle = await opts.execution!.launch({
                    run_id: input.agentRunId,
                    node_id: input.scratchpad.workItemId,
                    prompt: input.prompt,
                    role: "captain",
                    kind: "captain",
                    title: "WorkGraph Captain",
                    directory: process.cwd(),
                    hidden: true,
                  });
                  return { sessionId: handle.session_id ?? handle.id };
                },
              });
            },
          })
        } catch (err) {
          console.error("[workgraph] intake triage failed:", err)
        }
      })
    : undefined;
  const intakeOpts = opts?.intake ?? (triage ? { scheduleTriage: triage.schedule } : undefined);

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
  app.get("/runs", (c) => {
    const limit  = Number(c.req.query("limit")  ?? "0") || undefined;
    const cursor = Number(c.req.query("cursor") ?? "0") || undefined;
    if (limit) return c.json(runStore.listRuns({ limit, cursor }));
    return c.json(runStore.listRuns());
  });

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
    const metrics = executionStore.getRunMetrics(runId);
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
  app.route("/", lifecycleRouter(healthStore));
  app.route("/", graphRouter(db, executionStore, runStore, eventStore, sliceStore, connStore, opts?.execution, opts?.providers, opts?.auth, opts?.repos));
  app.route("/", mcpRouter(db, executionStore, eventStore, opts?.execution));
  app.route("/", workRouter());
  app.route("/", decisionsRouter());
  app.route("/", loadoutRouter());
  app.route("/", intakeRouter(connStore, intakeOpts));
  app.route("/", triageModesRouter());
  app.route("/", activityRouter());
  app.route("/", triggersRouter(triggerStore, runStore, eventStore, executionStore));

  return app;
}

async function waitForWorkGraphScratchpad(
  workGraph: ReturnType<typeof getWorkGraph>,
  agentRunId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
) {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const started = Date.now();
  while (!workGraph.getLatestScratchpadByRun(agentRunId)) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Timed out waiting for triage scratchpad for agent run '${agentRunId}'`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Default app factory — call createApp(db, opts) for proper initialization.
export { createApp as default };
