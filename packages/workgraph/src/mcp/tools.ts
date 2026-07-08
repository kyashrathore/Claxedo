import * as planner from "../sdk/planner";
import type { IPlannerStore } from "../sdk/planner";
import type { IEventStore } from "../substrate/event-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpToolContext {
  plannerStore: IPlannerStore;
  eventStore: IEventStore;
  runId: string;
  nodeId?: string; // set for task agents, undefined for planner
  /** Invoked (and awaited) for BOTH terminal outcomes reported via update_status. */
  onNodeStatus?: (runId: string, nodeId: string, status: "completed" | "failed") => void | Promise<void>;
}

export type McpRole = "agent" | "captain";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  roles: McpRole[];
}

// Re-export for callers that need the heuristic directly
export const inferRuntimeType = planner.inferRuntimeType;

// ---------------------------------------------------------------------------
// Tool definitions (JSON Schema format for MCP)
// ---------------------------------------------------------------------------

const createNodeSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Human-readable title for the node" },
    kind: { type: "string", description: "Node kind (e.g. code_gen, test, review, research)" },
    role: { type: "string", description: "Agent role (e.g. developer, reviewer)" },
    prompt: {
      type: "string",
      description:
        "The prompt / instructions stored as the node's scratchpad entry. Keep it at one node boundary; if the work can be decomposed or parallelized internally, say so here instead of creating microtasks.",
    },
    depends_on: {
      type: "array",
      items: { type: "string" },
      description: "Array of node_ids this node depends on",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "Confidence from 0 to 1. Defaults to 0.85; use a value below 0.8 when the proposal needs human clarification.",
    },
    runtime_type: {
      type: "string",
      enum: ["workspace", "task", "service"],
      description:
        "Execution runtime for this node. Defaults to 'workspace' for code_gen/test kinds, 'task' otherwise.",
    },
    runtime_type_reason: {
      type: "string",
      description:
        "Why this runtime_type was chosen (auto-set to 'planner-heuristic' or 'user-specified' when omitted).",
    },
    node_type: {
      type: "string",
      enum: ["task", "mission", "synthesis"],
      description:
        "Hierarchy role for the node. Use 'mission' for aggregate-only groupings and 'synthesis' for consolidation nodes.",
    },
    parent_node_id: {
      type: "string",
      description:
        "Optional parent node_id for hierarchy. This does not create an execution dependency by itself.",
    },
  },
  required: ["title", "kind", "role", "prompt"],
};

const edgeSchema = {
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
};

const removeEdgeSchema = {
  type: "object",
  properties: {
    source_id: { type: "string", description: "The upstream node" },
    target_id: { type: "string", description: "The downstream node" },
  },
  required: ["source_id", "target_id"],
};

const workGraphProposalFields = {
  confidence: {
    type: "number",
    minimum: 0,
    maximum: 1,
    description: "Confidence from 0 to 1. Defaults to 0.85.",
  },
  evidence_md: {
    type: "string",
    description: "Optional evidence summary. Defaults to the triggering scratchpad content.",
  },
};

const decisionIntentKindSchema = {
  type: "string",
  enum: [
    "add_node",
    "add_edge",
    "remove_edge",
    "update_status",
    "delete_node",
    "merge_nodes",
    "split_node",
    "reparent_node",
    "update_loadout",
    "sync_source",
  ],
};

const decisionAnswerSchema = {
  type: "object",
  properties: {
    decision_id: { type: "string", description: "The decision to resolve." },
    action: { type: "string", enum: ["accept", "reject", "edit"], description: "Resolution action." },
    payload: { type: "object", description: "Required for edit; optional override for accept." },
    free_text_answer: { type: "string", description: "Optional human explanation." },
  },
  required: ["decision_id", "action"],
};

const readRoles: McpRole[] = ["agent", "captain"];
const captainRole: McpRole[] = ["captain"];
const agentRole: McpRole[] = ["agent"];

function allToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: "propose_create_node",
      roles: captainRole,
      description:
        "Propose a new task node in the work graph. Safe proposals apply directly; risky proposals become review decisions.",
      inputSchema: createNodeSchema,
    },
    {
      name: "propose_add_edge",
      roles: captainRole,
      description:
        "Propose a dependency edge between two nodes. source must complete before target can start.",
      inputSchema: edgeSchema,
    },
    {
      name: "propose_remove_edge",
      roles: captainRole,
      description: "Propose removing a dependency edge between two nodes.",
      inputSchema: removeEdgeSchema,
    },
    {
      name: "propose_split_node",
      roles: captainRole,
      description: "Propose splitting a WorkGraph node into child tasks.",
      inputSchema: {
        type: "object",
        properties: {
          node_id: { type: "string", description: "The node to split." },
          new_nodes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                description: { type: "string" },
              },
              required: ["title"],
            },
            description: "Proposed child tasks.",
          },
          ...workGraphProposalFields,
        },
        required: ["node_id"],
      },
    },
    {
      name: "propose_merge_nodes",
      roles: captainRole,
      description: "Propose merging source nodes into a target node.",
      inputSchema: {
        type: "object",
        properties: {
          source_node_ids: { type: "array", items: { type: "string" }, description: "Nodes to merge into the target." },
          target_node_id: { type: "string", description: "The node that remains after the merge." },
          ...workGraphProposalFields,
        },
        required: ["source_node_ids", "target_node_id"],
      },
    },
    {
      name: "propose_reparent_node",
      roles: captainRole,
      description: "Propose moving a node under a different parent.",
      inputSchema: {
        type: "object",
        properties: {
          node_id: { type: "string", description: "The node to reparent." },
          parent_id: { type: ["string", "null"], description: "New parent id, or null for root." },
          ...workGraphProposalFields,
        },
        required: ["node_id", "parent_id"],
      },
    },
    {
      name: "propose_loadout_update",
      roles: captainRole,
      description: "Propose updating a WorkGraph loadout slot.",
      inputSchema: {
        type: "object",
        properties: {
          scope_type: {
            type: "string",
            enum: ["intake_item", "work_item", "mission", "repo", "role", "source_adapter", "task_kind", "system"],
          },
          scope_id: { type: ["string", "null"], description: "Scope id, or null for system scope." },
          loadout_kind: {
            type: "string",
            enum: ["triage_mode", "model", "harness", "role", "source_context", "memory_provider", "auto_policy"],
          },
          payload: { type: "object", description: "Loadout payload." },
          previous_payload: { type: ["object", "null"], description: "Optional previous payload for review context." },
          broad_scope: { type: "boolean", description: "Marks the proposal as broad-scoped/destructive." },
          ...workGraphProposalFields,
        },
        required: ["scope_type", "loadout_kind", "payload"],
      },
    },
    {
      name: "propose_sync_source",
      roles: captainRole,
      description: "Propose recording an external source sync against WorkGraph state.",
      inputSchema: {
        type: "object",
        properties: {
          source_id: { type: "string", description: "Optional WorkGraph item id affected by the sync." },
          external_reference_id: { type: "string", description: "Optional external reference id." },
          hard_to_undo: { type: "boolean", description: "Whether this sync has hard-to-undo external effects." },
          ...workGraphProposalFields,
        },
      },
    },
    {
      name: "propose_update_status",
      roles: captainRole,
      description: "Propose a node status update.",
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
      name: "create_decision",
      roles: captainRole,
      description: "Create a reviewable WorkGraph decision directly when the Captain needs human input.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["clarification", "action"] },
          intent_kind: decisionIntentKindSchema,
          subject_type: { type: "string" },
          subject_id: { type: "string" },
          prompt_md: { type: "string" },
          recommended_intent_payload: { type: "object" },
          alternatives: { type: "array", items: { type: "object" } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence_md: { type: "string" },
          default_action: { type: "string" },
          auto_apply_allowed: { type: "boolean" },
        },
        required: ["kind", "intent_kind", "subject_type", "subject_id", "prompt_md", "recommended_intent_payload"],
      },
    },
    {
      name: "answer_decision",
      roles: captainRole,
      description: "Resolve a reviewable WorkGraph decision.",
      inputSchema: decisionAnswerSchema,
    },
    {
      name: "submit_review_batch",
      roles: captainRole,
      description: "Resolve multiple reviewable WorkGraph decisions as one submitted batch.",
      inputSchema: {
        type: "object",
        properties: {
          submitted_by: { type: "string", description: "Submitting actor. Defaults to human." },
          answers: { type: "array", items: decisionAnswerSchema },
        },
        required: ["answers"],
      },
    },
    {
      name: "create_node",
      roles: captainRole,
      description:
        "Create a new task node in the work graph. Returns the generated node_id and inferred runtime_type.",
      inputSchema: createNodeSchema,
    },
    {
      name: "add_edge",
      roles: captainRole,
      description:
        "Add a dependency edge between two nodes. source must complete before target can start.",
      inputSchema: edgeSchema,
    },
    {
      name: "remove_edge",
      roles: captainRole,
      description: "Remove a dependency edge between two nodes.",
      inputSchema: removeEdgeSchema,
    },
    {
      name: "update_status",
      roles: agentRole,
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
      roles: agentRole,
      description: "Write a scratchpad entry for a WorkGraph subject. Used to pass context to the Captain and downstream agents.",
      inputSchema: {
        type: "object",
        properties: {
          subject_type: {
            type: "string",
            enum: ["run_node", "intake_item"],
            description: "Scratchpad subject type.",
          },
          subject_id: {
            type: "string",
            description: "Scratchpad subject id.",
          },
          content: { type: "string", description: "Content to write" },
          agent_run_id: {
            type: "string",
            description: "Optional upstream agent run id. One completed agent run should write at most one scratchpad.",
          },
          kind: {
            type: "string",
            enum: ["triage", "executor"],
            description: "Scratchpad kind. Defaults to executor.",
          },
          priority: {
            type: "string",
            enum: ["fyi", "blocking", "scope_change"],
            description: "Priority level (defaults to fyi)",
          },
        },
        required: ["subject_type", "subject_id", "content"],
      },
    },
    {
      name: "read_scratchpads",
      roles: readRoles,
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
      roles: agentRole,
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
      roles: readRoles,
      description: "Get the full graph (nodes and edges) for the current run.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_run_status",
      roles: readRoles,
      description: "Get the current run status including node counts by status.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_run_source",
      roles: readRoles,
      description:
        "Get the source context (kind, title, content, path) attached to the current run. Returns null if no source was attached.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "read_loadout",
      roles: readRoles,
      description: "Read the effective loadout for a subject and kind.",
      inputSchema: {
        type: "object",
        properties: {
          subject: { type: "object", description: "Loadout subject." },
          kind: { type: "string", description: "Loadout kind." },
        },
        required: ["kind"],
      },
    },
    {
      name: "list_decisions",
      roles: readRoles,
      description: "List currently visible review decisions.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];
}

