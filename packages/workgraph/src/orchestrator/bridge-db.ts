/**
 * Database-agnostic interface for the data that syncSourcePlan reads from the
 * orchestrator's SQLite database. Mirrors the repo.ts / db.ts pattern used
 * for WorkGraphRepo.
 */
export interface BridgeDb {
  getSource(sourceId: string): {
    goal: string;
    title: string;
    content: string;
    kind: string;
    repo_ref: string | null;
    repo_label: string | null;
  } | null;
  getNodes(runId: string): Array<{
    node_id: string;
    kind: string;
    title: string;
    node_type: string | null;
    parent_node_id: string | null;
  }>;
  getNodePrompts(runId: string): Array<{ node_id: string; content: string }>;
  getEdges(runId: string): Array<{ source_id: string; target_id: string }>;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

class SqliteBridgeDb implements BridgeDb {
  constructor(private db: any) {}

  getSource(sourceId: string) {
    return this.db
      .query(
        "SELECT goal, title, content, kind, repo_ref, repo_label FROM sources_current WHERE source_id = ?",
      )
      .get(sourceId) as {
        goal: string;
        title: string;
        content: string;
        kind: string;
        repo_ref: string | null;
        repo_label: string | null;
      } | null
  }

  getNodes(runId: string) {
    return this.db
      .query(
        "SELECT node_id, kind, title, node_type, parent_node_id FROM nodes_current WHERE run_id = ? ORDER BY rowid ASC",
      )
      .all(runId) as Array<{
        node_id: string;
        kind: string;
        title: string;
        node_type: string | null;
        parent_node_id: string | null;
      }>
  }

  getNodePrompts(runId: string) {
    return this.db
      .query(
        "SELECT node_id, content FROM scratchpad_entries WHERE run_id = ? ORDER BY created_at ASC",
      )
      .all(runId) as Array<{ node_id: string; content: string }>
  }

  getEdges(runId: string) {
    return this.db
      .query(
        "SELECT source_id, target_id FROM dependency_edges_current WHERE run_id = ?",
      )
      .all(runId) as Array<{ source_id: string; target_id: string }>
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function openSqliteBridgeDb(db: any): BridgeDb {
  return new SqliteBridgeDb(db)
}
