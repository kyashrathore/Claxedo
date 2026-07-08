/**
 * Register WorkGraph MCP tools on an existing McpServer instance.
 *
 * Each tool is a thin HTTP proxy to the workgraph server's
 * POST /mcp/tools/call endpoint. This keeps all tool logic in the
 * workgraph package while allowing any MCP server to expose them to agents.
 *
 * Usage:
 *   import { registerWorkGraphTools } from "@workgraph/mcp/register"
 *   registerWorkGraphTools(server, httpFn, { origin: "http://localhost:4100" })
 */

import { z } from "zod";

type McpServer = {
  registerTool: (
    name: string,
    opts: { description: string; inputSchema: Record<string, any> },
    handler: (args: any) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
  ) => void;
};

type HttpFn = <T>(path: string, init?: RequestInit, mode?: "json" | "text") => Promise<T>;

interface WorkGraphOptions {
  /** WorkGraph server origin, e.g. "http://localhost:4100" */
  origin: string;
  /** Directory header/query to forward to the workgraph server. */
  directory?: string;
  /** Tool naming mode. */
  mode?: "prefixed" | "bare" | "both";
}

/**
 * Call a workgraph MCP tool via the HTTP bridge.
 */
async function callTool(
  http: HttpFn,
  origin: string,
  toolName: string,
  runId: string,
  args: Record<string, any>,
  directory?: string,
  nodeId?: string,
  role?: "agent" | "captain",
): Promise<any> {
  const q = directory ? `?directory=${encodeURIComponent(directory)}` : "";
  const url = `${origin}/mcp/tools/call${q}`;
  const body: Record<string, any> = {
    tool_name: toolName,
    args,
    run_id: runId,
    ...(nodeId ? { node_id: nodeId } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(directory ? { "x-opencode-directory": directory } : {}),
      ...(role ? { "x-workgraph-role": role } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || `HTTP ${res.status}`);
  }
  return text.trim() ? JSON.parse(text) : null;
}

function ok(data: any): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(msg: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

export function registerWorkGraphTools(
  server: McpServer,
  http: HttpFn,
  opts: WorkGraphOptions,
) {
  const origin = opts.origin;
  const directory = opts.directory;
  const mode = opts.mode ?? "prefixed";
  const names = (name: string) =>
    mode === "both"
      ? [name, `workgraph_${name}`]
      : mode === "bare"
        ? [name]
        : [`workgraph_${name}`];
  const add = (
    name: string,
    inputSchema: Record<string, any>,
    description: string,
    handler: (args: any) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
  ) => names(name).forEach((item) => server.registerTool(item, { description, inputSchema }, handler));
  const addCaptainProxy = (
    name: string,
    inputSchema: Record<string, any>,
    description: string,
  ) => add(name, inputSchema, description, async (args) => {
    try {
      const { run_id, ...toolArgs } = args;
      const result = await callTool(http, origin, name, run_id, toolArgs, directory, undefined, "captain");
      if (result.error) return err(result.error);
      return ok(result);
    } catch (e) {
      return err((e as Error).message);
    }
  });

  const intentKind = z.enum([
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
  ]);
  const decisionAnswer = {
    decision_id: z.string().describe("The decision to resolve."),
    action: z.enum(["accept", "reject", "edit"]).describe("Resolution action."),
    payload: z.object({}).passthrough().optional().describe("Required for edit; optional override for accept."),
    free_text_answer: z.string().optional().describe("Optional human explanation."),
  };

  // ---------------------------------------------------------------------------
  // WorkGraph — Planning tools (used by planner agents)
  // ---------------------------------------------------------------------------

  add(
    "propose_create_node",
    {
        run_id: z.string().describe("The orchestration run ID."),
        title: z.string().describe("Human-readable title for the node."),
        kind: z.string().describe("Node kind (e.g. code_gen, research, review, test)."),
        role: z.string().describe("Agent role (e.g. developer, architect, reviewer)."),
        prompt: z.string().describe("Instructions stored as the node's scratchpad entry."),
        depends_on: z
          .array(z.string())
          .optional()
          .describe("Array of node_ids this node depends on."),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Confidence from 0 to 1. Defaults to 0.85; use below 0.8 when the proposal needs human clarification."),
        runtime_type: z
          .enum(["workspace", "task", "service"])
          .optional()
          .describe(
            "Execution runtime. Defaults to 'workspace' for code_gen/test kinds, 'task' otherwise.",
          ),
        runtime_type_reason: z
          .string()
          .optional()
          .describe(
            "Reason for the runtime_type choice. Auto-set to 'planner-heuristic' or 'user-specified' when omitted.",
          ),
    },
    "Propose a new task node in the WorkGraph. Safe high-confidence proposals apply directly; low-confidence " +
      "or ambiguous proposals become ReviewableDecisions. The prompt is stored as the node's scratchpad entry for the task agent.",
    async (args) => {
      try {
        const { run_id, ...toolArgs } = args;
        const result = await callTool(http, origin, "propose_create_node", run_id, toolArgs, directory, undefined, "captain");
        if (result.error) return err(result.error);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  add(
    "propose_add_edge",
    {
        run_id: z.string().describe("The orchestration run ID."),
        source_id: z.string().describe("The upstream node (dependency)."),
        target_id: z.string().describe("The downstream node (dependent)."),
    },
    "Propose a dependency edge between two WorkGraph nodes. " +
      "The source must complete before the target can start.",
    async (args) => {
      try {
        const { run_id, ...toolArgs } = args;
        const result = await callTool(http, origin, "propose_add_edge", run_id, toolArgs, directory, undefined, "captain");
        if (result.error) return err(result.error);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  add(
    "propose_remove_edge",
    {
        run_id: z.string().describe("The orchestration run ID."),
        source_id: z.string().describe("The upstream node."),
        target_id: z.string().describe("The downstream node."),
    },
    "Propose removing a dependency edge between two WorkGraph nodes.",
    async (args) => {
      try {
        const { run_id, ...toolArgs } = args;
        const result = await callTool(http, origin, "propose_remove_edge", run_id, toolArgs, directory, undefined, "captain");
        if (result.error) return err(result.error);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  add(
    "validate_graph",
    {
        run_id: z.string().describe("The orchestration run ID."),
    },
    "Validate the WorkGraph for a run: checks for cycles, orphan edges, and unreachable nodes.",
    async (args) => {
      try {
        const result = await callTool(http, origin, "validate_graph", args.run_id, {}, directory, undefined, "captain");
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  add(
    "propose_finish_planning",
    {
        run_id: z.string().describe("The orchestration run ID."),
        summary: z.string().describe("A summary of the plan that was created."),
    },
    "Propose that WorkGraph planning is complete and the graph is ready for execution. " +
      "This triggers the execution cascade — task agents will be spawned for ready nodes.",
    async (args) => {
      try {
        const { run_id, ...toolArgs } = args;
        const result = await callTool(http, origin, "propose_finish_planning", run_id, toolArgs, directory, undefined, "captain");
        if (result.error) return err(result.error);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  addCaptainProxy(
    "propose_split_node",
    {
      run_id: z.string().describe("The orchestration run ID."),
      node_id: z.string().describe("The node to split."),
      new_nodes: z.array(z.object({
        title: z.string(),
        description: z.string().optional(),
      })).optional().describe("Proposed child tasks."),
      confidence: z.number().min(0).max(1).optional().describe("Confidence from 0 to 1."),
      evidence_md: z.string().optional().describe("Optional evidence summary."),
    },
    "Propose splitting a WorkGraph node into child tasks.",
  );

  addCaptainProxy(
    "propose_merge_nodes",
    {
      run_id: z.string().describe("The orchestration run ID."),
      source_node_ids: z.array(z.string()).describe("Nodes to merge into the target."),
      target_node_id: z.string().describe("The node that remains after the merge."),
      confidence: z.number().min(0).max(1).optional().describe("Confidence from 0 to 1."),
      evidence_md: z.string().optional().describe("Optional evidence summary."),
    },
    "Propose merging source nodes into a target node.",
  );

  addCaptainProxy(
    "propose_reparent_node",
    {
      run_id: z.string().describe("The orchestration run ID."),
      node_id: z.string().describe("The node to reparent."),
      parent_id: z.string().nullable().describe("New parent id, or null for root."),
      confidence: z.number().min(0).max(1).optional().describe("Confidence from 0 to 1."),
      evidence_md: z.string().optional().describe("Optional evidence summary."),
    },
    "Propose moving a WorkGraph node under a different parent.",
  );

  addCaptainProxy(
    "propose_loadout_update",
    {
      run_id: z.string().describe("The orchestration run ID."),
      scope_type: z.enum(["intake_item", "work_item", "mission", "repo", "role", "source_adapter", "task_kind", "system"]),
      scope_id: z.string().nullable().optional().describe("Scope id, or null for system scope."),
      loadout_kind: z.enum(["triage_mode", "model", "harness", "role", "source_context", "memory_provider", "auto_policy"]),
      payload: z.object({}).passthrough().describe("Loadout payload."),
      previous_payload: z.object({}).passthrough().nullable().optional().describe("Optional previous payload for review context."),
      broad_scope: z.boolean().optional().describe("Marks the proposal as broad-scoped/destructive."),
      confidence: z.number().min(0).max(1).optional().describe("Confidence from 0 to 1."),
      evidence_md: z.string().optional().describe("Optional evidence summary."),
    },
    "Propose updating a WorkGraph loadout slot.",
  );

  addCaptainProxy(
    "propose_sync_source",
    {
      run_id: z.string().describe("The orchestration run ID."),
      source_id: z.string().optional().describe("Optional WorkGraph item id affected by the sync."),
      external_reference_id: z.string().optional().describe("Optional external reference id."),
      hard_to_undo: z.boolean().optional().describe("Whether this sync has hard-to-undo external effects."),
      confidence: z.number().min(0).max(1).optional().describe("Confidence from 0 to 1."),
      evidence_md: z.string().optional().describe("Optional evidence summary."),
    },
    "Propose recording an external source sync against WorkGraph state.",
  );

  addCaptainProxy(
    "create_decision",
    {
      run_id: z.string().describe("The orchestration run ID."),
      kind: z.enum(["clarification", "action"]),
      intent_kind: intentKind,
      subject_type: z.string(),
      subject_id: z.string(),
      prompt_md: z.string(),
      recommended_intent_payload: z.object({}).passthrough(),
      alternatives: z.array(z.object({}).passthrough()).optional(),
      confidence: z.number().min(0).max(1).optional(),
      evidence_md: z.string().optional(),
      default_action: z.string().optional(),
      auto_apply_allowed: z.boolean().optional(),
    },
    "Create a reviewable WorkGraph decision directly when the Captain needs human input.",
  );

  addCaptainProxy(
    "answer_decision",
    {
      run_id: z.string().describe("The orchestration run ID."),
      ...decisionAnswer,
    },
    "Resolve a reviewable WorkGraph decision.",
  );

  addCaptainProxy(
    "submit_review_batch",
    {
      run_id: z.string().describe("The orchestration run ID."),
      submitted_by: z.string().optional().describe("Submitting actor. Defaults to human."),
      answers: z.array(z.object(decisionAnswer)),
    },
    "Resolve multiple reviewable WorkGraph decisions as one submitted batch.",
  );

  // ---------------------------------------------------------------------------
  // WorkGraph — Task agent tools (used by executing agents)
  // ---------------------------------------------------------------------------

  add(
    "update_status",
    {
        run_id: z.string().describe("The orchestration run ID."),
        node_id: z.string().describe("The node to update."),
        status: z.enum(["completed", "failed"]).describe("New status."),
    },
    "Update a WorkGraph node's status to completed or failed. " +
      "Call this when your task is done. On completion, downstream nodes become eligible to run.",
    async (args) => {
      try {
        const { run_id, node_id, ...toolArgs } = args;
        const result = await callTool(
          http, origin, "update_status", run_id,
          { node_id, ...toolArgs }, directory, node_id, "agent",
        );
        if (result.error) return err(result.error);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  add(
    "write_scratchpad",
    {
        run_id: z.string().describe("The orchestration run ID."),
        subject_type: z.enum(["run_node", "intake_item"]).describe("Scratchpad subject type."),
        subject_id: z.string().describe("Scratchpad subject id."),
        content: z.string().describe("Content to write."),
        agent_run_id: z.string().optional().describe("Optional upstream agent run id."),
        kind: z.enum(["triage", "executor"]).optional().describe("Scratchpad kind (defaults to executor)."),
        priority: z
          .enum(["fyi", "blocking", "scope_change"])
          .optional()
          .describe("Priority level (defaults to fyi)."),
    },
    "Write a scratchpad entry for a WorkGraph subject. " +
      "Use this to pass context, findings, or results to the Captain and downstream agents.",
    async (args) => {
      try {
        const { run_id, subject_id, ...toolArgs } = args;
        const result = await callTool(
          http, origin, "write_scratchpad", run_id, { subject_id, ...toolArgs }, directory, subject_id, "agent",
        );
        if (result.error) return err(result.error);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  add(
    "read_scratchpads",
    {
        run_id: z.string().describe("The orchestration run ID."),
        node_id: z.string().optional().describe("Node to read scratchpads for (optional)."),
    },
    "Read WorkGraph scratchpad entries. Returns the node's own scratchpad plus " +
      "scratchpads from completed upstream dependencies. Use this to get context from prior tasks.",
    async (args) => {
      try {
        const { run_id, node_id, ...toolArgs } = args;
        const result = await callTool(
          http, origin, "read_scratchpads", run_id, toolArgs, directory, node_id, node_id ? "agent" : "captain",
        );
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  add(
    "create_artifact",
    {
        run_id: z.string().describe("The orchestration run ID."),
        node_id: z.string().optional().describe("Owning node (defaults to caller's node)."),
        content: z.string().describe("Artifact content."),
        type: z.string().describe("Artifact type (e.g. file, diff, log)."),
    },
    "Create an artifact associated with a WorkGraph node (e.g. generated code, diff, log).",
    async (args) => {
      try {
        const { run_id, node_id, ...toolArgs } = args;
        const result = await callTool(
          http, origin, "create_artifact", run_id, toolArgs, directory, node_id, "agent",
        );
        if (result.error) return err(result.error);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // WorkGraph — Query tools (used by any agent)
  // ---------------------------------------------------------------------------

  add(
    "get_graph",
    {
        run_id: z.string().describe("The orchestration run ID."),
    },
    "Get the full WorkGraph (all nodes and edges) for a run.",
    async (args) => {
      try {
        const result = await callTool(http, origin, "get_graph", args.run_id, {}, directory);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  add(
    "get_run_status",
    {
        run_id: z.string().describe("The orchestration run ID."),
    },
    "Get the current WorkGraph run status including phase and node counts by status " +
      "(pending, active, completed, failed).",
    async (args) => {
      try {
        const result = await callTool(http, origin, "get_run_status", args.run_id, {}, directory);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  add(
    "read_loadout",
    {
        run_id: z.string().describe("The orchestration run ID."),
        subject: z.object({ type: z.string(), id: z.string().optional() }).optional().describe("Loadout subject."),
        kind: z.string().describe("Loadout kind."),
    },
    "Read the effective WorkGraph loadout for a subject and kind.",
    async (args) => {
      try {
        const { run_id, ...toolArgs } = args;
        const result = await callTool(http, origin, "read_loadout", run_id, toolArgs, directory);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  add(
    "list_decisions",
    {
        run_id: z.string().describe("The orchestration run ID."),
    },
    "List WorkGraph decisions visible to this run.",
    async (args) => {
      try {
        const result = await callTool(http, origin, "list_decisions", args.run_id, {}, directory);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );
}
