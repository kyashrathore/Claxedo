import type { OrchestratorRunState, OrchestratorHooks, NodeAgentHistory, RunPhase } from "./types";
import type { OrchestratorMetadata } from "./types-ui";
import { LeaseManager, type TeamPolicy, getReadyNodes } from "./core/scheduler";
import { GraphEngine, type Node as GraphNode } from "./graph";
import { linkRun, markNodeDone, getWorkGraph, onRunCompleted as bridgeOnRunCompleted } from "./workgraph-bridge";
import type { IExecutionStore } from "../sdk/execution-store";
import { buildPlannerPrompt, buildTaskPrompt, contract, shared } from "./prompts";

// ---------------------------------------------------------------------------
// RunMetrics — computed at run completion, stored in runs_current.metrics_json
// ---------------------------------------------------------------------------

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

const MAX_RETRIES = 2;

/**
 * Sample the parallelism tracker: flush the integral for elapsed time,
 * apply the count delta, and update the timestamp.
 */
function sampleParallelism(p: import("./types").ParallelismTracker, delta: number): void {
  const now = Date.now();
  const dt = now - p.last_sample_ms;
  p.integral += p.current * dt;
  p.last_sample_ms = now;
  p.current = Math.max(0, p.current + delta);
  if (p.current > p.max) p.max = p.current;
}

/**
 * Get RunMetrics for a completed run from the store.
 */
export function getRunMetrics(store: IExecutionStore, runId: string): RunMetrics | null {
  return store.getRunMetrics(runId);
}

// ---------------------------------------------------------------------------
// Function type interfaces
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

export interface AgentState {
  id: string;
  status?: string;
  exit_code?: number | null;
  output_chunks?: string[];
  stderr_chunks?: string[];
}

// ---------------------------------------------------------------------------
// In-memory orchestration state
// ---------------------------------------------------------------------------

/** Active orchestration runs keyed by run_id */
const orchestrations = new Map<string, OrchestratorRunState>();

export function getOrchestration(runId: string): OrchestratorRunState | undefined {
  return orchestrations.get(runId);
}

export function getAllOrchestrations(): OrchestratorRunState[] {
  return Array.from(orchestrations.values());
}

export function clearAllIntervals(): void {
  // No-op in MCP-driven mode (no polling intervals)
  // Kept for backward compatibility with server.ts
}

/**
 * Get the OrchestratorMetadata for a run, suitable for the frontend
 * OrchestratorTool component (sent as ToolPart.state.metadata).
 */
export function getRunMetadata(store: IExecutionStore, runId: string): OrchestratorMetadata | undefined {
  const state = orchestrations.get(runId);
  if (!state) return undefined;

  const rawNodes = store.queryRunNodes(runId);
  const nodes = rawNodes.map((node) => ({
    id: node.node_id,
    title: node.title || node.kind,
    kind: node.kind,
    status: (
      node.status === "active"
        ? "running"
        : node.status === "pending"
          ? "pending"
          : node.status === "completed"
            ? "completed"
            : node.status === "failed"
              ? "failed"
              : "blocked"
    ) as "pending" | "running" | "completed" | "failed" | "blocked",
    sessionID: node.session_id ?? undefined,
    agent: node.role || "developer",
  }));

  const rawEdges = store.getEdgesForRun(runId);
  const edges = rawEdges.map((edge) => ({ source: edge.source_id, target: edge.target_id }));

  const done = nodes.filter((node) => node.status === "completed").length;
  const running = nodes.filter((node) => node.status === "running").length;
  const failed = nodes.filter((node) => node.status === "failed").length;
  const summary = [
    nodes.length ? `${done}/${nodes.length} tasks completed` : "",
    running ? `${running} running` : "",
    failed ? `${failed} failed` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    goal: store.getRunGoal(runId),
    phase: state.phase === "blocked" ? "executing" : (state.phase as OrchestratorMetadata["phase"]),
    nodes,
    edges,
    summary: summary || undefined,
    startTime: new Date(state.created_at).getTime(),
    endTime:
      state.phase === "completed" || state.phase === "failed"
        ? Date.now()
        : undefined,
  };
}

function agentErr(agent: AgentState) {
  const err = agent.stderr_chunks?.join("").trim();
  if (err) return err;
  const out = agent.output_chunks?.join("").trim();
  if (out) return out;
  if (typeof agent.exit_code === "number") return `Planner exited with code ${agent.exit_code}`;
  return "Planner exited before calling finish_planning";
}

