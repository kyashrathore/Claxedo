import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../src/app";
import type { Hono } from "hono";
import { buildPlannerPrompt, parsePlannerOutput } from "../src/orchestrator/planner";
import { buildGraphFromPlan } from "../src/orchestrator/graph-builder";
import { executionTick } from "../src/orchestrator/executor";
import type { OrchestratorRunState, NodeAgentHistory, DecompositionPlan } from "../src/orchestrator/types";

// ── Planner Tests ──

describe("buildPlannerPrompt", () => {
  it("should include the goal in the prompt", () => {
    const prompt = buildPlannerPrompt("Build a REST API");
    expect(prompt).toContain("Build a REST API");
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("teams");
    expect(prompt).toContain("tasks");
    expect(prompt).toContain("depends_on");
  });
});

describe("parsePlannerOutput", () => {
  it("should parse valid JSON output", () => {
    const json = JSON.stringify({
      teams: [{ id: "t1", name: "Backend" }],
      tasks: [
        { id: "task1", title: "Setup", kind: "code_gen", team: "t1", prompt: "Setup project", depends_on: [] },
        { id: "task2", title: "API", kind: "code_gen", team: "t1", prompt: "Build API", depends_on: ["task1"] },
      ],
      summary: "Two-step plan",
    });

    // Wrap in stream-json result format
    const output = JSON.stringify({ type: "result", result: json });
    const plan = parsePlannerOutput(output);

    expect(plan.teams).toHaveLength(1);
    expect(plan.teams[0].name).toBe("Backend");
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[1].depends_on).toEqual(["task1"]);
    expect(plan.summary).toBe("Two-step plan");
  });

  it("should handle fenced code blocks", () => {
    const json = JSON.stringify({
      teams: [{ id: "t1", name: "Team" }],
      tasks: [{ id: "task1", title: "Do thing", kind: "research", team: "t1", prompt: "Research", depends_on: [] }],
      summary: "Simple",
    });

    const output = "```json\n" + json + "\n```";
    const plan = parsePlannerOutput(output);
    expect(plan.tasks).toHaveLength(1);
  });

  it("should detect cycles", () => {
    const json = JSON.stringify({
      teams: [{ id: "t1", name: "Team" }],
      tasks: [
        { id: "task1", title: "A", kind: "code_gen", team: "t1", prompt: "A", depends_on: ["task2"] },
        { id: "task2", title: "B", kind: "code_gen", team: "t1", prompt: "B", depends_on: ["task1"] },
      ],
      summary: "Cyclic",
    });

    expect(() => parsePlannerOutput(json)).toThrow("Cycle detected");
  });

  it("should throw on empty output", () => {
    expect(() => parsePlannerOutput("")).toThrow("no output");
  });

  it("should throw on invalid JSON", () => {
    expect(() => parsePlannerOutput("not json at all")).toThrow();
  });

  it("should throw on missing teams/tasks", () => {
    const output = JSON.stringify({ foo: "bar" });
    expect(() => parsePlannerOutput(output)).toThrow("missing");
  });
});

// ── Graph Builder Tests ──

