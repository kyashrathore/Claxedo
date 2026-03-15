/**
 * Unit tests for each MCP tool handler.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDb } from "../../src/app";
import { handleToolCall, getToolDefinitions, inferRuntimeType, type McpToolContext } from "../../src/mcp/tools";

function makeDb() {
  const db = new Database(":memory:");
  initializeDb(db);
  db.run("INSERT INTO runs_current (run_id, goal, status) VALUES ('run_test', 'test goal', 'active')");
  return db;
}

function ctx(db: any, extra: Partial<McpToolContext> = {}): McpToolContext {
  return { db, runId: "run_test", ...extra };
}

// ---------------------------------------------------------------------------
// inferRuntimeType
// ---------------------------------------------------------------------------

describe("inferRuntimeType", () => {
  it("returns workspace for code_gen", () => expect(inferRuntimeType("code_gen")).toBe("workspace"));
  it("returns workspace for test", () => expect(inferRuntimeType("test")).toBe("workspace"));
  it("returns task for research", () => expect(inferRuntimeType("research")).toBe("task"));
  it("returns task for review", () => expect(inferRuntimeType("review")).toBe("task"));
  it("returns task for docs", () => expect(inferRuntimeType("docs")).toBe("task"));
  it("returns task for unknown kind", () => expect(inferRuntimeType("unknown_kind")).toBe("task"));
});

// ---------------------------------------------------------------------------
// getToolDefinitions
// ---------------------------------------------------------------------------

describe("getToolDefinitions", () => {
  it("returns all expected tools", () => {
    const tools = getToolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toContain("create_node");
    expect(names).toContain("add_edge");
    expect(names).toContain("remove_edge");
    expect(names).toContain("validate_graph");
    expect(names).toContain("finish_planning");
    expect(names).toContain("update_status");
    expect(names).toContain("write_scratchpad");
    expect(names).toContain("read_scratchpads");
    expect(names).toContain("create_artifact");
    expect(names).toContain("get_graph");
    expect(names).toContain("get_run_status");
    expect(names).toContain("get_run_source");
  });

  it("each tool has name, description, and inputSchema", () => {
    for (const tool of getToolDefinitions()) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(typeof tool.inputSchema).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// create_node
// ---------------------------------------------------------------------------

describe("create_node", () => {
  let db: any;
  beforeEach(() => { db = makeDb(); });

  it("creates a node and returns node_id + runtime_type", async () => {
    const result = await handleToolCall(ctx(db), "create_node", {
      title: "Build API", kind: "code_gen", role: "developer", prompt: "build it",
    });
    expect(result.node_id).toBeTruthy();
    expect(result.runtime_type).toBe("workspace");
  });

  it("infers runtime_type=task for research kind", async () => {
    const result = await handleToolCall(ctx(db), "create_node", {
      title: "Research", kind: "research", role: "developer", prompt: "research it",
    });
    expect(result.runtime_type).toBe("task");
  });

  it("stores prompt as scratchpad entry", async () => {
    const result = await handleToolCall(ctx(db), "create_node", {
      title: "Node", kind: "code_gen", role: "developer", prompt: "do something useful",
    });
    const sp = db.query("SELECT content FROM scratchpad_entries WHERE node_id = ?").get(result.node_id) as any;
    expect(sp.content).toBe("do something useful");
  });

  it("creates edges for depends_on", async () => {
    const n1 = await handleToolCall(ctx(db), "create_node", {
      title: "First", kind: "code_gen", role: "developer", prompt: "first",
    });
    const n2 = await handleToolCall(ctx(db), "create_node", {
      title: "Second", kind: "code_gen", role: "developer", prompt: "second",
      depends_on: [n1.node_id],
    });
    const edge = db.query("SELECT * FROM dependency_edges_current WHERE source_id = ? AND target_id = ?").get(n1.node_id, n2.node_id) as any;
    expect(edge).not.toBeNull();
    expect(edge.type).toBe("depends_on");
  });

  it("returns error for non-existent dependency", async () => {
    const result = await handleToolCall(ctx(db), "create_node", {
      title: "Bad", kind: "code_gen", role: "developer", prompt: "bad",
      depends_on: ["nonexistent_node"],
    });
    expect(result.error).toBeTruthy();
  });

  it("accepts explicit runtime_type override", async () => {
    const result = await handleToolCall(ctx(db), "create_node", {
      title: "Service", kind: "code_gen", role: "developer", prompt: "service",
      runtime_type: "service",
    });
    expect(result.runtime_type).toBe("service");
  });

  it("supports node_type mission", async () => {
    const result = await handleToolCall(ctx(db), "create_node", {
      title: "Group", kind: "mission", role: "pm", prompt: "group",
      node_type: "mission",
    });
    const node = db.query("SELECT node_type FROM nodes_current WHERE node_id = ?").get(result.node_id) as any;
    expect(node.node_type).toBe("mission");
  });

  it("emits node_created event", async () => {
    const result = await handleToolCall(ctx(db), "create_node", {
      title: "Event", kind: "research", role: "developer", prompt: "event",
    });
    const event = db.query("SELECT type FROM events WHERE run_id = 'run_test' AND type = 'node_created'").get() as any;
    expect(event).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// add_edge / remove_edge
// ---------------------------------------------------------------------------

describe("add_edge", () => {
  let db: any;
  beforeEach(() => { db = makeDb(); });

  it("adds an edge between two nodes", async () => {
    const n1 = await handleToolCall(ctx(db), "create_node", { title: "A", kind: "research", role: "developer", prompt: "A" });
    const n2 = await handleToolCall(ctx(db), "create_node", { title: "B", kind: "research", role: "developer", prompt: "B" });
    const result = await handleToolCall(ctx(db), "add_edge", { source_id: n1.node_id, target_id: n2.node_id });
    expect(result.edge_id).toBeTruthy();
  });

  it("returns error for non-existent source", async () => {
    const n2 = await handleToolCall(ctx(db), "create_node", { title: "B", kind: "research", role: "developer", prompt: "B" });
    const result = await handleToolCall(ctx(db), "add_edge", { source_id: "bad_id", target_id: n2.node_id });
    expect(result.error).toBeTruthy();
  });

  it("rejects cycle-creating edge", async () => {
    const n1 = await handleToolCall(ctx(db), "create_node", { title: "A", kind: "research", role: "developer", prompt: "A" });
    const n2 = await handleToolCall(ctx(db), "create_node", { title: "B", kind: "research", role: "developer", prompt: "B" });
    await handleToolCall(ctx(db), "add_edge", { source_id: n1.node_id, target_id: n2.node_id });
    const result = await handleToolCall(ctx(db), "add_edge", { source_id: n2.node_id, target_id: n1.node_id });
    expect(result.error).toContain("cycle");
  });
});

describe("remove_edge", () => {
  let db: any;
  beforeEach(() => { db = makeDb(); });

  it("removes an existing edge", async () => {
    const n1 = await handleToolCall(ctx(db), "create_node", { title: "A", kind: "research", role: "developer", prompt: "A" });
    const n2 = await handleToolCall(ctx(db), "create_node", { title: "B", kind: "research", role: "developer", prompt: "B" });
    await handleToolCall(ctx(db), "add_edge", { source_id: n1.node_id, target_id: n2.node_id });

    await handleToolCall(ctx(db), "remove_edge", { source_id: n1.node_id, target_id: n2.node_id });
    const edge = db.query("SELECT * FROM dependency_edges_current WHERE source_id = ? AND target_id = ?").get(n1.node_id, n2.node_id) as any;
    expect(edge).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validate_graph
// ---------------------------------------------------------------------------

describe("validate_graph", () => {
  let db: any;
  beforeEach(() => { db = makeDb(); });

  it("returns valid=true for a simple DAG", async () => {
    const n1 = await handleToolCall(ctx(db), "create_node", { title: "A", kind: "research", role: "developer", prompt: "A" });
    const n2 = await handleToolCall(ctx(db), "create_node", { title: "B", kind: "research", role: "developer", prompt: "B", depends_on: [n1.node_id] });
    const result = await handleToolCall(ctx(db), "validate_graph", {});
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("returns valid=true for empty graph", async () => {
    const result = await handleToolCall(ctx(db), "validate_graph", {});
    expect(result.valid).toBe(true);
  });

  it("detects cycles via injected bad edge", async () => {
    const n1 = await handleToolCall(ctx(db), "create_node", { title: "A", kind: "research", role: "developer", prompt: "A" });
    const n2 = await handleToolCall(ctx(db), "create_node", { title: "B", kind: "research", role: "developer", prompt: "B", depends_on: [n1.node_id] });
    // Force a cycle directly in DB
    db.run("INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES ('e_cycle', 'run_test', ?, ?, 'depends_on')",
      [n2.node_id, n1.node_id]);
    const result = await handleToolCall(ctx(db), "validate_graph", {});
    expect(result.valid).toBe(false);
    expect(result.issues.some((i: string) => i.toLowerCase().includes("cycle"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// finish_planning
// ---------------------------------------------------------------------------

describe("finish_planning", () => {
  let db: any;
  beforeEach(() => { db = makeDb(); });

  it("emits run_planned event", async () => {
    let planningCompleteCalled = false;
    const context: McpToolContext = {
      db,
      runId: "run_test",
      onPlanningComplete: () => { planningCompleteCalled = true; },
    };
    await handleToolCall(context, "finish_planning", { summary: "Plan done" });

    const event = db.query("SELECT type FROM events WHERE run_id = 'run_test' AND type = 'run_planned'").get() as any;
    expect(event).not.toBeNull();
    expect(planningCompleteCalled).toBe(true);
  });

  it("returns { ok: true }", async () => {
    const result = await handleToolCall(ctx(db), "finish_planning", { summary: "ready" });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// update_status
// ---------------------------------------------------------------------------

describe("update_status", () => {
  let db: any;
  beforeEach(() => { db = makeDb(); });

  it("updates node to completed", async () => {
    const n1 = await handleToolCall(ctx(db), "create_node", { title: "T", kind: "research", role: "developer", prompt: "p" });
    const result = await handleToolCall(ctx(db, { nodeId: n1.node_id }), "update_status", { node_id: n1.node_id, status: "completed" });
    expect(result.ok).toBe(true);
    const node = db.query("SELECT status FROM nodes_current WHERE node_id = ?").get(n1.node_id) as any;
    expect(node.status).toBe("completed");
  });

  it("calls onNodeCompleted callback when completed", async () => {
    let called: string | null = null;
    const n1 = await handleToolCall(ctx(db), "create_node", { title: "T", kind: "research", role: "developer", prompt: "p" });
    await handleToolCall(ctx(db, { onNodeCompleted: (_, nId) => { called = nId; } }), "update_status", { node_id: n1.node_id, status: "completed" });
    expect(called).toBe(n1.node_id);
  });

  it("returns error for unknown node", async () => {
    const result = await handleToolCall(ctx(db), "update_status", { node_id: "bad_id", status: "completed" });
    expect(result.error).toBeTruthy();
  });

  it("increments retry_count on failure", async () => {
    const n1 = await handleToolCall(ctx(db), "create_node", { title: "T", kind: "research", role: "developer", prompt: "p" });
    await handleToolCall(ctx(db), "update_status", { node_id: n1.node_id, status: "failed" });
    const node = db.query("SELECT retry_count FROM nodes_current WHERE node_id = ?").get(n1.node_id) as any;
    expect(node.retry_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// write_scratchpad / read_scratchpads
// ---------------------------------------------------------------------------

describe("write_scratchpad", () => {
  let db: any;
  beforeEach(() => { db = makeDb(); });

  it("creates a scratchpad entry", async () => {
    const n1 = await handleToolCall(ctx(db), "create_node", { title: "T", kind: "research", role: "developer", prompt: "p" });
    const result = await handleToolCall(ctx(db, { nodeId: n1.node_id }), "write_scratchpad", { content: "findings here" });
    expect(result.scratchpad_id).toBeTruthy();
  });

  it("returns error when no node_id context", async () => {
    const result = await handleToolCall(ctx(db), "write_scratchpad", { content: "no node" });
    expect(result.error).toBeTruthy();
  });

  it("stores content in DB", async () => {
    const n1 = await handleToolCall(ctx(db), "create_node", { title: "T", kind: "research", role: "developer", prompt: "p" });
    const result = await handleToolCall(ctx(db, { nodeId: n1.node_id }), "write_scratchpad", { content: "stored content" });
    const sp = db.query("SELECT content FROM scratchpad_entries WHERE id = ?").get(result.scratchpad_id) as any;
    expect(sp.content).toBe("stored content");
  });
});

describe("read_scratchpads", () => {
  let db: any;
  beforeEach(() => { db = makeDb(); });

  it("returns own entries for a node", async () => {
    const n1 = await handleToolCall(ctx(db), "create_node", { title: "T", kind: "research", role: "developer", prompt: "original prompt" });
    await handleToolCall(ctx(db, { nodeId: n1.node_id }), "write_scratchpad", { content: "new finding" });
    const result = await handleToolCall(ctx(db, { nodeId: n1.node_id }), "read_scratchpads", {});
    const contents = result.entries.map((e: any) => e.content);
    expect(contents).toContain("original prompt");
    expect(contents).toContain("new finding");
  });

  it("returns upstream completed node entries for downstream node", async () => {
    const n1 = await handleToolCall(ctx(db), "create_node", { title: "Up", kind: "research", role: "developer", prompt: "upstream prompt" });
    const n2 = await handleToolCall(ctx(db), "create_node", { title: "Down", kind: "code_gen", role: "developer", prompt: "downstream prompt", depends_on: [n1.node_id] });

    await handleToolCall(ctx(db, { nodeId: n1.node_id }), "write_scratchpad", { content: "upstream finding" });
    db.run("UPDATE nodes_current SET status = 'completed' WHERE node_id = ?", [n1.node_id]);

    const result = await handleToolCall(ctx(db, { nodeId: n2.node_id }), "read_scratchpads", {});
    const contents = result.entries.map((e: any) => e.content);
    expect(contents).toContain("upstream finding");
  });

  it("does not include upstream entries if upstream is not completed", async () => {
    const n1 = await handleToolCall(ctx(db), "create_node", { title: "Up", kind: "research", role: "developer", prompt: "up prompt" });
    const n2 = await handleToolCall(ctx(db), "create_node", { title: "Down", kind: "code_gen", role: "developer", prompt: "down prompt", depends_on: [n1.node_id] });

    await handleToolCall(ctx(db, { nodeId: n1.node_id }), "write_scratchpad", { content: "upstream secret" });
    // n1 still pending (not completed)

    const result = await handleToolCall(ctx(db, { nodeId: n2.node_id }), "read_scratchpads", {});
    const contents = result.entries.map((e: any) => e.content);
    expect(contents).not.toContain("upstream secret");
  });
});

// ---------------------------------------------------------------------------
// create_artifact
// ---------------------------------------------------------------------------

describe("create_artifact", () => {
  let db: any;
  beforeEach(() => { db = makeDb(); });

  it("creates an artifact and emits event", async () => {
    const n1 = await handleToolCall(ctx(db), "create_node", { title: "T", kind: "code_gen", role: "developer", prompt: "p" });
    const result = await handleToolCall(ctx(db, { nodeId: n1.node_id }), "create_artifact", {
      content: "const x = 1;",
      type: "file",
    });
    expect(result.artifact_id).toBeTruthy();

    const event = db.query("SELECT payload_json FROM events WHERE run_id = 'run_test' AND type = 'artifact_created'").get() as any;
    const payload = JSON.parse(event.payload_json);
    expect(payload.type).toBe("file");
    expect(payload.content).toBe("const x = 1;");
  });

  it("returns error when no node_id", async () => {
    const result = await handleToolCall(ctx(db), "create_artifact", { content: "data", type: "log" });
    expect(result.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// get_graph / get_run_status / get_run_source
// ---------------------------------------------------------------------------

describe("get_graph", () => {
  let db: any;
  beforeEach(() => { db = makeDb(); });

  it("returns nodes and edges arrays", async () => {
    const n1 = await handleToolCall(ctx(db), "create_node", { title: "A", kind: "research", role: "developer", prompt: "A" });
    const n2 = await handleToolCall(ctx(db), "create_node", { title: "B", kind: "research", role: "developer", prompt: "B", depends_on: [n1.node_id] });
    const result = await handleToolCall(ctx(db), "get_graph", {});
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
  });

  it("returns empty arrays for empty run", async () => {
    const result = await handleToolCall(ctx(db), "get_graph", {});
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});

describe("get_run_status", () => {
  let db: any;
  beforeEach(() => { db = makeDb(); });

  it("returns correct counts", async () => {
    await handleToolCall(ctx(db), "create_node", { title: "A", kind: "research", role: "developer", prompt: "A" });
    await handleToolCall(ctx(db), "create_node", { title: "B", kind: "research", role: "developer", prompt: "B" });
    const result = await handleToolCall(ctx(db), "get_run_status", {});
    expect(result.total_nodes).toBe(2);
    expect(result.pending).toBe(2);
    expect(result.completed).toBe(0);
  });

  it("returns error for non-existent run", async () => {
    const result = await handleToolCall({ db, runId: "run_nonexistent" }, "get_run_status", {});
    expect(result.error).toBeTruthy();
  });
});

describe("get_run_source", () => {
  let db: any;
  beforeEach(() => { db = makeDb(); });

  it("returns null when no source attached", async () => {
    const result = await handleToolCall(ctx(db), "get_run_source", {});
    expect(result).toBeNull();
  });

  it("returns source when attached", async () => {
    const now = new Date().toISOString();
    db.run("INSERT INTO run_sources_current (run_id, kind, title, content, source_path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["run_test", "spec", "My Spec", "Do the thing", null, now]);
    const result = await handleToolCall(ctx(db), "get_run_source", {});
    expect(result).not.toBeNull();
    expect(result.kind).toBe("spec");
    expect(result.content).toBe("Do the thing");
  });
});

// ---------------------------------------------------------------------------
// Unknown tool
// ---------------------------------------------------------------------------

describe("handleToolCall", () => {
  let db: any;
  beforeEach(() => { db = makeDb(); });

  it("returns error for unknown tool", async () => {
    const result = await handleToolCall(ctx(db), "not_a_real_tool", {});
    expect(result.error).toContain("Unknown tool");
  });
});
