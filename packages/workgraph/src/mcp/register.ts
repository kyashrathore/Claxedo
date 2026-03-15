/**
 * Register WorkGraph MCP tools on an existing McpServer instance.
 *
 * Each tool is a thin HTTP proxy to the workgraph server's
 * POST /mcp/tools/call endpoint. This keeps all tool logic in the
 * workgraph package while allowing any MCP server (e.g. claxedo-mcp)
 * to expose them to agents.
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

  // ---------------------------------------------------------------------------
  // WorkGraph — Planning tools (used by planner agents)
  // ---------------------------------------------------------------------------

  add(
    "create_node",
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
    "Create a new task node in the WorkGraph. Returns the generated node_id and runtime_type. " +
      "The prompt is stored as the node's scratchpad entry for the task agent.",
    async (args) => {
      try {
        const { run_id, ...toolArgs } = args;
        const result = await callTool(http, origin, "create_node", run_id, toolArgs, directory);
        if (result.error) return err(result.error);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  add(
    "add_edge",
    {
        run_id: z.string().describe("The orchestration run ID."),
        source_id: z.string().describe("The upstream node (dependency)."),
        target_id: z.string().describe("The downstream node (dependent)."),
    },
    "Add a dependency edge between two WorkGraph nodes. " +
      "The source must complete before the target can start.",
    async (args) => {
      try {
        const { run_id, ...toolArgs } = args;
        const result = await callTool(http, origin, "add_edge", run_id, toolArgs, directory);
        if (result.error) return err(result.error);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  add(
    "remove_edge",
    {
        run_id: z.string().describe("The orchestration run ID."),
        source_id: z.string().describe("The upstream node."),
        target_id: z.string().describe("The downstream node."),
    },
    "Remove a dependency edge between two WorkGraph nodes.",
    async (args) => {
      try {
        const { run_id, ...toolArgs } = args;
        const result = await callTool(http, origin, "remove_edge", run_id, toolArgs, directory);
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
        const result = await callTool(http, origin, "validate_graph", args.run_id, {}, directory);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  add(
    "finish_planning",
    {
        run_id: z.string().describe("The orchestration run ID."),
        summary: z.string().describe("A summary of the plan that was created."),
    },
    "Signal that WorkGraph planning is complete and the graph is ready for execution. " +
      "This triggers the execution cascade — task agents will be spawned for ready nodes.",
    async (args) => {
      try {
        const { run_id, ...toolArgs } = args;
        const result = await callTool(http, origin, "finish_planning", run_id, toolArgs, directory);
        if (result.error) return err(result.error);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
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
          { node_id, ...toolArgs }, directory, node_id,
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
        node_id: z.string().optional().describe("Target node (defaults to caller's node)."),
        content: z.string().describe("Content to write."),
        priority: z
          .enum(["fyi", "blocking", "scope_change"])
          .optional()
          .describe("Priority level (defaults to fyi)."),
    },
    "Write a scratchpad entry for a WorkGraph node. " +
      "Use this to pass context, findings, or results to downstream task agents.",
    async (args) => {
      try {
        const { run_id, node_id, ...toolArgs } = args;
        const result = await callTool(
          http, origin, "write_scratchpad", run_id, toolArgs, directory, node_id,
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
          http, origin, "read_scratchpads", run_id, toolArgs, directory, node_id,
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
          http, origin, "create_artifact", run_id, toolArgs, directory, node_id,
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
}
