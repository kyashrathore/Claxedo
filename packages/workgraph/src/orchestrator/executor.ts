import { ulid } from "ulid";
import type { EventEnvelope } from "./events";
import type { OrchestratorRunState, NodeAgentHistory } from "./types";
import { planOrchestration } from "./planner";
import { generateHash, insertEvent, getNextSeq } from "../db/helpers";
import type { AgentRecord } from "../routes/agent";
import { buildMetadata } from "./session-bridge";
import type { OrchestratorMetadata } from "./types-ui";
import { onNodeCompleted, onRunCompleted, unlinkRun } from "./workgraph-bridge";
import type { ExecutionBackend, TaskHandle } from "./backends";
import { SubprocessBackend } from "./backends";

const MAX_RETRIES = 2;

/** Active orchestration runs keyed by run_id */
const orchestrations = new Map<string, OrchestratorRunState>();

export function getOrchestration(runId: string): OrchestratorRunState | undefined {
  return orchestrations.get(runId);
}

export function getAllOrchestrations(): OrchestratorRunState[] {
  return Array.from(orchestrations.values());
}

export function clearAllIntervals(): void {
  for (const state of orchestrations.values()) {
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = null;
    }
  }
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
// Legacy interfaces (kept for backward compatibility with tests)
// ---------------------------------------------------------------------------

interface SpawnAgentFn {
  (prompt: string, runId: string, nodeId: string): Promise<AgentRecord>;
}

interface GetAgentFn {
  (agentId: string): AgentRecord | undefined;
}

// ---------------------------------------------------------------------------
// Cascading async execution — no setInterval
// ---------------------------------------------------------------------------

/**
 * Execute an orchestration run using cascading async execution.
 *
 * Core loop (mirrors tool.ts Phase 3):
 *   while (completed + failed < totalNodes):
 *     ready = findReadyNodes()
 *     if no ready and no running → deadlock, break
 *     if no ready but some running → await nextCompletion()
 *     executions = ready.map(node => executeNode(node))
 *     await Promise.allSettled(executions)
 */
