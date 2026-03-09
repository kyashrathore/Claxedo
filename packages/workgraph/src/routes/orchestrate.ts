import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ulid } from "ulid";
import type { EventEnvelope } from "../orchestrator/events";
import { generateHash, insertEvent, getNextSeq } from "../db/helpers";
import {
  startOrchestration,
  onPlanningComplete,
  cancelOrchestration,
  getOrchestration,
  getAllOrchestrations,
  getRunMetadata,
} from "../orchestrator/executor";
import { getAgentRecord, waitForAgentCompletion } from "./agent";

/**
 * Spawn a Claude agent via the internal agent module.
 * This is the default implementation used in production.
 */
async function spawnAgentViaRoute(
  prompt: string,
  runId: string,
  nodeId: string
): Promise<any> {
  const port = process.env.PORT || 4100;
  console.log(`[orchestrate] Spawning agent via HTTP: run=${runId} node=${nodeId || "(planner)"} prompt="${prompt.slice(0, 60)}..."`);

  const res = await fetch(`http://localhost:${port}/agent/spawn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      run_id: runId,
      node_id: nodeId || undefined,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[orchestrate] Spawn failed: HTTP ${res.status} — ${body}`);
    throw new Error(`Failed to spawn agent: ${res.status} — ${body}`);
  }

  const agent = await res.json();
  console.log(`[orchestrate] Agent spawned: ${agent.id}`);
  return agent;
}

function killAgent(agentId: string): void {
  const agent = getAgentRecord(agentId);
  if (agent?.process) {
    try {
      agent.process.kill("SIGTERM");
    } catch {
      // already exited
    }
  }
}

function createRunInDb(db: any, runId: string, goal: string): void {
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
}

/**
 * Read the current graph state (nodes + edges) from the DB for a run.
 */
function getGraphFromDb(db: any, runId: string) {
  const nodes = db
    .query("SELECT node_id, role, kind, title, status FROM nodes_current WHERE run_id = ?")
    .all(runId) as Array<{
      node_id: string;
      role: string;
      kind: string;
      title: string;
      status: string;
    }>;

  const edges = db
    .query("SELECT id, source_id, target_id, type FROM dependency_edges_current WHERE run_id = ?")
    .all(runId) as Array<{
      id: string;
      source_id: string;
      target_id: string;
      type: string;
    }>;

  return { nodes, edges };
}