describe("buildGraphFromPlan", () => {
  let db: InstanceType<typeof Database>;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    const app = createApp(db);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Graph builder test" }),
    });
    runId = (await res.json()).run_id;
  });

  it("should create teams, nodes, edges, and messages from plan", () => {
    const plan: DecompositionPlan = {
      teams: [{ id: "t1", name: "Alpha" }],
      tasks: [
        { id: "task1", title: "Research", kind: "research", team: "t1", prompt: "Do research", depends_on: [] },
        { id: "task2", title: "Code", kind: "code_gen", team: "t1", prompt: "Write code", depends_on: ["task1"] },
      ],
      summary: "Research then code",
    };

    const result = buildGraphFromPlan(db, runId, plan);

    // Teams created
    const teams = db.query("SELECT * FROM teams_current WHERE run_id = ?").all(runId) as any[];
    expect(teams).toHaveLength(1);
    expect(teams[0].name).toBe("Alpha");
    expect(result.teamIdMap.get("t1")).toBe(teams[0].team_id);

    // Nodes created
    const nodes = db.query("SELECT * FROM nodes_current WHERE run_id = ?").all(runId) as any[];
    expect(nodes).toHaveLength(2);
    expect(nodes[0].status).toBe("pending");
    expect(nodes[0].retry_count).toBe(0);

    // Edges created
    const edges = db.query("SELECT * FROM dependency_edges_current WHERE run_id = ?").all(runId) as any[];
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe("depends_on");

    // Verify edge direction: task1 → task2 (task2 depends on task1)
    const task1NodeId = result.taskNodeMap.get("task1")!;
    const task2NodeId = result.taskNodeMap.get("task2")!;
    expect(edges[0].source_id).toBe(task1NodeId);
    expect(edges[0].target_id).toBe(task2NodeId);

    // Messages (node_metadata) created
    const messages = db.query("SELECT * FROM messages_current WHERE run_id = ? AND message_type = 'node_metadata'").all(runId) as any[];
    expect(messages).toHaveLength(2);
  });

  it("should throw if task references unknown team", () => {
    const plan: DecompositionPlan = {
      teams: [{ id: "t1", name: "Only Team" }],
      tasks: [
        { id: "task1", title: "Bad ref", kind: "code_gen", team: "t_nonexistent", prompt: "Fail", depends_on: [] },
      ],
      summary: "Should fail",
    };

    expect(() => buildGraphFromPlan(db, runId, plan)).toThrow("unknown team");
  });

  it("should handle multiple teams", () => {
    const plan: DecompositionPlan = {
      teams: [
        { id: "t1", name: "Frontend" },
        { id: "t2", name: "Backend" },
      ],
      tasks: [
        { id: "task1", title: "UI", kind: "code_gen", team: "t1", prompt: "Build UI", depends_on: [] },
        { id: "task2", title: "API", kind: "code_gen", team: "t2", prompt: "Build API", depends_on: [] },
        { id: "task3", title: "Integrate", kind: "review", team: "t1", prompt: "Integrate", depends_on: ["task1", "task2"] },
      ],
      summary: "Parallel teams",
    };

    const result = buildGraphFromPlan(db, runId, plan);
    expect(result.teamIdMap.size).toBe(2);
    expect(result.taskNodeMap.size).toBe(3);

    const edges = db.query("SELECT * FROM dependency_edges_current WHERE run_id = ?").all(runId) as any[];
    expect(edges).toHaveLength(2);
  });

  it("should emit events for all created entities", () => {
    const plan: DecompositionPlan = {
      teams: [{ id: "t1", name: "Solo" }],
      tasks: [
        { id: "task1", title: "Only task", kind: "research", team: "t1", prompt: "Research stuff", depends_on: [] },
      ],
      summary: "One task",
    };

    buildGraphFromPlan(db, runId, plan);

    // Events: run_created (from beforeEach) + team_created + node_created + message_posted
    const events = db.query("SELECT type FROM events WHERE run_id = ?").all(runId) as any[];
    const types = events.map((e: any) => e.type);
    expect(types).toContain("team_created");
    expect(types).toContain("node_created");
    expect(types).toContain("message_posted");
  });
});

// ── Execution Tick Tests ──

