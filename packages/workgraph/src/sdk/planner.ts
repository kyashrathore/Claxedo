/**
 * Planner SDK — business logic for orchestration graph operations.
 *
 * All functions are transport-agnostic: they take plain arguments and return
 * plain objects. No Hono, no MCP protocol concerns here.
 *
 * Consumed by:
 *   - mcp/tools.ts (via MCP tool calls from agents)
 *   - routes/planning.ts (via HTTP from the planner UI)
 */

import { ulid } from "ulid";
import { insertEvent, generateHash, getNextSeq } from "../db/helpers";
import { getSource } from "../db/source";
import type { RuntimeType } from "../orchestrator/types";
import type { EventEnvelope } from "../orchestrator/events";

// ---------------------------------------------------------------------------
// Runtime type heuristic
// ---------------------------------------------------------------------------

const WORKSPACE_KINDS = new Set<string>(["code_gen", "test"]);

export function inferRuntimeType(kind: string): RuntimeType {
  return WORKSPACE_KINDS.has(kind) ? "workspace" : "task";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emitEvent(
  db: any,
  runId: string,
  type: string,
  payload: Record<string, any>,
  actorType = "agent",
  actorId = "mcp",
): EventEnvelope {
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
    actor_type: actorType,
    actor_id: actorId,
    op_id: `op_${eventId}`,
    prev_hash: "00000000",
    hash: generateHash(),
    created_at: new Date().toISOString(),
  };
  insertEvent(db, event);
  return event;
}

function nodeExists(db: any, runId: string, nodeId: string): boolean {
  return !!db
    .query("SELECT node_id FROM nodes_current WHERE node_id = ? AND run_id = ?")
    .get(nodeId, runId);
}

