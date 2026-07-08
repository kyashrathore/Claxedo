/**
 * Flat attempt engine — launches one agent per work item and tracks the
 * lifecycle card → attempt → session with no dependency scheduling.
 *
 * Replaces orchestrator/executor.ts for the flat inbox model
 * (plan 2026-07-06-004): no planner phase, no GraphEngine/edges, no leases or
 * team policies, no in-memory run registry. Run state is derived from the DB;
 * the only module state is a double-spawn guard and best-effort parallelism
 * samples for metrics.
 *
 * Node statuses: pending → active → completed | failed | cancelled.
 * "blocked" nodes (external blockers recorded at snapshot time) are never
 * auto-spawned; a run with only blocked work left parks as "blocked".
 */

import type { IExecutionStore } from "./execution-store";
import { buildTaskPrompt, shared } from "./prompts";
import { getWorkGraph } from "../model/registry";
import type { WorkGraph } from "../model/workgraph";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnAgentFn {
  (
    prompt: string,
    runId: string,
    nodeId: string,
    meta?: {
      role?: string;
      kind?: string;
      title?: string;
      directory?: string;
    },
  ): Promise<{
    id: string;
    runtime_type?: string | null;
    session_id?: string | null;
    pty_id?: string | null;
    directory?: string | null;
    worktree_path?: string | null;
    status?: string;
    exit_code?: number | null;
    output_chunks?: string[];
    stderr_chunks?: string[];
  }>;
}

export interface RunMetrics {
  wall_time_ms: number;
  task_count: number;
  completed_count: number;
  failed_count: number;
  max_parallelism: number;
  avg_parallelism: number;
  total_tokens_used: number | null;
  estimated_cost_usd: number | null;
}

/**
 * Run statuses. The flat engine only produces executing → blocked | completed
 * | failed | cancelled; the planning vocabulary remains for legacy rows.
 */
export type RunPhase =
  | "draft"
  | "planning"
  | "planned"
  | "executing"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunParallelism {
  start_ms: number;
  current: number;
  max: number;
  integral: number;
  last_sample_ms: number;
}

/**
 * Options threaded through the attempt engine. `graph` overrides the
 * registry singleton so embedded hosts (WorkGraphClient) can supply their
 * own WorkGraph instance for item sync.
 */
export interface AttemptOptions {
  graph?: WorkGraph;
}

const MAX_RETRIES = 1;

// ---------------------------------------------------------------------------
// Module state: double-spawn guard + metrics samples (both best-effort)
// ---------------------------------------------------------------------------

const inflight = new Set<string>();
const parallelism = new Map<string, RunParallelism>();

function key(runId: string, nodeId: string) {
  return `${runId}:${nodeId}`;
}

function sample(runId: string, delta: number) {
  const now = Date.now();
  let p = parallelism.get(runId);
  if (!p) {
    p = { start_ms: now, current: 0, max: 0, integral: 0, last_sample_ms: now };
    parallelism.set(runId, p);
  }
  p.integral += p.current * (now - p.last_sample_ms);
  p.current = Math.max(0, p.current + delta);
  p.max = Math.max(p.max, p.current);
  p.last_sample_ms = now;
}

/** Test hook: forget all in-flight guards and metric samples. */
export function resetAttemptState(): void {
  inflight.clear();
  parallelism.clear();
}

export function getRunMetrics(store: IExecutionStore, runId: string): RunMetrics | null {
  return store.getRunMetrics(runId);
}

// ---------------------------------------------------------------------------
// Item sync — node status changes reflect onto the linked work item
// ---------------------------------------------------------------------------

function itemForNode(store: IExecutionStore, runId: string, nodeId: string): string | null {
  return store.getWorkItemForNode?.(runId, nodeId) ?? null;
}

function graphFor(opts?: AttemptOptions): WorkGraph {
  return opts?.graph ?? getWorkGraph();
}

function markItemActive(store: IExecutionStore, runId: string, nodeId: string, opts?: AttemptOptions): void {
  const itemId = itemForNode(store, runId, nodeId);
  if (!itemId) return;
  const wg = graphFor(opts);
  const item = wg.get(itemId);
  if (item && item.status === "open") wg.update(itemId, { status: "in_progress" });
}

