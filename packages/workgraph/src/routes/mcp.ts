import { Hono } from "hono";
import { handleToolCall, getToolDefinitions, type McpToolContext } from "../mcp/tools";
import { onPlanningComplete, onNodeStatusUpdate } from "../orchestrator/executor";

/**
 * HTTP route that exposes MCP tool calls over HTTP.
 *
 * POST /mcp/tools/call   — invoke a tool by name
 * GET  /mcp/tools/list   — list available tools
 *
 * This lets external MCP servers (e.g. claxedo-mcp) proxy tool
 * calls to the workgraph server without reimplementing tool logic.
 */
export function mcpRouter(db: any) {
  const router = new Hono();

  const port = Number(process.env.PORT) || 4100;

  async function spawnAgentViaRoute(
    prompt: string,
    runId: string,
    nodeId: string,
  ): Promise<any> {
    const res = await fetch(`http://localhost:${port}/agent/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        run_id: runId,
        node_id: nodeId || undefined,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to spawn agent: ${res.status} — ${body}`);
    }
    return res.json();
  }

  // --- GET /mcp/tools/list ---
  router.get("/mcp/tools/list", (c) => {
    return c.json({ tools: getToolDefinitions() });
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

      if (!tool_name || !run_id) {
        return c.json({ error: "tool_name and run_id are required" }, 400);
      }

      const ctx: McpToolContext = {
        db,
        runId: run_id,
        nodeId: node_id,
        onPlanningComplete: (rId: string, summary: string) => {
          onPlanningComplete(db, rId, summary, spawnAgentViaRoute);
        },
        onNodeCompleted: (rId: string, nId: string) => {
          onNodeStatusUpdate(db, rId, nId, "completed", spawnAgentViaRoute);
        },
      };

      try {
        const result = await handleToolCall(ctx, tool_name, args);
        return c.json(result);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    },
  );

  return router;
}
