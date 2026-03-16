import * as planner from "../sdk/planner";
import type { IPlannerStore } from "../sdk/planner";
import type { IEventStore } from "../orchestrator/core/services/event-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpToolContext {
  plannerStore: IPlannerStore;
  eventStore: IEventStore;
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

// Re-export for callers that need the heuristic directly
export const inferRuntimeType = planner.inferRuntimeType;

// ---------------------------------------------------------------------------
// Tool definitions (JSON Schema format for MCP)
// ---------------------------------------------------------------------------

export function getToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: "create_node",
      description:
        "Create a new task node in the work graph. Returns the generated node_id and inferred runtime_type.",
      inputSchema: {
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
      description: "Signal that planning is complete and the graph is ready for execution.",
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
      description: "Write a scratchpad entry for a node. Used to pass context between nodes.",
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
      description: "Get the current run status including node counts by status.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_run_source",
      description:
        "Get the source context (kind, title, content, path) attached to the current run. Returns null if no source was attached.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tool dispatcher — thin adapter from McpToolContext to sdk/planner
// ---------------------------------------------------------------------------

export async function handleToolCall(
  ctx: McpToolContext,
  toolName: string,
  args: Record<string, any>,
): Promise<any> {
  const { plannerStore, eventStore, runId, nodeId, onPlanningComplete, onNodeCompleted } = ctx;

  try {
    switch (toolName) {
      case "create_node":
        return planner.createNode(plannerStore, eventStore, runId, args as Parameters<typeof planner.createNode>[3]);
      case "add_edge":
        return planner.addEdge(plannerStore, eventStore, runId, args as Parameters<typeof planner.addEdge>[3]);
      case "remove_edge":
        return planner.removeEdge(plannerStore, eventStore, runId, args as Parameters<typeof planner.removeEdge>[3]);
      case "validate_graph":
        return planner.validateGraph(plannerStore, runId);
      case "finish_planning":
        return planner.finishPlanning(plannerStore, eventStore, runId, args.summary, onPlanningComplete);
      case "update_status":
        return planner.updateStatus(
          plannerStore,
          eventStore,
          runId,
          args as Parameters<typeof planner.updateStatus>[3],
          onNodeCompleted,
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
      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}
