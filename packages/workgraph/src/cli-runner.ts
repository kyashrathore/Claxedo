/**
 * CLI runner — orchestrates a run end-to-end in-process.
 *
 * Creates a run in an embedded SQLite database, starts orchestration with
 * either a real or mock SpawnAgentFn, polls for completion, and returns
 * metrics when done.
 */

import { Database } from "bun:sqlite";
import { initializeDb, createApp } from "./app";
import {
  startOrchestration,
  getOrchestration,
  getRunMetrics,
  type RunMetrics,
  type SpawnAgentFn,
} from "./orchestrator/executor";
import { openSqliteEventStore } from "./orchestrator/core/services/event-store-sqlite";
import { openSqliteExecutionStore, type IExecutionStore } from "./sdk/execution-store";
import type { NodeSummary } from "./cli-metrics";

export interface RunOptions {
  goal: string;
  directory?: string;
  runtime?: "workspace" | "task";
  dryRun?: boolean;
  /** Called on each status update with current node states */
  onUpdate?: (nodes: NodeSummary[], phase: string) => void;
}

export interface RunResult {
  runId: string;
  phase: string;
  metrics: RunMetrics | null;
  nodes: NodeSummary[];
}

const POLL_INTERVAL_MS = 100;
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Create a dry-run SpawnAgentFn that auto-completes nodes without AI.
 */
function makeDryRunSpawnFn(db: any, executionStore: IExecutionStore): SpawnAgentFn {
  const { onNodeStatusUpdate, onPlanningComplete } = require("./orchestrator/executor");
  const { handleToolCall } = require("./mcp/tools");
  let seq = 0;

  const fn: SpawnAgentFn = async (prompt: string, runId: string, nodeId: string, meta?: any) => {
    const agentId = `dry_${++seq}`;
    const dir = meta?.directory ?? `/tmp/dry/${agentId}`;

    // Schedule async completion
    setTimeout(async () => {
      if (nodeId === "") {
        // Planner: create a single summary node
        const ctx = { db, runId };
        await handleToolCall(ctx, "create_node", {
          title: "Dry run task",
          kind: "research",
          role: "developer",
          prompt: `[dry-run] ${prompt.slice(0, 200)}`,
        });
        await onPlanningComplete(executionStore, runId, "[dry-run] Plan complete", fn);
      } else {
        // Task: write scratchpad and complete
        const ctx = { db, runId, nodeId };
        await handleToolCall(ctx, "write_scratchpad", {
          content: `[dry-run] Completed ${nodeId}`,
        });
        await onNodeStatusUpdate(executionStore, runId, nodeId, "completed", fn);
      }
    }, 0);

    return {
      id: agentId,
      session_id: agentId,
      runtime_type: "task",
      directory: dir,
      worktree_path: dir,
      status: "running",
    };
  };

  return fn;
}

function getCurrentNodes(db: any, runId: string): NodeSummary[] {
  const rows = db
    .query("SELECT title, status FROM nodes_current WHERE run_id = ? ORDER BY rowid ASC")
    .all(runId) as Array<{ title: string; status: string }>;
  return rows.map((r) => ({ title: r.title || "(untitled)", status: r.status }));
}

export async function runCLI(opts: RunOptions): Promise<RunResult> {
  const db = new Database(":memory:");
  initializeDb(db);
  const eventStore = openSqliteEventStore(db);
  const executionStore = openSqliteExecutionStore(db, eventStore);

  // Create run
  const app = createApp(db);
  const createRes = await app.request("/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal: opts.goal }),
  });

  if (!createRes.ok) {
    throw new Error(`Failed to create run: ${createRes.status}`);
  }

  const { run_id: runId } = await createRes.json();

  // Build spawn function
  const spawnFn: SpawnAgentFn = opts.dryRun
    ? makeDryRunSpawnFn(db, executionStore)
    : (() => { throw new Error("Real agent spawning not implemented in CLI yet. Use --dry-run for testing."); })();

  // Start orchestration (fire and forget)
  await startOrchestration(executionStore, runId, opts.goal, spawnFn);

  // Poll for completion
  const startMs = Date.now();
  let phase = "planning";

  while (true) {
    const state = getOrchestration(runId);
    phase = state?.phase ?? "unknown";
    const nodes = getCurrentNodes(db, runId);

    if (opts.onUpdate) {
      opts.onUpdate(nodes, phase);
    }

    if (phase === "completed" || phase === "failed" || phase === "cancelled") {
      break;
    }

    if (Date.now() - startMs > MAX_WAIT_MS) {
      throw new Error(`Run ${runId} timed out after ${MAX_WAIT_MS}ms`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  const metrics = getRunMetrics(executionStore, runId);
  const nodes = getCurrentNodes(db, runId);

  return { runId, phase, metrics, nodes };
}
