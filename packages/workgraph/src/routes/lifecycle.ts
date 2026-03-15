import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ReactionEngine } from "../orchestrator/core/services/reactions";
import { Watchdog } from "../orchestrator/core/services/watchdog";

/**
 * Creates a Hono sub-router for lifecycle automation APIs.
 * Handles reaction evaluation and health checks.
 */
export function lifecycleRouter(db: any) {
  const router = new Hono();

  // --- POST /runs/:run_id/reactions/evaluate ---
  router.post(
    "/runs/:run_id/reactions/evaluate",
    zValidator(
      "json",
      z.object({
        event: z.object({
          type: z.string().min(1),
          payload: z.any(),
        }),
        rules: z
          .array(
            z.object({
              id: z.string().min(1),
              trigger: z.string().min(1),
              cooldownMs: z.number().optional(),
            })
          )
          .optional(),
      })
    ),
    async (c) => {
      const runId = c.req.param("run_id");
      const { event, rules } = c.req.valid("json");

      // Check the run exists
      const run = db
        .query("SELECT * FROM runs_current WHERE run_id = ?")
        .get(runId) as { run_id: string } | null;

      if (!run) {
        return c.json({ error: "Run not found" }, 404);
      }

      // Get current run state for reaction evaluation
      const runState = db
        .query("SELECT * FROM runs_current WHERE run_id = ?")
        .get(runId);

      const engine = new ReactionEngine();

      // Add rules if provided
      if (rules) {
        for (const rule of rules) {
          engine.addRule({
            id: rule.id,
            trigger: rule.trigger,
            cooldownMs: rule.cooldownMs ?? 0,
            condition: () => true,
            action: (evt: any, _state: any) => ({
              type: `${rule.trigger}_reaction`,
              payload: { source_event: evt.type, rule_id: rule.id },
            }),
          });
        }
      }

      const actions = engine.evaluate(event, runState);

      return c.json({ run_id: runId, actions }, 200);
    }
  );

  // --- GET /runs/:run_id/health ---
  router.get("/runs/:run_id/health", async (c) => {
    const runId = c.req.param("run_id");

    // Check the run exists
    const run = db
      .query("SELECT * FROM runs_current WHERE run_id = ?")
      .get(runId) as { run_id: string } | null;

    if (!run) {
      return c.json({ error: "Run not found" }, 404);
    }

    // Query all nodes for this run
    const nodes = db
      .query("SELECT * FROM nodes_current WHERE run_id = ?")
      .all(runId) as Array<{
      node_id: string;
      run_id: string;
      team_id: string;
      kind: string;
      status: string;
      retry_count: number;
    }>;

    const watchdog = new Watchdog({ noProgressTimeoutMs: 120_000 });

    // Record activity for each node
    // Check events for last activity timestamp per node
    for (const node of nodes) {
      // Find the latest event involving this node
      const latestEvent = db
        .query(
          "SELECT created_at FROM events WHERE run_id = ? AND payload_json LIKE ? ORDER BY stream_seq DESC LIMIT 1"
        )
        .get(runId, `%${node.node_id}%`) as { created_at: string } | null;

      const lastActivityAt = latestEvent
        ? new Date(latestEvent.created_at).getTime()
        : Date.now();

      watchdog.recordActivity(node.node_id, node.status);
      // Override the internal timestamp for accurate checking
      // We use a direct approach: check manually
    }

    const stalledNodes = watchdog.checkStalled();

    return c.json({
      healthy: stalledNodes.length === 0,
      stalledNodes,
    });
  });

  return router;
}