export function orchestrateRouter(db: any) {
  const router = new Hono();

  // --- POST /orchestrate --- (backward compat: plan + execute in one call)
  router.post(
    "/orchestrate",
    zValidator(
      "json",
      z.object({
        goal: z.string().min(1),
        work_item_id: z.string().optional(),
      })
    ),
    async (c) => {
      const { goal, work_item_id } = c.req.valid("json");

      const runId = `run_${ulid()}`;
      createRunInDb(db, runId, goal);

      // Start orchestration asynchronously
      const state = startOrchestration(
        db,
        runId,
        goal,
        spawnAgentViaRoute,
        (agentId) => getAgentRecord(agentId)!,
        waitForAgentCompletion,
        work_item_id
      );

      // Don't await — return immediately
      state.catch((err) => {
        console.error(`[orchestrate] Error for run ${runId}:`, err);
      });

      return c.json(
        {
          run_id: runId,
          goal,
          status: "active",
          phase: "planning",
        },
        201
      );
    }
  );

  // --- POST /orchestrate/plan --- (planning only: planner builds graph via MCP tools, no execution)
  router.post(
    "/orchestrate/plan",
    zValidator(
      "json",
      z.object({
        goal: z.string().min(1),
        work_item_id: z.string().optional(),
        parent_session_id: z.string().optional(),
      })
    ),
    async (c) => {
      const { goal, work_item_id, parent_session_id } = c.req.valid("json");

      const runId = `run_${ulid()}`;
      createRunInDb(db, runId, goal);

      try {
        // Start orchestration but don't execute — the planner agent builds
        // the graph via MCP tools. We await planning completion, then return
        // the graph as the "plan".
        const statePromise = startOrchestration(
          db,
          runId,
          goal,
          spawnAgentViaRoute,
          (agentId) => getAgentRecord(agentId)!,
          waitForAgentCompletion,
          work_item_id,
        );

        // Wait for planning to complete (startOrchestration runs plan + execute,
        // but we return graph state once nodes exist). For plan-only, we await
        // the full orchestration — if only planning is desired, the caller can
        // use the /execute endpoint separately.
        const state = await statePromise;

        // Read the graph that the planner agent built
        const graph = getGraphFromDb(db, runId);

        return c.json(
          {
            run_id: runId,
            goal,
            status: state.phase,
            phase: state.phase,
            graph: {
              nodes: graph.nodes.map((n) => ({
                node_id: n.node_id,
                title: n.title,
                kind: n.kind,
                role: n.role,
                status: n.status,
              })),
              edges: graph.edges.map((e) => ({
                id: e.id,
                source_id: e.source_id,
                target_id: e.target_id,
                type: e.type,
              })),
            },
            node_count: graph.nodes.length,
          },
          201
        );
      } catch (err) {
        return c.json(
          {
            run_id: runId,
            error: (err as Error).message,
            phase: "failed",
          },
          500
        );
      }
    }
  );

  // --- POST /orchestrate/:run_id/execute --- (execute a planned run)
  router.post(
    "/orchestrate/:run_id/execute",
    zValidator(
      "json",
      z.object({
        parent_session_id: z.string().optional(),
      }).optional()
    ),
    async (c) => {
      const runId = c.req.param("run_id");
      const body = c.req.valid("json");
      const parentSessionID = body?.parent_session_id;

      const orch = getOrchestration(runId);
      if (!orch) {
        return c.json({ error: "Orchestration not found" }, 404);
      }

      if (orch.phase === "executing") {
        return c.json(
          { error: `Run is already executing` },
          400
        );
      }

      if (orch.phase === "completed" || orch.phase === "failed" || orch.phase === "cancelled") {
        return c.json(
          { error: `Cannot execute: run is in phase '${orch.phase}'` },
          400
        );
      }

      // Trigger execution cascade via onPlanningComplete (MCP-driven model)
      const execution = onPlanningComplete(db, runId, "Manual execution trigger", spawnAgentViaRoute);
      execution.catch((err) => {
        console.error(`[orchestrate] Execute error for run ${runId}:`, err);
      });

      return c.json({
        run_id: runId,
        phase: "executing",
      });
    }
  );

  // --- GET /orchestrate/:run_id ---
  router.get("/orchestrate/:run_id", async (c) => {
    const runId = c.req.param("run_id");
    const orch = getOrchestration(runId);

    if (!orch) {
      return c.json({ error: "Orchestration not found" }, 404);
    }

    const run = db
      .query("SELECT * FROM runs_current WHERE run_id = ?")
      .get(runId) as any;

    const nodes = db
      .query("SELECT * FROM nodes_current WHERE run_id = ?")
      .all(runId) as any[];

    return c.json({
      run_id: orch.run_id,
      phase: orch.phase,
      goal: run?.goal,
      status: run?.status,
      planner_agent_id: orch.planner_agent_id,
      error: orch.error,
      created_at: orch.created_at,
      result: orch.result || null,
      node_count: nodes.length,
      nodes_by_status: {
        pending: nodes.filter((n) => n.status === "pending").length,
        active: nodes.filter((n) => n.status === "active").length,
        completed: nodes.filter((n) => n.status === "completed").length,
        failed: nodes.filter((n) => n.status === "failed").length,
      },
    });
  });

  // --- GET /orchestrate/:run_id/metadata ---
  router.get("/orchestrate/:run_id/metadata", async (c) => {
    const runId = c.req.param("run_id");
    const metadata = getRunMetadata(db, runId);
    if (!metadata) {
      return c.json({ error: "Orchestration not found" }, 404);
    }
    return c.json(metadata);
  });

  // --- GET /orchestrate ---
  router.get("/orchestrate", async (c) => {
    const all = getAllOrchestrations();
    return c.json(
      all.map((o) => ({
        run_id: o.run_id,
        phase: o.phase,
        error: o.error,
        created_at: o.created_at,
      }))
    );
  });

  // --- POST /orchestrate/:run_id/cancel ---
  router.post("/orchestrate/:run_id/cancel", async (c) => {
    const runId = c.req.param("run_id");
    const orch = getOrchestration(runId);

    if (!orch) {
      return c.json({ error: "Orchestration not found" }, 404);
    }

    if (orch.phase === "completed" || orch.phase === "failed" || orch.phase === "cancelled") {
      return c.json({ error: `Orchestration already ${orch.phase}` }, 400);
    }

    cancelOrchestration(orch, db, killAgent);

    return c.json({ run_id: runId, phase: orch.phase, message: "Cancelled" });
  });

  return router;
}