function failPlanning(store: IExecutionStore, runId: string, message: string) {
  const state = orchestrations.get(runId);
  if (!state || state.phase !== "planning") return false;
  state.phase = "failed";
  state.error = message;
  store.updateRunStatus(runId, "failed");
  store.emitRunEvent(runId, "planning_failed", { error: message });
  store.updateSource(store.getRunSourceId(runId), "failed", { error: message, planRunId: runId });
  return true;
}

function sourceStatus(sourceId: string | null, status: "completed" | "failed", hooks?: OrchestratorHooks) {
  if (!sourceId || status === "failed") return status;
  if (hooks?.sourceHasWork) return hooks.sourceHasWork(sourceId) ? "planned" : "completed";
  return status;
}

// ---------------------------------------------------------------------------
// startOrchestration — MCP-driven entry point
// ---------------------------------------------------------------------------

/**
 * Start an orchestration run for a goal.
 *
 * In the MCP-driven model:
 *   1. Create initial state (phase="planning")
 *   2. Store in orchestrations map
 *   3. Spawn the PLANNER agent with MCP tools configured
 *   4. The planner builds the graph via MCP tools and calls finish_planning
 *   5. finish_planning triggers onPlanningComplete which starts the execution cascade
 *
 * The planner agent is fire-and-forget — this function returns immediately
 * after spawning it. The planner calls finish_planning MCP tool when done,
 * which triggers the execution cascade.
 */
export async function startOrchestration(
  store: IExecutionStore,
  runId: string,
  goal: string,
  spawnAgentFn: SpawnAgentFn,
  opts?: {
    auto_execute?: boolean;
    hooks?: OrchestratorHooks;
    teamPolicy?: TeamPolicy;
    /** Link this run to an existing WorkGraph item by ID */
    work_item_id?: string;
  },
): Promise<OrchestratorRunState> {
  const state: OrchestratorRunState = {
    run_id: runId,
    phase: "planning",
    auto_execute: opts?.auto_execute ?? true,
    planner_agent_id: null,
    node_agents: new Map(),
    error: null,
    created_at: new Date().toISOString(),
    result: null,
    leaseManager: new LeaseManager(),
    teamPolicy: opts?.teamPolicy ?? { maxActivePerRun: 12, maxActivePerTeam: 4 },
    hooks: opts?.work_item_id
      ? {
          ...opts?.hooks,
          onRunCompleted: opts?.hooks?.onRunCompleted ?? bridgeOnRunCompleted,
        }
      : opts?.hooks,
  };

  if (opts?.work_item_id) linkRun(runId, opts.work_item_id);

  orchestrations.set(runId, state);
  store.updateRunStatus(runId, "planning");
  store.emitRunEvent(runId, "planning_started", { auto_execute: state.auto_execute });
  store.traceEvent({ event_type: "run_created", run_id: runId, payload: { goal, auto_execute: state.auto_execute } });

  // Spawn the planner agent (fire and forget)
  try {
    const plannerPrompt = buildPlannerPrompt(runId, goal, store.getRunSource(runId));
    const plannerAgent = await spawnAgentFn(plannerPrompt, runId, "");
    state.planner_agent_id = plannerAgent.id;
    store.upsertRunExec(runId, {
      runtimeType: plannerAgent.runtime_type ?? "workspace",
      sessionId: plannerAgent.session_id ?? null,
      ptyId: plannerAgent.pty_id ?? null,
      directory: plannerAgent.directory ?? null,
    });
    console.log(`[executor] ${runId} planner agent spawned: ${plannerAgent.id}`);
    store.traceEvent({ event_type: "planning_start", run_id: runId, payload: { planner_agent_id: plannerAgent.id } });
  } catch (err) {
    failPlanning(store, runId, `Failed to spawn planner agent: ${(err as Error).message}`);
    console.error(`[executor] ${runId} failed to spawn planner:`, err);
  }

  return state;
}

// ---------------------------------------------------------------------------
// onPlanningComplete — called by MCP finish_planning tool handler
// ---------------------------------------------------------------------------

/**
 * Called when the planner agent finishes building the graph via MCP tools
 * and calls the `finish_planning` tool.
 *
 * Transitions from planning → executing and kicks off the execution cascade
 * by finding ready nodes and spawning task agents for each.
 */
