import { ulid } from "ulid";
import type { EventEnvelope } from "./events";
import type { OrchestratorRunState, NodeAgentHistory } from "./types";
import { generateHash, insertEvent, getNextSeq } from "../db/helpers";
import type { AgentRecord } from "../routes/agent";
import { buildMetadata } from "./session-bridge";
import type { OrchestratorMetadata } from "./types-ui";
import {
  onNodeCompleted as wgOnNodeCompleted,
  onRunCompleted,
  unlinkRun,
  linkRun,
} from "./workgraph-bridge";

const MAX_RETRIES = 2;

// ---------------------------------------------------------------------------
// Function type interfaces
// ---------------------------------------------------------------------------

export interface SpawnAgentFn {
  (prompt: string, runId: string, nodeId: string): Promise<AgentRecord>;
}

export interface GetAgentFn {
  (agentId: string): AgentRecord | undefined;
}

export interface WaitForAgentFn {
  (agentId: string): Promise<AgentRecord>;
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
export function getRunMetadata(db: any, runId: string): OrchestratorMetadata | undefined {
  const state = orchestrations.get(runId);
  if (!state) return undefined;
  return buildMetadata(db, runId, state);
}

// ---------------------------------------------------------------------------
// Planner prompt
// ---------------------------------------------------------------------------

const PLANNER_PROMPT_PREFIX = `You are a technical project planner. Break the following goal into small, PR-sized tasks. Use the provided tools to build a task graph. For each task, call create_node with a title, kind, role, prompt, and depends_on. Available roles: architect, developer, code_reviewer, qa, pm, designer. When the graph is complete, call validate_graph to check for issues, then call finish_planning with a summary.

Goal: `;

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
  db: any,
  runId: string,
  goal: string,
  spawnAgentFn: SpawnAgentFn,
  getAgentFn: GetAgentFn,
  waitForAgentFn: WaitForAgentFn,
  workItemId?: string,
): Promise<OrchestratorRunState> {
  const state: OrchestratorRunState = {
    run_id: runId,
    phase: "planning",
    planner_agent_id: null,
    node_agents: new Map(),
    error: null,
    created_at: new Date().toISOString(),
    result: null,
    work_item_id: workItemId,
    node_work_items: new Map(),
  };

  orchestrations.set(runId, state);

  // Link run to WorkGraph item if provided
  if (workItemId) {
    linkRun(runId, workItemId);
  }

  // Spawn the planner agent (fire and forget)
  try {
    const plannerPrompt = PLANNER_PROMPT_PREFIX + goal;
    const plannerAgent = await spawnAgentFn(plannerPrompt, runId, "");
    state.planner_agent_id = plannerAgent.id;
    console.log(`[executor] ${runId} planner agent spawned: ${plannerAgent.id}`);
  } catch (err) {
    state.phase = "failed";
    state.error = `Failed to spawn planner agent: ${(err as Error).message}`;
    updateRunStatus(db, runId, "failed");
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
  db: any,
  runId: string,
  summary: string,
  spawnAgentFn: SpawnAgentFn,
): Promise<void> {
  const state = orchestrations.get(runId);
  if (!state) {
    console.error(`[executor] onPlanningComplete: run ${runId} not found`);
    return;
  }

  if (state.phase !== "planning") {
    console.warn(`[executor] onPlanningComplete: run ${runId} in unexpected phase '${state.phase}'`);
    return;
  }

  state.phase = "executing";
  console.log(`[executor] ${runId} planning complete, transitioning to executing. Summary: "${summary.slice(0, 120)}"`);

  // Check if there are any nodes at all
  const allNodes = db
    .query("SELECT node_id, status FROM nodes_current WHERE run_id = ?")
    .all(runId) as Array<{ node_id: string; status: string }>;

  if (allNodes.length === 0) {
    console.log(`[executor] ${runId} no nodes found, marking completed`);
    state.phase = "completed";
    state.result = summary;
    updateRunStatus(db, runId, "completed");
    onRunCompleted(runId).catch((err) =>
      console.warn("[executor] workgraph onRunCompleted error:", err)
    );
    return;
  }

  // Find ready nodes and spawn task agents
  const readyNodeIds = findReadyNodes(db, runId);
  console.log(`[executor] ${runId} found ${readyNodeIds.length} ready nodes after planning`);

  for (const nodeId of readyNodeIds) {
    await spawnTaskAgent(db, state, nodeId, spawnAgentFn);
  }

  // If no nodes are ready and none are running, check for deadlock
  if (readyNodeIds.length === 0) {
    const active = allNodes.filter((n) => n.status === "active");
    if (active.length === 0) {
      console.error(`[executor] ${runId} deadlock after planning: no ready or active nodes`);
      state.phase = "failed";
      state.error = "Deadlock: no nodes are ready and none are running after planning";
      updateRunStatus(db, runId, "failed");
    }
  }
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
  db: any,
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

  if (status === "completed") {
    console.log(`[executor] ${runId} node ${nodeId} completed`);
    updateNodeStatus(db, runId, nodeId, "completed");
    wgOnNodeCompleted(runId);
  } else {
    // Failed — check retry count
    const dbNode = db
      .query("SELECT retry_count FROM nodes_current WHERE node_id = ?")
      .get(nodeId) as { retry_count: number } | null;
    const retryCount = dbNode?.retry_count ?? 0;

    console.error(
      `[executor] ${runId} node ${nodeId} failed (retry ${retryCount}/${MAX_RETRIES}): ${errorMessage?.slice(0, 200) ?? "(no error message)"}`,
    );

    if (retryCount < MAX_RETRIES) {
      // Retry: increment count, re-spawn agent
      db.run(
        "UPDATE nodes_current SET retry_count = retry_count + 1 WHERE node_id = ?",
        [nodeId],
      );
      console.log(`[executor] ${runId} node ${nodeId} retrying (attempt ${retryCount + 1})`);
      await spawnTaskAgent(db, state, nodeId, spawnAgentFn);
      return;
    }

    // All retries exhausted — mark failed
    console.error(`[executor] ${runId} node ${nodeId} max retries exhausted — marking failed`);
    updateNodeStatus(db, runId, nodeId, "failed");

    // Cascade failure to dependent nodes
    cascadeFailure(db, runId, nodeId);
  }

  // Check if the run is complete
  await checkRunCompletion(db, runId, state, spawnAgentFn);
}

// ---------------------------------------------------------------------------
// findReadyNodes — query DB for pending nodes with all deps satisfied
// ---------------------------------------------------------------------------

/**
 * Find nodes that are ready to execute: pending status with all hard
 * dependencies completed.
 *
 * Also cascades failure to nodes whose dependencies have failed.
 */
export function findReadyNodes(db: any, runId: string): string[] {
  const allNodes = db
    .query("SELECT node_id, status FROM nodes_current WHERE run_id = ?")
    .all(runId) as Array<{ node_id: string; status: string }>;

  const edges = db
    .query("SELECT source_id, target_id FROM dependency_edges_current WHERE run_id = ?")
    .all(runId) as Array<{ source_id: string; target_id: string }>;

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
    if (node.status !== "pending") continue;

    const deps = dependenciesOf.get(node.node_id) || [];

    // If any dependency failed, this node is blocked forever → cascade failure
    const anyDepFailed = deps.some((depId) => statusMap.get(depId) === "failed");
    if (anyDepFailed) {
      updateNodeStatus(db, runId, node.node_id, "failed");
      statusMap.set(node.node_id, "failed");
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
  db: any,
  state: OrchestratorRunState,
  nodeId: string,
  spawnAgentFn: SpawnAgentFn,
): Promise<void> {
  const runId = state.run_id;

  // Get node metadata from DB
  const dbNode = db
    .query("SELECT node_id, role, kind, title FROM nodes_current WHERE node_id = ?")
    .get(nodeId) as { node_id: string; role: string; kind: string; title: string } | null;

  const role = dbNode?.role || "developer";
  const title = dbNode?.title || nodeId;

  // Get the node's prompt from scratchpad entries
  let nodePrompt = "";
  const scratchpad = db
    .query(
      "SELECT content FROM scratchpad_entries WHERE run_id = ? AND node_id = ? ORDER BY created_at ASC LIMIT 1",
    )
    .get(runId, nodeId) as { content: string } | null;

  if (scratchpad) {
    nodePrompt = scratchpad.content;
  }

  if (!nodePrompt) {
    nodePrompt = `Execute task: ${title}`;
  }

  // Build the full prompt instructing the agent to use MCP tools
  const taskPrompt = `You are a ${role}. Execute the following task. Use read_scratchpads to get context from upstream tasks. Use write_scratchpad to record your findings. When done, call update_status with status 'completed'. If you encounter an unrecoverable error, call update_status with status 'failed'.

Task: ${title}

${nodePrompt}`;

  // Mark node as active before spawning
  updateNodeStatus(db, runId, nodeId, "active");

  try {
    console.log(`[executor] ${runId} spawning task agent for node ${nodeId} (${role}): "${title}"`);
    const agent = await spawnAgentFn(taskPrompt, runId, nodeId);

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

    console.log(`[executor] ${runId} agent ${agent.id} spawned for node ${nodeId}`);
  } catch (err) {
    console.error(`[executor] ${runId} failed to spawn agent for node ${nodeId}:`, err);
    // Revert to pending so it can be retried on next cascade
    updateNodeStatus(db, runId, nodeId, "pending");
  }
}

// ---------------------------------------------------------------------------
// cascadeFailure — mark downstream dependents as failed
// ---------------------------------------------------------------------------

/**
 * Cascade failure to all nodes that depend (directly or transitively) on a
 * failed node. Only affects nodes that are still pending.
 */
function cascadeFailure(db: any, runId: string, failedNodeId: string): void {
  // Find all edges from the failed node to its dependents
  const edges = db
    .query("SELECT target_id FROM dependency_edges_current WHERE run_id = ? AND source_id = ?")
    .all(runId, failedNodeId) as Array<{ target_id: string }>;

  for (const edge of edges) {
    const targetNode = db
      .query("SELECT status FROM nodes_current WHERE node_id = ?")
      .get(edge.target_id) as { status: string } | null;

    if (targetNode && targetNode.status === "pending") {
      console.log(`[executor] ${runId} cascading failure from ${failedNodeId} → ${edge.target_id}`);
      updateNodeStatus(db, runId, edge.target_id, "failed");
      // Recursively cascade
      cascadeFailure(db, runId, edge.target_id);
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
  db: any,
  runId: string,
  state: OrchestratorRunState,
  spawnAgentFn: SpawnAgentFn,
): Promise<void> {
  const allNodes = db
    .query("SELECT node_id, status FROM nodes_current WHERE run_id = ?")
    .all(runId) as Array<{ node_id: string; status: string }>;

  const pending = allNodes.filter((n) => n.status === "pending");
  const active = allNodes.filter((n) => n.status === "active");
  const completed = allNodes.filter((n) => n.status === "completed");
  const failed = allNodes.filter((n) => n.status === "failed");

  // All nodes are in a terminal state (completed or failed)?
  if (pending.length === 0 && active.length === 0) {
    if (failed.length > 0 && completed.length === 0) {
      console.log(`[executor] ${runId} all nodes finished — ${failed.length} failed, 0 completed → FAILED`);
      state.phase = "failed";
      state.error = "All tasks failed";
      updateRunStatus(db, runId, "failed");
    } else {
      if (failed.length > 0) {
        console.log(`[executor] ${runId} finished: ${completed.length} completed, ${failed.length} failed`);
      }
      state.phase = "completed";
      updateRunStatus(db, runId, "completed");
      onRunCompleted(runId).catch((err) =>
        console.warn("[executor] workgraph onRunCompleted error:", err)
      );

      // Generate final result from scratchpad entries of completed nodes
      const outputEntries = db
        .query(
          "SELECT sp.content, sp.node_id FROM scratchpad_entries sp INNER JOIN nodes_current n ON sp.node_id = n.node_id AND n.run_id = sp.run_id WHERE sp.run_id = ? AND n.status = 'completed' ORDER BY sp.created_at ASC",
        )
        .all(runId) as Array<{ content: string; node_id: string }>;

      const resultParts = outputEntries.map((e) => e.content);
      state.result =
        resultParts.length > 0
          ? resultParts.join("\n\n---\n\n")
          : "All tasks completed successfully.";
    }
    return;
  }

  // Check for newly ready nodes
  const readyNodeIds = findReadyNodes(db, runId);

  if (readyNodeIds.length > 0) {
    console.log(`[executor] ${runId} found ${readyNodeIds.length} newly ready nodes`);
    for (const nodeId of readyNodeIds) {
      await spawnTaskAgent(db, state, nodeId, spawnAgentFn);
    }
    return;
  }

  // No ready nodes, but some are still active — just wait
  if (active.length > 0) {
    return;
  }

  // No ready, no active, but pending exist → deadlock
  if (pending.length > 0) {
    console.error(
      `[executor] ${runId} deadlock: ${pending.length} pending, ${failed.length} failed, ${completed.length} completed — no nodes can proceed`,
    );
    state.phase = "failed";
    state.error = "Deadlock: remaining nodes have unsatisfied dependencies";
    updateRunStatus(db, runId, "failed");
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
  db: any,
  killAgentFn: (agentId: string) => void,
): void {
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

  unlinkRun(state.run_id);
  state.phase = "cancelled";
  updateRunStatus(db, state.run_id, "failed");
}

// ---------------------------------------------------------------------------
// Legacy exports — kept for backward compatibility
// ---------------------------------------------------------------------------

/**
 * @deprecated Use the MCP-driven flow (startOrchestration + onPlanningComplete + onNodeStatusUpdate).
 * Kept as a no-op for backward compat with imports.
 */
export async function executeOrchestration(
  _db: any,
  _state: OrchestratorRunState,
  _backend: any,
  _parentSessionID?: string,
): Promise<void> {
  console.warn("[executor] executeOrchestration() is deprecated in MCP-driven mode — use onPlanningComplete/onNodeStatusUpdate");
}

/**
 * @deprecated Use the MCP-driven flow. Kept for backward compat with imports.
 */
export async function executionTick(
  _db: any,
  _state: OrchestratorRunState,
  _spawnAgentFn: SpawnAgentFn,
  _getAgentFn: GetAgentFn,
): Promise<void> {
  console.warn("[executor] executionTick() is deprecated in MCP-driven mode — use onNodeStatusUpdate");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updateRunStatus(db: any, runId: string, status: string): void {
  db.run("UPDATE runs_current SET status = ? WHERE run_id = ?", [status, runId]);
}

function updateNodeStatus(
  db: any,
  runId: string,
  nodeId: string,
  status: string,
): void {
  db.run("UPDATE nodes_current SET status = ? WHERE node_id = ?", [status, nodeId]);

  // Emit event
  const eventId = `evt_${ulid()}`;
  const seq = getNextSeq(db, runId);
  const event: EventEnvelope = {
    id: eventId,
    run_id: runId,
    stream_id: runId,
    stream_seq: seq,
    logical_ts: seq,
    schema_version: 1,
    type: "node_status_changed",
    payload_json: JSON.stringify({ node_id: nodeId, status }),
    actor_type: "system",
    actor_id: "orchestrator",
    op_id: `op_${eventId}`,
    prev_hash: "00000000",
    hash: generateHash(),
    created_at: new Date().toISOString(),
  };
  insertEvent(db, event);
}
