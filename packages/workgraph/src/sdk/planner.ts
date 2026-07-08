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
export type RuntimeType = "workspace" | "task" | "service";
import type { IEventStore } from "../substrate/event-store";
import { sqlite, type SqliteDb, type SqliteInput } from "../sqlite";
import type { LoadoutKind, LoadoutScopeType } from "../model/types";
import type { Intent } from "../model/policy-types";
import { getWorkGraph } from "../model/registry";
import "../model/loadout";

// ---------------------------------------------------------------------------
// IPlannerStore — DB-agnostic interface for all planner SQL operations
// ---------------------------------------------------------------------------

export interface IPlannerStore {
  // Node existence / queries
  nodeExists(runId: string, nodeId: string): boolean;
  queryNodes(runId: string): Array<Record<string, any>>;
  getNodeStatus(runId: string, nodeId: string): { status: string } | null;
  queryNodeStatuses(runId: string): Array<{ status: string }>;
  isNodeCompleted(runId: string, nodeId: string): boolean;

  // Node mutations
  insertNode(
    nodeId: string,
    runId: string,
    role: string,
    kind: string,
    title: string,
    nodeType: string,
    parentNodeId: string | null,
    runtimeType: string,
    runtimeTypeReason: string,
  ): void;
  updateNodeStatus(nodeId: string, status: string, incrementRetry: boolean): void;

  // Edge mutations
  insertEdge(edgeId: string, runId: string, sourceId: string, targetId: string, type: string): void;
  deleteEdge(runId: string, sourceId: string, targetId: string): void;

  // Edge queries
  queryEdges(runId: string): Array<Record<string, any>>;
  getIncomingEdges(runId: string, nodeId: string): Array<{ source_id: string }>;

  // Scratchpad
  insertScratchpad(
    id: string,
    runId: string,
    nodeId: string,
    content: string,
    createdAt: string,
    expiresAt: string,
    sizeBytes: number,
  ): void;
  queryScratchpads(
    runId: string,
    nodeId?: string,
  ): Array<{ id: string; run_id: string; node_id: string; content: string; created_at: string }>;

  // Run / source queries
  getRun(
    runId: string,
  ): { run_id: string; goal: string; status: string; runtime_type: string; runtime_type_reason: string | null } | null;
  getRunSource(runId: string): Record<string, any> | null;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

class SqlitePlannerStore implements IPlannerStore {
  constructor(private db: SqliteDb) {}

  nodeExists(runId: string, nodeId: string): boolean {
    return !!this.db
      .query("SELECT node_id FROM nodes_current WHERE node_id = ? AND run_id = ?")
      .get(nodeId, runId);
  }

  queryNodes(runId: string): Array<Record<string, any>> {
    return this.db.query("SELECT * FROM nodes_current WHERE run_id = ?").all(runId) as Array<Record<string, any>>;
  }

  getNodeStatus(runId: string, nodeId: string): { status: string } | null {
    return this.db
      .query("SELECT status FROM nodes_current WHERE node_id = ? AND run_id = ?")
      .get(nodeId, runId) as { status: string } | null;
  }

  queryNodeStatuses(runId: string): Array<{ status: string }> {
    return this.db
      .query("SELECT status FROM nodes_current WHERE run_id = ?")
      .all(runId) as Array<{ status: string }>;
  }

  isNodeCompleted(runId: string, nodeId: string): boolean {
    return !!this.db
      .query("SELECT status FROM nodes_current WHERE node_id = ? AND run_id = ? AND status = 'completed'")
      .get(nodeId, runId);
  }

  insertNode(
    nodeId: string,
    runId: string,
    role: string,
    kind: string,
    title: string,
    nodeType: string,
    parentNodeId: string | null,
    runtimeType: string,
    runtimeTypeReason: string,
  ): void {
    this.db.run(
      "INSERT INTO nodes_current (node_id, run_id, role, kind, title, node_type, parent_node_id, status, retry_count, runtime_type, runtime_type_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [nodeId, runId, role, kind, title, nodeType, parentNodeId, "pending", 0, runtimeType, runtimeTypeReason],
    );
  }