export async function onPlanningComplete(
  store: IExecutionStore,
  runId: string,
  summary: string,
  spawnAgentFn: SpawnAgentFn,
): Promise<void> {
  const state = orchestrations.get(runId);
  if (!state) {
    console.error(`[executor] onPlanningComplete: run ${runId} not found`);
    return;
  }

  if (state.phase !== "planning" && state.phase !== "planned") {
    console.warn(`[executor] onPlanningComplete: run ${runId} in unexpected phase '${state.phase}'`);
    return;
  }

  store.traceEvent({ event_type: "planning_end", run_id: runId, payload: { summary } });

  if (!state.auto_execute) {
    state.phase = "planned";
    state.result = summary;
    store.updateRunStatus(runId, "planned");
    const sourceId = store.getRunSourceId(runId);
    if (sourceId) {
      state.hooks?.onPlanSynced?.(store, runId, sourceId);
      store.updateSource(sourceId, "planned", { error: null, planRunId: runId });
    }
    return;
  }

  await beginExecution(store, state, summary, spawnAgentFn);
}

export async function onPlannerStopped(
  store: IExecutionStore,
  runId: string,
  sessionId: string,
  errorMessage: string,
): Promise<boolean> {
  const state = orchestrations.get(runId);
  if (!state || state.phase !== "planning") return false;
  if (state.planner_agent_id && state.planner_agent_id !== sessionId) return false;
  return failPlanning(store, runId, errorMessage);
}

async function beginExecution(
  store: IExecutionStore,
  state: OrchestratorRunState,
  summary: string,
  spawnAgentFn: SpawnAgentFn,
): Promise<void> {
  const runId = state.run_id;

  state.phase = "executing";
  state.result = null;
  // Initialize parallelism tracker for metrics
  const now = Date.now();
  state.parallelism = { start_ms: now, current: 0, max: 0, integral: 0, last_sample_ms: now };
  store.updateRunStatus(runId, "executing");
  store.updateSource(store.getRunSourceId(runId), "executing", { error: null, lastRunId: runId });
  store.emitRunEvent(runId, "execution_started", { summary });
  console.log(`[executor] ${runId} planning complete, transitioning to executing. Summary: "${summary.slice(0, 120)}"`);

  // Check if there are any nodes at all
  const allNodes = store.getNodesForRun(runId);

  if (allNodes.length === 0) {
    console.log(`[executor] ${runId} no nodes found, marking completed`);
    state.phase = "completed";
    state.result = summary;
    store.updateRunStatus(runId, "completed");
    state.hooks?.onRunCompleted?.(runId).catch((err) =>
      console.warn("[executor] workgraph onRunCompleted error:", err),
    );
    return;
  }

  // Find ready nodes and spawn task agents
  const readyNodeIds = findScheduledReadyNodes(store, runId, state);
  console.log(`[executor] ${runId} found ${readyNodeIds.length} ready nodes after planning`);

  for (const nodeId of readyNodeIds) {
    await spawnTaskAgent(store, state, nodeId, spawnAgentFn);
  }

  // If no nodes are ready and none are running, check for outside blockers first
  if (readyNodeIds.length === 0) {
    const active = allNodes.filter((n) => n.status === "active");
    if (active.length === 0) {
      if (store.hasBlockers(runId)) {
        console.log(`[executor] ${runId} blocked after planning: waiting on outside work`);
        state.phase = "blocked";
        store.updateRunStatus(runId, "blocked");
        store.emitRunEvent(runId, "run_blocked", { reason: "outside_blockers" });
        return;
      }
      console.error(`[executor] ${runId} deadlock after planning: no ready or active nodes`);
      state.phase = "failed";
      state.error = "Deadlock: no nodes are ready and none are running after planning";
      store.updateRunStatus(runId, "failed");
    }
  }
}

