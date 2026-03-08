/**
 * Session Bridge — maps orchestrator DB state to the OrchestratorMetadata
 * format consumed by the frontend OrchestratorTool component.
 *
 * Also provides the ability to create OpenCode child sessions for each
 * orchestrated task node (when an OpenCode server URL is configured).
 */

import type {
  OrchestratorMetadata,
  OrchestratorNodeUI,
  OrchestratorEdgeUI,
} from "./types-ui";
import type { OrchestratorRunState, DecomposedTask } from "./types";

// ---------------------------------------------------------------------------
// Session tracking — maps node_id → OpenCode session ID
// ---------------------------------------------------------------------------

const nodeSessions = new Map<string, Map<string, string>>();

export function setNodeSession(
  runId: string,
  nodeId: string,
  sessionId: string,
): void {
  let run = nodeSessions.get(runId);
  if (!run) {
    run = new Map();
    nodeSessions.set(runId, run);
  }
  run.set(nodeId, sessionId);
}

export function getNodeSession(
  runId: string,
  nodeId: string,
): string | undefined {
  return nodeSessions.get(runId)?.get(nodeId);
}

export function clearRunSessions(runId: string): void {
  nodeSessions.delete(runId);
}

// ---------------------------------------------------------------------------
// Build metadata from DB state
// ---------------------------------------------------------------------------

interface DbNode {
  node_id: string;
  run_id: string;
  team_id: string;
  kind: string;
  title: string;
  status: string;
  retry_count: number;
}

interface DbEdge {
  id: string;
  run_id: string;
  source_id: string;
  target_id: string;
  type: string;
}

/**
 * Build the OrchestratorMetadata object from the current DB state.
 * This is the shape sent in ToolPart.state.metadata and consumed by the
 * OrchestratorTool frontend component.
 */
export function buildMetadata(
  db: any,
  runId: string,
  state: OrchestratorRunState,
): OrchestratorMetadata {
  const dbNodes = db
    .query("SELECT * FROM nodes_current WHERE run_id = ?")
    .all(runId) as DbNode[];

  const dbEdges = db
    .query("SELECT * FROM dependency_edges_current WHERE run_id = ?")
    .all(runId) as DbEdge[];

  // Build completed-node set for blocked detection
  const completedSet = new Set(
    dbNodes.filter((n) => n.status === "completed").map((n) => n.node_id),
  );

  // Build dependency map: nodeId → source node IDs that must complete
  const depsOf = new Map<string, string[]>();
  for (const edge of dbEdges) {
    const list = depsOf.get(edge.target_id) ?? [];
    list.push(edge.source_id);
    depsOf.set(edge.target_id, list);
  }

  const nodes: OrchestratorNodeUI[] = dbNodes.map((n) => {
    // Determine display status
    let uiStatus: OrchestratorNodeUI["status"] = n.status as any;

    // Pending nodes whose dependencies are NOT all completed → show as blocked
    if (n.status === "pending") {
      const deps = depsOf.get(n.node_id) ?? [];
      const allMet = deps.every((d) => completedSet.has(d));
      if (deps.length > 0 && !allMet) {
        uiStatus = "blocked";
      }
    }

    // Map "active" (DB term) → "running" (UI term)
    if (n.status === "active") {
      uiStatus = "running";
    }

    // Lookup agent name from the plan
    let agent = "build";
    if (state.plan) {
      for (const task of state.plan.tasks) {
        if (state.task_node_map.get(task.id) === n.node_id) {
          agent = task.team;
          break;
        }
      }
    }

    return {
      id: n.node_id,
      title: n.title || n.kind,
      kind: n.kind,
      status: uiStatus,
      sessionID: getNodeSession(runId, n.node_id),
      agent,
    };
  });

  const edges: OrchestratorEdgeUI[] = dbEdges.map((e) => ({
    source: e.source_id,
    target: e.target_id,
  }));

  // Summary line
  const done = nodes.filter((n) => n.status === "completed").length;
  const running = nodes.filter((n) => n.status === "running").length;
  const failed = nodes.filter((n) => n.status === "failed").length;
  const parts: string[] = [];
  if (nodes.length > 0) parts.push(`${done}/${nodes.length} tasks completed`);
  if (running) parts.push(`${running} running`);
  if (failed) parts.push(`${failed} failed`);

  return {
    goal: state.plan?.summary ?? "",
    phase: state.phase as OrchestratorMetadata["phase"],
    nodes,
    edges,
    summary: parts.join(" · ") || undefined,
    startTime: new Date(state.created_at).getTime(),
    endTime:
      state.phase === "completed" || state.phase === "failed"
        ? Date.now()
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// OpenCode session integration (optional — requires OPENCODE_SERVER_URL)
// ---------------------------------------------------------------------------

/**
 * Create an OpenCode child session for a task node and send its prompt.
 * Returns the session ID, or undefined if the OpenCode server is not
 * configured.
 *
 * @param parentSessionID - The parent session in which the orchestrate tool is running
 * @param task            - The decomposed task to execute
 * @param nodeId          - The orchestrator DB node ID
 * @param runId           - The orchestrator run ID
 */
export async function createChildSession(
  parentSessionID: string,
  task: DecomposedTask,
  nodeId: string,
  runId: string,
): Promise<string | undefined> {
  const serverUrl = process.env.OPENCODE_SERVER_URL;
  if (!serverUrl) return undefined;

  try {
    // Create session
    const createRes = await fetch(`${serverUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parentID: parentSessionID,
        title: task.title,
      }),
    });

    if (!createRes.ok) {
      console.error(
        `[session-bridge] Failed to create session for node ${nodeId}: ${createRes.status}`,
      );
      return undefined;
    }

    const session = (await createRes.json()) as { data: { id: string } };
    const sessionId = session.data.id;

    // Track the session
    setNodeSession(runId, nodeId, sessionId);

    // Send the task prompt
    const promptRes = await fetch(`${serverUrl}/session/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: agentForKind(task.kind),
        parts: [{ type: "text", text: task.prompt }],
      }),
    });

    if (!promptRes.ok) {
      console.error(
        `[session-bridge] Failed to send prompt to session ${sessionId}: ${promptRes.status}`,
      );
    }

    return sessionId;
  } catch (err) {
    console.error(
      `[session-bridge] Error creating child session for node ${nodeId}:`,
      err,
    );
    return undefined;
  }
}

