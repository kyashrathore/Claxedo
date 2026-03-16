import { ulid } from "ulid";
import type { EventEnvelope } from "./events";
import type { OrchestratorRunState, OrchestratorHooks, NodeAgentHistory, RunPhase, ParallelismTracker } from "./types";
import { generateHash, insertEvent, getNextSeq } from "../db/helpers";
import type { OrchestratorMetadata } from "./types-ui";
import { createTraceEvent, appendTraceEvent } from "./trace";

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

/**
 * Compute and store RunMetrics for a completed/failed run.
 * Called once execution reaches a terminal phase.
 */
function finalizeMetrics(db: any, runId: string, state: OrchestratorRunState): RunMetrics {
  const allNodes = db
    .query("SELECT status FROM nodes_current WHERE run_id = ?")
    .all(runId) as Array<{ status: string }>;

  const completed_count = allNodes.filter((n) => n.status === "completed").length;
  const failed_count = allNodes.filter((n) => n.status === "failed").length;

  const p = state.parallelism;
  let wall_time_ms = 0;
  let max_parallelism = 1;
  let avg_parallelism = 1;

  if (p) {
    const now = Date.now();
    wall_time_ms = now - p.start_ms;
    max_parallelism = p.max;
    // Flush remaining integral for any still-active nodes
    const dt = now - p.last_sample_ms;
    const finalIntegral = p.integral + p.current * dt;
    avg_parallelism = wall_time_ms > 0 ? finalIntegral / wall_time_ms : 1;
  } else {
    // Fallback: wall time from created_at
    wall_time_ms = Date.now() - new Date(state.created_at).getTime();
  }

  const metrics: RunMetrics = {
    wall_time_ms: Math.round(wall_time_ms),
    task_count: allNodes.length,
    completed_count,
    failed_count,
    max_parallelism,
    avg_parallelism: Math.round(avg_parallelism * 100) / 100,
    total_tokens_used: null,
    estimated_cost_usd: null,
  };

  db.run("UPDATE runs_current SET metrics_json = ? WHERE run_id = ?", [
    JSON.stringify(metrics),
    runId,
  ]);

  return metrics;
}

/**
 * Sample the parallelism tracker: flush the integral for elapsed time,
 * apply the count delta, and update the timestamp.
 */
function sampleParallelism(p: ParallelismTracker, delta: number): void {
  const now = Date.now();
  const dt = now - p.last_sample_ms;
  p.integral += p.current * dt;
  p.last_sample_ms = now;
  p.current = Math.max(0, p.current + delta);
  if (p.current > p.max) p.max = p.current;
}

/**
 * Get RunMetrics for a completed run from the DB.
 */
export function getRunMetrics(db: any, runId: string): RunMetrics | null {
  const row = db
    .query("SELECT metrics_json FROM runs_current WHERE run_id = ?")
    .get(runId) as { metrics_json: string | null } | null;
  if (!row || !row.metrics_json) return null;
  try {
    return JSON.parse(row.metrics_json) as RunMetrics;
  } catch {
    return null;
  }
}

const MAX_RETRIES = 2;
const tool = {
  create: "claxedo-mcp_workgraph_create_node",
  validate: "claxedo-mcp_workgraph_validate_graph",
  finish: "claxedo-mcp_workgraph_finish_planning",
  read: "claxedo-mcp_workgraph_read_scratchpads",
  write: "claxedo-mcp_workgraph_write_scratchpad",
  status: "claxedo-mcp_workgraph_update_status",
  artifact: "claxedo-mcp_workgraph_create_artifact",
} as const

function shared(kind: string) {
  return ["research", "docs", "design", "review", "synthesis"].includes(kind);
}

function slug(text: string) {
  const value = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (value) return value;
  return "workgraph-output";
}

function plan(kind: string, title: string) {
  if (shared(kind)) return true;
  return /\b(plan|design|spec|brief|summary|report|proposal)\b/i.test(title);
}