export async function startExecution(
  store: IExecutionStore,
  runId: string,
  goal: string,
  spawnAgentFn: SpawnAgentFn,
  opts?: { hooks?: OrchestratorHooks; teamPolicy?: TeamPolicy; node_work_items?: Map<string, string> },
): Promise<OrchestratorRunState> {
  const state: OrchestratorRunState = {
    run_id: runId,
    phase: "planned",
    auto_execute: true,
    planner_agent_id: null,
    node_agents: new Map(),
    error: null,
    created_at: new Date().toISOString(),
    result: null,
    leaseManager: new LeaseManager(),
    teamPolicy: opts?.teamPolicy ?? { maxActivePerRun: 12, maxActivePerTeam: 4 },
    node_work_items: opts?.node_work_items,
    hooks: opts?.node_work_items
      ? {
          ...opts?.hooks,
          sourceHasWork: opts?.hooks?.sourceHasWork ?? ((sourceId: string) => {
            const wg = getWorkGraph();
            const items = wg.getBySource(sourceId);
            return items.some((item) => item.status !== "done");
          }),
        }
      : opts?.hooks,
  };

  orchestrations.set(runId, state);
  store.traceEvent({ event_type: "run_created", run_id: runId, payload: { goal } });
  await beginExecution(store, state, goal, spawnAgentFn);
  return state;
}

// ---------------------------------------------------------------------------
// onNodeStatusUpdate — called by MCP update_status tool handler
// ---------------------------------------------------------------------------

/**
 * Called when a task agent finishes a node (via the `update_status` MCP tool).
 *
 * Handles:
 *   - Marking the node completed/failed in the DB
 *   - Retry logic for failed nodes
 *   - Cascade: finding newly ready nodes and spawning agents for them
 *   - Cascade failure to dependent nodes when retries exhausted
 *   - Detecting run completion or failure
 */
export async function onNodeStatusUpdate(
  store: IExecutionStore,
  runId: string,
  nodeId: string,
  status: "completed" | "failed",
  spawnAgentFn: SpawnAgentFn,
  errorMessage?: string,
): Promise<void> {
  const state = orchestrations.get(runId);
  if (!state) {
    console.error(`[executor] onNodeStatusUpdate: run ${runId} not found`);
    return;
  }

  if (state.phase !== "executing") {
    console.warn(`[executor] onNodeStatusUpdate: run ${runId} in phase '${state.phase}', ignoring`);
    return;
  }

  // Update agent history
  const history = state.node_agents.get(nodeId);
  if (history) {
    const lastEntry = history.history[history.history.length - 1];
    if (lastEntry) {
      lastEntry.status = status;
      lastEntry.finished_at = new Date().toISOString();
    }
    history.current_agent_id = null;
  }

  if (state.parallelism) sampleParallelism(state.parallelism, -1);

  if (status === "completed") {
    console.log(`[executor] ${runId} node ${nodeId} completed`);
    store.finishAttempt(runId, nodeId, "completed");
    store.updateNodeStatus(runId, nodeId, "completed");
    state.leaseManager.releaseLease(nodeId);
    store.traceEvent({ event_type: "node_completed", run_id: runId, node_id: nodeId, payload: {} });
    if (state.node_work_items) {
      markNodeDone(state.node_work_items, nodeId).catch((err) =>
        console.warn("[executor] markNodeDone error:", err),
      );
    }
    state.hooks?.onNodeCompleted?.(runId, nodeId).catch((err) =>
      console.warn("[executor] workgraph onNodeCompleted error:", err),
    );
  } else {
    // Failed — check retry count
    const dbNode = store.getNode(nodeId);
    const retryCount = dbNode?.retry_count ?? 0;

    console.error(
      `[executor] ${runId} node ${nodeId} failed (retry ${retryCount}/${MAX_RETRIES}): ${errorMessage?.slice(0, 200) ?? "(no error message)"}`,
    );

    if (retryCount < MAX_RETRIES) {
      // Retry: increment count, re-spawn agent
      store.finishAttempt(runId, nodeId, "failed");
      store.incrementNodeRetry(nodeId);
      console.log(`[executor] ${runId} node ${nodeId} retrying (attempt ${retryCount + 1})`);
      store.traceEvent({ event_type: "node_retried", run_id: runId, node_id: nodeId, payload: { attempt: retryCount + 1, error: errorMessage ?? null } });
      state.leaseManager.releaseLease(nodeId);
      await spawnTaskAgent(store, state, nodeId, spawnAgentFn);
      return;
    }

    // All retries exhausted — mark failed
    console.error(`[executor] ${runId} node ${nodeId} max retries exhausted — marking failed`);
    store.finishAttempt(runId, nodeId, "failed");
    store.updateNodeStatus(runId, nodeId, "failed");
    state.leaseManager.releaseLease(nodeId);
    store.traceEvent({ event_type: "node_failed", run_id: runId, node_id: nodeId, payload: { retries: retryCount, error: errorMessage ?? null } });
    state.hooks?.onNodeFailed?.(runId, nodeId);

    // Cascade failure to dependent nodes
    cascadeFailure(store, runId, nodeId);
  }

  // Check if the run is complete
  await checkRunCompletion(store, runId, state, spawnAgentFn);
}

