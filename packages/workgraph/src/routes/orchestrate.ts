import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ulid } from "ulid";
import type { EventEnvelope } from "../orchestrator/events";
import { generateHash, insertEvent, getNextSeq } from "../db/helpers";
import {
  startOrchestration,
  executeOrchestration,
  cancelOrchestration,
  getOrchestration,
  getAllOrchestrations,
  getRunMetadata,
} from "../orchestrator/executor";
import { planOrchestration } from "../orchestrator/planner";
import { SubprocessBackend, createBackend } from "../orchestrator/backends";
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

  // --- POST /orchestrate/plan --- (planning only, no execution)
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
        const state = await planOrchestration(
          db,
          runId,
          goal,
          spawnAgentViaRoute,
          waitForAgentCompletion,
          work_item_id,
        );

        return c.json(
          {
            run_id: runId,
            goal,
            status: "planned",
            phase: "planned",
            plan: state.plan
              ? {
                  teams: state.plan.teams,
                  tasks: state.plan.tasks.map((t) => ({
                    id: t.id,
                    title: t.title,
                    kind: t.kind,
                    depends_on: t.depends_on,
                  })),
                  summary: state.plan.summary,
                }
              : null,
            node_count: state.task_node_map.size,
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

      if (orch.phase !== "planned") {
        return c.json(
          { error: `Cannot execute: run is in phase '${orch.phase}', expected 'planned'` },
          400
        );
      }

      // Create backend and start execution asynchronously
      const backend = createBackend(
        spawnAgentViaRoute,
        waitForAgentCompletion,
        killAgent,
      );

      const execution = executeOrchestration(db, orch, backend, parentSessionID);
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
      plan_summary: orch.plan?.summary || null,
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