export async function executeOrchestration(
  db: any,
  state: OrchestratorRunState,
  backend: ExecutionBackend,
  parentSessionID?: string,
): Promise<void> {
  state.phase = "executing";
  orchestrations.set(state.run_id, state);

  const runId = state.run_id;
  const completed = new Set<string>();
  const failed = new Set<string>();
  const running = new Set<string>();
  const handles = new Map<string, TaskHandle>();

  // Shared promise resolver for cascading: when any node completes,
  // the outer loop can wake up to find newly-ready nodes.
  let resolveNext: (() => void) | null = null;
  function nextCompletion(): Promise<void> {
    return new Promise<void>((r) => {
      resolveNext = r;
    });
  }
  function signalCompletion(): void {
    if (resolveNext) {
      const fn = resolveNext;
      resolveNext = null;
      fn();
    }
  }

  // Get all nodes for this run
  const allNodes = db
    .query("SELECT node_id, status FROM nodes_current WHERE run_id = ?")
    .all(runId) as Array<{ node_id: string; status: string }>;

  // Pre-populate completed/failed from DB state (in case of resume)
  for (const node of allNodes) {
    if (node.status === "completed") completed.add(node.node_id);
    if (node.status === "failed") failed.add(node.node_id);
  }

  const totalNodes = allNodes.length;
  if (totalNodes === 0) {
    state.phase = "completed";
    updateRunStatus(db, runId, "completed");
    return;
  }

  // Build dependency map: nodeId → source node IDs that must complete
  const edges = db
    .query("SELECT source_id, target_id FROM dependency_edges_current WHERE run_id = ?")
    .all(runId) as Array<{ source_id: string; target_id: string }>;

  const dependenciesOf = new Map<string, string[]>();
  for (const edge of edges) {
    const deps = dependenciesOf.get(edge.target_id) || [];
    deps.push(edge.source_id);
    dependenciesOf.set(edge.target_id, deps);
  }

  function findReadyNodes(): string[] {
    const ready: string[] = [];
    for (const node of allNodes) {
      if (completed.has(node.node_id) || failed.has(node.node_id) || running.has(node.node_id)) {
        continue;
      }
      const deps = dependenciesOf.get(node.node_id) || [];
      const allDepsCompleted = deps.every((depId) => completed.has(depId));
      // If any dep has failed, this node is blocked forever
      const anyDepFailed = deps.some((depId) => failed.has(depId));
      if (anyDepFailed) {
        // Mark as failed since dependency failed
        failed.add(node.node_id);
        updateNodeStatus(db, runId, node.node_id, "failed");
        continue;
      }
      if (allDepsCompleted) {
        ready.push(node.node_id);
      }
    }
    return ready;
  }

  function getNodePrompt(nodeId: string): string {
    // Try direct lookup via node_id column
    const metaMsg = db
      .query(
        "SELECT content FROM messages_current WHERE run_id = ? AND message_type = 'node_metadata' AND node_id = ?"
      )
      .get(runId, nodeId) as { content: string } | null;

    if (metaMsg) return metaMsg.content;

    // Fallback: look up from plan
    if (state.plan) {
      for (const task of state.plan.tasks) {
        if (state.task_node_map.get(task.id) === nodeId) {
          return task.prompt;
        }
      }
    }

    return `Execute task for node ${nodeId}`;
  }

  function getTaskForNode(nodeId: string) {
    if (!state.plan) return undefined;
    for (const task of state.plan.tasks) {
      if (state.task_node_map.get(task.id) === nodeId) {
        return task;
      }
    }
    return undefined;
  }

  async function executeNode(nodeId: string): Promise<void> {
    running.add(nodeId);
    updateNodeStatus(db, runId, nodeId, "active");

    const task = getTaskForNode(nodeId);
    const prompt = getNodePrompt(nodeId);
    const taskForBackend = task || {
      id: nodeId,
      title: nodeId,
      kind: "code_gen",
      team: "",
      prompt,
      depends_on: [],
    };

    // Track in node_agents for backward compatibility
    const history: NodeAgentHistory = state.node_agents.get(nodeId) || {
      current_agent_id: null,
      history: [],
    };

    let retryCount = 0;
    const dbNode = db
      .query("SELECT retry_count FROM nodes_current WHERE node_id = ?")
      .get(nodeId) as { retry_count: number } | null;
    if (dbNode) retryCount = dbNode.retry_count;

    let lastError: string | undefined;

    for (let attempt = retryCount; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[executor] ${runId} launching task for node ${nodeId} (attempt ${attempt})`);
        const handle = await backend.launch(taskForBackend, runId, nodeId, parentSessionID);

        // Track agent/session in history
        history.current_agent_id = handle.id;
        history.history.push({
          agent_id: handle.id,
          status: "running",
          started_at: new Date().toISOString(),
          finished_at: null,
        });
        state.node_agents.set(nodeId, history);
        handles.set(nodeId, handle);

        console.log(`[executor] ${runId} node ${nodeId} handle ${handle.id} — awaiting completion`);

        const result = await handle.await();

        // Update history
        const lastEntry = history.history[history.history.length - 1];
        if (lastEntry) {
          lastEntry.status = result.status === "completed" ? "completed" : "failed";
          lastEntry.finished_at = new Date().toISOString();
        }
        history.current_agent_id = null;

        if (result.status === "completed") {
          // Store agent output
          if (result.output.trim()) {
            const node = db
              .query("SELECT team_id FROM nodes_current WHERE node_id = ?")
              .get(nodeId) as { team_id: string } | null;
            const teamId = node?.team_id || "system";
            const msgId = `msg_${ulid()}`;
            db.run(
              "INSERT INTO messages_current (id, run_id, team_id, sender_id, content, message_type, created_at, node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              [msgId, runId, teamId, handle.id, result.output, "agent_output", new Date().toISOString(), nodeId]
            );
          }

          console.log(`[executor] ${runId} node ${nodeId} completed`);
          completed.add(nodeId);
          running.delete(nodeId);
          updateNodeStatus(db, runId, nodeId, "completed");
          onNodeCompleted(runId);
          handles.delete(nodeId);
          signalCompletion();
          return;
        } else {
          // Failed
          lastError = result.error;
          const node = db
            .query("SELECT team_id FROM nodes_current WHERE node_id = ?")
            .get(nodeId) as { team_id: string } | null;
          const teamId = node?.team_id || "system";
          const errorContent = result.error || `Task failed`;
          const msgId = `msg_${ulid()}`;
          db.run(
            "INSERT INTO messages_current (id, run_id, team_id, sender_id, content, message_type, created_at, node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [msgId, runId, teamId, handle.id, errorContent, "agent_error", new Date().toISOString(), nodeId]
          );

          console.error(`[executor] ${runId} node ${nodeId} failed (attempt ${attempt}/${MAX_RETRIES}): ${lastError?.slice(0, 200)}`);

          if (attempt < MAX_RETRIES) {
            // Retry: increment count and try again
            db.run(
              "UPDATE nodes_current SET retry_count = retry_count + 1 WHERE node_id = ?",
              [nodeId]
            );
            console.log(`[executor] ${runId} node ${nodeId} retrying...`);
            handles.delete(nodeId);
            continue;
          }
        }
      } catch (err) {
        lastError = (err as Error).message;
        console.error(`[executor] ${runId} node ${nodeId} launch error:`, err);

        const lastEntry = history.history[history.history.length - 1];
        if (lastEntry) {
          lastEntry.status = "failed";
          lastEntry.finished_at = new Date().toISOString();
        }
        history.current_agent_id = null;

        if (attempt < MAX_RETRIES) {
          db.run(
            "UPDATE nodes_current SET retry_count = retry_count + 1 WHERE node_id = ?",
            [nodeId]
          );
          handles.delete(nodeId);
          continue;
        }
      }
    }

    // All retries exhausted
    console.error(`[executor] ${runId} node ${nodeId} max retries exhausted — marking failed`);
    failed.add(nodeId);
    running.delete(nodeId);
    updateNodeStatus(db, runId, nodeId, "failed");
    handles.delete(nodeId);
    signalCompletion();
  }

  // --- Main execution loop ---
  try {
    while (completed.size + failed.size < totalNodes) {
      const ready = findReadyNodes();

      if (ready.length === 0 && running.size === 0) {
        // Deadlock: no pending or ready nodes, nothing running
        console.error(`[executor] ${runId} deadlock: ${failed.size} failed, ${completed.size} completed, ${totalNodes - completed.size - failed.size} unreachable`);
        state.error = "Deadlock: remaining nodes have unsatisfied dependencies";
        break;
      }

      if (ready.length === 0 && running.size > 0) {
        // Wait for any running node to complete, then check again
        await nextCompletion();
        continue;
      }

      // Launch all ready nodes in parallel
      const executions = ready.map((nodeId) => executeNode(nodeId));
      await Promise.allSettled(executions);
    }

    // Determine final state
    if (failed.size > 0 && completed.size === 0) {
      state.phase = "failed";
      state.error = state.error || "All tasks failed";
      updateRunStatus(db, runId, "failed");
    } else if (completed.size + failed.size >= totalNodes) {
      if (failed.size > 0) {
        // Partial success — some completed, some failed
        console.log(`[executor] ${runId} finished: ${completed.size} completed, ${failed.size} failed`);
      }
      state.phase = "completed";
      updateRunStatus(db, runId, "completed");
      onRunCompleted(runId).catch((err) =>
        console.warn("[executor] workgraph onRunCompleted error:", err)
      );

      // Generate final result
      const outputMsgs = db
        .query(
          "SELECT content, team_id FROM messages_current WHERE run_id = ? AND message_type = 'agent_output' ORDER BY created_at ASC"
        )
        .all(runId) as Array<{ content: string; team_id: string }>;

      const resultParts = outputMsgs.map((m) => m.content);
      const resultSummary =
        resultParts.length > 0
          ? resultParts.join("\n\n---\n\n")
          : "All tasks completed successfully.";

      state.result = resultSummary;

      const resultMsgId = `msg_${ulid()}`;
      db.run(
        "INSERT INTO messages_current (id, run_id, team_id, sender_id, content, message_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [resultMsgId, runId, "system", "orchestrator", resultSummary, "final_result", new Date().toISOString()]
      );
    } else {
      // Deadlock path
      state.phase = "failed";
      updateRunStatus(db, runId, "failed");
    }
  } catch (err) {
    state.error = (err as Error).message;
    state.phase = "failed";
    updateRunStatus(db, runId, "failed");
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible startOrchestration (plan + execute in one call)
// ---------------------------------------------------------------------------

/**
 * Start a full orchestration loop for a goal.
 *
 * Phase 1: PLANNING — spawn planner agent, wait for JSON output
 * Phase 2: BUILDING_GRAPH — parse plan, create DB entities
 * Phase 3: EXECUTING — cascading async: find ready nodes → launch → await → cascade
 * Phase 4: COMPLETED or FAILED
 */
export async function startOrchestration(
  db: any,
  runId: string,
  goal: string,
  spawnAgentFn: SpawnAgentFn,
  getAgentFn: GetAgentFn,
  waitForAgentFn: (agentId: string) => Promise<AgentRecord>,
  workItemId?: string
): Promise<OrchestratorRunState> {
  try {
    // Plan
    const state = await planOrchestration(
      db,
      runId,
      goal,
      spawnAgentFn,
      waitForAgentFn,
      workItemId,
    );
    orchestrations.set(runId, state);

    // Execute using subprocess backend (backward compat with agent.ts)
    const backend = new SubprocessBackend(spawnAgentFn, waitForAgentFn);
    await executeOrchestration(db, state, backend);

    return state;
  } catch (err) {
    // Create/update state for error case
    let state = orchestrations.get(runId);
    if (!state) {
      state = {
        run_id: runId,
        phase: "failed",
        planner_agent_id: null,
        plan: null,
        task_node_map: new Map(),
        team_id_map: new Map(),
        node_agents: new Map(),
        interval: null,
        error: (err as Error).message,
        created_at: new Date().toISOString(),
        result: null,
        work_item_id: workItemId,
        node_work_items: new Map(),
      };
      orchestrations.set(runId, state);
    }
    state.error = (err as Error).message;
    state.phase = "failed";
    updateRunStatus(db, runId, "failed");
    return state;
  }
}

// ---------------------------------------------------------------------------
// Legacy executionTick — kept for backward compatibility with existing tests
// ---------------------------------------------------------------------------

/** Default agent stale timeout: 5 minutes (should match agent.ts timeout) */
const AGENT_STALE_MS = parseInt(process.env.AGENT_TIMEOUT_MS || "", 10) || 5 * 60 * 1000;

/**
 * One tick of the execution loop.
 * 1. Reconcile agent statuses → update node statuses
 * 2. Check for completion or deadlock
 * 3. Spawn agents for newly-ready nodes
 *
 * @deprecated Use executeOrchestration() with a backend instead.
 * Kept for backward compatibility with tests.
 */
export async function executionTick(
  db: any,
  state: OrchestratorRunState,
  spawnAgentFn: SpawnAgentFn,
  getAgentFn: GetAgentFn
): Promise<void> {
  if (state.phase !== "executing") return;

  const runId = state.run_id;

  // 1. Reconcile: check agent statuses and update corresponding nodes
  for (const [nodeId, history] of state.node_agents) {
    const agentId = history.current_agent_id;
    if (!agentId) continue;

    const agent = getAgentFn(agentId);
    if (!agent) continue;

    if (agent.status === "completed") {
      const node = db
        .query("SELECT status, team_id FROM nodes_current WHERE node_id = ?")
        .get(nodeId) as { status: string; team_id: string } | null;
      if (node && node.status === "active") {
        console.log(`[orchestrator] ${runId} node ${nodeId} completed (agent ${agentId})`);

        // Store agent output as a message
        const agentOutput = agent.output_chunks?.join("") || "";
        if (agentOutput.trim()) {
          const msgId = `msg_${ulid()}`;
          db.run(
            "INSERT INTO messages_current (id, run_id, team_id, sender_id, content, message_type, created_at, node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [msgId, runId, node.team_id, agentId, agentOutput, "agent_output", new Date().toISOString(), nodeId]
          );
        }

        updateNodeStatus(db, runId, nodeId, "completed");
        onNodeCompleted(runId);

        history.current_agent_id = null;
        const lastEntry = history.history[history.history.length - 1];
        if (lastEntry) {
          lastEntry.status = "completed";
          lastEntry.finished_at = new Date().toISOString();
        }
      }
    } else if (agent.status === "failed") {
      const node = db
        .query("SELECT status, retry_count, team_id FROM nodes_current WHERE node_id = ?")
        .get(nodeId) as { status: string; retry_count: number; team_id: string } | null;
      if (node && node.status === "active") {
        const stderr = (agent as any).stderr_chunks?.join("") || "";
        const agentOutput = agent.output_chunks?.join("") || "";
        console.error(`[orchestrator] ${runId} node ${nodeId} agent failed (exit ${agent.exit_code}, retry ${node.retry_count}/${MAX_RETRIES})`);
        if (stderr) console.error(`[orchestrator] ${runId} node ${nodeId} stderr: ${stderr.slice(0, 500)}`);

        // Store agent error output as a message
        const errorContent = stderr || agentOutput || `Agent failed with exit code ${agent.exit_code}`;
        if (errorContent.trim()) {
          const msgId = `msg_${ulid()}`;
          db.run(
            "INSERT INTO messages_current (id, run_id, team_id, sender_id, content, message_type, created_at, node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [msgId, runId, node.team_id, agentId, errorContent, "agent_error", new Date().toISOString(), nodeId]
          );
        }

        history.current_agent_id = null;
        const lastEntry = history.history[history.history.length - 1];
        if (lastEntry) {
          lastEntry.status = "failed";
          lastEntry.finished_at = new Date().toISOString();
        }

        if (node.retry_count < MAX_RETRIES) {
          console.log(`[orchestrator] ${runId} node ${nodeId} retrying (attempt ${node.retry_count + 1})`);
          db.run(
            "UPDATE nodes_current SET status = 'pending', retry_count = retry_count + 1 WHERE node_id = ?",
            [nodeId]
          );
        } else {
          console.error(`[orchestrator] ${runId} node ${nodeId} max retries exhausted, marking failed`);
          updateNodeStatus(db, runId, nodeId, "failed");
        }
      }
    }
  }

  // 1b. Check for stale agents
  const now = Date.now();
  for (const [nodeId, history] of state.node_agents) {
    if (!history.current_agent_id) continue;
    const lastEntry = history.history[history.history.length - 1];
    if (lastEntry && lastEntry.status === "running") {
      const elapsed = now - new Date(lastEntry.started_at).getTime();
      if (elapsed > AGENT_STALE_MS + 30_000) {
        console.error(`[orchestrator] ${runId} agent ${history.current_agent_id} for node ${nodeId} is stale (${Math.round(elapsed / 1000)}s) — marking failed`);
        const node = db
          .query("SELECT status, retry_count, team_id FROM nodes_current WHERE node_id = ?")
          .get(nodeId) as { status: string; retry_count: number; team_id: string } | null;
        if (node && node.status === "active") {
          const errorMsg = `Agent timed out after ${Math.round(elapsed / 1000)} seconds`;
          const msgId = `msg_${ulid()}`;
          db.run(
            "INSERT INTO messages_current (id, run_id, team_id, sender_id, content, message_type, created_at, node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [msgId, runId, node.team_id, history.current_agent_id, errorMsg, "agent_error", new Date().toISOString(), nodeId]
          );

          history.current_agent_id = null;
          lastEntry.status = "failed";
          lastEntry.finished_at = new Date().toISOString();

          if (node.retry_count < MAX_RETRIES) {
            db.run(
              "UPDATE nodes_current SET status = 'pending', retry_count = retry_count + 1 WHERE node_id = ?",
              [nodeId]
            );
          } else {
            updateNodeStatus(db, runId, nodeId, "failed");
          }
        }
      }
    }
  }

  // 2. Check completion/deadlock
  const allNodes = db
    .query("SELECT node_id, status FROM nodes_current WHERE run_id = ?")
    .all(runId) as Array<{ node_id: string; status: string }>;

  const pending = allNodes.filter((n) => n.status === "pending");
  const active = allNodes.filter((n) => n.status === "active");
  const completedNodes = allNodes.filter((n) => n.status === "completed");
  const failedNodes = allNodes.filter((n) => n.status === "failed");

  // All done?
  if (pending.length === 0 && active.length === 0) {
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = null;
    }

    if (failedNodes.length > 0 && completedNodes.length === 0) {
      console.log(`[orchestrator] ${runId} all nodes finished — ${failedNodes.length} failed, 0 completed → FAILED`);
      state.phase = "failed";
      updateRunStatus(db, runId, "failed");
    } else {
      console.log(`[orchestrator] ${runId} all nodes finished — ${completedNodes.length} completed, ${failedNodes.length} failed → COMPLETED`);
      state.phase = "completed";
      updateRunStatus(db, runId, "completed");
      onRunCompleted(runId).catch((err) =>
        console.warn("[orchestrator] workgraph onRunCompleted error:", err)
      );

      // Generate final result
      const outputMsgs = db
        .query(
          "SELECT content, team_id FROM messages_current WHERE run_id = ? AND message_type = 'agent_output' ORDER BY created_at ASC"
        )
        .all(runId) as Array<{ content: string; team_id: string }>;

      const resultParts = outputMsgs.map((m) => m.content);
      const resultSummary =
        resultParts.length > 0
          ? resultParts.join("\n\n---\n\n")
          : "All tasks completed successfully.";

      state.result = resultSummary;

      const resultMsgId = `msg_${ulid()}`;
      db.run(
        "INSERT INTO messages_current (id, run_id, team_id, sender_id, content, message_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [resultMsgId, runId, "system", "orchestrator", resultSummary, "final_result", new Date().toISOString()]
      );
    }
    return;
  }

  // 3. Find ready nodes and spawn agents
  const edgesAll = db
    .query("SELECT * FROM dependency_edges_current WHERE run_id = ?")
    .all(runId) as Array<{ source_id: string; target_id: string }>;

  const nodeStatusMap = new Map<string, string>();
  for (const n of allNodes) {
    nodeStatusMap.set(n.node_id, n.status);
  }

  const dependenciesOf = new Map<string, string[]>();
  for (const edge of edgesAll) {
    const deps = dependenciesOf.get(edge.target_id) || [];
    deps.push(edge.source_id);
    dependenciesOf.set(edge.target_id, deps);
  }

  for (const node of pending) {
    // Skip if we already have an active agent for this node
    const existingHistory = state.node_agents.get(node.node_id);
    if (existingHistory?.current_agent_id != null) continue;

    const deps = dependenciesOf.get(node.node_id) || [];
    const allDepsCompleted = deps.every(
      (depId) => nodeStatusMap.get(depId) === "completed"
    );

    if (allDepsCompleted) {
      let prompt = `Execute task for node ${node.node_id}`;

      const metaMsg = db
        .query(
          "SELECT content FROM messages_current WHERE run_id = ? AND message_type = 'node_metadata' AND node_id = ?"
        )
        .get(runId, node.node_id) as { content: string } | null;

      if (metaMsg) {
        prompt = metaMsg.content;
      } else if (state.plan) {
        for (const task of state.plan.tasks) {
          if (state.task_node_map.get(task.id) === node.node_id) {
            prompt = task.prompt;
            break;
          }
        }
      }

      updateNodeStatus(db, runId, node.node_id, "active");
      console.log(`[orchestrator] ${runId} spawning agent for node ${node.node_id} (prompt: "${prompt.slice(0, 80)}...")`);

      try {
        const agent = await spawnAgentFn(prompt, runId, node.node_id);

        const history: NodeAgentHistory = existingHistory || { current_agent_id: null, history: [] };
        history.current_agent_id = agent.id;
        history.history.push({
          agent_id: agent.id,
          status: "running",
          started_at: new Date().toISOString(),
          finished_at: null,
        });
        state.node_agents.set(node.node_id, history);

        console.log(`[orchestrator] ${runId} agent ${agent.id} spawned for node ${node.node_id}`);
      } catch (err) {
        console.error(`[orchestrator] ${runId} failed to spawn agent for node ${node.node_id}:`, err);
        updateNodeStatus(db, runId, node.node_id, "pending");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * Cancel an orchestration run. Stops execution and kills active tasks.
 */
export function cancelOrchestration(
  state: OrchestratorRunState,
  db: any,
  killAgentFn: (agentId: string) => void
): void {
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
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

  unlinkRun(state.run_id);
  state.phase = "cancelled";
  updateRunStatus(db, state.run_id, "failed");
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
  status: string
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