async function markItemDone(store: IExecutionStore, runId: string, nodeId: string, opts?: AttemptOptions): Promise<void> {
  const itemId = itemForNode(store, runId, nodeId);
  if (!itemId) return;
  const wg = graphFor(opts);
  if (wg.get(itemId)) await wg.complete(itemId);
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

async function spawnAttempt(
  store: IExecutionStore,
  runId: string,
  nodeId: string,
  spawn: SpawnAgentFn,
  opts?: AttemptOptions,
): Promise<void> {
  const dbNode = store.getNode(nodeId);
  if (dbNode?.node_type === "mission") {
    store.updateNodeStatus(runId, nodeId, "completed");
    return;
  }

  const k = key(runId, nodeId);
  if (inflight.has(k)) return;
  inflight.add(k);

  const role = dbNode?.role || "developer";
  const kind = dbNode?.kind || "task";
  const title = dbNode?.title || nodeId;
  const nodePrompt = store.getScratchpad(runId, nodeId) || `Execute task: ${title}`;
  const agentRunId = crypto.randomUUID();
  const prompt = buildTaskPrompt(role, runId, nodeId, kind, title, nodePrompt, agentRunId);

  store.updateNodeStatus(runId, nodeId, "active");
  markItemActive(store, runId, nodeId, opts);
  sample(runId, +1);

  try {
    const baseDirectory = store.getRunDirectory(runId);
    const agent = await spawn(prompt, runId, nodeId, {
      role,
      kind,
      title,
      directory: baseDirectory ?? undefined,
    });
    const sessionId = agent.session_id ?? agent.id;
    const attachable = !!sessionId || !!agent.pty_id;
    if (!attachable) throw new Error(`Node ${nodeId} started without an attachable session or PTY`);
    if (!shared(kind) && !agent.worktree_path) {
      throw new Error(`Node ${nodeId} started without an isolated worktree`);
    }
    store.createAttempt({
      runId,
      nodeId,
      status: "running",
      runtimeType: agent.runtime_type ?? "workspace",
      directory: agent.directory ?? baseDirectory ?? null,
      worktreePath: agent.worktree_path ?? null,
      sessionId,
      ptyId: agent.pty_id ?? null,
    });
    store.upsertRunExec(runId, {
      runtimeType: agent.runtime_type ?? null,
      sessionId,
      ptyId: agent.pty_id ?? null,
      directory: agent.directory ?? baseDirectory ?? null,
    });
    store.traceEvent({
      event_type: "node_started",
      run_id: runId,
      node_id: nodeId,
      payload: { agent_id: agent.id, agent_run_id: agentRunId, role, kind, title },
    });
  } catch (err) {
    console.error(`[attempts] ${runId} failed to spawn agent for node ${nodeId}:`, err);
    sample(runId, -1);
    inflight.delete(k);
    store.updateNodeStatus(runId, nodeId, "pending");
    // Revert the linked item too — the card should stay actionable.
    const itemId = itemForNode(store, runId, nodeId);
    if (itemId) {
      const wg = graphFor(opts);
      const item = wg.get(itemId);
      if (item && item.status === "in_progress") wg.update(itemId, { status: "open" });
    }
  }
}

// ---------------------------------------------------------------------------
// Completion check — derived purely from node rows
// ---------------------------------------------------------------------------

/**
 * Resolve recorded blockers whose work item is now done, then promote any
 * blocked node with no remaining blockers back to pending. Returns true when
 * at least one node was unblocked (callers should reclassify).
 */
function resolveBlockers(
  store: IExecutionStore,
  runId: string,
  blocked: Array<{ node_id: string }>,
  opts?: AttemptOptions,
): boolean {
  if (!store.listBlockers || !store.removeBlocker) return false;
  const wg = graphFor(opts);
  const recorded = new Set(store.listBlockers(runId).map((row) => row.target_node_id));
  for (const row of store.listBlockers(runId)) {
    if (wg.get(row.work_item_id)?.status === "done") {
      store.removeBlocker(runId, row.work_item_id, row.target_node_id);
    }
  }
  const remaining = new Set(store.listBlockers(runId).map((row) => row.target_node_id));
  let unblocked = false;
  for (const node of blocked) {
    // Only promote nodes whose recorded blockers all resolved. Blocked nodes
    // without any recorded blocker rows stay parked (externally managed).
    if (!recorded.has(node.node_id) || remaining.has(node.node_id)) continue;
    store.updateNodeStatus(runId, node.node_id, "pending");
    unblocked = true;
  }
  return unblocked;
}

async function checkRunCompletion(
  store: IExecutionStore,
  runId: string,
  spawn: SpawnAgentFn,
  opts?: AttemptOptions,
): Promise<void> {
  // Bounded reclassification loop: a pass can change node states (missions
  // complete instantly on spawn, resolved blockers promote nodes back to
  // pending), so classification re-runs until a stable outcome or the guard
  // trips. Worst case (unblock → spawn → classify) needs three extra passes.
  for (let pass = 0; pass < 4; pass++) {
    const allNodes = store.getNodesForRun(runId);
    const by = (s: string) => allNodes.filter((n) => n.status === s);
    const pending = by("pending");
    const blocked = by("blocked");
    const active = by("active");
    const completed = by("completed");
    const failed = by("failed");
    const cancelled = by("cancelled");

    if (pending.length > 0) {
      for (const node of pending) await spawnAttempt(store, runId, node.node_id, spawn, opts);
      // Spawn failures revert nodes to pending: leave the run executing so a
      // later reconcile can retry instead of spinning here.
      if (store.getNodesForRun(runId).some((n) => n.status === "pending")) return;
      continue;
    }

    if (active.length > 0) return;

    if (blocked.length > 0 || store.hasBlockers(runId)) {
      if (resolveBlockers(store, runId, blocked, opts)) continue;
      store.updateRunStatus(runId, "blocked");
      store.emitRunEvent(runId, "run_blocked", { blocked: blocked.length });
      return;
    }

    // All terminal.
    if (failed.length > 0 && completed.length === 0 && cancelled.length === 0) {
      store.finalizeMetrics(runId, { parallelism: parallelism.get(runId) });
      store.updateRunStatus(runId, "failed");
      store.traceEvent({ event_type: "run_failed", run_id: runId, payload: { failed_count: failed.length, error: "All tasks failed" } });
      store.updateSource(store.getRunSourceId(runId), "failed", { error: "All tasks failed", lastRunId: runId });
    } else {
      store.finalizeMetrics(runId, { parallelism: parallelism.get(runId) });
      store.updateRunStatus(runId, "completed");
      store.traceEvent({ event_type: "run_completed", run_id: runId, payload: { completed_count: completed.length, failed_count: failed.length } });
      store.updateSource(store.getRunSourceId(runId), "completed", { error: null, lastRunId: runId });
    }
    parallelism.delete(runId);
    return;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Launch attempts for every pending node of a run — one agent per item,
 * no ordering. Mission nodes complete instantly.
 */
export async function startAttempts(
  store: IExecutionStore,
  runId: string,
  goal: string,
  spawn: SpawnAgentFn,
  opts?: AttemptOptions,
): Promise<void> {
  store.traceEvent({ event_type: "run_created", run_id: runId, payload: { goal } });
  store.updateRunStatus(runId, "executing");
  store.updateSource(store.getRunSourceId(runId), "executing", { error: null, lastRunId: runId });
  store.emitRunEvent(runId, "execution_started", { goal });
  await checkRunCompletion(store, runId, spawn, opts);
}

/**
 * Terminal status reported for an attempt (via the update_status MCP tool or
 * a session-stop signal). Rejects updates for nodes that are not active —
 * the only legal transitions are active → completed | failed.
 */
export async function onAttemptStatusUpdate(
  store: IExecutionStore,
  runId: string,
  nodeId: string,
  status: "completed" | "failed",
  spawn: SpawnAgentFn,
  errorMessage?: string,
  opts?: AttemptOptions,
): Promise<void> {
  const node = store.getNode(nodeId);
  if (!node) {
    console.warn(`[attempts] ${runId} node ${nodeId} not found, ignoring '${status}'`);
    return;
  }
  // The MCP update_status tool writes the node status before this handler
  // runs; treat that idempotent pre-write as legal while the attempt is
  // still open. Everything else outside active is an illegal transition.
  const preWritten = node.status === status && (store.hasOpenAttempt?.(runId, nodeId) ?? false);
  if (node.status !== "active" && !preWritten) {
    console.warn(`[attempts] ${runId} node ${nodeId} is '${node.status}', ignoring illegal transition to '${status}'`);
    return;
  }

  sample(runId, -1);
  inflight.delete(key(runId, nodeId));

  if (status === "completed") {
    store.finishAttempt(runId, nodeId, "completed");
    store.updateNodeStatus(runId, nodeId, "completed");
    store.traceEvent({ event_type: "node_completed", run_id: runId, node_id: nodeId, payload: {} });
    await markItemDone(store, runId, nodeId, opts).catch((err) =>
      console.warn("[attempts] markItemDone error:", err),
    );
  } else {
    const retryCount = node.retry_count ?? 0;
    if (retryCount < MAX_RETRIES) {
      store.finishAttempt(runId, nodeId, "failed");
      store.incrementNodeRetry(nodeId);
      store.traceEvent({ event_type: "node_retried", run_id: runId, node_id: nodeId, payload: { attempt: retryCount + 1, error: errorMessage ?? null } });
      await spawnAttempt(store, runId, nodeId, spawn, opts);
      return;
    }
    store.finishAttempt(runId, nodeId, "failed");
    store.updateNodeStatus(runId, nodeId, "failed");
    store.traceEvent({ event_type: "node_failed", run_id: runId, node_id: nodeId, payload: { retries: retryCount, error: errorMessage ?? null } });
  }

  await checkRunCompletion(store, runId, spawn, opts);
}

/**
 * A session backing an open attempt stopped without reporting a status.
 * Marks the attempt failed (with retry semantics). Returns false when no
 * open attempt matches the session.
 */
export async function onSessionStopped(
  store: IExecutionStore,
  runId: string,
  nodeId: string,
  sessionId: string,
  spawn: SpawnAgentFn,
  errorMessage: string,
  opts?: AttemptOptions,
): Promise<boolean> {
  const attemptId = store.findOpenAttemptId(runId, nodeId, sessionId);
  if (!attemptId) return false;
  await onAttemptStatusUpdate(store, runId, nodeId, "failed", spawn, errorMessage, opts);
  return true;
}

/**
 * @deprecated The planner was removed (plan 2026-07-06-004); there are no
 * planner sessions to stop. Always returns false. Kept only so existing
 * hosts compile until they drop the call.
 */
export async function onPlannerStopped(
  _store: IExecutionStore,
  _runId: string,
  _sessionId: string,
  _errorMessage: string,
): Promise<boolean> {
  return false;
}

/**
 * Cancel a node's execution: close the open attempt and mark the node
 * cancelled. Item status is left untouched so the card can be retried.
 */
export function cancelAttempt(
  store: IExecutionStore,
  runId: string,
  nodeId: string,
  reason = "cancelled",
): void {
  inflight.delete(key(runId, nodeId));
  store.finishAttempt(runId, nodeId, "cancelled");
  store.updateNodeStatus(runId, nodeId, "cancelled");
  store.emitRunEvent(runId, "node_cancelled", { node_id: nodeId, reason });
}

/**
 * Re-derive a run after restart or mutation: spawn still-pending nodes,
 * finish the run if everything is terminal. Terminal runs are left alone.
 */
export async function reconcileAttempts(
  store: IExecutionStore,
  runId: string,
  spawn: SpawnAgentFn,
  opts?: AttemptOptions,
): Promise<void> {
  const run = store.getRun(runId);
  if (!run) return;
  if (run.status === "cancelled" || run.status === "completed" || run.status === "failed") return;
  store.updateRunStatus(runId, "executing");
  await checkRunCompletion(store, runId, spawn, opts);
}