describe("executionTick", () => {
  let db: InstanceType<typeof Database>;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    const app = createApp(db);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Executor test" }),
    });
    runId = (await res.json()).run_id;
  });

  function makeState(overrides?: Partial<OrchestratorRunState>): OrchestratorRunState {
    return {
      run_id: runId,
      phase: "executing",
      planner_agent_id: null,
      plan: null,
      task_node_map: new Map(),
      team_id_map: new Map(),
      node_agents: new Map(),
      interval: null,
      error: null,
      created_at: new Date().toISOString(),
      result: null,
      node_work_items: new Map(),
      ...overrides,
    };
  }

  function makeNodeAgentHistory(agentId: string): NodeAgentHistory {
    return {
      current_agent_id: agentId,
      history: [{
        agent_id: agentId,
        status: "running",
        started_at: new Date().toISOString(),
        finished_at: null,
      }],
    };
  }

  it("should spawn agents for ready nodes", async () => {
    // Create team and nodes directly
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "pending", 0]);

    const spawnedAgents: any[] = [];
    const mockSpawn = async (prompt: string, rId: string, nId: string) => {
      const agent = { id: `agent_${spawnedAgents.length + 1}`, status: "running", prompt, run_id: rId, node_id: nId };
      spawnedAgents.push(agent);
      return agent as any;
    };
    const mockGetAgent = (id: string) => spawnedAgents.find((a) => a.id === id);

    const plan: DecompositionPlan = {
      teams: [{ id: "t1", name: "Test" }],
      tasks: [{ id: "task1", title: "Task 1", kind: "code_gen", team: "t1", prompt: "Do code", depends_on: [] }],
      summary: "",
    };

    const state = makeState({
      plan,
      task_node_map: new Map([["task1", "node_1"]]),
    });

    await executionTick(db, state, mockSpawn, mockGetAgent);

    // Node should be active now
    const node = db.query("SELECT status FROM nodes_current WHERE node_id = 'node_1'").get() as any;
    expect(node.status).toBe("active");

    // Agent should have been spawned
    expect(spawnedAgents).toHaveLength(1);
    const history = state.node_agents.get("node_1");
    expect(history?.current_agent_id).toBe("agent_1");
    expect(history?.history).toHaveLength(1);
    expect(history?.history[0].status).toBe("running");
  });

  it("should not spawn for nodes with unmet dependencies", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "pending", 0]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_2", runId, "team_1", "review", "pending", 0]);
    db.run("INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)", ["edge_1", runId, "node_1", "node_2", "depends_on"]);

    const spawnedAgents: any[] = [];
    const mockSpawn = async (prompt: string, rId: string, nId: string) => {
      const agent = { id: `agent_${spawnedAgents.length + 1}`, status: "running" };
      spawnedAgents.push(agent);
      return agent as any;
    };
    const mockGetAgent = (id: string) => spawnedAgents.find((a) => a.id === id);

    const plan: DecompositionPlan = {
      teams: [{ id: "t1", name: "Test" }],
      tasks: [
        { id: "task1", title: "A", kind: "code_gen", team: "t1", prompt: "Do A", depends_on: [] },
        { id: "task2", title: "B", kind: "review", team: "t1", prompt: "Do B", depends_on: ["task1"] },
      ],
      summary: "",
    };

    const state = makeState({
      plan,
      task_node_map: new Map([["task1", "node_1"], ["task2", "node_2"]]),
    });

    await executionTick(db, state, mockSpawn, mockGetAgent);

    // Only node_1 should be active (node_2 has unmet dep)
    expect(spawnedAgents).toHaveLength(1);
    const node1 = db.query("SELECT status FROM nodes_current WHERE node_id = 'node_1'").get() as any;
    const node2 = db.query("SELECT status FROM nodes_current WHERE node_id = 'node_2'").get() as any;
    expect(node1.status).toBe("active");
    expect(node2.status).toBe("pending");
  });

  it("should mark run completed when all nodes are done", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "completed", 0]);

    const state = makeState();
    await executionTick(db, state, async () => ({} as any), () => undefined);

    expect(state.phase).toBe("completed");
    const run = db.query("SELECT status FROM runs_current WHERE run_id = ?").get(runId) as any;
    expect(run.status).toBe("completed");
  });

  it("should reconcile completed agents to completed nodes", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "active", 0]);

    const mockAgent = { id: "agent_1", status: "completed" as const, exit_code: 0, output_chunks: ["Task done successfully"] };
    const state = makeState({
      node_agents: new Map([["node_1", makeNodeAgentHistory("agent_1")]]),
    });

    await executionTick(db, state, async () => ({} as any), () => mockAgent as any);

    const node = db.query("SELECT status FROM nodes_current WHERE node_id = 'node_1'").get() as any;
    expect(node.status).toBe("completed");

    // Agent history should be updated (Gap 4)
    const history = state.node_agents.get("node_1");
    expect(history?.current_agent_id).toBeNull();
    expect(history?.history[0].status).toBe("completed");
    expect(history?.history[0].finished_at).not.toBeNull();
  });

  it("should retry failed nodes up to MAX_RETRIES", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "active", 0]);

    const mockAgent = { id: "agent_1", status: "failed" as const, exit_code: 1, output_chunks: ["error output"] };
    const spawnedAgents: any[] = [];
    const state = makeState({
      node_agents: new Map([["node_1", makeNodeAgentHistory("agent_1")]]),
    });

    // After reconciliation, the tick will also try to spawn for ready nodes.
    // The spawn step will re-activate the retried node, so we verify retry_count was incremented.
    await executionTick(
      db,
      state,
      async (prompt, rId, nId) => {
        const agent = { id: `agent_new_${spawnedAgents.length}`, status: "running" };
        spawnedAgents.push(agent);
        return agent as any;
      },
      (id) => {
        if (id === "agent_1") return mockAgent as any;
        return spawnedAgents.find((a) => a.id === id);
      }
    );

    // retry_count should have been incremented to 1 (may be re-activated by spawn step)
    const node = db.query("SELECT status, retry_count FROM nodes_current WHERE node_id = 'node_1'").get() as any;
    expect(node.retry_count).toBe(1);
    // A new agent should have been spawned for the retry
    expect(spawnedAgents.length).toBe(1);
    // Agent history should track the failed attempt (Gap 4)
    const history = state.node_agents.get("node_1");
    expect(history?.history.length).toBeGreaterThanOrEqual(1);
    expect(history?.history[0].status).toBe("failed");
  });

  it("should mark node as failed after max retries", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "active", 2]);

    const mockAgent = { id: "agent_1", status: "failed" as const, exit_code: 1, output_chunks: [] };
    const state = makeState({
      node_agents: new Map([["node_1", makeNodeAgentHistory("agent_1")]]),
    });

    await executionTick(db, state, async () => ({} as any), () => mockAgent as any);

    const node = db.query("SELECT status FROM nodes_current WHERE node_id = 'node_1'").get() as any;
    expect(node.status).toBe("failed");
  });

  it("should skip tick if phase is not executing", async () => {
    const state = makeState({ phase: "completed" });

    const spawnCalled = { value: false };
    await executionTick(
      db,
      state,
      async () => { spawnCalled.value = true; return {} as any; },
      () => undefined
    );

    expect(spawnCalled.value).toBe(false);
  });
});

