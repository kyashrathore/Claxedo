import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../src/app";

describe("MCP HTTP route", () => {
  let db: InstanceType<typeof Database>;
  let app: ReturnType<typeof createApp>;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    db.run(`
      CREATE TABLE IF NOT EXISTS scratchpad_entries (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
        content TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        size_bytes INTEGER NOT NULL
      );
    `);
    app = createApp(db);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "MCP route test" }),
    });
    runId = (await res.json()).run_id;
  });

  it("GET /mcp/tools/list should return tool definitions", async () => {
    const res = await app.request("/mcp/tools/list");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tools).toBeArray();
    expect(body.tools.length).toBeGreaterThan(0);
    const names = body.tools.map((t: any) => t.name);
    expect(names).toContain("create_node");
    expect(names).toContain("finish_planning");
    expect(names).toContain("update_status");
  });

  it("POST /mcp/tools/call should invoke create_node", async () => {
    const res = await app.request("/mcp/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool_name: "create_node",
        run_id: runId,
        args: {
          title: "Test node",
          kind: "code_gen",
          role: "developer",
          prompt: "Do the thing",
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.node_id).toMatch(/^node_/);

    // Verify in DB
    const node = db.query("SELECT * FROM nodes_current WHERE node_id = ?").get(body.node_id) as any;
    expect(node).not.toBeNull();
    expect(node.title).toBe("Test node");
  });

  it("POST /mcp/tools/call should invoke get_graph", async () => {
    // Create a node first
    await app.request("/mcp/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool_name: "create_node",
        run_id: runId,
        args: { title: "A", kind: "code_gen", role: "developer", prompt: "A" },
      }),
    });

    const res = await app.request("/mcp/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool_name: "get_graph",
        run_id: runId,
        args: {},
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toHaveLength(1);
  });

  it("POST /mcp/tools/call should return error for unknown tool", async () => {
    const res = await app.request("/mcp/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool_name: "nonexistent_tool",
        run_id: runId,
        args: {},
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toContain("Unknown tool");
  });

  it("POST /mcp/tools/call should pass node_id for task agent tools", async () => {
    // Create a node
    const createRes = await app.request("/mcp/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool_name: "create_node",
        run_id: runId,
        args: { title: "Writer", kind: "code_gen", role: "developer", prompt: "Write code" },
      }),
    });
    const { node_id } = await createRes.json();

    // Write scratchpad with node_id context
    const spRes = await app.request("/mcp/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool_name: "write_scratchpad",
        run_id: runId,
        node_id: node_id,
        args: { content: "My findings" },
      }),
    });
    expect(spRes.status).toBe(200);
    const spBody = await spRes.json();
    expect(spBody.scratchpad_id).toMatch(/^sp_/);
  });
});
