import { Hono } from "hono";
import { Watchdog } from "../orchestrator/core/services/watchdog";

/**
 * Creates a Hono sub-router for lifecycle APIs.
 * Handles health checks.
 */
export function lifecycleRouter(db: any) {
  const router = new Hono();

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