  updateNodeStatus(nodeId: string, status: string, incrementRetry: boolean): void {
    if (incrementRetry) {
      this.db.run(
        "UPDATE nodes_current SET status = ?, retry_count = retry_count + 1 WHERE node_id = ?",
        [status, nodeId],
      );
    } else {
      this.db.run("UPDATE nodes_current SET status = ? WHERE node_id = ?", [status, nodeId]);
    }
  }

  insertEdge(edgeId: string, runId: string, sourceId: string, targetId: string, type: string): void {
    this.db.run(
      "INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
      [edgeId, runId, sourceId, targetId, type],
    );
  }

  deleteEdge(runId: string, sourceId: string, targetId: string): void {
    this.db.run(
      "DELETE FROM dependency_edges_current WHERE run_id = ? AND source_id = ? AND target_id = ?",
      [runId, sourceId, targetId],
    );
  }

  queryEdges(runId: string): Array<Record<string, any>> {
    return this.db
      .query("SELECT * FROM dependency_edges_current WHERE run_id = ?")
      .all(runId) as Array<Record<string, any>>;
  }

  getIncomingEdges(runId: string, nodeId: string): Array<{ source_id: string }> {
    return this.db
      .query("SELECT source_id FROM dependency_edges_current WHERE run_id = ? AND target_id = ?")
      .all(runId, nodeId) as Array<{ source_id: string }>;
  }

  insertScratchpad(
    id: string,
    runId: string,
    nodeId: string,
    content: string,
    createdAt: string,
    expiresAt: string,
    sizeBytes: number,
  ): void {
    this.db.run(
      "INSERT INTO scratchpad_entries (id, run_id, node_id, content, created_at, expires_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, runId, nodeId, content, createdAt, expiresAt, sizeBytes],
    );
  }

  queryScratchpads(
    runId: string,
    nodeId?: string,
  ): Array<{ id: string; run_id: string; node_id: string; content: string; created_at: string }> {
    const cols = "id, run_id, node_id, content, created_at";
    if (nodeId !== undefined) {
      return this.db
        .query(`SELECT ${cols} FROM scratchpad_entries WHERE run_id = ? AND node_id = ? ORDER BY created_at ASC`)
        .all(runId, nodeId) as any[];
    }
    return this.db
      .query(`SELECT ${cols} FROM scratchpad_entries WHERE run_id = ? ORDER BY created_at ASC`)
      .all(runId) as any[];
  }

  getRun(
    runId: string,
  ): { run_id: string; goal: string; status: string; runtime_type: string; runtime_type_reason: string | null } | null {
    return this.db.query("SELECT * FROM runs_current WHERE run_id = ?").get(runId) as any;
  }

  getRunSource(runId: string): Record<string, any> | null {
    return (
      this.db
        .query(
          "SELECT run_id, kind, title, content, source_path, created_at FROM run_sources_current WHERE run_id = ?",
        )
        .get(runId) as Record<string, any> | null ?? null
    );
  }
}

export function openSqlitePlannerStore(db: SqliteInput): IPlannerStore {
  return new SqlitePlannerStore(sqlite(db));
}

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

async function emitEvent(
  eventStore: IEventStore,
  runId: string,
  type: string,
  payload: Record<string, any>,
  actorType = "agent",
  actorId = "mcp",
): Promise<void> {
  const eventId = `evt_${ulid()}`;
  await eventStore.append({
    id: eventId,
    run_id: runId,
    stream_id: runId,
    schema_version: 1,
    type,
    payload_json: JSON.stringify(payload),
    actor_type: actorType,
    actor_id: actorId,
    op_id: `op_${eventId}`,
    created_at: new Date().toISOString(),
  });
}

function isReachable(store: IPlannerStore, runId: string, start: string, target: string): boolean {
  const edges = store.queryEdges(runId) as Array<{ source_id: string; target_id: string }>;

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
  store: IPlannerStore,
  eventStore: IEventStore,
  runId: string,
  args: {
    title: string;
    kind: string;
    role: string;
    prompt: string;
    depends_on?: string[];
    confidence?: number;
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
      if (!store.nodeExists(runId, depId)) return { error: `Dependency node not found: ${depId}` };
    }
  }
  if (parentNodeId && !store.nodeExists(runId, parentNodeId)) {
    return { error: `Parent node not found: ${parentNodeId}` };
  }