export async function onSessionStopped(
  store: IExecutionStore,
  runId: string,
  nodeId: string,
  sessionId: string,
  spawnAgentFn: SpawnAgentFn,
  errorMessage: string,
): Promise<boolean> {
  const attemptId = store.findOpenAttemptId(runId, nodeId, sessionId);
  if (!attemptId) return false;
  await onNodeStatusUpdate(store, runId, nodeId, "failed", spawnAgentFn, errorMessage);
  return true;
}

export function cancelNodeExecution(
  store: IExecutionStore,
  runId: string,
  nodeId: string,
  reason = "cancelled",
): void {
  const state = orchestrations.get(runId);
  const history = state?.node_agents.get(nodeId);
  if (history) {
    const last = history.history[history.history.length - 1];
    if (last) {
      last.status = "cancelled";
      last.finished_at = new Date().toISOString();
    }
    history.current_agent_id = null;
  }
  store.finishAttempt(runId, nodeId, "cancelled");
  store.updateNodeStatus(runId, nodeId, "cancelled");
  store.emitRunEvent(runId, "node_cancelled", { node_id: nodeId, reason });
}

export async function reconcileExecution(
  store: IExecutionStore,
  runId: string,
  spawnAgentFn: SpawnAgentFn,
  hooks?: OrchestratorHooks,
): Promise<void> {
  const state = ensureState(store, runId);
  if (!state) return;
  if (state.phase === "cancelled" || state.phase === "completed" || state.phase === "failed") return;
  if (hooks && !state.hooks) state.hooks = hooks;
  state.phase = "executing";
  await checkRunCompletion(store, runId, state, spawnAgentFn);
}

// ---------------------------------------------------------------------------
// findReadyNodes — query DB for pending nodes with all deps satisfied
// ---------------------------------------------------------------------------

function dbStatusToNodeStatus(s: string): GraphNode["status"] {
  if (
    s === "active" ||
    s === "completed" ||
    s === "failed" ||
    s === "retryable"
  )
    return s;
  // "blocked" nodes are waiting on external dependencies — treat as "active"
  // so GraphEngine neither schedules them nor cascades completion to dependents
  if (s === "blocked") return "active";
  return "pending";
}

/**
 * Same cascade-failure logic as findReadyNodes, but uses GraphEngine +
 * LeaseManager + TeamPolicy from state to enforce parallelism caps.
 */
function findScheduledReadyNodes(
  store: IExecutionStore,
  runId: string,
  state: OrchestratorRunState,
): string[] {
  const allNodes = store.getNodesForRun(runId);
  const edges = store.getEdgesForRun(runId);

  const statusMap = new Map<string, string>();
  for (const node of allNodes) statusMap.set(node.node_id, node.status);

  const dependenciesOf = new Map<string, string[]>();
  for (const edge of edges) {
    const deps = dependenciesOf.get(edge.target_id) ?? [];
    deps.push(edge.source_id);
    dependenciesOf.set(edge.target_id, deps);
  }

  // Cascade failure + mission completion (mirrors findReadyNodes side-effects)
  for (const node of allNodes) {
    if (node.node_type === "mission") {
      if (node.status === "pending") {
        store.updateNodeStatus(runId, node.node_id, "completed");
        statusMap.set(node.node_id, "completed");
      }
      continue;
    }
    if (node.status !== "pending") continue;
    const deps = dependenciesOf.get(node.node_id) ?? [];
    const anyDepFailed = deps.some((d) => statusMap.get(d) === "failed");
    if (anyDepFailed) {
      store.updateNodeStatus(runId, node.node_id, "failed");
      statusMap.set(node.node_id, "failed");
      continue;
    }
    const anyDepStopped = deps.some((d) => {
      const s = statusMap.get(d);
      return s === "cancelled" || s === "blocked";
    });
    if (anyDepStopped) {
      store.updateNodeStatus(runId, node.node_id, "blocked");
      statusMap.set(node.node_id, "blocked");
    }
  }

  // Build GraphEngine nodes (excluding missions)
  const graphNodes: GraphNode[] = allNodes
    .filter((n) => n.node_type !== "mission")
    .map((n) => ({
      id: n.node_id,
      status: dbStatusToNodeStatus(statusMap.get(n.node_id) ?? n.status),
    }));

  const graphEdges = edges.map((e) => ({
    source_id: e.source_id,
    target_id: e.target_id,
    type: "hard" as const,
  }));

  const graph = new GraphEngine(graphNodes, graphEdges);

  const nodeTeamMap = new Map<string, string>();
  for (const node of allNodes) {
    if (node.role) nodeTeamMap.set(node.node_id, node.role);
  }

  const ready = getReadyNodes(graphNodes, graph, {
    leaseManager: state.leaseManager,
    teamPolicy: state.teamPolicy,
    nodeTeamMap,
  });

  return ready.map((n) => n.id);
}

