import { Hono } from "hono";
import { handleToolCall, getToolDefinitions, type McpRole, type McpToolContext } from "../mcp/tools";
import { onAttemptStatusUpdate } from "../sdk/attempts";
import { openSqlitePlannerStore } from "../sdk/planner";
import { dir } from "../dir";
import type { ExecutionAdapter } from "../execution";
import type { IExecutionStore } from "../sdk/execution-store";
import type { IEventStore } from "../substrate/event-store";
import { sqlite, type SqliteInput } from "../sqlite";

/**
 * HTTP route that exposes MCP tool calls over HTTP.
 *
 * POST /mcp/tools/call   — invoke a tool by name
 * GET  /mcp/tools/list   — list available tools
 *
 * This lets external MCP servers proxy tool calls to the workgraph server
 * without reimplementing tool logic.
 */
function launch(c: any, execution?: ExecutionAdapter) {
  const cwd = dir(c.req.query("directory") || c.req.header("x-opencode-directory"));
  if (!execution) {
    return async () => {
      throw new Error(`Execution adapter is not configured for ${cwd ?? process.cwd()}`)
    }
  }
  return (
    prompt: string,
    runId: string,
    nodeId: string,
    meta?: {
      role?: string;
      kind?: string;
      title?: string;
      directory?: string;
    },
  ) =>
    execution.launch({
      run_id: runId,
      node_id: nodeId,
      prompt,
      role: meta?.role ?? "developer",
      kind: meta?.kind ?? "task",
      title: meta?.title ?? nodeId,
      directory: meta?.directory ?? cwd,
    });
}

export function mcpRouter(input: SqliteInput, executionStore: IExecutionStore, eventStore: IEventStore, execution?: ExecutionAdapter) {
  const db = sqlite(input);
  const plannerStore = openSqlitePlannerStore(db);
  const router = new Hono();

  // --- GET /mcp/tools/list ---
  router.get("/mcp/tools/list", (c) => {
    const role = roleFromHeader(c.req.header("x-workgraph-role"));
    return c.json({ tools: getToolDefinitions(role) });
  });

  // --- POST /mcp/tools/call ---
  router.post(
    "/mcp/tools/call",
    async (c) => {
      const body = await c.req.json();
      const tool_name = body.tool_name as string;
      const args = body.args ?? {};
      const run_id = body.run_id as string;
      const node_id = body.node_id as string | undefined;
      const call = launch(c, execution);
      const role = roleFromHeader(c.req.header("x-workgraph-role")) ?? (node_id ? "agent" : "captain");

      if (!tool_name || !run_id) {
        return c.json({ error: "tool_name and run_id are required" }, 400);
      }

      const ctx: McpToolContext = {
        plannerStore,
        eventStore,
        runId: run_id,
        nodeId: node_id,
        onNodeStatus: (rId: string, nId: string, status: "completed" | "failed") =>
          onAttemptStatusUpdate(executionStore, rId, nId, status, call),
      };

      try {
        // v1 trusts this route header because WorkGraph is single-tenant behind the product control plane.
        // Signed role claims are deferred until the route is exposed behind an untrusted proxy.
        const result = await handleToolCall(ctx, tool_name, args, role);
        if (result?.status === 403) return c.json(result, 403);
        return c.json(result);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    },
  );

  return router;
}

function roleFromHeader(value: string | undefined): McpRole | undefined {
  return value === "agent" || value === "captain" ? value : undefined;
}
