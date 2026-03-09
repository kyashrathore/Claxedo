import { ulid } from "ulid";
import type { EventEnvelope } from "../orchestrator/events";
import { insertEvent, generateHash, getNextSeq } from "../db/helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpToolContext {
  db: any; // bun:sqlite db instance
  runId: string;
  nodeId?: string; // set for task agents, undefined for planner
  onNodeCompleted?: (runId: string, nodeId: string) => void;
  onPlanningComplete?: (runId: string, summary: string) => void;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
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
  actorId = "mcp"
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
  const row = db
    .query("SELECT node_id FROM nodes_current WHERE node_id = ? AND run_id = ?")
    .get(nodeId, runId);
  return !!row;
}

/**
 * Cycle detection via DFS.
 * Returns true if `target` is reachable from `start` following existing edges
 * (source_id -> target_id direction).
 */
function isReachable(
  db: any,
  runId: string,
  start: string,
  target: string
): boolean {
  const edges = db
    .query("SELECT source_id, target_id FROM dependency_edges_current WHERE run_id = ?")
    .all(runId) as Array<{ source_id: string; target_id: string }>;

  // Build adjacency: source -> [targets]
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source_id) || [];
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
    const neighbors = adj.get(current) || [];
    for (const n of neighbors) {
      if (!visited.has(n)) stack.push(n);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tool definitions (JSON Schema format for MCP)
// ---------------------------------------------------------------------------

export function getToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: "create_node",
      description:
        "Create a new task node in the work graph. Returns the generated node_id.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Human-readable title for the node" },
          kind: { type: "string", description: "Node kind (e.g. code, test, review)" },
          role: { type: "string", description: "Agent role (e.g. developer, reviewer)" },
          prompt: {
            type: "string",
            description: "The prompt / instructions stored as the node's scratchpad entry",
          },
          depends_on: {
            type: "array",
            items: { type: "string" },
            description: "Array of node_ids this node depends on",
          },
        },
        required: ["title", "kind", "role", "prompt"],
      },
    },
    {
      name: "add_edge",
      description:
        "Add a dependency edge between two nodes. source must complete before target can start.",
      inputSchema: {
        type: "object",
        properties: {
          source_id: { type: "string", description: "The upstream node (dependency)" },
          target_id: { type: "string", description: "The downstream node (dependent)" },
          type: {
            type: "string",
            description: "Edge type (defaults to 'depends_on')",
          },
        },
        required: ["source_id", "target_id"],
      },
    },
    {
      name: "remove_edge",
      description: "Remove a dependency edge between two nodes.",
      inputSchema: {
        type: "object",
        properties: {
          source_id: { type: "string", description: "The upstream node" },
          target_id: { type: "string", description: "The downstream node" },
        },
        required: ["source_id", "target_id"],
      },
    },
    {
      name: "validate_graph",
      description:
        "Validate the current run's graph: check for cycles, orphan edges, and unreachable nodes.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "finish_planning",
      description:
        "Signal that planning is complete and the graph is ready for execution.",
      inputSchema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "A summary of the plan that was created",
          },
        },
        required: ["summary"],
      },
    },
    {
      name: "update_status",
      description: "Update a node's status to completed or failed.",
      inputSchema: {
        type: "object",
        properties: {
          node_id: { type: "string", description: "The node to update" },
          status: {
            type: "string",
            enum: ["completed", "failed"],
            description: "New status",
          },
        },
        required: ["node_id", "status"],
      },
    },
    {
      name: "write_scratchpad",
      description:
        "Write a scratchpad entry for a node. Used to pass context between nodes.",
      inputSchema: {
        type: "object",
        properties: {
          node_id: {
            type: "string",
            description: "Target node (defaults to caller's node)",
          },
          content: { type: "string", description: "Content to write" },
          priority: {
            type: "string",
            enum: ["fyi", "blocking", "scope_change"],
            description: "Priority level (defaults to fyi)",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "read_scratchpads",
      description:
        "Read scratchpad entries. If node_id is given, returns entries for that node. " +
        "If omitted and caller is a task agent, returns own + upstream dependency scratchpads.",
      inputSchema: {
        type: "object",
        properties: {
          node_id: {
            type: "string",
            description: "Node to read scratchpads for (optional)",
          },
        },
      },
    },
    {
      name: "create_artifact",
      description: "Create an artifact associated with a node.",
      inputSchema: {
        type: "object",
        properties: {
          node_id: {
            type: "string",
            description: "Owning node (defaults to caller's node)",
          },
          content: { type: "string", description: "Artifact content" },
          type: { type: "string", description: "Artifact type (e.g. file, diff, log)" },
        },
        required: ["content", "type"],
      },
    },
    {
      name: "get_graph",
      description: "Get the full graph (nodes and edges) for the current run.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_run_status",
      description:
        "Get the current run status including node counts by status.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function createNode(
  ctx: McpToolContext,
  args: {
    title: string;
    kind: string;
    role: string;
    prompt: string;
    depends_on?: string[];
  }
): Promise<{ node_id: string } | { error: string }> {
  const { db, runId } = ctx;
  const { title, kind, role, prompt, depends_on } = args;

  const nodeId = `node_${ulid()}`;

  // Validate dependencies exist before creating anything
  if (depends_on && depends_on.length > 0) {
    for (const depId of depends_on) {
      if (!nodeExists(db, runId, depId)) {
        return { error: `Dependency node not found: ${depId}` };
      }
    }
  }

  // Insert node
  db.run(
    "INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [nodeId, runId, role, kind, title, "pending", 0]
  );

  // Store prompt as scratchpad entry
  const spId = `sp_${ulid()}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const sizeBytes = new TextEncoder().encode(prompt).length;
  db.run(
    "INSERT INTO scratchpad_entries (id, run_id, node_id, content, created_at, expires_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [spId, runId, nodeId, prompt, now, expiresAt, sizeBytes]
  );

  // Emit node_created event
  emitEvent(db, runId, "node_created", {
    node_id: nodeId,
    kind,
    role,
    title,
  });

  // Create dependency edges
  if (depends_on && depends_on.length > 0) {
    for (const sourceId of depends_on) {
      const edgeId = `edge_${ulid()}`;
      db.run(
        "INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
        [edgeId, runId, sourceId, nodeId, "depends_on"]
      );
      emitEvent(db, runId, "edge_added", {
        id: edgeId,
        source_id: sourceId,
        target_id: nodeId,
        type: "depends_on",
      });
    }
  }

  return { node_id: nodeId };
}

async function addEdge(
  ctx: McpToolContext,
  args: { source_id: string; target_id: string; type?: string }
): Promise<{ edge_id: string } | { error: string }> {
  const { db, runId } = ctx;
  const { source_id, target_id, type: edgeType = "depends_on" } = args;

  // Validate both nodes exist
  if (!nodeExists(db, runId, source_id)) {
    return { error: `Source node not found: ${source_id}` };
  }
  if (!nodeExists(db, runId, target_id)) {
    return { error: `Target node not found: ${target_id}` };
  }

  // Cycle detection: adding edge source->target creates a cycle if target can already reach source
  if (isReachable(db, runId, target_id, source_id)) {
    return {
      error: `Adding edge ${source_id} -> ${target_id} would create a cycle`,
    };
  }

  const edgeId = `edge_${ulid()}`;
  db.run(
    "INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
    [edgeId, runId, source_id, target_id, edgeType]
  );

  emitEvent(db, runId, "edge_added", {
    id: edgeId,
    source_id,
    target_id,
    type: edgeType,
  });

  return { edge_id: edgeId };
}

async function removeEdge(
  ctx: McpToolContext,
  args: { source_id: string; target_id: string }
): Promise<{ ok: boolean } | { error: string }> {
  const { db, runId } = ctx;
  const { source_id, target_id } = args;

  db.run(
    "DELETE FROM dependency_edges_current WHERE run_id = ? AND source_id = ? AND target_id = ?",
    [runId, source_id, target_id]
  );

  emitEvent(db, runId, "edge_removed", {
    source_id,
    target_id,
  });

  return { ok: true };
}

async function validateGraph(
  ctx: McpToolContext
): Promise<{ valid: boolean; issues: string[] }> {
  const { db, runId } = ctx;
  const issues: string[] = [];

  const nodes = db
    .query("SELECT node_id FROM nodes_current WHERE run_id = ?")
    .all(runId) as Array<{ node_id: string }>;
  const edges = db
    .query("SELECT id, source_id, target_id FROM dependency_edges_current WHERE run_id = ?")
    .all(runId) as Array<{ id: string; source_id: string; target_id: string }>;

  const nodeIdList = nodes.map((n) => n.node_id);
  const nodeIdSet = new Set(nodeIdList);

  // Check for orphan edges (referencing non-existent nodes)
  for (const edge of edges) {
    if (!nodeIdSet.has(edge.source_id)) {
      issues.push(
        `Edge ${edge.id} references non-existent source node: ${edge.source_id}`
      );
    }
    if (!nodeIdSet.has(edge.target_id)) {
      issues.push(
        `Edge ${edge.id} references non-existent target node: ${edge.target_id}`
      );
    }
  }

  // Build adjacency for cycle detection
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source_id) || [];
    list.push(e.target_id);
    adj.set(e.source_id, list);
  }

  // Cycle detection via DFS (detect back edges)
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const nid of nodeIdList) color.set(nid, WHITE);

  function dfs(node: string): boolean {
    color.set(node, GRAY);
    for (const neighbor of adj.get(node) || []) {
      const c = color.get(neighbor) ?? WHITE;
      if (c === GRAY) return true; // back edge = cycle
      if (c === WHITE && dfs(neighbor)) return true;
    }
    color.set(node, BLACK);
    return false;
  }

  let hasCycle = false;
  for (const nid of nodeIdList) {
    if (color.get(nid) === WHITE) {
      if (dfs(nid)) {
        hasCycle = true;
        break;
      }
    }
  }
  if (hasCycle) {
    issues.push("Graph contains a cycle");
  }

  // Check all nodes are reachable from at least one root
  // Root = node with no incoming edges
  const hasIncoming = new Set<string>();
  for (const e of edges) {
    hasIncoming.add(e.target_id);
  }
  const roots = nodeIdList.filter((id) => !hasIncoming.has(id));

  if (roots.length === 0 && nodes.length > 0) {
    issues.push("No root nodes found — every node has an incoming edge");
  } else {
    // BFS from all roots
    const reachable = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const neighbor of adj.get(current) || []) {
        if (!reachable.has(neighbor)) queue.push(neighbor);
      }
    }
    for (const nid of nodeIdList) {
      if (!reachable.has(nid)) {
        issues.push(`Node ${nid} is not reachable from any root`);
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

async function finishPlanning(
  ctx: McpToolContext,
  args: { summary: string }
): Promise<{ ok: boolean } | { error: string }> {
  const { db, runId } = ctx;
  const { summary } = args;

  // Emit run_planned event
  emitEvent(db, runId, "run_planned", { summary });

  // Update run status to executing
  db.run("UPDATE runs_current SET status = ? WHERE run_id = ?", [
    "executing",
    runId,
  ]);

  // Trigger the executor
  if (ctx.onPlanningComplete) {
    ctx.onPlanningComplete(runId, summary);
  }

  return { ok: true };
}

async function updateStatus(
  ctx: McpToolContext,
  args: { node_id: string; status: "completed" | "failed" }
): Promise<{ ok: boolean } | { error: string }> {
  const { db, runId } = ctx;
  const { node_id, status } = args;

  // Validate the node belongs to this run
  const existing = db
    .query("SELECT * FROM nodes_current WHERE node_id = ? AND run_id = ?")
    .get(node_id, runId) as {
    node_id: string;
    status: string;
    retry_count: number;
  } | null;

  if (!existing) {
    return { error: `Node not found in this run: ${node_id}` };
  }

  const previousStatus = existing.status;

  if (status === "failed") {
    // Increment retry count on failure
    db.run(
      "UPDATE nodes_current SET status = ?, retry_count = retry_count + 1 WHERE node_id = ?",
      [status, node_id]
    );
  } else {
    db.run("UPDATE nodes_current SET status = ? WHERE node_id = ?", [
      status,
      node_id,
    ]);
  }

  emitEvent(db, runId, "node_status_changed", {
    node_id,
    status,
    previous_status: previousStatus,
  });

  if (status === "completed" && ctx.onNodeCompleted) {
    ctx.onNodeCompleted(runId, node_id);
  }

  return { ok: true };
}

async function writeScratchpad(
  ctx: McpToolContext,
  args: { node_id?: string; content: string; priority?: "fyi" | "blocking" | "scope_change" }
): Promise<{ scratchpad_id: string } | { error: string }> {
  const { db, runId } = ctx;
  const targetNodeId = args.node_id || ctx.nodeId;

  if (!targetNodeId) {
    return { error: "No node_id provided and no default nodeId in context" };
  }

  const spId = `sp_${ulid()}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const sizeBytes = new TextEncoder().encode(args.content).length;

  db.run(
    "INSERT INTO scratchpad_entries (id, run_id, node_id, content, created_at, expires_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [spId, runId, targetNodeId, args.content, now, expiresAt, sizeBytes]
  );

  emitEvent(db, runId, "scratchpad_written", {
    scratchpad_id: spId,
    node_id: targetNodeId,
    priority: args.priority || "fyi",
    size_bytes: sizeBytes,
  });

  return { scratchpad_id: spId };
}

async function readScratchpads(
  ctx: McpToolContext,
  args: { node_id?: string }
): Promise<{ entries: Array<Record<string, any>> }> {
  const { db, runId } = ctx;

  if (args.node_id) {
    // Return entries for the specified node
    const entries = db
      .query(
        "SELECT id, run_id, node_id, content, created_at FROM scratchpad_entries WHERE run_id = ? AND node_id = ? ORDER BY created_at ASC"
      )
      .all(runId, args.node_id) as Array<Record<string, any>>;
    return { entries };
  }

  if (ctx.nodeId) {
    // Task agent: return own scratchpad + upstream dependency scratchpads
    const ownEntries = db
      .query(
        "SELECT id, run_id, node_id, content, created_at FROM scratchpad_entries WHERE run_id = ? AND node_id = ? ORDER BY created_at ASC"
      )
      .all(runId, ctx.nodeId) as Array<Record<string, any>>;

    // Find upstream dependencies (edges where target_id = ctx.nodeId)
    const incomingEdges = db
      .query(
        "SELECT source_id FROM dependency_edges_current WHERE run_id = ? AND target_id = ?"
      )
      .all(runId, ctx.nodeId) as Array<{ source_id: string }>;

    const upstreamEntries: Array<Record<string, any>> = [];
    for (const edge of incomingEdges) {
      // Only include scratchpads from completed upstream nodes
      const sourceNode = db
        .query(
          "SELECT status FROM nodes_current WHERE node_id = ? AND run_id = ? AND status = 'completed'"
        )
        .get(edge.source_id, runId);
      if (!sourceNode) continue;

      const entries = db
        .query(
          "SELECT id, run_id, node_id, content, created_at FROM scratchpad_entries WHERE run_id = ? AND node_id = ? ORDER BY created_at ASC"
        )
        .all(runId, edge.source_id) as Array<Record<string, any>>;
      upstreamEntries.push(...entries);
    }

    return { entries: [...ownEntries, ...upstreamEntries] };
  }

  // Planner with no node_id specified: return all entries for the run
  const entries = db
    .query(
      "SELECT id, run_id, node_id, content, created_at FROM scratchpad_entries WHERE run_id = ? ORDER BY created_at ASC"
    )
    .all(runId) as Array<Record<string, any>>;
  return { entries };
}

async function createArtifact(
  ctx: McpToolContext,
  args: { node_id?: string; content: string; type: string }
): Promise<{ artifact_id: string } | { error: string }> {
  const { db, runId } = ctx;
  const targetNodeId = args.node_id || ctx.nodeId;

  if (!targetNodeId) {
    return { error: "No node_id provided and no default nodeId in context" };
  }

  const artifactId = `artifact_${ulid()}`;

  emitEvent(db, runId, "artifact_created", {
    artifact_id: artifactId,
    node_id: targetNodeId,
    type: args.type,
    content: args.content,
  });

  return { artifact_id: artifactId };
}

async function getGraph(
  ctx: McpToolContext
): Promise<{ nodes: Array<Record<string, any>>; edges: Array<Record<string, any>> }> {
  const { db, runId } = ctx;

  const nodes = db
    .query("SELECT * FROM nodes_current WHERE run_id = ?")
    .all(runId) as Array<Record<string, any>>;
  const edges = db
    .query("SELECT * FROM dependency_edges_current WHERE run_id = ?")
    .all(runId) as Array<Record<string, any>>;

  return { nodes, edges };
}

async function getRunStatus(
  ctx: McpToolContext
): Promise<Record<string, any>> {
  const { db, runId } = ctx;

  const run = db
    .query("SELECT * FROM runs_current WHERE run_id = ?")
    .get(runId) as { run_id: string; goal: string; status: string } | null;

  if (!run) {
    return { error: `Run not found: ${runId}` };
  }

  const nodes = db
    .query("SELECT status FROM nodes_current WHERE run_id = ?")
    .all(runId) as Array<{ status: string }>;

  let completed = 0;
  let failed = 0;
  let pending = 0;
  let active = 0;

  for (const n of nodes) {
    switch (n.status) {
      case "completed":
        completed++;
        break;
      case "failed":
        failed++;
        break;
      case "pending":
        pending++;
        break;
      case "active":
      case "running":
        active++;
        break;
      default:
        pending++;
        break;
    }
  }

  return {
    phase: run.status,
    total_nodes: nodes.length,
    completed,
    failed,
    pending,
    active,
  };
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

const TOOL_HANDLERS: Record<
  string,
  (ctx: McpToolContext, args: any) => Promise<any>
> = {
  create_node: createNode,
  add_edge: addEdge,
  remove_edge: removeEdge,
  validate_graph: validateGraph,
  finish_planning: finishPlanning,
  update_status: updateStatus,
  write_scratchpad: writeScratchpad,
  read_scratchpads: readScratchpads,
  create_artifact: createArtifact,
  get_graph: getGraph,
  get_run_status: getRunStatus,
};

export async function handleToolCall(
  ctx: McpToolContext,
  toolName: string,
  args: Record<string, any>
): Promise<any> {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) {
    return { error: `Unknown tool: ${toolName}` };
  }

  try {
    return await handler(ctx, args);
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}