function contract(kind: string, title: string) {
  if (plan(kind, title)) {
    const file = `.workgraph/${slug(title)}.md`;
    return [
      "Completion contract:",
      `1. Create a durable markdown deliverable in the current working directory at ${file}.`,
      "2. Put the full plan, design, report, or summary in that file.",
      `3. Call ${tool.artifact} with the final deliverable content and type 'file'.`,
      `4. Call ${tool.write} with a concise summary that includes the file path and key decisions.`,
      `5. Only after the file and artifact exist, call ${tool.status} with status 'completed'.`,
      "6. If you are blocked or cannot produce the deliverable, explain why in a scratchpad and call update_status with status 'failed'.",
    ].join("\n");
  }

  return [
    "Completion contract:",
    "1. Perform the requested work in the current working directory.",
    "2. Finish the main side effect for the node before marking it complete. Examples: code changed, tests run, PR prepared, comment posted, or data updated.",
    `3. Call ${tool.write} with a concise execution summary, including changed files, validations, and any follow-up risks.`,
    `4. If the node produced a durable deliverable worth viewing later, also call ${tool.artifact} with that output.`,
    `5. Only after the work and summary are complete, call ${tool.status} with status 'completed'.`,
    "6. If you are blocked or the work failed, write the blocker to a scratchpad and call update_status with status 'failed'.",
  ].join("\n");
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
export function getRunMetadata(db: any, runId: string): OrchestratorMetadata | undefined {
  const state = orchestrations.get(runId);
  if (!state) return undefined;
  const nodes = (db
    .query(
      `SELECT
         n.node_id,
         n.role,
         n.kind,
         n.title,
         n.status,
         (
           SELECT a.session_id
           FROM attempts_current a
           WHERE a.run_id = n.run_id AND a.node_id = n.node_id
           ORDER BY a.started_at DESC
           LIMIT 1
         ) AS session_id
       FROM nodes_current n
       WHERE n.run_id = ?`,
    )
    .all(runId) as Array<{
      node_id: string;
      role: string;
      kind: string;
      title: string;
      status: string;
      session_id: string | null;
    }>)
    .map((node) => ({
      id: node.node_id,
      title: node.title || node.kind,
      kind: node.kind,
      status:
        node.status === "active"
          ? "running"
          : node.status === "pending"
            ? "pending"
            : node.status === "completed"
              ? "completed"
              : node.status === "failed"
                ? "failed"
                : "blocked",
      sessionID: node.session_id ?? undefined,
      agent: node.role || "developer",
    }))

  const edges = (db
    .query("SELECT source_id, target_id FROM dependency_edges_current WHERE run_id = ?")
    .all(runId) as Array<{ source_id: string; target_id: string }>)
    .map((edge) => ({ source: edge.source_id, target: edge.target_id }))

  const done = nodes.filter((node) => node.status === "completed").length
  const running = nodes.filter((node) => node.status === "running").length
  const failed = nodes.filter((node) => node.status === "failed").length
  const summary = [
    nodes.length ? `${done}/${nodes.length} tasks completed` : "",
    running ? `${running} running` : "",
    failed ? `${failed} failed` : "",
  ]
    .filter(Boolean)
    .join(" · ")

  return {
    goal: (db.query("SELECT goal FROM runs_current WHERE run_id = ?").get(runId) as { goal: string } | null)?.goal ?? "",
    phase: state.phase === "blocked" ? "executing" : (state.phase as OrchestratorMetadata["phase"]),
    nodes,
    edges,
    summary: summary || undefined,
    startTime: new Date(state.created_at).getTime(),
    endTime:
      state.phase === "completed" || state.phase === "failed"
        ? Date.now()
        : undefined,
  }
}

function agentErr(agent: AgentState) {
  const err = agent.stderr_chunks?.join("").trim()
  if (err) return err
  const out = agent.output_chunks?.join("").trim()
  if (out) return out
  if (typeof agent.exit_code === "number") return `Planner exited with code ${agent.exit_code}`
  return "Planner exited before calling finish_planning"
}

function failPlanning(db: any, runId: string, message: string) {
  const state = orchestrations.get(runId)
  if (!state || state.phase !== "planning") return false
  state.phase = "failed"
  state.error = message
  updateRunStatus(db, runId, "failed")
  emitRunEvent(db, runId, "planning_failed", { error: message })
  updateSource(db, runSource(db, runId), "failed", { error: message, planRunId: runId })
  return true
}

// ---------------------------------------------------------------------------
// Planner prompt
// ---------------------------------------------------------------------------

const PLANNER_PROMPT_PREFIX = `You are a technical project planner. Break the following goal into durable, user-visible tasks sized for one execution context. Do not default to tiny PR-sized microtasks. Use the provided MCP tools to build a task graph. Do not use ToolSearch for this. Call these tools exactly by name:
- ${tool.create}
- ${tool.validate}
- ${tool.finish}

For every MCP call, include the current run_id exactly as provided below. For each task, call ${tool.create} with run_id, title, kind, role, prompt, depends_on, and when needed node_type plus parent_node_id. Use node_type='mission' only for aggregate-only grouping nodes that should not run directly. Use node_type='synthesis' for consolidation nodes that merge outputs from sibling work. Available roles: architect, developer, code_reviewer, qa, pm, designer.

Planning rules:
- Prefer fewer cohesive tasks when one capable executor can decompose or parallelize the internal work with its own harness.
- Split work into separate sibling nodes only when they need separate outputs, blockers, retries, ownership, or user-visible tracking.
- Do not create broad specialist buckets like API/UI/tests/infra just for coverage. Only split that way when those are truly separate deliverables or externally defined tasks.
- For broad review, audit, research, or implementation tasks, group nearby work by subsystem, flow, or question so one node can return one consolidated result.
- When a node can internally decompose or parallelize, say that explicitly in its prompt and ask for one consolidated output for the node.

When the graph is complete, call ${tool.validate} with run_id to check for issues, then call ${tool.finish} with run_id and a summary.

Goal: `;

function buildPlannerPrompt(
  db: any,
  runId: string,
  goal: string,
) {
  const src = db
    .query("SELECT kind, title, content, source_path FROM run_sources_current WHERE run_id = ?")
    .get(runId) as
    | {
        kind: string;
        title: string;
        content: string;
        source_path: string | null;
      }
    | null;

  if (!src?.content) {
    return PLANNER_PROMPT_PREFIX + goal;
  }

  const body = src.content.slice(0, 16_000);
  return [
    PLANNER_PROMPT_PREFIX + goal,
    "",
    `Current run_id: ${runId}`,
    "",
    "Primary source context:",
    `- kind: ${src.kind}`,
    src.title ? `- title: ${src.title}` : "",
    src.source_path ? `- path: ${src.source_path}` : "",
    "",
    "Use the source below as the main brief. Preserve explicit requirements, constraints, and implied follow-up work.",
    "",
    body,
  ]
    .filter(Boolean)
    .join("\n");
}

function runSource(db: any, runId: string): string | null {
  const row = db
    .query("SELECT source_id FROM runs_current WHERE run_id = ?")
    .get(runId) as { source_id: string | null } | null
  return row?.source_id ?? null
}

function updateSource(
  db: any,
  sourceId: string | null,
  status: string,
  extra?: {
    error?: string | null
    planRunId?: string | null
    lastRunId?: string | null
  },
) {
  if (!sourceId) return
  const sets = ["status = ?", "updated_at = ?"]
  const vals: Array<string | null> = [status, new Date().toISOString()]
  if (extra && "error" in extra) {
    sets.push("error = ?")
    vals.push(extra.error ?? null)
  }
  if (extra && "planRunId" in extra) {
    sets.push("plan_run_id = ?")
    vals.push(extra.planRunId ?? null)
  }
  if (extra && "lastRunId" in extra) {
    sets.push("last_run_id = ?")
    vals.push(extra.lastRunId ?? null)
  }
  vals.push(sourceId)
  db.run(`UPDATE sources_current SET ${sets.join(", ")} WHERE source_id = ?`, vals)
}

function sourceStatus(sourceId: string | null, status: "completed" | "failed", hooks?: OrchestratorHooks) {
  if (!sourceId || status === "failed") return status
  if (hooks?.sourceHasWork) return hooks.sourceHasWork(sourceId) ? "planned" : "completed"
  return status
}

function attemptCreate(
  db: any,
  input: {
    runId: string
    nodeId: string
    status: string
    runtimeType: string
    directory?: string | null
    worktreePath?: string | null
    sessionId?: string | null
    ptyId?: string | null
  },
) {
  const now = new Date().toISOString()
  db.run(
    "INSERT INTO attempts_current (attempt_id, run_id, node_id, status, runtime_type, directory, worktree_path, session_id, pty_id, started_at, finished_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      `att_${ulid()}`,
      input.runId,
      input.nodeId,
      input.status,
      input.runtimeType,
      input.directory ?? null,
      input.worktreePath ?? null,
      input.sessionId ?? null,
      input.ptyId ?? null,
      now,
      null,
      now,
    ],
  )
}