/**
 * Find nodes that are ready to execute: pending status with all hard
 * dependencies completed.
 *
 * Also cascades failure to nodes whose dependencies have failed.
 */
export function findReadyNodes(store: IExecutionStore, runId: string): string[] {
  const allNodes = store.getNodesForRun(runId);
  const edges = store.getEdgesForRun(runId);

  // Build status map and dependency map
  const statusMap = new Map<string, string>();
  for (const node of allNodes) {
    statusMap.set(node.node_id, node.status);
  }

  const dependenciesOf = new Map<string, string[]>();
  for (const edge of edges) {
    const deps = dependenciesOf.get(edge.target_id) || [];
    deps.push(edge.source_id);
    dependenciesOf.set(edge.target_id, deps);
  }

  const ready: string[] = [];

  for (const node of allNodes) {
    if (node.node_type === "mission") {
      if (node.status === "pending") {
        store.updateNodeStatus(runId, node.node_id, "completed");
        statusMap.set(node.node_id, "completed");
      }
      continue;
    }
    if (node.status !== "pending") continue;

    const deps = dependenciesOf.get(node.node_id) || [];

    // If any dependency failed, this node is blocked forever → cascade failure
    const anyDepFailed = deps.some((depId) => statusMap.get(depId) === "failed");
    if (anyDepFailed) {
      store.updateNodeStatus(runId, node.node_id, "failed");
      statusMap.set(node.node_id, "failed");
      continue;
    }

    const anyDepStopped = deps.some((depId) => {
      const status = statusMap.get(depId);
      return status === "cancelled" || status === "blocked";
    });
    if (anyDepStopped) {
      store.updateNodeStatus(runId, node.node_id, "blocked");
      statusMap.set(node.node_id, "blocked");
      continue;
    }

    // All deps must be completed for the node to be ready
    const allDepsCompleted = deps.every((depId) => statusMap.get(depId) === "completed");
    if (allDepsCompleted) {
      ready.push(node.node_id);
    }
  }

  return ready;
}

// ---------------------------------------------------------------------------
// spawnTaskAgent — spawn a task agent for a ready node
// ---------------------------------------------------------------------------

/**
 * Spawn a task agent for a given node.
 *
 * 1. Get the node's prompt from scratchpad_entries
 * 2. Build a task prompt that instructs the agent to use MCP tools
 * 3. Spawn the agent via spawnAgentFn
 * 4. Track in state.node_agents
 * 5. Fire and forget — does NOT await completion
 */
