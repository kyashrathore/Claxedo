import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../src/app";
import { buildPlannerPrompt } from "../src/orchestrator/planner";
import { handleToolCall, type McpToolContext } from "../src/mcp/tools";

// ---------------------------------------------------------------------------
// buildPlannerPrompt
// ---------------------------------------------------------------------------

describe("buildPlannerPrompt", () => {
  it("should include the goal in the prompt", () => {
    const prompt = buildPlannerPrompt("Build a REST API");
    expect(prompt).toContain("Build a REST API");
  });

  it("should reference MCP tool names", () => {
    const prompt = buildPlannerPrompt("anything");
    expect(prompt).toContain("create_node");
    expect(prompt).toContain("validate_graph");
    expect(prompt).toContain("finish_planning");
  });

  it("should mention roles", () => {
    const prompt = buildPlannerPrompt("anything");
    expect(prompt).toContain("role");
    expect(prompt).toContain("depends_on");
  });
});

// ---------------------------------------------------------------------------
// MCP Tools — planning flow (create_node, add_edge, validate_graph, finish_planning)
// ---------------------------------------------------------------------------

describe("MCP planning tools", () => {
  let db: InstanceType<typeof Database>;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    db.run(`
      CREATE TABLE IF NOT EXISTS scratchpad_entries (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        size_bytes INTEGER NOT NULL
      );
    `);
    const app = createApp(db);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "MCP tool test" }),
    });
    runId = (await res.json()).run_id;
  });

  function makeCtx(overrides?: Partial<McpToolContext>): McpToolContext {
    return { db, runId, ...overrides };
  }

  it("should create a node via create_node tool", async () => {
    const result = await handleToolCall(makeCtx(), "create_node", {
      title: "Setup DB",
      kind: "code_gen",
      role: "developer",
      prompt: "Create the database schema",
    });

    expect(result).toHaveProperty("node_id");
    expect(result.node_id).toMatch(/^node_/);

    // Verify in DB
    const node = db.query("SELECT * FROM nodes_current WHERE node_id = ?").get(result.node_id) as any;
    expect(node).not.toBeNull();
    expect(node.title).toBe("Setup DB");
    expect(node.kind).toBe("code_gen");
    expect(node.role).toBe("developer");
    expect(node.status).toBe("pending");
    expect(node.retry_count).toBe(0);
  });

  it("should store prompt as scratchpad entry", async () => {
    const result = await handleToolCall(makeCtx(), "create_node", {
      title: "Research",
      kind: "research",
      role: "architect",
      prompt: "Research best practices",
    });

    const sp = db.query(
      "SELECT * FROM scratchpad_entries WHERE run_id = ? AND node_id = ?"
    ).get(runId, result.node_id) as any;

    expect(sp).not.toBeNull();
    expect(sp.content).toBe("Research best practices");
  });

  it("should create dependency edges via depends_on", async () => {
    const node1 = await handleToolCall(makeCtx(), "create_node", {
      title: "First",
      kind: "research",
      role: "developer",
      prompt: "Do first",
    });
    const node2 = await handleToolCall(makeCtx(), "create_node", {
      title: "Second",
      kind: "code_gen",
      role: "developer",
      prompt: "Do second",
      depends_on: [node1.node_id],
    });

    const edges = db.query(
      "SELECT * FROM dependency_edges_current WHERE run_id = ?"
    ).all(runId) as any[];

    expect(edges).toHaveLength(1);
    expect(edges[0].source_id).toBe(node1.node_id);
    expect(edges[0].target_id).toBe(node2.node_id);
  });

  it("should reject depends_on with non-existent node", async () => {
    const result = await handleToolCall(makeCtx(), "create_node", {
      title: "Bad dep",
      kind: "code_gen",
      role: "developer",
      prompt: "Will fail",
      depends_on: ["node_nonexistent"],
    });

    expect(result).toHaveProperty("error");
    expect(result.error).toContain("not found");
  });

  it("should add edges via add_edge tool", async () => {
    const node1 = await handleToolCall(makeCtx(), "create_node", {
      title: "A", kind: "code_gen", role: "developer", prompt: "A",
    });
    const node2 = await handleToolCall(makeCtx(), "create_node", {
      title: "B", kind: "code_gen", role: "developer", prompt: "B",
    });

    const result = await handleToolCall(makeCtx(), "add_edge", {
      source_id: node1.node_id,
      target_id: node2.node_id,
    });

    expect(result).toHaveProperty("edge_id");

    const edges = db.query(
      "SELECT * FROM dependency_edges_current WHERE run_id = ?"
    ).all(runId) as any[];
    expect(edges).toHaveLength(1);
  });

  it("should detect cycles in add_edge", async () => {
    const node1 = await handleToolCall(makeCtx(), "create_node", {
      title: "A", kind: "code_gen", role: "developer", prompt: "A",
    });
    const node2 = await handleToolCall(makeCtx(), "create_node", {
      title: "B", kind: "code_gen", role: "developer", prompt: "B",
    });

    await handleToolCall(makeCtx(), "add_edge", {
      source_id: node1.node_id,
      target_id: node2.node_id,
    });

    // Reverse edge should create a cycle
    const result = await handleToolCall(makeCtx(), "add_edge", {
      source_id: node2.node_id,
      target_id: node1.node_id,
    });

    expect(result).toHaveProperty("error");
    expect(result.error).toContain("cycle");
  });

  it("should remove edges via remove_edge tool", async () => {
    const node1 = await handleToolCall(makeCtx(), "create_node", {
      title: "A", kind: "code_gen", role: "developer", prompt: "A",
    });
    const node2 = await handleToolCall(makeCtx(), "create_node", {
      title: "B", kind: "code_gen", role: "developer", prompt: "B",
    });

    await handleToolCall(makeCtx(), "add_edge", {
      source_id: node1.node_id,
      target_id: node2.node_id,
    });

    const result = await handleToolCall(makeCtx(), "remove_edge", {
      source_id: node1.node_id,
      target_id: node2.node_id,
    });

    expect(result).toEqual({ ok: true });

    const edges = db.query(
      "SELECT * FROM dependency_edges_current WHERE run_id = ?"
    ).all(runId) as any[];
    expect(edges).toHaveLength(0);
  });

  it("should validate a valid graph", async () => {
    const node1 = await handleToolCall(makeCtx(), "create_node", {
      title: "A", kind: "code_gen", role: "developer", prompt: "A",
    });
    const node2 = await handleToolCall(makeCtx(), "create_node", {
      title: "B", kind: "code_gen", role: "developer", prompt: "B",
      depends_on: [node1.node_id],
    });

    const result = await handleToolCall(makeCtx(), "validate_graph", {});
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("should detect cycles in validate_graph", async () => {
    // Manually create a cycle by inserting directly into DB
    db.run(
      "INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["n1", runId, "developer", "code_gen", "A", "pending", 0]
    );
    db.run(
      "INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["n2", runId, "developer", "code_gen", "B", "pending", 0]
    );
    db.run(
      "INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
      ["e1", runId, "n1", "n2", "depends_on"]
    );
    db.run(
      "INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
      ["e2", runId, "n2", "n1", "depends_on"]
    );

    const result = await handleToolCall(makeCtx(), "validate_graph", {});
    expect(result.valid).toBe(false);
    expect(result.issues.some((i: string) => i.includes("cycle"))).toBe(true);
  });

  it("should trigger onPlanningComplete callback via finish_planning", async () => {
    let calledWith: { runId: string; summary: string } | null = null;

    const ctx = makeCtx({
      onPlanningComplete: (rId, summary) => {
        calledWith = { runId: rId, summary };
      },
    });

    const result = await handleToolCall(ctx, "finish_planning", {
      summary: "Two-step plan: research then build",
    });

    expect(result).toEqual({ ok: true });
    expect(calledWith).not.toBeNull();
    expect(calledWith!.runId).toBe(runId);
    expect(calledWith!.summary).toBe("Two-step plan: research then build");
  });

  it("should emit events for created nodes and edges", async () => {
    await handleToolCall(makeCtx(), "create_node", {
      title: "Only task",
      kind: "research",
      role: "developer",
      prompt: "Research stuff",
    });

    const events = db.query("SELECT type FROM events WHERE run_id = ?").all(runId) as any[];
    const types = events.map((e: any) => e.type);
    expect(types).toContain("node_created");
  });

  it("should build a full graph via MCP tools (integration)", async () => {
    const ctx = makeCtx();

    // Create nodes
    const research = await handleToolCall(ctx, "create_node", {
      title: "Research APIs", kind: "research", role: "architect", prompt: "Research available APIs",
    });
    const build = await handleToolCall(ctx, "create_node", {
      title: "Build API", kind: "code_gen", role: "developer", prompt: "Build the REST API",
      depends_on: [research.node_id],
    });
    const review = await handleToolCall(ctx, "create_node", {
      title: "Review", kind: "review", role: "code_reviewer", prompt: "Review the code",
      depends_on: [build.node_id],
    });

    // Validate
    const validation = await handleToolCall(ctx, "validate_graph", {});
    expect(validation.valid).toBe(true);

    // Check DB
    const nodes = db.query("SELECT * FROM nodes_current WHERE run_id = ?").all(runId) as any[];
    expect(nodes).toHaveLength(3);
    expect(nodes.every((n: any) => n.status === "pending")).toBe(true);

    const edges = db.query("SELECT * FROM dependency_edges_current WHERE run_id = ?").all(runId) as any[];
    expect(edges).toHaveLength(2);

    // Get graph via MCP tool
    const graph = await handleToolCall(ctx, "get_graph", {});
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(2);
  });
});
