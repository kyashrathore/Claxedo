import { cancelNodeExecution, reconcileExecution } from "../orchestrator/executor";
import { getWorkGraph } from "../orchestrator/workgraph-bridge";
import { liveExecutions, itemRow } from "./graph-query";
import type { IExecutionStore } from "./execution-store";
import type { ISliceStore } from "./slices";
import type { ExecutionAdapter } from "../execution";
import type { SpawnAgentFn } from "../orchestrator/executor";
import type { SqliteDb } from "../sqlite";

export interface ArchiveResult {
  item: ReturnType<typeof itemRow>;
}

export type ArchiveError =
  | { status: 404; error: string }
  | { status: 400; error: string };

/**
 * Archive a work item: cancel any live executions, update WorkGraph state,
 * and reconcile remaining execution. Returns the updated item row or an error.
 */
export async function archiveWorkItem(
  db: SqliteDb,
  id: string,
  reason: string | undefined,
  executionStore: IExecutionStore,
  sliceStore: ISliceStore,
  spawnFn: SpawnAgentFn,
  execution?: ExecutionAdapter,
): Promise<ArchiveResult | ArchiveError> {
  const wg = getWorkGraph();
  const item = wg.get(id);
  if (!item) return { status: 404, error: "Work item not found" };
  if (item.deletedAt) return { status: 400, error: "Deleted work item cannot be archived" };

  const rows = liveExecutions(db, id);
  const runs = new Set<string>();
  for (const row of rows) {
    cancelNodeExecution(executionStore, row.run_id, row.node_id, "archived");
    runs.add(row.run_id);
    await execution?.cleanup?.({
      run_id: row.run_id,
      node_id: row.node_id,
      session_id: row.session_id,
      pty_id: row.pty_id,
      directory: row.directory,
      worktree_path: row.worktree_path,
      mode: "archive",
    });
  }

  const next = wg.archive(id, reason);
  for (const runId of runs) await reconcileExecution(executionStore, runId, spawnFn);

  return { item: itemRow(db, next, sliceStore) };
}