function attemptFinish(
  db: any,
  runId: string,
  nodeId: string,
  status: string,
) {
  const row = db
    .query(
      "SELECT attempt_id FROM attempts_current WHERE run_id = ? AND node_id = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .get(runId, nodeId) as { attempt_id: string } | null
  if (!row) return
  db.run(
    "UPDATE attempts_current SET status = ?, finished_at = ?, last_heartbeat_at = ? WHERE attempt_id = ?",
    [status, new Date().toISOString(), new Date().toISOString(), row.attempt_id],
  )
}

function hasBlockers(db: any, runId: string) {
  const row = db
    .query(
      `SELECT 1
       FROM run_blockers_current b
       INNER JOIN nodes_current n ON n.run_id = b.run_id AND n.node_id = b.target_node_id
       WHERE b.run_id = ? AND n.status IN ('pending', 'blocked')
       LIMIT 1`,
    )
    .get(runId) as any
  return !!row
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
  db: any,
  runId: string,
  goal: string,
  spawnAgentFn: SpawnAgentFn,
  opts?: {
    auto_execute?: boolean;
    hooks?: OrchestratorHooks;
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
    hooks: opts?.hooks,
  };

  orchestrations.set(runId, state);
  updateRunStatus(db, runId, "planning");
  emitRunEvent(db, runId, "planning_started", { auto_execute: state.auto_execute });
  traceEvent(db, { event_type: "run_created", run_id: runId, payload: { goal, auto_execute: state.auto_execute } });

  // Spawn the planner agent (fire and forget)
  try {
    const plannerPrompt = buildPlannerPrompt(db, runId, goal);
    const plannerAgent = await spawnAgentFn(plannerPrompt, runId, "");
    state.planner_agent_id = plannerAgent.id;
    db.run(
      "INSERT INTO run_exec_current (run_id, runtime_type, session_id, pty_id, directory, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET runtime_type = excluded.runtime_type, session_id = excluded.session_id, pty_id = excluded.pty_id, directory = COALESCE(excluded.directory, run_exec_current.directory), updated_at = excluded.updated_at",
      [
        runId,
        plannerAgent.runtime_type ?? "workspace",
        plannerAgent.session_id ?? null,
        plannerAgent.pty_id ?? null,
        plannerAgent.directory ?? null,
        new Date().toISOString(),
      ],
    )
    console.log(`[executor] ${runId} planner agent spawned: ${plannerAgent.id}`);
    traceEvent(db, { event_type: "planning_start", run_id: runId, payload: { planner_agent_id: plannerAgent.id } });
  } catch (err) {
    failPlanning(db, runId, `Failed to spawn planner agent: ${(err as Error).message}`)
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

  if (state.phase !== "planning" && state.phase !== "planned") {
    console.warn(`[executor] onPlanningComplete: run ${runId} in unexpected phase '${state.phase}'`);
    return;
  }

  traceEvent(db, { event_type: "planning_end", run_id: runId, payload: { summary } });

  if (!state.auto_execute) {
    state.phase = "planned";
    state.result = summary;
    updateRunStatus(db, runId, "planned");
    const sourceId = runSource(db, runId)
    if (sourceId) {
      state.hooks?.onPlanSynced?.(db, runId, sourceId)
      updateSource(db, sourceId, "planned", { error: null, planRunId: runId })
    }
    return;
  }

  await beginExecution(db, state, summary, spawnAgentFn);
}

export async function onPlannerStopped(
  db: any,
  runId: string,
  sessionId: string,
  errorMessage: string,
): Promise<boolean> {
  const state = orchestrations.get(runId)
  if (!state || state.phase !== "planning") return false
  if (state.planner_agent_id && state.planner_agent_id !== sessionId) return false
  return failPlanning(db, runId, errorMessage)
}

async function beginExecution(
  db: any,
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
  updateRunStatus(db, runId, "executing");
  updateSource(db, runSource(db, runId), "executing", { error: null, lastRunId: runId });
  emitRunEvent(db, runId, "execution_started", { summary });
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
    state.hooks?.onRunCompleted?.(runId).catch((err) =>
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

  // If no nodes are ready and none are running, check for outside blockers first
  if (readyNodeIds.length === 0) {
    const active = allNodes.filter((n) => n.status === "active");
    if (active.length === 0) {
      if (hasBlockers(db, runId)) {
        console.log(`[executor] ${runId} blocked after planning: waiting on outside work`);
        state.phase = "blocked";
        updateRunStatus(db, runId, "blocked");
        emitRunEvent(db, runId, "run_blocked", { reason: "outside_blockers" });
        return;
      }
      console.error(`[executor] ${runId} deadlock after planning: no ready or active nodes`);
      state.phase = "failed";
      state.error = "Deadlock: no nodes are ready and none are running after planning";
      updateRunStatus(db, runId, "failed");
    }
  }
}

export async function startExecution(
  db: any,
  runId: string,
  goal: string,
  spawnAgentFn: SpawnAgentFn,
  opts?: { hooks?: OrchestratorHooks },
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
    hooks: opts?.hooks,
  }

  orchestrations.set(runId, state)
  traceEvent(db, { event_type: "run_created", run_id: runId, payload: { goal } })
  await beginExecution(db, state, goal, spawnAgentFn)
  return state
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

  if (state.parallelism) sampleParallelism(state.parallelism, -1);

  if (status === "completed") {
    console.log(`[executor] ${runId} node ${nodeId} completed`);
    attemptFinish(db, runId, nodeId, "completed");
    updateNodeStatus(db, runId, nodeId, "completed");
    traceEvent(db, { event_type: "node_completed", run_id: runId, node_id: nodeId, payload: {} });
    state.hooks?.onNodeCompleted?.(runId, nodeId).catch((err) =>
      console.warn("[executor] workgraph onNodeCompleted error:", err),
    );
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
      attemptFinish(db, runId, nodeId, "failed");
      db.run(
        "UPDATE nodes_current SET retry_count = retry_count + 1 WHERE node_id = ?",
        [nodeId],
      );
      console.log(`[executor] ${runId} node ${nodeId} retrying (attempt ${retryCount + 1})`);
      traceEvent(db, { event_type: "node_retried", run_id: runId, node_id: nodeId, payload: { attempt: retryCount + 1, error: errorMessage ?? null } });
      await spawnTaskAgent(db, state, nodeId, spawnAgentFn);
      return;
    }

    // All retries exhausted — mark failed
    console.error(`[executor] ${runId} node ${nodeId} max retries exhausted — marking failed`);
    attemptFinish(db, runId, nodeId, "failed");
    updateNodeStatus(db, runId, nodeId, "failed");
    traceEvent(db, { event_type: "node_failed", run_id: runId, node_id: nodeId, payload: { retries: retryCount, error: errorMessage ?? null } });
    state.hooks?.onNodeFailed?.(runId, nodeId);

    // Cascade failure to dependent nodes
    cascadeFailure(db, runId, nodeId);
  }

  // Check if the run is complete
  await checkRunCompletion(db, runId, state, spawnAgentFn);
}

export async function onSessionStopped(
  db: any,
  runId: string,
  nodeId: string,
  sessionId: string,
  spawnAgentFn: SpawnAgentFn,
  errorMessage: string,
): Promise<boolean> {
  const row = db
    .query(
      "SELECT attempt_id FROM attempts_current WHERE run_id = ? AND node_id = ? AND session_id = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .get(runId, nodeId, sessionId) as { attempt_id: string } | null

  if (!row) return false
  await onNodeStatusUpdate(db, runId, nodeId, "failed", spawnAgentFn, errorMessage)
  return true
}

export function cancelNodeExecution(
  db: any,
  runId: string,
  nodeId: string,
  reason = "cancelled",
): void {
  const state = orchestrations.get(runId)
  const history = state?.node_agents.get(nodeId)
  if (history) {
    const last = history.history[history.history.length - 1]
    if (last) {
      last.status = "cancelled"
      last.finished_at = new Date().toISOString()
    }
    history.current_agent_id = null
  }
  attemptFinish(db, runId, nodeId, "cancelled")
  updateNodeStatus(db, runId, nodeId, "cancelled")
  emitRunEvent(db, runId, "node_cancelled", { node_id: nodeId, reason })
}

export async function reconcileExecution(
  db: any,
  runId: string,
  spawnAgentFn: SpawnAgentFn,
  hooks?: OrchestratorHooks,
): Promise<void> {
  const state = ensureState(db, runId)
  if (!state) return
  if (state.phase === "cancelled" || state.phase === "completed" || state.phase === "failed") return
  if (hooks && !state.hooks) state.hooks = hooks
  state.phase = "executing"
  await checkRunCompletion(db, runId, state, spawnAgentFn)
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
    .query("SELECT node_id, status, node_type FROM nodes_current WHERE run_id = ?")
    .all(runId) as Array<{ node_id: string; status: string; node_type: string }>;

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
    if (node.node_type === "mission") {
      if (node.status === "pending") {
        updateNodeStatus(db, runId, node.node_id, "completed")
        statusMap.set(node.node_id, "completed")
      }
      continue
    }
    if (node.status !== "pending") continue;

    const deps = dependenciesOf.get(node.node_id) || [];

    // If any dependency failed, this node is blocked forever → cascade failure
    const anyDepFailed = deps.some((depId) => statusMap.get(depId) === "failed");
    if (anyDepFailed) {
      updateNodeStatus(db, runId, node.node_id, "failed");
      statusMap.set(node.node_id, "failed");
      continue;
    }

    const anyDepStopped = deps.some((depId) => {
      const status = statusMap.get(depId)
      return status === "cancelled" || status === "blocked"
    })
    if (anyDepStopped) {
      updateNodeStatus(db, runId, node.node_id, "blocked");
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
  db: any,
  state: OrchestratorRunState,
  nodeId: string,
  spawnAgentFn: SpawnAgentFn,
): Promise<void> {
  const runId = state.run_id;

  // Get node metadata from DB
  const dbNode = db
    .query("SELECT node_id, role, kind, title, node_type FROM nodes_current WHERE node_id = ?")
    .get(nodeId) as { node_id: string; role: string; kind: string; title: string; node_type: string } | null;

  if (dbNode?.node_type === "mission") {
    updateNodeStatus(db, runId, nodeId, "completed")
    return
  }

  const role = dbNode?.role || "developer";
  const kind = dbNode?.kind || "task";
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
  const taskPrompt = `You are a ${role}. Execute the following task. Use these MCP tools exactly by name:
- ${tool.read}
- ${tool.write}
- ${tool.status}
- ${tool.artifact}

For every MCP call, include run_id = ${runId}. For node-scoped tools, use node_id = ${nodeId}. Use ${tool.read} to get context from upstream tasks. Use ${tool.write} to record findings and execution summaries.

Output vs done:
- Output is what you produced: files, code changes, artifacts, comments, reports, summaries, PRs, or other side effects.
- Done means the node's contract is satisfied and downstream work can safely continue.
- Do not mark the node completed just because you thought about the task or wrote a partial note.
- If this node covers several closely related checks, analyses, or implementation slices, you may decompose and parallelize them internally using your own harness. Keep ownership at this node boundary and return one consolidated result for this node.

${contract(kind, title)}

Task: ${title}

${nodePrompt}`;

  // Mark node as active before spawning
  updateNodeStatus(db, runId, nodeId, "active");
  state.hooks?.onNodeActive?.(runId, nodeId);
  if (state.parallelism) sampleParallelism(state.parallelism, +1);

  try {
    console.log(`[executor] ${runId} spawning task agent for node ${nodeId} (${role}): "${title}"`);
    const base = db
      .query("SELECT directory FROM run_exec_current WHERE run_id = ?")
      .get(runId) as { directory: string | null } | null;
    const agent = await spawnAgentFn(taskPrompt, runId, nodeId, {
      role,
      kind,
      title,
      directory: base?.directory ?? undefined,
    });
    const isolated = !shared(kind);
    const sessionId = agent.session_id ?? agent.id;
    const attachable = !!sessionId || !!agent.pty_id
    if (!attachable) {
      throw new Error(`Node ${nodeId} started without an attachable session or PTY`);
    }
    if (isolated && attachable && !agent.worktree_path) {
      throw new Error(`Node ${nodeId} started without an isolated worktree`);
    }
    attemptCreate(db, {
      runId,
      nodeId,
      status: "running",
      runtimeType: agent.runtime_type ?? "workspace",
      directory: agent.directory ?? base?.directory ?? null,
      worktreePath: agent.worktree_path ?? null,
      sessionId,
      ptyId: agent.pty_id ?? null,
    });
    db.run(
      "UPDATE run_exec_current SET runtime_type = COALESCE(?, runtime_type), session_id = ?, pty_id = ?, directory = COALESCE(?, directory), updated_at = ? WHERE run_id = ?",
      [
        agent.runtime_type ?? null,
        sessionId,
        agent.pty_id ?? null,
        agent.directory ?? base?.directory ?? null,
        new Date().toISOString(),
        runId,
      ],
    );

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

    traceEvent(db, { event_type: "node_started", run_id: runId, node_id: nodeId, payload: { agent_id: agent.id, role, kind, title } });
    console.log(`[executor] ${runId} agent ${agent.id} spawned for node ${nodeId}`);
  } catch (err) {
    console.error(`[executor] ${runId} failed to spawn agent for node ${nodeId}:`, err);
    // Revert parallelism and status — spawn never completed
    if (state.parallelism) sampleParallelism(state.parallelism, -1);
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
      finalizeMetrics(db, runId, state);
      updateRunStatus(db, runId, "failed");
      traceEvent(db, { event_type: "run_failed", run_id: runId, payload: { failed_count: failed.length, error: state.error } });
      updateSource(db, runSource(db, runId), "failed", { error: state.error, lastRunId: runId });
    } else {
      if (failed.length > 0) {
        console.log(`[executor] ${runId} finished: ${completed.length} completed, ${failed.length} failed, ${cancelled.length} cancelled`);
      }
      state.phase = "completed";
      finalizeMetrics(db, runId, state);
      updateRunStatus(db, runId, "completed");
      traceEvent(db, { event_type: "run_completed", run_id: runId, payload: { completed_count: completed.length, failed_count: failed.length } });
      const sourceId = runSource(db, runId);
      updateSource(db, sourceId, sourceStatus(sourceId, "completed", state.hooks), {
        error: null,
        lastRunId: runId,
      });
      state.hooks?.onRunCompleted?.(runId).catch((err) =>
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

  if (blocked.length > 0 || hasBlockers(db, runId)) {
    console.log(
      `[executor] ${runId} blocked: ${blocked.length} blocked, ${pending.length} pending, ${completed.length} completed`,
    );
    state.phase = "blocked";
    updateRunStatus(db, runId, "blocked");
    emitRunEvent(db, runId, "run_blocked", {
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
    updateRunStatus(db, runId, "failed");
    updateSource(db, runSource(db, runId), "failed", { error: state.error, lastRunId: runId });
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
  updateRunStatus(db, state.run_id, "cancelled");
  emitRunEvent(db, state.run_id, "run_cancelled", {});
  state.hooks?.onRunCancelled?.(state.run_id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updateRunStatus(db: any, runId: string, status: string): void {
  db.run("UPDATE runs_current SET status = ?, updated_at = ? WHERE run_id = ?", [status, new Date().toISOString(), runId]);
}

function emitRunEvent(
  db: any,
  runId: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  const eventId = `evt_${ulid()}`;
  const seq = getNextSeq(db, runId);
  const event: EventEnvelope = {
    id: eventId,
    run_id: runId,
    stream_id: runId,
    stream_seq: seq,
    logical_ts: seq,
    schema_version: 1,
    type,
    payload_json: JSON.stringify(payload),
    actor_type: "system",
    actor_id: "orchestrator",
    op_id: `op_${eventId}`,
    prev_hash: "00000000",
    hash: generateHash(),
    created_at: new Date().toISOString(),
  };
  insertEvent(db, event);
}

function traceEvent(
  db: any,
  input: Parameters<typeof createTraceEvent>[0],
): void {
  try {
    appendTraceEvent(db, createTraceEvent(input))
  } catch {
    // trace is best-effort; never crash the executor
  }
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

function ensureState(db: any, runId: string) {
  const existing = orchestrations.get(runId)
  if (existing) return existing
  const row = db
    .query("SELECT status, created_at FROM runs_current WHERE run_id = ?")
    .get(runId) as { status: RunPhase; created_at: string | null } | null
  if (!row) return
  const state: OrchestratorRunState = {
    run_id: runId,
    phase: row.status,
    auto_execute: true,
    planner_agent_id: null,
    node_agents: new Map(),
    error: null,
    created_at: row.created_at ?? new Date().toISOString(),
    result: null,
  }
  orchestrations.set(runId, state)
  return state
}