export function getToolDefinitions(role?: McpRole): McpToolDefinition[] {
  const tools = allToolDefinitions();
  if (!role) return tools;
  return tools.filter((tool) => tool.roles.includes(role));
}

// ---------------------------------------------------------------------------
// Tool dispatcher — thin adapter from McpToolContext to sdk/planner
// ---------------------------------------------------------------------------

export async function handleToolCall(
  ctx: McpToolContext,
  toolName: string,
  args: Record<string, any>,
  role?: McpRole,
): Promise<any> {
  const { plannerStore, eventStore, runId, nodeId, onNodeStatus } = ctx;
  const resolvedRole = role ?? (nodeId ? "agent" : "captain");
  const definition = allToolDefinitions().find((tool) => tool.name === toolName);
  if (!definition) return { error: `Unknown tool: ${toolName}` };
  if (!definition.roles.includes(resolvedRole)) {
    const requiredRole = definition.roles[0];
    return {
      error: `Tool '${toolName}' is not available for role '${resolvedRole}'`,
      status: 403,
      code: "tool_not_in_role_surface",
      tool: toolName,
      calling_role: resolvedRole,
      required_role: requiredRole,
      hint:
        "Working agents narrate via `write_scratchpad`; the Captain mutates the graph. " +
        "If you want to propose a change, write your reasoning into the scratchpad and the Captain will pick it up.",
    };
  }

  try {
    switch (toolName) {
      case "propose_create_node":
        return planner.proposeCreateNode(plannerStore, eventStore, runId, args as Parameters<typeof planner.proposeCreateNode>[3]);
      case "propose_add_edge":
        return planner.proposeAddEdge(plannerStore, eventStore, runId, args as Parameters<typeof planner.proposeAddEdge>[3]);
      case "propose_remove_edge":
        return planner.proposeRemoveEdge(plannerStore, eventStore, runId, args as Parameters<typeof planner.proposeRemoveEdge>[3]);
      case "propose_split_node":
        return planner.proposeSplitNode(runId, args as Parameters<typeof planner.proposeSplitNode>[1]);
      case "propose_merge_nodes":
        return planner.proposeMergeNodes(runId, args as Parameters<typeof planner.proposeMergeNodes>[1]);
      case "propose_reparent_node":
        return planner.proposeReparentNode(runId, args as Parameters<typeof planner.proposeReparentNode>[1]);
      case "propose_loadout_update":
        return planner.proposeLoadoutUpdate(runId, args as Parameters<typeof planner.proposeLoadoutUpdate>[1]);
      case "propose_sync_source":
        return planner.proposeSyncSource(runId, args as Parameters<typeof planner.proposeSyncSource>[1]);
      case "propose_update_status":
        return planner.proposeUpdateStatus(
          plannerStore,
          eventStore,
          runId,
          args as Parameters<typeof planner.proposeUpdateStatus>[3],
          onNodeStatus,
        );
      case "create_decision":
        return planner.createDecision(args as Parameters<typeof planner.createDecision>[0]);
      case "answer_decision":
        return planner.answerDecision(args as Parameters<typeof planner.answerDecision>[0]);
      case "submit_review_batch":
        return planner.submitReviewBatch(args as Parameters<typeof planner.submitReviewBatch>[0]);
      case "create_node":
        return planner.createNode(plannerStore, eventStore, runId, args as Parameters<typeof planner.createNode>[3]);
      case "add_edge":
        return planner.addEdge(plannerStore, eventStore, runId, args as Parameters<typeof planner.addEdge>[3]);
      case "remove_edge":
        return planner.removeEdge(plannerStore, eventStore, runId, args as Parameters<typeof planner.removeEdge>[3]);
      case "update_status":
        return planner.updateStatus(
          plannerStore,
          eventStore,
          runId,
          args as Parameters<typeof planner.updateStatus>[3],
          onNodeStatus,
        );
      case "write_scratchpad":
        return planner.writeScratchpad(
          plannerStore,
          eventStore,
          runId,
          nodeId,
          args as Parameters<typeof planner.writeScratchpad>[4],
        );
      case "read_scratchpads":
        return planner.readScratchpads(plannerStore, runId, nodeId, args as Parameters<typeof planner.readScratchpads>[3]);
      case "create_artifact":
        return planner.createArtifact(
          plannerStore,
          eventStore,
          runId,
          nodeId,
          args as Parameters<typeof planner.createArtifact>[4],
        );
      case "get_graph":
        return planner.getGraph(plannerStore, runId);
      case "get_run_status":
        return planner.getRunStatus(plannerStore, runId);
      case "get_run_source":
        return planner.getRunSource(plannerStore, runId);
      case "read_loadout":
        return planner.readLoadout(plannerStore, args as Parameters<typeof planner.readLoadout>[1]);
      case "list_decisions":
        return planner.listDecisions();
      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}
