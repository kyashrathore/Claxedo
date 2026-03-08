import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../src/app";
import { planOrchestration } from "../src/orchestrator/planner";
import { getWorkGraph, resetWorkGraph } from "../src/orchestrator/workgraph-bridge";
import type { OrchestratorRunState, DecompositionPlan } from "../src/orchestrator/types";

// Mock planner agent that returns a pre-defined plan
function makeMockPlannerAgent(plan: DecompositionPlan) {
  const planJson = JSON.stringify(plan);
  // Wrap in stream-json result format (like the real planner output)
  const streamOutput = JSON.stringify({ type: "result", result: planJson });

  return {
    id: "agent_planner_mock",
    status: "completed" as const,
    exit_code: 0,
    output_chunks: [streamOutput],
    stderr_chunks: [],
    created_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    run_id: null,
    node_id: null,
    prompt: "",
    cwd: "",
    process: null,
    listeners: [],
    timeout_handle: null,
  };
}

describe("planOrchestration", () => {
  let db: InstanceType<typeof Database>;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    const app = createApp(db);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Plan test" }),
    });
    runId = (await res.json()).run_id;

    resetWorkGraph();
  });

  it("should return state with phase='planned' after planning", async () => {
    const plan: DecompositionPlan = {
      teams: [{ id: "t1", name: "Backend" }],
      tasks: [
        { id: "task1", title: "Research", kind: "research", team: "t1", prompt: "Research APIs", depends_on: [] },
        { id: "task2", title: "Build", kind: "code_gen", team: "t1", prompt: "Build API", depends_on: ["task1"] },
      ],
      summary: "Two-step plan",
    };

    const mockAgent = makeMockPlannerAgent(plan);
    const spawnedAgents: any[] = [];

    const state = await planOrchestration(
      db,
      runId,
      "Build an API",
      async (prompt, rId, nId) => {
        spawnedAgents.push(mockAgent);
        return mockAgent as any;
      },
      async (agentId) => mockAgent as any,
    );

    expect(state.phase).toBe("planned");
    expect(state.plan).not.toBeNull();
    expect(state.plan!.tasks).toHaveLength(2);
    expect(state.plan!.teams).toHaveLength(1);
    expect(state.task_node_map.size).toBe(2);
    expect(state.team_id_map.size).toBe(1);
  });

  it("should create WorkGraph items for each task", async () => {
    const plan: DecompositionPlan = {
      teams: [{ id: "t1", name: "Solo" }],
      tasks: [
        { id: "task1", title: "First", kind: "research", team: "t1", prompt: "Do first", depends_on: [] },
        { id: "task2", title: "Second", kind: "code_gen", team: "t1", prompt: "Do second", depends_on: ["task1"] },
      ],
      summary: "Sequential",
    };

    const mockAgent = makeMockPlannerAgent(plan);

    const state = await planOrchestration(
      db,
      runId,
      "Sequential tasks",
      async () => mockAgent as any,
      async () => mockAgent as any,
    );

    // Check WorkGraph items were created
    expect(state.node_work_items.size).toBe(2);

    const wg = getWorkGraph();
    for (const [nodeId, itemId] of state.node_work_items) {
      const item = wg.get(itemId);
      expect(item).toBeDefined();
      expect(item!.status).toBe("open");
      expect(item!.context).toContain(`run:${runId}`);
      expect(item!.context).toContain(`node:${nodeId}`);
    }
  });

  it("should create WorkGraph dependencies between items", async () => {
    const plan: DecompositionPlan = {
      teams: [{ id: "t1", name: "Solo" }],
      tasks: [
        { id: "task1", title: "First", kind: "research", team: "t1", prompt: "Do first", depends_on: [] },
        { id: "task2", title: "Second", kind: "code_gen", team: "t1", prompt: "Do second", depends_on: ["task1"] },
      ],
      summary: "Sequential",
    };

    const mockAgent = makeMockPlannerAgent(plan);

    const state = await planOrchestration(
      db,
      runId,
      "Sequential tasks",
      async () => mockAgent as any,
      async () => mockAgent as any,
    );

    const wg = getWorkGraph();
    const node1Id = state.task_node_map.get("task1")!;
    const node2Id = state.task_node_map.get("task2")!;
    const item1Id = state.node_work_items.get(node1Id)!;
    const item2Id = state.node_work_items.get(node2Id)!;

    // task2 item should be blocked by task1 item
    const blockers = wg.getBlockedBy(item2Id);
    expect(blockers.map((b) => b.id)).toContain(item1Id);
  });

  it("should build DB graph (teams, nodes, edges, messages)", async () => {
    const plan: DecompositionPlan = {
      teams: [{ id: "t1", name: "Alpha" }],
      tasks: [
        { id: "task1", title: "A", kind: "research", team: "t1", prompt: "Do A", depends_on: [] },
        { id: "task2", title: "B", kind: "code_gen", team: "t1", prompt: "Do B", depends_on: ["task1"] },
      ],
      summary: "A then B",
    };

    const mockAgent = makeMockPlannerAgent(plan);

    await planOrchestration(
      db,
      runId,
      "A then B",
      async () => mockAgent as any,
      async () => mockAgent as any,
    );

    // DB teams
    const teams = db.query("SELECT * FROM teams_current WHERE run_id = ?").all(runId) as any[];
    expect(teams).toHaveLength(1);

    // DB nodes
    const nodes = db.query("SELECT * FROM nodes_current WHERE run_id = ?").all(runId) as any[];
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n: any) => n.status === "pending")).toBe(true);

    // DB edges
    const edges = db.query("SELECT * FROM dependency_edges_current WHERE run_id = ?").all(runId) as any[];
    expect(edges).toHaveLength(1);

    // Messages (planner_output + node_metadata)
    const plannerMsgs = db.query(
      "SELECT * FROM messages_current WHERE run_id = ? AND message_type = 'planner_output'"
    ).all(runId) as any[];
    expect(plannerMsgs).toHaveLength(1);

    const metaMsgs = db.query(
      "SELECT * FROM messages_current WHERE run_id = ? AND message_type = 'node_metadata'"
    ).all(runId) as any[];
    expect(metaMsgs).toHaveLength(2);
  });

  it("should throw if planner agent fails", async () => {
    const failedAgent = {
      id: "agent_failed",
      status: "failed" as const,
      exit_code: 1,
      output_chunks: [],
      stderr_chunks: ["Claude error"],
      created_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      run_id: null,
      node_id: null,
      prompt: "",
      cwd: "",
      process: null,
      listeners: [],
      timeout_handle: null,
    };

    await expect(
      planOrchestration(
        db,
        runId,
        "Will fail",
        async () => failedAgent as any,
        async () => failedAgent as any,
      )
    ).rejects.toThrow("Planner agent failed");
  });

  it("should link to WorkGraph item when work_item_id provided", async () => {
    const wg = getWorkGraph();
    const item = wg.create({ title: "Parent item" });

    const plan: DecompositionPlan = {
      teams: [{ id: "t1", name: "Solo" }],
      tasks: [
        { id: "task1", title: "Only task", kind: "research", team: "t1", prompt: "Do thing", depends_on: [] },
      ],
      summary: "One task",
    };

    const mockAgent = makeMockPlannerAgent(plan);

    const state = await planOrchestration(
      db,
      runId,
      "One task",
      async () => mockAgent as any,
      async () => mockAgent as any,
      item.id,
    );

    expect(state.work_item_id).toBe(item.id);
  });
});