// ── Orchestrate Route Tests ──

describe("POST /orchestrate", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

  it("should create a run and return 201 with phase", async () => {
    const res = await app.request("/orchestrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Build a todo app" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body).toHaveProperty("run_id");
    expect(body.goal).toBe("Build a todo app");
    expect(body.status).toBe("active");
    expect(body.phase).toBe("planning");
  });

  it("should return 400 for empty goal", async () => {
    const res = await app.request("/orchestrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "" }),
    });

    expect(res.status).toBe(400);
  });

  it("should create the run in runs_current", async () => {
    const res = await app.request("/orchestrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Test run creation" }),
    });
    const body = await res.json();

    const run = db.query("SELECT * FROM runs_current WHERE run_id = ?").get(body.run_id) as any;
    expect(run).not.toBeNull();
    expect(run.goal).toBe("Test run creation");
    expect(run.status).toBe("active");
  });
});

describe("GET /orchestrate", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

  it("should list orchestrations", async () => {
    const res = await app.request("/orchestrate");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// ── ACP Endpoint Tests ──

describe("GET /acp/agents", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

  it("should list available agents", async () => {
    const res = await app.request("/acp/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    const names = body.map((a: any) => a.name);
    expect(names).toContain("orchestrator");
    expect(names).toContain("direct");
  });
});

describe("GET /acp/agents/:agent_id", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

  it("should return agent descriptor", async () => {
    const res = await app.request("/acp/agents/orchestrator");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("orchestrator");
    expect(body.capabilities).toBeDefined();
    expect(body.capabilities.streaming).toBe(true);
  });

  it("should return 404 for unknown agent", async () => {
    const res = await app.request("/acp/agents/unknown");
    expect(res.status).toBe(404);
  });
});

describe("POST /acp/agents/:agent_id/runs", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

  it("should create a run with ACP message format", async () => {
    const res = await app.request("/acp/agents/orchestrator/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            parts: [{ content_type: "text/plain", content: "Build a todo app" }],
          },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^run_/);
    expect(body.agent_id).toBe("orchestrator");
    expect(body.status).toBe("in-progress");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
  });

  it("should return 404 for unknown agent type", async () => {
    const res = await app.request("/acp/agents/unknown/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", parts: [{ content_type: "text/plain", content: "test" }] },
        ],
      }),
    });

    expect(res.status).toBe(404);
  });

  it("should return 400 for missing user message", async () => {
    const res = await app.request("/acp/agents/orchestrator/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "agent", parts: [{ content_type: "text/plain", content: "no user msg" }] },
        ],
      }),
    });

    expect(res.status).toBe(400);
  });

  it("should store the run in the database", async () => {
    const res = await app.request("/acp/agents/orchestrator/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", parts: [{ content_type: "text/plain", content: "Setup DB" }] },
        ],
      }),
    });

    const body = await res.json();
    const run = db.query("SELECT * FROM runs_current WHERE run_id = ?").get(body.id) as any;
    expect(run).not.toBeNull();
    expect(run.goal).toBe("Setup DB");
    expect(run.status).toBe("active");
  });
});

