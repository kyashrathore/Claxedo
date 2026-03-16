import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../src/app";
import type { Hono } from "hono";

describe("POST /runs", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

  it("should create a new run when given a valid goal", async () => {
    const res = await app.request("/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ goal: "Fix the login bug" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body).toHaveProperty("run_id");
    expect(body.goal).toBe("Fix the login bug");
    expect(body.status).toBe("active");
  });

  it("should return 400 when goal is completely missing", async () => {
    const res = await app.request("/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("should insert a run_created event into the events table", async () => {
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Build a dashboard" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    const events = db
      .query("SELECT * FROM events WHERE run_id = ?")
      .all(body.run_id) as any[];

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("run_created");
    expect(events[0].run_id).toBe(body.run_id);
  });

  it("should insert into runs_current projection", async () => {
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Deploy service" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    const runs = db
      .query("SELECT * FROM runs_current WHERE run_id = ?")
      .all(body.run_id) as any[];

    expect(runs.length).toBe(1);
    expect(runs[0].goal).toBe("Deploy service");
    expect(runs[0].status).toBe("active");
  });
});

describe("GET /runs/:run_id", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

  it("should return run data for a valid run_id", async () => {
    // First create a run
    const createRes = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Test retrieval" }),
    });
    const created = await createRes.json();

    // Then retrieve it
    const getRes = await app.request(`/runs/${created.run_id}`);
    expect(getRes.status).toBe(200);

    const body = await getRes.json();
    expect(body.run_id).toBe(created.run_id);
    expect(body.goal).toBe("Test retrieval");
    expect(body.status).toBe("active");
  });

  it("should return 404 for unknown run_id", async () => {
    const res = await app.request("/runs/run_nonexistent");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("Run not found");
  });
});

describe("GET /runs", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

});

describe("POST /runs/:run_id/nodes", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);

    const runRes = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Node test" }),
    });
    runId = (await runRes.json()).run_id;
  });

  it("should create a node and return 201", async () => {
    const res = await app.request(`/runs/${runId}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "code_gen", role: "developer" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body).toHaveProperty("node_id");
    expect(body.run_id).toBe(runId);
    expect(body.role).toBe("developer");
    expect(body.kind).toBe("code_gen");
    expect(body.status).toBe("pending");
    expect(body.retry_count).toBe(0);
  });

  it("should insert node_created event", async () => {
    await app.request(`/runs/${runId}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "review", role: "developer" }),
    });

    const events = db
      .query("SELECT * FROM events WHERE run_id = ? AND type = 'node_created'")
      .all(runId) as any[];

    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0].payload_json);
    expect(payload.kind).toBe("review");
  });
});

describe("POST /runs/:run_id/edges", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);

    const runRes = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Edge test" }),
    });
    runId = (await runRes.json()).run_id;
  });

  it("should create an edge and return 201", async () => {
    const res = await app.request(`/runs/${runId}/edges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_id: "node_a",
        target_id: "node_b",
        type: "depends_on",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body).toHaveProperty("id");
    expect(body.run_id).toBe(runId);
    expect(body.source_id).toBe("node_a");
    expect(body.target_id).toBe("node_b");
    expect(body.type).toBe("depends_on");
  });

  it("should insert edge_added event", async () => {
    await app.request(`/runs/${runId}/edges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_id: "node_x",
        target_id: "node_y",
        type: "blocks",
      }),
    });

    const events = db
      .query("SELECT * FROM events WHERE run_id = ? AND type = 'edge_added'")
      .all(runId) as any[];

    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0].payload_json);
    expect(payload.source_id).toBe("node_x");
    expect(payload.target_id).toBe("node_y");
  });
});

describe("GET /runs/:run_id/ready", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);

    const runRes = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Ready test" }),
    });
    runId = (await runRes.json()).run_id;
  });

  it("should return nodes with no dependencies as ready", async () => {
    const nodeRes = await app.request(`/runs/${runId}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "research", role: "developer" }),
    });
    const node = await nodeRes.json();

    const readyRes = await app.request(`/runs/${runId}/ready`);
    expect(readyRes.status).toBe(200);

    const body = await readyRes.json();
    expect(body.ready).toContain(node.node_id);
  });

  it("should not return nodes with unmet dependencies", async () => {
    // Create two nodes
    const nodeARes = await app.request(`/runs/${runId}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "code_gen", role: "developer" }),
    });
    const nodeA = await nodeARes.json();

    const nodeBRes = await app.request(`/runs/${runId}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "review", role: "developer" }),
    });
    const nodeB = await nodeBRes.json();

    // Add edge: A -> B (B depends on A)
    await app.request(`/runs/${runId}/edges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_id: nodeA.node_id,
        target_id: nodeB.node_id,
        type: "depends_on",
      }),
    });

    const readyRes = await app.request(`/runs/${runId}/ready`);
    const body = await readyRes.json();

    // Node A should be ready (no deps), Node B should not (depends on A which is pending)
    expect(body.ready).toContain(nodeA.node_id);
    expect(body.ready).not.toContain(nodeB.node_id);
  });

  it("should return empty array when no pending nodes exist", async () => {
    const readyRes = await app.request(`/runs/${runId}/ready`);
    const body = await readyRes.json();
    expect(body.ready).toEqual([]);
  });
});