  store.insertNode(nodeId, runId, role, kind, title, nodeType, parentNodeId, runtimeType, runtimeTypeReason);

  const spId = `sp_${ulid()}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  store.insertScratchpad(spId, runId, nodeId, prompt, now, expiresAt, new TextEncoder().encode(prompt).length);

  await emitEvent(eventStore, runId, "node_created", {
    node_id: nodeId,
    kind,
    role,
    title,
    node_type: nodeType,
    parent_node_id: parentNodeId,
    runtime_type: runtimeType,
    runtime_type_reason: runtimeTypeReason,
  });

  for (const sourceId of depends_on ?? []) {
    const edgeId = `edge_${ulid()}`;
    store.insertEdge(edgeId, runId, sourceId, nodeId, "depends_on");
    await emitEvent(eventStore, runId, "edge_added", {
      id: edgeId,
      source_id: sourceId,
      target_id: nodeId,
      type: "depends_on",
    });
  }

  return { node_id: nodeId, runtime_type: runtimeType };
}

export async function proposeCreateNode(
  store: IPlannerStore,
  eventStore: IEventStore,
  runId: string,
  args: Parameters<typeof createNode>[3],
) {
  const workGraph = getWorkGraph();
  const scratchpad = workGraph.getLatestScratchpadByRun(runId);
  if (scratchpad) {
    const result = workGraph.propose({
      intentKind: "add_node",
      subjectType: scratchpad.subjectType,
      subjectId: scratchpad.subjectId,
      confidence: args.confidence ?? 0.85,
      evidenceMd: scratchpad.content,
      title: args.title,
      description: args.prompt,
      labels: [args.kind, args.role].filter(Boolean),
      nodeType: args.node_type ?? "task",
    });
    return {
      outcome: result.outcome,
      fired_rule_id: result.firedRuleId,
      item_id: result.outcome === "applied" ? result.item?.id : undefined,
      decision_id: result.outcome === "decision" ? result.decision.id : undefined,
    };
  }

  await emitEvent(eventStore, runId, "captain_proposed", {
    intent_kind: "add_node",
    outcome: "apply",
    fired_rule_id: "default-high-confidence-apply",
    intent: args,
  }, "captain", "mcp");
  return createNode(store, eventStore, runId, args);
}

export async function addEdge(
  store: IPlannerStore,
  eventStore: IEventStore,
  runId: string,
  args: { source_id: string; target_id: string; type?: string },
): Promise<{ edge_id: string } | { error: string }> {
  const { source_id, target_id, type: edgeType = "depends_on" } = args;

  if (!store.nodeExists(runId, source_id)) return { error: `Source node not found: ${source_id}` };
  if (!store.nodeExists(runId, target_id)) return { error: `Target node not found: ${target_id}` };
  if (isReachable(store, runId, target_id, source_id)) {
    return { error: `Adding edge ${source_id} -> ${target_id} would create a cycle` };
  }

  const edgeId = `edge_${ulid()}`;
  store.insertEdge(edgeId, runId, source_id, target_id, edgeType);
  await emitEvent(eventStore, runId, "edge_added", { id: edgeId, source_id, target_id, type: edgeType });

  return { edge_id: edgeId };
}

export async function proposeAddEdge(
  store: IPlannerStore,
  eventStore: IEventStore,
  runId: string,
  args: Parameters<typeof addEdge>[3],
) {
  await emitEvent(eventStore, runId, "captain_proposed", {
    intent_kind: "add_edge",
    outcome: "apply",
    fired_rule_id: "default-high-confidence-apply",
    intent: args,
  }, "captain", "mcp");
  return addEdge(store, eventStore, runId, args);
}

export async function removeEdge(
  store: IPlannerStore,
  eventStore: IEventStore,
  runId: string,
  args: { source_id: string; target_id: string },
): Promise<{ ok: boolean }> {
  store.deleteEdge(runId, args.source_id, args.target_id);
  await emitEvent(eventStore, runId, "edge_removed", { source_id: args.source_id, target_id: args.target_id });
  return { ok: true };
}

export async function proposeRemoveEdge(
  store: IPlannerStore,
  eventStore: IEventStore,
  runId: string,
  args: Parameters<typeof removeEdge>[3],
) {
  const source = store.getNodeStatus(runId, args.source_id);
  const target = store.getNodeStatus(runId, args.target_id);
  const inFlight = [source?.status, target?.status].some((status) => status === "active" || status === "running");
  if (inFlight) {
    const decisionId = `decision_${ulid()}`;
    await emitEvent(eventStore, runId, "captain_proposed", {
      intent_kind: "remove_edge",
      outcome: "action",
      fired_rule_id: "safety-destructive-remove_edge_of_in_flight",
      intent: args,
    }, "captain", "mcp");
    await emitEvent(eventStore, runId, "decision_created", {
      decision_id: decisionId,
      kind: "action",
      intent_kind: "remove_edge",
      recommended_intent_payload: args,
      status: "open",
    }, "captain", "mcp");
    return { decision_id: decisionId };
  }

  await emitEvent(eventStore, runId, "captain_proposed", {
    intent_kind: "remove_edge",
    outcome: "apply",
    fired_rule_id: "default-high-confidence-apply",
    intent: args,
  }, "captain", "mcp");
  return removeEdge(store, eventStore, runId, args);
}

function workGraphProposalSubject(runId: string) {
  const workGraph = getWorkGraph();
  const scratchpad = workGraph.getLatestScratchpadByRun(runId);
  if (!scratchpad) return { error: `No WorkGraph scratchpad found for agent run '${runId}'` };
  return {
    workGraph,
    scratchpad,
    subjectType: scratchpad.subjectType,
    subjectId: scratchpad.subjectId,
  };
}

function proposalResponse(result: ReturnType<ReturnType<typeof getWorkGraph>["propose"]>) {
  return {
    outcome: result.outcome,
    fired_rule_id: result.firedRuleId,
    item_id: result.outcome === "applied" ? result.item?.id : undefined,
    decision_id: result.outcome === "decision" ? result.decision.id : undefined,
  };
}

function proposeWorkGraphIntent(runId: string, intent: Record<string, unknown> & {
  intentKind: Intent["intentKind"];
  confidence?: number;
  evidence_md?: string;
}) {
  const subject = workGraphProposalSubject(runId);
  if ("error" in subject) return subject;
  return proposalResponse(subject.workGraph.propose({
    ...intent,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    confidence: intent.confidence ?? 0.85,
    evidenceMd: intent.evidence_md ?? subject.scratchpad.content,
  } as Intent));
}

export function proposeReparentNode(
  runId: string,
  args: { node_id: string; parent_id: string | null; confidence?: number; evidence_md?: string },
) {
  return proposeWorkGraphIntent(runId, {
    intentKind: "reparent_node",
    nodeId: args.node_id,
    parentId: args.parent_id,
    confidence: args.confidence,
    evidence_md: args.evidence_md,
  });
}

export function proposeMergeNodes(
  runId: string,
  args: { source_node_ids: string[]; target_node_id: string; confidence?: number; evidence_md?: string },
) {
  return proposeWorkGraphIntent(runId, {
    intentKind: "merge_nodes",
    sourceNodeIds: args.source_node_ids,
    targetNodeId: args.target_node_id,
    confidence: args.confidence,
    evidence_md: args.evidence_md,
  });
}

export function proposeSplitNode(
  runId: string,
  args: { node_id: string; new_nodes?: Array<{ title: string; description?: string }>; confidence?: number; evidence_md?: string },
) {
  return proposeWorkGraphIntent(runId, {
    intentKind: "split_node",
    nodeId: args.node_id,
    newNodes: args.new_nodes,
    confidence: args.confidence,
    evidence_md: args.evidence_md,
  });
}

export function proposeLoadoutUpdate(
  runId: string,
  args: {
    scope_type: LoadoutScopeType;
    scope_id?: string | null;
    loadout_kind: LoadoutKind;
    payload: Record<string, unknown>;
    previous_payload?: Record<string, unknown> | null;
    broad_scope?: boolean;
    confidence?: number;
    evidence_md?: string;
  },
) {
  return proposeWorkGraphIntent(runId, {
    intentKind: "update_loadout",
    scopeType: args.scope_type,
    scopeId: args.scope_id ?? null,
    loadoutKind: args.loadout_kind,
    payload: args.payload,
    previousPayload: args.previous_payload,
    broadScope: args.broad_scope,
    confidence: args.confidence,
    evidence_md: args.evidence_md,
  });
}

export function proposeSyncSource(
  runId: string,
  args: { source_id?: string; external_reference_id?: string; hard_to_undo?: boolean; confidence?: number; evidence_md?: string },
) {
  return proposeWorkGraphIntent(runId, {
    intentKind: "sync_source",
    sourceId: args.source_id,
    externalReferenceId: args.external_reference_id,
    hardToUndo: args.hard_to_undo,
    confidence: args.confidence,
    evidence_md: args.evidence_md,
  });
}

export function createDecision(args: {
  kind: "clarification" | "action";
  intent_kind: Intent["intentKind"];
  subject_type: string;
  subject_id: string;
  prompt_md: string;
  recommended_intent_payload: Record<string, unknown>;
  alternatives?: Array<Record<string, unknown>>;
  confidence?: number;
  evidence_md?: string;
  default_action?: string;
  auto_apply_allowed?: boolean;
}) {
  const decision = getWorkGraph().createDecision({
    kind: args.kind,
    intentKind: args.intent_kind,
    subjectType: args.subject_type,
    subjectId: args.subject_id,
    promptMd: args.prompt_md,
    recommendedIntentPayload: args.recommended_intent_payload as unknown as Intent,
    alternatives: (args.alternatives ?? []) as unknown as Intent[],
    confidence: args.confidence ?? 0.5,
    evidenceMd: args.evidence_md ?? "",
    defaultAction: args.default_action ?? "ask",
    autoApplyAllowed: args.auto_apply_allowed ?? false,
  }, "captain");
  return { decision_id: decision.id };
}

export function answerDecision(args: {
  decision_id: string;
  action: "accept" | "reject" | "edit";
  payload?: Record<string, unknown>;
  free_text_answer?: string;
}) {
  if (args.action === "reject") return getWorkGraph().rejectDecision(args.decision_id);
  if (args.action === "edit") {
    if (!args.payload) return { error: "payload is required when editing a decision" };
    return getWorkGraph().editDecision(args.decision_id, args.payload, args.free_text_answer);
  }
  return getWorkGraph().acceptDecision(args.decision_id, {
    payload: args.payload,
    freeTextAnswer: args.free_text_answer,
  });
}

export function submitReviewBatch(args: {
  submitted_by?: string;
  answers: Array<{
    decision_id: string;
    action: "accept" | "reject" | "edit";
    payload?: Record<string, unknown>;
    free_text_answer?: string;
  }>;
}) {
  const answers = args.answers.map((answer) => {
    if (answer.action === "reject") {
      return {
        decisionId: answer.decision_id,
        action: "reject" as const,
      };
    }
    if (answer.action === "accept") {
      return {
        decisionId: answer.decision_id,
        action: "accept" as const,
        payload: answer.payload,
        freeTextAnswer: answer.free_text_answer,
      };
    }
    if (!answer.payload) throw new Error("payload is required when editing a decision");
    return {
      decisionId: answer.decision_id,
      action: "edit" as const,
      payload: answer.payload,
      freeTextAnswer: answer.free_text_answer,
    };
  });
  return getWorkGraph().submitReviewBatch({
    submittedBy: args.submitted_by,
    answers,
  });
}




// ---------------------------------------------------------------------------
// Task agent operations
// ---------------------------------------------------------------------------

export async function updateStatus(
  store: IPlannerStore,
  eventStore: IEventStore,
  runId: string,
  args: { node_id: string; status: "completed" | "failed" },
  onStatus?: (runId: string, nodeId: string, status: "completed" | "failed") => void | Promise<void>,
): Promise<{ ok: boolean } | { error: string }> {
  const { node_id, status } = args;
  const existing = store.getNodeStatus(runId, node_id);

  if (!existing) return { error: `Node not found in this run: ${node_id}` };

  const previousStatus = existing.status;
  store.updateNodeStatus(node_id, status, status === "failed");

  await emitEvent(eventStore, runId, "node_status_changed", {
    node_id,
    status,
    previous_status: previousStatus,
  });

  await onStatus?.(runId, node_id, status);
  return { ok: true };
}

export async function proposeUpdateStatus(
  store: IPlannerStore,
  eventStore: IEventStore,
  runId: string,
  args: Parameters<typeof updateStatus>[3],
  onStatus?: (runId: string, nodeId: string, status: "completed" | "failed") => void | Promise<void>,
) {
  await emitEvent(eventStore, runId, "captain_proposed", {
    intent_kind: "update_status",
    outcome: "apply",
    fired_rule_id: "default-high-confidence-apply",
    intent: args,
  }, "captain", "mcp");
  return updateStatus(store, eventStore, runId, args, onStatus);
}

export async function writeScratchpad(
  store: IPlannerStore,
  eventStore: IEventStore,
  runId: string,
  nodeId: string | undefined,
  args: {
    node_id?: string;
    subject_type?: "run_node" | "intake_item";
    subject_id?: string;
    agent_run_id?: string;
    kind?: "triage" | "executor";
    content: string;
    priority?: "fyi" | "blocking" | "scope_change";
  },
): Promise<{ scratchpad_id: string; agent_run_id?: string; kind?: "triage" | "executor" } | { error: string }> {
  if ((args.subject_type && !args.subject_id) || (!args.subject_type && args.subject_id)) {
    return { error: "Both subject_type and subject_id are required when writing a polymorphic scratchpad" };
  }
  const subjectId = args.subject_id ?? args.node_id ?? nodeId;
  if (!subjectId) return { error: "No subject_id provided and no default nodeId in context" };
  const subjectType = args.subject_type ?? "run_node";
  const kind = args.kind ?? "executor";

  const spId = `sp_${ulid()}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const sizeBytes = new TextEncoder().encode(args.content).length;

