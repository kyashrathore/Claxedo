import type { Database } from "bun:sqlite";

interface RunRow { run_id: string }
interface NodeRow { node_id: string; status: string; run_id: string }

export interface IRunHealthStore {
  getRun(runId: string): RunRow | null;
  getNodes(runId: string): NodeRow[];
  getLastNodeEventTime(runId: string, nodeId: string): string | null;
}

class SqliteRunHealthStore implements IRunHealthStore {
  constructor(private db: Database) {}

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

export function openSqliteRunHealthStore(db: Database): IRunHealthStore {
  return new SqliteRunHealthStore(db);
}