describe("GET /acp/agents/:agent_id/runs/:run_id", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

  it("should return run status in ACP format", async () => {
    // Create a run first via ACP
    const createRes = await app.request("/acp/agents/orchestrator/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", parts: [{ content_type: "text/plain", content: "My goal" }] },
        ],
      }),
    });
    const createBody = await createRes.json();

    const res = await app.request(`/acp/agents/orchestrator/runs/${createBody.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(createBody.id);
    expect(body.agent_id).toBe("orchestrator");
    expect(body.messages).toBeDefined();
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].parts[0].content).toBe("My goal");
  });

  it("should return 404 for non-existent run", async () => {
    const res = await app.request("/acp/agents/orchestrator/runs/run_nonexistent");
    expect(res.status).toBe(404);
  });
});

// ── Node title tests ──

describe("nodes_current title column", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

  it("should store title when creating a node via API", async () => {
    // Create a run first
    const runRes = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "test" }),
    });
    const run = await runRes.json();

    // Create a team
    const teamRes = await app.request(`/runs/${run.run_id}/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Team" }),
    });
    const team = await teamRes.json();

    // Create a node with title
    const nodeRes = await app.request(`/runs/${run.run_id}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "code_gen", team_id: team.team_id, title: "Setup DB Schema" }),
    });

    expect(nodeRes.status).toBe(201);
    const node = await nodeRes.json();
    expect(node.title).toBe("Setup DB Schema");

    // Verify in DB
    const dbNode = db.query("SELECT title FROM nodes_current WHERE node_id = ?").get(node.node_id) as any;
    expect(dbNode.title).toBe("Setup DB Schema");
  });

  it("should store title via graph builder", () => {
    const plan = {
      teams: [{ id: "t1", name: "Backend" }],
      tasks: [
        { id: "task1", title: "Build API", kind: "code_gen", team: "t1", prompt: "Build it", depends_on: [] },
      ],
      summary: "Test plan",
    };

    // Create run first
    db.run("INSERT INTO runs_current (run_id, goal, status) VALUES (?, ?, ?)", ["run_test", "test", "active"]);

    const { taskNodeMap } = buildGraphFromPlan(db, "run_test", plan);
    const nodeId = taskNodeMap.get("task1")!;
    const node = db.query("SELECT title FROM nodes_current WHERE node_id = ?").get(nodeId) as any;
    expect(node.title).toBe("Build API");
  });
});

// ── Gap 1: Planner output message tests ──

describe("planner output message (Gap 1)", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
  });

  it("should store node_id in messages via graph builder", () => {
    db.run("INSERT INTO runs_current (run_id, goal, status) VALUES (?, ?, ?)", ["run_1", "test", "active"]);

    const plan: DecompositionPlan = {
      teams: [{ id: "t1", name: "Team" }],
      tasks: [{ id: "task1", title: "Do thing", kind: "code_gen", team: "t1", prompt: "Build it", depends_on: [] }],
      summary: "Plan",
    };

    const { taskNodeMap } = buildGraphFromPlan(db, "run_1", plan);
    const nodeId = taskNodeMap.get("task1")!;

    const msg = db.query(
      "SELECT node_id FROM messages_current WHERE run_id = ? AND message_type = 'node_metadata'"
    ).get("run_1") as any;

    expect(msg.node_id).toBe(nodeId);
  });
});

// ── Gap 2: Agent output capture tests ──

describe("agent output capture (Gap 2)", () => {
  let db: InstanceType<typeof Database>;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    const app = createApp(db);
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Output capture test" }),
    });
    runId = (await res.json()).run_id;
  });

  function makeState(overrides?: Partial<OrchestratorRunState>): OrchestratorRunState {
    return {
      run_id: runId,
      phase: "executing",
      planner_agent_id: null,
      plan: null,
      task_node_map: new Map(),
      team_id_map: new Map(),
      node_agents: new Map(),
      interval: null,
      error: null,
      created_at: new Date().toISOString(),
      result: null,
      node_work_items: new Map(),
      ...overrides,
    };
  }

  it("should store agent output as message when agent completes", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "active", 0]);

    const mockAgent = {
      id: "agent_1",
      status: "completed" as const,
      exit_code: 0,
      output_chunks: ["Here is the ", "generated code:\n```\nconsole.log('hello');\n```"],
    };

    const history: NodeAgentHistory = {
      current_agent_id: "agent_1",
      history: [{ agent_id: "agent_1", status: "running", started_at: new Date().toISOString(), finished_at: null }],
    };

    const state = makeState({
      node_agents: new Map([["node_1", history]]),
    });

    await executionTick(db, state, async () => ({} as any), () => mockAgent as any);

    // Should have stored an agent_output message
    const msgs = db.query(
      "SELECT * FROM messages_current WHERE run_id = ? AND message_type = 'agent_output'"
    ).all(runId) as any[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].sender_id).toBe("agent_1");
    expect(msgs[0].content).toContain("generated code");
    expect(msgs[0].node_id).toBe("node_1");
    expect(msgs[0].team_id).toBe("team_1");
  });

  it("should store agent error as message when agent fails", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "active", 2]);

    const mockAgent = {
      id: "agent_1",
      status: "failed" as const,
      exit_code: 1,
      output_chunks: [],
      stderr_chunks: ["Error: something went wrong"],
    };

    const history: NodeAgentHistory = {
      current_agent_id: "agent_1",
      history: [{ agent_id: "agent_1", status: "running", started_at: new Date().toISOString(), finished_at: null }],
    };

    const state = makeState({
      node_agents: new Map([["node_1", history]]),
    });

    await executionTick(db, state, async () => ({} as any), () => mockAgent as any);

    // Should have stored an agent_error message
    const msgs = db.query(
      "SELECT * FROM messages_current WHERE run_id = ? AND message_type = 'agent_error'"
    ).all(runId) as any[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain("something went wrong");
    expect(msgs[0].node_id).toBe("node_1");
  });

  it("should not store empty agent output", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "active", 0]);

    const mockAgent = {
      id: "agent_1",
      status: "completed" as const,
      exit_code: 0,
      output_chunks: ["", "  "],
    };

    const history: NodeAgentHistory = {
      current_agent_id: "agent_1",
      history: [{ agent_id: "agent_1", status: "running", started_at: new Date().toISOString(), finished_at: null }],
    };

    const state = makeState({
      node_agents: new Map([["node_1", history]]),
    });

    await executionTick(db, state, async () => ({} as any), () => mockAgent as any);

    const msgs = db.query(
      "SELECT * FROM messages_current WHERE run_id = ? AND message_type = 'agent_output'"
    ).all(runId) as any[];
    expect(msgs).toHaveLength(0);
  });
});

// ── Gap 3: Final result tests ──

describe("final result aggregation (Gap 3)", () => {
  let db: InstanceType<typeof Database>;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    const app = createApp(db);
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Final result test" }),
    });
    runId = (await res.json()).run_id;
  });

  function makeState(overrides?: Partial<OrchestratorRunState>): OrchestratorRunState {
    return {
      run_id: runId,
      phase: "executing",
      planner_agent_id: null,
      plan: null,
      task_node_map: new Map(),
      team_id_map: new Map(),
      node_agents: new Map(),
      interval: null,
      error: null,
      created_at: new Date().toISOString(),
      result: null,
      node_work_items: new Map(),
      ...overrides,
    };
  }

  it("should generate final result when all nodes complete", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "completed", 0]);

    // Pre-insert an agent_output message to be aggregated
    db.run(
      "INSERT INTO messages_current (id, run_id, team_id, sender_id, content, message_type, created_at, node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["msg_1", runId, "team_1", "agent_1", "Built the API successfully", "agent_output", new Date().toISOString(), "node_1"]
    );

    const state = makeState();
    await executionTick(db, state, async () => ({} as any), () => undefined);

    expect(state.phase).toBe("completed");
    expect(state.result).not.toBeNull();
    expect(state.result).toContain("Built the API successfully");

    // Should have stored a final_result message
    const resultMsgs = db.query(
      "SELECT * FROM messages_current WHERE run_id = ? AND message_type = 'final_result'"
    ).all(runId) as any[];
    expect(resultMsgs).toHaveLength(1);
    expect(resultMsgs[0].sender_id).toBe("orchestrator");
    expect(resultMsgs[0].team_id).toBe("system");
    expect(resultMsgs[0].content).toContain("Built the API successfully");
  });

  it("should use default message when no agent outputs exist", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "completed", 0]);

    const state = makeState();
    await executionTick(db, state, async () => ({} as any), () => undefined);

    expect(state.result).toBe("All tasks completed successfully.");
  });

  it("should aggregate multiple agent outputs with separators", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "completed", 0]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_2", runId, "team_1", "review", "completed", 0]);

    // Pre-insert agent_output messages
    db.run(
      "INSERT INTO messages_current (id, run_id, team_id, sender_id, content, message_type, created_at, node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["msg_1", runId, "team_1", "agent_1", "Output from task 1", "agent_output", "2024-01-01T00:00:01Z", "node_1"]
    );
    db.run(
      "INSERT INTO messages_current (id, run_id, team_id, sender_id, content, message_type, created_at, node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["msg_2", runId, "team_1", "agent_2", "Output from task 2", "agent_output", "2024-01-01T00:00:02Z", "node_2"]
    );

    const state = makeState();
    await executionTick(db, state, async () => ({} as any), () => undefined);

    expect(state.result).toContain("Output from task 1");
    expect(state.result).toContain("---");
    expect(state.result).toContain("Output from task 2");
  });

  it("should not generate final result on failure", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "failed", 0]);

    const state = makeState();
    await executionTick(db, state, async () => ({} as any), () => undefined);

    expect(state.phase).toBe("failed");
    expect(state.result).toBeNull();

    const resultMsgs = db.query(
      "SELECT * FROM messages_current WHERE run_id = ? AND message_type = 'final_result'"
    ).all(runId) as any[];
    expect(resultMsgs).toHaveLength(0);
  });
});

// ── Gap 4: Multi-agent history tests ──

describe("multi-agent per node (Gap 4)", () => {
  let db: InstanceType<typeof Database>;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    const app = createApp(db);
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Multi-agent test" }),
    });
    runId = (await res.json()).run_id;
  });

  function makeState(overrides?: Partial<OrchestratorRunState>): OrchestratorRunState {
    return {
      run_id: runId,
      phase: "executing",
      planner_agent_id: null,
      plan: null,
      task_node_map: new Map(),
      team_id_map: new Map(),
      node_agents: new Map(),
      interval: null,
      error: null,
      created_at: new Date().toISOString(),
      result: null,
      node_work_items: new Map(),
      ...overrides,
    };
  }

  it("should track multiple agents across retries", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "active", 0]);

    // First agent fails
    const failedAgent = { id: "agent_1", status: "failed" as const, exit_code: 1, output_chunks: ["fail output"], stderr_chunks: ["error"] };
    const history: NodeAgentHistory = {
      current_agent_id: "agent_1",
      history: [{ agent_id: "agent_1", status: "running", started_at: new Date().toISOString(), finished_at: null }],
    };

    const spawnedAgents: any[] = [];
    const state = makeState({
      node_agents: new Map([["node_1", history]]),
    });

    // Tick 1: agent_1 fails, node retried, agent_2 spawned
    await executionTick(
      db,
      state,
      async (prompt, rId, nId) => {
        const agent = { id: `agent_${spawnedAgents.length + 2}`, status: "running" };
        spawnedAgents.push(agent);
        return agent as any;
      },
      (id) => {
        if (id === "agent_1") return failedAgent as any;
        return spawnedAgents.find((a) => a.id === id);
      }
    );

    // History should have 2 entries: agent_1 (failed) + agent_2 (running)
    const nodeHistory = state.node_agents.get("node_1");
    expect(nodeHistory?.history).toHaveLength(2);
    expect(nodeHistory?.history[0].agent_id).toBe("agent_1");
    expect(nodeHistory?.history[0].status).toBe("failed");
    expect(nodeHistory?.history[0].finished_at).not.toBeNull();
    expect(nodeHistory?.history[1].agent_id).toBe("agent_2");
    expect(nodeHistory?.history[1].status).toBe("running");
    expect(nodeHistory?.current_agent_id).toBe("agent_2");
  });

  it("should not spawn duplicate agent when current is active", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "pending", 0]);

    const plan: DecompositionPlan = {
      teams: [{ id: "t1", name: "Test" }],
      tasks: [{ id: "task1", title: "Task 1", kind: "code_gen", team: "t1", prompt: "Do code", depends_on: [] }],
      summary: "",
    };

    // Pre-set an active agent for the node
    const history: NodeAgentHistory = {
      current_agent_id: "agent_existing",
      history: [{ agent_id: "agent_existing", status: "running", started_at: new Date().toISOString(), finished_at: null }],
    };

    const spawnedAgents: any[] = [];
    const state = makeState({
      plan,
      task_node_map: new Map([["task1", "node_1"]]),
      node_agents: new Map([["node_1", history]]),
    });

    await executionTick(
      db,
      state,
      async () => { spawnedAgents.push({}); return {} as any; },
      () => ({ id: "agent_existing", status: "running" } as any)
    );

    // No new agent should be spawned
    expect(spawnedAgents).toHaveLength(0);
  });
});

// ── Stale agent timeout tests ──

describe("stale agent detection", () => {
  let db: InstanceType<typeof Database>;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    const app = createApp(db);
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Stale agent test" }),
    });
    runId = (await res.json()).run_id;
  });

  function makeState(overrides?: Partial<OrchestratorRunState>): OrchestratorRunState {
    return {
      run_id: runId,
      phase: "executing",
      planner_agent_id: null,
      plan: null,
      task_node_map: new Map(),
      team_id_map: new Map(),
      node_agents: new Map(),
      interval: null,
      error: null,
      created_at: new Date().toISOString(),
      result: null,
      node_work_items: new Map(),
      ...overrides,
    };
  }

  it("should force-fail stale agents that exceed timeout + grace period", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "active", 2]);

    // Agent that started long ago (10 minutes ago, well past the 5min + 30s threshold)
    const longAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const history: NodeAgentHistory = {
      current_agent_id: "agent_stale",
      history: [{ agent_id: "agent_stale", status: "running", started_at: longAgo, finished_at: null }],
    };

    const state = makeState({
      node_agents: new Map([["node_1", history]]),
    });

    // The getAgentFn returns the agent as still "running" (it's stuck)
    const mockAgent = { id: "agent_stale", status: "running" as const, exit_code: null, output_chunks: [] };

    await executionTick(db, state, async () => ({} as any), () => mockAgent as any);

    // Node should be marked failed (max retries exhausted at 2)
    const node = db.query("SELECT status FROM nodes_current WHERE node_id = 'node_1'").get() as any;
    expect(node.status).toBe("failed");

    // Agent history should be updated
    expect(history.current_agent_id).toBeNull();
    expect(history.history[0].status).toBe("failed");
    expect(history.history[0].finished_at).not.toBeNull();

    // Should have stored an agent_error message about timeout
    const msgs = db.query(
      "SELECT * FROM messages_current WHERE run_id = ? AND message_type = 'agent_error'"
    ).all(runId) as any[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain("timed out");
  });

  it("should retry stale agent if retries remain", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "active", 0]);

    const longAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const history: NodeAgentHistory = {
      current_agent_id: "agent_stale",
      history: [{ agent_id: "agent_stale", status: "running", started_at: longAgo, finished_at: null }],
    };

    const spawnedAgents: any[] = [];
    const state = makeState({
      node_agents: new Map([["node_1", history]]),
    });

    const mockAgent = { id: "agent_stale", status: "running" as const, exit_code: null, output_chunks: [] };

    await executionTick(
      db,
      state,
      async (prompt, rId, nId) => {
        const agent = { id: `agent_new_${spawnedAgents.length}`, status: "running" };
        spawnedAgents.push(agent);
        return agent as any;
      },
      (id) => {
        if (id === "agent_stale") return mockAgent as any;
        return spawnedAgents.find((a) => a.id === id);
      }
    );

    // Node should be reset to pending then re-activated by spawn
    const node = db.query("SELECT retry_count FROM nodes_current WHERE node_id = 'node_1'").get() as any;
    expect(node.retry_count).toBe(1);
    // New agent should have been spawned
    expect(spawnedAgents.length).toBe(1);
  });

  it("should not flag non-stale agents", async () => {
    db.run("INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)", ["team_1", runId, "Test", "active"]);
    db.run("INSERT INTO nodes_current (node_id, run_id, team_id, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)", ["node_1", runId, "team_1", "code_gen", "active", 0]);

    // Agent that just started (10 seconds ago)
    const recentStart = new Date(Date.now() - 10_000).toISOString();
    const history: NodeAgentHistory = {
      current_agent_id: "agent_fresh",
      history: [{ agent_id: "agent_fresh", status: "running", started_at: recentStart, finished_at: null }],
    };

    const state = makeState({
      node_agents: new Map([["node_1", history]]),
    });

    const mockAgent = { id: "agent_fresh", status: "running" as const, exit_code: null, output_chunks: [] };

    await executionTick(db, state, async () => ({} as any), () => mockAgent as any);

    // Agent should still be running — not flagged as stale
    expect(history.current_agent_id).toBe("agent_fresh");
    expect(history.history[0].status).toBe("running");

    // Node should still be active
    const node = db.query("SELECT status FROM nodes_current WHERE node_id = 'node_1'").get() as any;
    expect(node.status).toBe("active");
  });
});

// ── Schema: node_id column tests ──

describe("messages_current node_id column", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
  });

  it("should support null node_id", () => {
    db.run(
      "INSERT INTO messages_current (id, run_id, team_id, sender_id, content, message_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["msg_1", "run_1", "team_1", "user", "hello", "chat", new Date().toISOString()]
    );
    const msg = db.query("SELECT node_id FROM messages_current WHERE id = 'msg_1'").get() as any;
    expect(msg.node_id).toBeNull();
  });

  it("should store node_id when provided", () => {
    db.run(
      "INSERT INTO messages_current (id, run_id, team_id, sender_id, content, message_type, created_at, node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["msg_1", "run_1", "team_1", "agent_1", "output", "agent_output", new Date().toISOString(), "node_1"]
    );
    const msg = db.query("SELECT node_id FROM messages_current WHERE id = 'msg_1'").get() as any;
    expect(msg.node_id).toBe("node_1");
  });
});