  store.insertScratchpad(spId, runId, subjectId, args.content, now, expiresAt, sizeBytes);
  if (kind === "triage" && args.agent_run_id) {
    const workGraph = getWorkGraph();
    const target = subjectType === "intake_item" ? workGraph.getIntakeItem(subjectId) : workGraph.get(subjectId);
    if (!workGraph.getLatestScratchpadByRun(args.agent_run_id) && target) {
      workGraph.writeScratchpad({
        subjectType,
        subjectId,
        agentRunId: args.agent_run_id,
        kind,
        content: args.content,
        priority: args.priority,
        actor: "triage",
      });
    }
  }
  await emitEvent(eventStore, runId, "scratchpad_written", {
    scratchpad_id: spId,
    node_id: subjectId,
    subject_type: subjectType,
    subject_id: subjectId,
    agent_run_id: args.agent_run_id,
    kind,
    priority: args.priority ?? "fyi",
    size_bytes: sizeBytes,
  });

  if (args.agent_run_id || args.kind) {
    return { scratchpad_id: spId, agent_run_id: args.agent_run_id, kind };
  }
  return { scratchpad_id: spId };
}

export async function readScratchpads(
  store: IPlannerStore,
  runId: string,
  nodeId: string | undefined,
  args: { node_id?: string },
): Promise<{ entries: Array<Record<string, any>> }> {
  if (args.node_id) {
    return { entries: store.queryScratchpads(runId, args.node_id) };
  }

  if (nodeId) {
    const own = store.queryScratchpads(runId, nodeId);
    const incoming = store.getIncomingEdges(runId, nodeId);

    const upstream: Array<Record<string, any>> = [];
    for (const { source_id } of incoming) {
      if (!store.isNodeCompleted(runId, source_id)) continue;
      upstream.push(...store.queryScratchpads(runId, source_id));
    }
    return { entries: [...own, ...upstream] };
  }

  return { entries: store.queryScratchpads(runId) };
}