/**
 * Check the status of an OpenCode session.
 * Returns "idle" (completed), "running", or undefined on error.
 */
export async function checkSessionStatus(
  sessionId: string,
): Promise<"idle" | "running" | undefined> {
  const serverUrl = process.env.OPENCODE_SERVER_URL;
  if (!serverUrl) return undefined;

  try {
    const res = await fetch(`${serverUrl}/session/status`);
    if (!res.ok) return undefined;

    const data = (await res.json()) as {
      data: Array<{ sessionID: string; type: string }>
    };

    const entry = data.data.find((s) => s.sessionID === sessionId);
    if (!entry) return "idle"; // no status entry = not running = idle
    return entry.type === "running" ? "running" : "idle";
  } catch {
    return undefined;
  }
}

/**
 * Await an OpenCode session until it becomes idle (completed).
 * Polls the session status endpoint with a 2-second interval.
 * Returns when the session is idle or if the server is unreachable.
 */
export async function awaitSessionIdle(sessionId: string): Promise<void> {
  const maxWaitMs = parseInt(process.env.SESSION_TIMEOUT_MS || "", 10) || 10 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const status = await checkSessionStatus(sessionId);
    if (status === "idle" || status === undefined) return;
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(`Session ${sessionId} did not complete within ${maxWaitMs / 1000}s`);
}

/**
 * Get the final result text from an OpenCode session.
 * Returns the last assistant message content, or undefined on error.
 */
export async function getSessionResult(
  sessionId: string,
): Promise<string | undefined> {
  const serverUrl = process.env.OPENCODE_SERVER_URL;
  if (!serverUrl) return undefined;

  try {
    const res = await fetch(`${serverUrl}/session/${sessionId}`);
    if (!res.ok) return undefined;

    const data = (await res.json()) as {
      data: {
        messages: Array<{
          role: string;
          parts: Array<{ type: string; text?: string }>;
        }>;
      };
    };

    // Find the last assistant message with text content
    const messages = data.data.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        const textParts = msg.parts
          ?.filter((p) => p.type === "text" && p.text)
          .map((p) => p.text!)
          .join("\n");
        if (textParts) return textParts;
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map task kind to OpenCode agent name.
 */
function agentForKind(kind: string): string {
  switch (kind) {
    case "research":
      return "ask";
    case "code_gen":
      return "build";
    case "test":
      return "build";
    case "review":
      return "ask";
    case "docs":
      return "docs";
    default:
      return "build";
  }
}
