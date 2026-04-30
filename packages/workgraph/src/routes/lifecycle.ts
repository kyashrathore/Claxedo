import { Hono } from "hono";
import { Watchdog } from "../orchestrator/core/services/watchdog";
export type { IRunHealthStore } from "../sdk/health-store";
export { openSqliteRunHealthStore } from "../sdk/health-store";
import type { IRunHealthStore } from "../sdk/health-store";

/**
 * Creates a Hono sub-router for lifecycle APIs.
 * Handles health checks via IRunHealthStore (no raw SQL in route handlers).
 */
export function lifecycleRouter(healthStore: IRunHealthStore) {
  const router = new Hono();

  // --- GET /runs/:run_id/health ---
  router.get("/runs/:run_id/health", async (c) => {
    const runId = c.req.param("run_id");

    const run = healthStore.getRun(runId);
    if (!run) return c.json({ error: "Run not found" }, 404);

    const nodes = healthStore.getNodes(runId);
    const watchdog = new Watchdog({ noProgressTimeoutMs: 120_000 });

    for (const node of nodes) {
      watchdog.recordActivity(node.node_id, node.status);
    }

    const stalledNodes = watchdog.checkStalled();
    return c.json({ healthy: stalledNodes.length === 0, stalledNodes });
  });

  return router;
}