function isReachable(db: any, runId: string, start: string, target: string): boolean {
  const edges = db
    .query("SELECT source_id, target_id FROM dependency_edges_current WHERE run_id = ?")
    .all(runId) as Array<{ source_id: string; target_id: string }>;

  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source_id) ?? [];
    list.push(e.target_id);
    adj.set(e.source_id, list);
  }

  const visited = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const n of adj.get(current) ?? []) {
      if (!visited.has(n)) stack.push(n);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Graph mutation operations
// ---------------------------------------------------------------------------

export async function createNode(
  db: any,
  runId: string,
  args: {
    title: string;
    kind: string;
    role: string;
    prompt: string;
    depends_on?: string[];
    runtime_type?: RuntimeType;
    runtime_type_reason?: string;
    node_type?: "task" | "mission" | "synthesis";
    parent_node_id?: string;
  },
): Promise<{ node_id: string; runtime_type: RuntimeType } | { error: string }> {
  const { title, kind, role, prompt, depends_on } = args;
  const nodeType = args.node_type ?? "task";
  const parentNodeId = args.parent_node_id ?? null;
  const runtimeType: RuntimeType = args.runtime_type ?? inferRuntimeType(kind);
  const runtimeTypeReason = args.runtime_type
    ? (args.runtime_type_reason ?? "user-specified")
    : "planner-heuristic";
  const nodeId = `node_${ulid()}`;

  if (depends_on?.length) {
    for (const depId of depends_on) {
      if (!nodeExists(db, runId, depId)) return { error: `Dependency node not found: ${depId}` };
    }
  }
  if (parentNodeId && !nodeExists(db, runId, parentNodeId)) {
    return { error: `Parent node not found: ${parentNodeId}` };
  }

  db.run(
    "INSERT INTO nodes_current (node_id, run_id, role, kind, title, node_type, parent_node_id, status, retry_count, runtime_type, runtime_type_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [nodeId, runId, role, kind, title, nodeType, parentNodeId, "pending", 0, runtimeType, runtimeTypeReason],
  );

  const spId = `sp_${ulid()}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.run(
    "INSERT INTO scratchpad_entries (id, run_id, node_id, content, created_at, expires_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [spId, runId, nodeId, prompt, now, expiresAt, new TextEncoder().encode(prompt).length],
  );

  emitEvent(db, runId, "node_created", {
    node_id: nodeId, kind, role, title,
    node_type: nodeType, parent_node_id: parentNodeId,
    runtime_type: runtimeType, runtime_type_reason: runtimeTypeReason,
  });

  for (const sourceId of depends_on ?? []) {
    const edgeId = `edge_${ulid()}`;
    db.run(
      "INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
      [edgeId, runId, sourceId, nodeId, "depends_on"],
    );
    emitEvent(db, runId, "edge_added", { id: edgeId, source_id: sourceId, target_id: nodeId, type: "depends_on" });
  }

  return { node_id: nodeId, runtime_type: runtimeType };
}

export async function addEdge(
  db: any,
  runId: string,
  args: { source_id: string; target_id: string; type?: string },
): Promise<{ edge_id: string } | { error: string }> {
  const { source_id, target_id, type: edgeType = "depends_on" } = args;

  if (!nodeExists(db, runId, source_id)) return { error: `Source node not found: ${source_id}` };
  if (!nodeExists(db, runId, target_id)) return { error: `Target node not found: ${target_id}` };
  if (isReachable(db, runId, target_id, source_id)) {
    return { error: `Adding edge ${source_id} -> ${target_id} would create a cycle` };
  }

  const edgeId = `edge_${ulid()}`;
  db.run(
    "INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
    [edgeId, runId, source_id, target_id, edgeType],
  );
  emitEvent(db, runId, "edge_added", { id: edgeId, source_id, target_id, type: edgeType });

  return { edge_id: edgeId };
}

export async function removeEdge(
  db: any,
  runId: string,
  args: { source_id: string; target_id: string },
): Promise<{ ok: boolean }> {
  db.run(
    "DELETE FROM dependency_edges_current WHERE run_id = ? AND source_id = ? AND target_id = ?",
    [runId, args.source_id, args.target_id],
  );
  emitEvent(db, runId, "edge_removed", { source_id: args.source_id, target_id: args.target_id });
  return { ok: true };
}

export async function validateGraph(
  db: any,
  runId: string,
): Promise<{ valid: boolean; issues: string[] }> {
  const issues: string[] = [];
  const nodes = db
    .query("SELECT node_id FROM nodes_current WHERE run_id = ?")
    .all(runId) as Array<{ node_id: string }>;
  const edges = db
    .query("SELECT id, source_id, target_id FROM dependency_edges_current WHERE run_id = ?")
    .all(runId) as Array<{ id: string; source_id: string; target_id: string }>;

  const nodeIdSet = new Set(nodes.map((n) => n.node_id));

  for (const edge of edges) {
    if (!nodeIdSet.has(edge.source_id))
      issues.push(`Edge ${edge.id} references non-existent source node: ${edge.source_id}`);
    if (!nodeIdSet.has(edge.target_id))
      issues.push(`Edge ${edge.id} references non-existent target node: ${edge.target_id}`);
  }

  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source_id) ?? [];
    list.push(e.target_id);
    adj.set(e.source_id, list);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.node_id, WHITE);

  function dfs(node: string): boolean {
    color.set(node, GRAY);
    for (const neighbor of adj.get(node) ?? []) {
      const c = color.get(neighbor) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && dfs(neighbor)) return true;
    }
    color.set(node, BLACK);
    return false;
  }

  for (const n of nodes) {
    if (color.get(n.node_id) === WHITE && dfs(n.node_id)) {
      issues.push("Graph contains a cycle");
      break;
    }
  }

  const hasIncoming = new Set(edges.map((e) => e.target_id));
  const roots = nodes.filter((n) => !hasIncoming.has(n.node_id));

  if (roots.length === 0 && nodes.length > 0) {
    issues.push("No root nodes found — every node has an incoming edge");
  } else {
    const reachable = new Set<string>();
    const queue = roots.map((n) => n.node_id);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const neighbor of adj.get(cur) ?? []) {
        if (!reachable.has(neighbor)) queue.push(neighbor);
      }
    }
    for (const n of nodes) {
      if (!reachable.has(n.node_id))
        issues.push(`Node ${n.node_id} is not reachable from any root`);
    }
  }

  return { valid: issues.length === 0, issues };
}

export async function finishPlanning(
  db: any,
  runId: string,
  summary: string,
  onComplete?: (runId: string, summary: string) => void,
): Promise<{ ok: boolean }> {
  emitEvent(db, runId, "run_planned", { summary });
  onComplete?.(runId, summary);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Task agent operations
// ---------------------------------------------------------------------------

export async function updateStatus(
  db: any,
  runId: string,
  args: { node_id: string; status: "completed" | "failed" },
  onNodeCompleted?: (runId: string, nodeId: string) => void,
): Promise<{ ok: boolean } | { error: string }> {
  const { node_id, status } = args;
  const existing = db
    .query("SELECT * FROM nodes_current WHERE node_id = ? AND run_id = ?")
    .get(node_id, runId) as { status: string } | null;

  if (!existing) return { error: `Node not found in this run: ${node_id}` };

  const previousStatus = existing.status;
  if (status === "failed") {
    db.run("UPDATE nodes_current SET status = ?, retry_count = retry_count + 1 WHERE node_id = ?", [status, node_id]);
  } else {
    db.run("UPDATE nodes_current SET status = ? WHERE node_id = ?", [status, node_id]);
  }

  emitEvent(db, runId, "node_status_changed", { node_id, status, previous_status: previousStatus });

  if (status === "completed") onNodeCompleted?.(runId, node_id);
  return { ok: true };
}

export async function writeScratchpad(
  db: any,
  runId: string,
  nodeId: string | undefined,
  args: { node_id?: string; content: string; priority?: "fyi" | "blocking" | "scope_change" },
): Promise<{ scratchpad_id: string } | { error: string }> {
  const targetNodeId = args.node_id ?? nodeId;
  if (!targetNodeId) return { error: "No node_id provided and no default nodeId in context" };

  const spId = `sp_${ulid()}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const sizeBytes = new TextEncoder().encode(args.content).length;

  db.run(
    "INSERT INTO scratchpad_entries (id, run_id, node_id, content, created_at, expires_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [spId, runId, targetNodeId, args.content, now, expiresAt, sizeBytes],
  );
  emitEvent(db, runId, "scratchpad_written", {
    scratchpad_id: spId, node_id: targetNodeId,
    priority: args.priority ?? "fyi", size_bytes: sizeBytes,
  });

  return { scratchpad_id: spId };
}

export async function readScratchpads(
  db: any,
  runId: string,
  nodeId: string | undefined,
  args: { node_id?: string },
): Promise<{ entries: Array<Record<string, any>> }> {
  const cols = "id, run_id, node_id, content, created_at";

  if (args.node_id) {
    return {
      entries: db
        .query(`SELECT ${cols} FROM scratchpad_entries WHERE run_id = ? AND node_id = ? ORDER BY created_at ASC`)
        .all(runId, args.node_id),
    };
  }

  if (nodeId) {
    const own = db
      .query(`SELECT ${cols} FROM scratchpad_entries WHERE run_id = ? AND node_id = ? ORDER BY created_at ASC`)
      .all(runId, nodeId) as Array<Record<string, any>>;

    const incoming = db
      .query("SELECT source_id FROM dependency_edges_current WHERE run_id = ? AND target_id = ?")
      .all(runId, nodeId) as Array<{ source_id: string }>;

    const upstream: Array<Record<string, any>> = [];
    for (const { source_id } of incoming) {
      const completed = db
        .query("SELECT status FROM nodes_current WHERE node_id = ? AND run_id = ? AND status = 'completed'")
        .get(source_id, runId);
      if (!completed) continue;
      upstream.push(
        ...db
          .query(`SELECT ${cols} FROM scratchpad_entries WHERE run_id = ? AND node_id = ? ORDER BY created_at ASC`)
          .all(runId, source_id),
      );
    }
    return { entries: [...own, ...upstream] };
  }

  return {
    entries: db
      .query(`SELECT ${cols} FROM scratchpad_entries WHERE run_id = ? ORDER BY created_at ASC`)
      .all(runId),
  };
}

export async function createArtifact(
  db: any,
  runId: string,
  nodeId: string | undefined,
  args: { node_id?: string; content: string; type: string },
): Promise<{ artifact_id: string } | { error: string }> {
  const targetNodeId = args.node_id ?? nodeId;
  if (!targetNodeId) return { error: "No node_id provided and no default nodeId in context" };

  const artifactId = `artifact_${ulid()}`;
  emitEvent(db, runId, "artifact_created", {
    artifact_id: artifactId, node_id: targetNodeId, type: args.type, content: args.content,
  });
  return { artifact_id: artifactId };
}

// ---------------------------------------------------------------------------
// Query operations
// ---------------------------------------------------------------------------

export async function getGraph(
  db: any,
  runId: string,
): Promise<{ nodes: Array<Record<string, any>>; edges: Array<Record<string, any>> }> {
  return {
    nodes: db.query("SELECT * FROM nodes_current WHERE run_id = ?").all(runId),
    edges: db.query("SELECT * FROM dependency_edges_current WHERE run_id = ?").all(runId),
  };
}

export async function getRunStatus(db: any, runId: string): Promise<Record<string, any>> {
  const run = db
    .query("SELECT * FROM runs_current WHERE run_id = ?")
    .get(runId) as { run_id: string; goal: string; status: string; runtime_type: string; runtime_type_reason: string | null } | null;

  if (!run) return { error: `Run not found: ${runId}` };

  const nodes = db
    .query("SELECT status FROM nodes_current WHERE run_id = ?")
    .all(runId) as Array<{ status: string }>;

  let completed = 0, failed = 0, pending = 0, active = 0;
  for (const n of nodes) {
    if (n.status === "completed") completed++;
    else if (n.status === "failed") failed++;
    else if (n.status === "active" || n.status === "running") active++;
    else pending++;
  }

  return {
    phase: run.status, runtime_type: run.runtime_type,
    runtime_type_reason: run.runtime_type_reason ?? null,
    total_nodes: nodes.length, completed, failed, pending, active,
  };
}

export async function getRunSource(db: any, runId: string): Promise<Record<string, any> | null> {
  return getSource(db, runId);
}