async function spawnTaskAgent(
  store: IExecutionStore,
  state: OrchestratorRunState,
  nodeId: string,
  spawnAgentFn: SpawnAgentFn,
): Promise<void> {
  const runId = state.run_id;

  // Get node metadata from store
  const dbNode = store.getNode(nodeId);

  if (dbNode?.node_type === "mission") {
    store.updateNodeStatus(runId, nodeId, "completed");
    return;
  }

  // Acquire dispatch lease — prevents duplicate spawning if called concurrently
  if (!state.leaseManager.acquireLease(nodeId)) {
    console.log(`[executor] ${runId} node ${nodeId} already leased — skipping duplicate spawn`);
    return;
  }

  const role = dbNode?.role || "developer";
  const kind = dbNode?.kind || "task";
  const title = dbNode?.title || nodeId;

  // Get the node's prompt from scratchpad entries
  const scratchpadContent = store.getScratchpad(runId, nodeId);
  const nodePrompt = scratchpadContent || `Execute task: ${title}`;

  // Build the full prompt instructing the agent to use MCP tools
  const taskPrompt = buildTaskPrompt(role, runId, nodeId, kind, title, nodePrompt);

  // Mark node as active before spawning
  store.updateNodeStatus(runId, nodeId, "active");
  state.hooks?.onNodeActive?.(runId, nodeId);
  if (state.parallelism) sampleParallelism(state.parallelism, +1);

  try {
    console.log(`[executor] ${runId} spawning task agent for node ${nodeId} (${role}): "${title}"`);
    const baseDirectory = store.getRunDirectory(runId);
    const agent = await spawnAgentFn(taskPrompt, runId, nodeId, {
      role,
      kind,
      title,
      directory: baseDirectory ?? undefined,
    });
    const isolated = !shared(kind);
    const sessionId = agent.session_id ?? agent.id;
    const attachable = !!sessionId || !!agent.pty_id;
    if (!attachable) {
      throw new Error(`Node ${nodeId} started without an attachable session or PTY`);
    }
    if (isolated && attachable && !agent.worktree_path) {
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

    // Track in node_agents
    const history: NodeAgentHistory = state.node_agents.get(nodeId) || {
      current_agent_id: null,
      history: [],
    };
    history.current_agent_id = agent.id;
    history.history.push({
      agent_id: agent.id,
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
    });
    state.node_agents.set(nodeId, history);

    store.traceEvent({ event_type: "node_started", run_id: runId, node_id: nodeId, payload: { agent_id: agent.id, role, kind, title } });
    console.log(`[executor] ${runId} agent ${agent.id} spawned for node ${nodeId}`);
  } catch (err) {
    console.error(`[executor] ${runId} failed to spawn agent for node ${nodeId}:`, err);
    // Revert parallelism and status — spawn never completed
    if (state.parallelism) sampleParallelism(state.parallelism, -1);
    store.updateNodeStatus(runId, nodeId, "pending");
  }
}

// ---------------------------------------------------------------------------
// cascadeFailure — mark downstream dependents as failed
// ---------------------------------------------------------------------------

/**
 * Cascade failure to all nodes that depend (directly or transitively) on a
 * failed node. Only affects nodes that are still pending.
 */
function cascadeFailure(store: IExecutionStore, runId: string, failedNodeId: string): void {
  const dependents = store.getDependentsOf(runId, failedNodeId);
  for (const dep of dependents) {
    if (dep.status === "pending") {
      console.log(`[executor] ${runId} cascading failure from ${failedNodeId} → ${dep.target_id}`);
      store.updateNodeStatus(runId, dep.target_id, "failed");
      cascadeFailure(store, runId, dep.target_id);
    }
  }
}

// ---------------------------------------------------------------------------
// checkRunCompletion — determine if run is done
// ---------------------------------------------------------------------------

/**
 * After a node status change, check if the entire run is complete.
 *
 * - If all nodes completed → run completed
 * - If some failed and no more can run → run failed
 * - If newly ready nodes exist → spawn agents for them
 */
async function checkRunCompletion(
  store: IExecutionStore,
  runId: string,
  state: OrchestratorRunState,
  spawnAgentFn: SpawnAgentFn,
): Promise<void> {
  const allNodes = store.getNodesForRun(runId);

  const pending = allNodes.filter((n) => n.status === "pending");
  const blocked = allNodes.filter((n) => n.status === "blocked");
  const active = allNodes.filter((n) => n.status === "active");
  const completed = allNodes.filter((n) => n.status === "completed");
  const failed = allNodes.filter((n) => n.status === "failed");
  const cancelled = allNodes.filter((n) => n.status === "cancelled");

  // All nodes are in a terminal state (completed or failed)?
  if (pending.length === 0 && blocked.length === 0 && active.length === 0) {
    if (failed.length > 0 && completed.length === 0 && cancelled.length === 0) {
      console.log(`[executor] ${runId} all nodes finished — ${failed.length} failed, 0 completed → FAILED`);
      state.phase = "failed";
      state.error = "All tasks failed";
      store.finalizeMetrics(runId, state);
      store.updateRunStatus(runId, "failed");
      store.traceEvent({ event_type: "run_failed", run_id: runId, payload: { failed_count: failed.length, error: state.error } });
      store.updateSource(store.getRunSourceId(runId), "failed", { error: state.error, lastRunId: runId });
    } else {
      if (failed.length > 0) {
        console.log(`[executor] ${runId} finished: ${completed.length} completed, ${failed.length} failed, ${cancelled.length} cancelled`);
      }
      state.phase = "completed";
      store.finalizeMetrics(runId, state);
      store.updateRunStatus(runId, "completed");
      store.traceEvent({ event_type: "run_completed", run_id: runId, payload: { completed_count: completed.length, failed_count: failed.length } });
      const sourceId = store.getRunSourceId(runId);
      store.updateSource(sourceId, sourceStatus(sourceId, "completed", state.hooks), {
        error: null,
        lastRunId: runId,
      });
      state.hooks?.onRunCompleted?.(runId).catch((err) =>
        console.warn("[executor] workgraph onRunCompleted error:", err),
      );

      // Generate final result from scratchpad entries of completed nodes
      // We inline this query since it joins scratchpad+nodes in one pass
      // and there is no store method for it yet.
      // Use the raw completed node IDs we already have to pull scratchpad content.
      const completedNodeIds = completed.map((n) => n.node_id);
      const resultParts: string[] = [];
      for (const nid of completedNodeIds) {
        const content = store.getScratchpad(runId, nid);
        if (content) resultParts.push(content);
      }
      state.result =
        resultParts.length > 0
          ? resultParts.join("\n\n---\n\n")
          : "All tasks completed successfully.";
    }
    return;
  }

  // Check for newly ready nodes
  const readyNodeIds = findScheduledReadyNodes(store, runId, state);

  if (readyNodeIds.length > 0) {
    console.log(`[executor] ${runId} found ${readyNodeIds.length} newly ready nodes`);
    for (const nodeId of readyNodeIds) {
      await spawnTaskAgent(store, state, nodeId, spawnAgentFn);
    }
    return;
  }

  // No ready nodes, but some are still active — just wait
  if (active.length > 0) {
    return;
  }

  if (blocked.length > 0 || store.hasBlockers(runId)) {
    console.log(
      `[executor] ${runId} blocked: ${blocked.length} blocked, ${pending.length} pending, ${completed.length} completed`,
    );
    state.phase = "blocked";
    store.updateRunStatus(runId, "blocked");
    store.emitRunEvent(runId, "run_blocked", {
      blocked: blocked.length,
      pending: pending.length,
    });
    return;
  }

  // No ready, no active, but pending exist → deadlock
  if (pending.length > 0) {
    console.error(
      `[executor] ${runId} deadlock: ${pending.length} pending, ${failed.length} failed, ${completed.length} completed — no nodes can proceed`,
    );
    state.phase = "failed";
    state.error = "Deadlock: remaining nodes have unsatisfied dependencies";
    store.updateRunStatus(runId, "failed");
    store.updateSource(store.getRunSourceId(runId), "failed", { error: state.error, lastRunId: runId });
  }
}

// ---------------------------------------------------------------------------
// cancelOrchestration
// ---------------------------------------------------------------------------

/**
 * Cancel an orchestration run. Stops execution and kills active tasks.
 */
export function cancelOrchestration(
  state: OrchestratorRunState,
  store: IExecutionStore,
  killAgentFn: (agentId: string) => void,
): void {
  if (state.phase === "cancelled" || state.phase === "completed" || state.phase === "failed") {
    console.warn(`[executor] cancelOrchestration: run ${state.run_id} already in terminal phase '${state.phase}'`);
    return;
  }
  // Kill all active worker agents
  for (const [_nodeId, history] of state.node_agents) {
    if (history.current_agent_id) {
      try {
        killAgentFn(history.current_agent_id);
      } catch {
        // agent may have already exited
      }
    }
  }

  state.phase = "cancelled";
  store.updateRunStatus(state.run_id, "cancelled");
  store.emitRunEvent(state.run_id, "run_cancelled", {});
  state.hooks?.onRunCancelled?.(state.run_id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureState(store: IExecutionStore, runId: string) {
  const existing = orchestrations.get(runId);
  if (existing) return existing;
  const row = store.getRun(runId);
  if (!row) return;
  const state: OrchestratorRunState = {
    run_id: runId,
    phase: row.status,
    auto_execute: true,
    planner_agent_id: null,
    node_agents: new Map(),
    error: null,
    created_at: row.created_at ?? new Date().toISOString(),
    result: null,
    leaseManager: new LeaseManager(),
    teamPolicy: { maxActivePerRun: 12, maxActivePerTeam: 4 },
  };
  orchestrations.set(runId, state);
  return state;
}
