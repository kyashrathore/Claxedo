import { Hono } from "hono";
import { Watchdog } from "../orchestrator/core/services/watchdog";

interface RunRow { run_id: string }
interface NodeRow { node_id: string; status: string; run_id: string }

export interface IRunHealthStore {
  getRun(runId: string): RunRow | null;
  getNodes(runId: string): NodeRow[];
  getLastNodeEventTime(runId: string, nodeId: string): string | null;
}

class SqliteRunHealthStore implements IRunHealthStore {
  constructor(private db: any) {}

  getRun(runId: string): RunRow | null {
    return this.db.query("SELECT run_id FROM runs_current WHERE run_id = ?").get(runId) as RunRow | null;
  }

  getNodes(runId: string): NodeRow[] {
    return this.db.query("SELECT node_id, status, run_id FROM nodes_current WHERE run_id = ?").all(runId) as NodeRow[];
  }

  getLastNodeEventTime(runId: string, nodeId: string): string | null {
    const row = this.db
      .query("SELECT created_at FROM events WHERE run_id = ? AND payload_json LIKE ? ORDER BY stream_seq DESC LIMIT 1")
      .get(runId, `%${nodeId}%`) as { created_at: string } | null;
    return row?.created_at ?? null;
  }
}

export function openSqliteRunHealthStore(db: any): IRunHealthStore {
  return new SqliteRunHealthStore(db);
}

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