export async function createArtifact(
  _store: IPlannerStore,
  eventStore: IEventStore,
  runId: string,
  nodeId: string | undefined,
  args: { node_id?: string; content: string; type: string },
): Promise<{ artifact_id: string } | { error: string }> {
  const targetNodeId = args.node_id ?? nodeId;
  if (!targetNodeId) return { error: "No node_id provided and no default nodeId in context" };

  const artifactId = `artifact_${ulid()}`;
  await emitEvent(eventStore, runId, "artifact_created", {
    artifact_id: artifactId,
    node_id: targetNodeId,
    type: args.type,
    content: args.content,
  });
  return { artifact_id: artifactId };
}

// ---------------------------------------------------------------------------
// Query operations
// ---------------------------------------------------------------------------

export async function getGraph(
  store: IPlannerStore,
  runId: string,
): Promise<{ nodes: Array<Record<string, any>>; edges: Array<Record<string, any>> }> {
  return {
    nodes: store.queryNodes(runId),
    edges: store.queryEdges(runId),
  };
}

export async function getRunStatus(store: IPlannerStore, runId: string): Promise<Record<string, any>> {
  const run = store.getRun(runId);
  if (!run) return { error: `Run not found: ${runId}` };

  const nodes = store.queryNodeStatuses(runId);

  let completed = 0,
    failed = 0,
    pending = 0,
    active = 0;
  for (const n of nodes) {
    if (n.status === "completed") completed++;
    else if (n.status === "failed") failed++;
    else if (n.status === "active" || n.status === "running") active++;
    else pending++;
  }

  return {
    phase: run.status,
    runtime_type: run.runtime_type,
    runtime_type_reason: run.runtime_type_reason ?? null,
    total_nodes: nodes.length,
    completed,
    failed,
    pending,
    active,
  };
}

export async function getRunSource(store: IPlannerStore, runId: string): Promise<Record<string, any> | null> {
  return store.getRunSource(runId);
}

export async function readLoadout(_store: IPlannerStore, args: {
  subject?: { type: "system" | "work_item" | "intake_item"; id?: string };
  kind: LoadoutKind;
}) {
  if (args.subject?.type === "work_item" && args.subject.id) {
    return getWorkGraph().resolveLoadoutSlot({ type: "work_item", id: args.subject.id }, args.kind);
  }
  if (args.subject?.type === "intake_item" && args.subject.id) {
    return getWorkGraph().resolveLoadoutSlot({ type: "intake_item", id: args.subject.id }, args.kind);
  }
  return getWorkGraph().resolveLoadoutSlot({ type: "system" }, args.kind);
}

export async function listDecisions() {
  return { decisions: [] };
}
