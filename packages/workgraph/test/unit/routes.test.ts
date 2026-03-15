/**
 * Unit tests for HTTP route handlers.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../../src/app";
import type { Hono } from "hono";

function makeApp() {
  const db = new Database(":memory:");
  initializeDb(db);
  const app = createApp(db);
  return { db, app };
}

// ---------------------------------------------------------------------------
// POST /runs
// ---------------------------------------------------------------------------

describe("POST /runs", () => {
  it("creates a run and returns 201", async () => {
    const { app } = makeApp();
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Build a feature" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.run_id).toMatch(/^run_/);
    expect(body.goal).toBe("Build a feature");
    expect(body.status).toBe("active");
  });

  it("returns 400 for missing goal", async () => {
    const { app } = makeApp();
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty goal", async () => {
    const { app } = makeApp();
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "" }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /runs
// ---------------------------------------------------------------------------

describe("GET /runs", () => {
  it("returns empty array initially", async () => {
    const { app } = makeApp();
    const res = await app.request("/runs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("returns created runs", async () => {
    const { app } = makeApp();
    await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Task one" }),
    });
    await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Task two" }),
    });
    const res = await app.request("/runs");
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// GET /runs/:run_id
// ---------------------------------------------------------------------------

describe("GET /runs/:run_id", () => {
  it("returns run data", async () => {
    const { app } = makeApp();
    const created = await (await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Get me" }),
    })).json();

    const res = await app.request(`/runs/${created.run_id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run_id).toBe(created.run_id);
    expect(body.goal).toBe("Get me");
  });

  it("returns 404 for unknown run", async () => {
    const { app } = makeApp();
    const res = await app.request("/runs/run_nonexistent");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /runs/:run_id/metrics
// ---------------------------------------------------------------------------

describe("GET /runs/:run_id/metrics", () => {
  it("returns 404 when run not found", async () => {
    const { app } = makeApp();
    const res = await app.request("/runs/run_ghost/metrics");
    expect(res.status).toBe(404);
  });

  it("returns 404 when metrics not yet computed", async () => {
    const { app } = makeApp();
    const created = await (await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "incomplete" }),
    })).json();

    const res = await app.request(`/runs/${created.run_id}/metrics`);
    expect(res.status).toBe(404);
  });

  it("returns 200 with metrics after injected metrics_json", async () => {
    const { app, db } = makeApp();
    const created = await (await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "measured" }),
    })).json();

    const metrics = { wall_time_ms: 1000, task_count: 2, completed_count: 2, failed_count: 0, max_parallelism: 1, avg_parallelism: 1, total_tokens_used: null, estimated_cost_usd: null };
    db.run("UPDATE runs_current SET metrics_json = ? WHERE run_id = ?", [JSON.stringify(metrics), created.run_id]);

    const res = await app.request(`/runs/${created.run_id}/metrics`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task_count).toBe(2);
    expect(body.wall_time_ms).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// POST /runs/:run_id/nodes
// ---------------------------------------------------------------------------

describe("POST /runs/:run_id/nodes", () => {
  it("creates node and returns 201", async () => {
    const { app } = makeApp();
    const run = await (await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "test" }),
    })).json();

    const res = await app.request(`/runs/${run.run_id}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "code_gen", role: "developer" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.node_id).toMatch(/^node_/);
    expect(body.status).toBe("pending");
    expect(body.retry_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /runs/:run_id/edges
// ---------------------------------------------------------------------------

describe("POST /runs/:run_id/edges", () => {
  it("creates edge and returns 201", async () => {
    const { app } = makeApp();
    const run = await (await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "test" }),
    })).json();

    const n1 = await (await app.request(`/runs/${run.run_id}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "code_gen", role: "developer" }),
    })).json();
    const n2 = await (await app.request(`/runs/${run.run_id}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "review", role: "developer" }),
    })).json();

    const res = await app.request(`/runs/${run.run_id}/edges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: n1.node_id, target_id: n2.node_id, type: "depends_on" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.source_id).toBe(n1.node_id);
    expect(body.target_id).toBe(n2.node_id);
  });
});

// ---------------------------------------------------------------------------
// GET /runs/:run_id/ready
// ---------------------------------------------------------------------------

describe("GET /runs/:run_id/ready", () => {
  it("returns ready nodes with no unmet dependencies", async () => {
    const { app } = makeApp();
    const run = await (await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "test" }),
    })).json();

    const n = await (await app.request(`/runs/${run.run_id}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "research", role: "developer" }),
    })).json();

    const res = await app.request(`/runs/${run.run_id}/ready`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toContain(n.node_id);
  });

  it("returns empty array when no nodes", async () => {
    const { app } = makeApp();
    const run = await (await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "empty" }),
    })).json();

    const res = await app.request(`/runs/${run.run_id}/ready`);
    const body = await res.json();
    expect(body.ready).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PATCH /runs/:run_id/nodes/:node_id
// ---------------------------------------------------------------------------

describe("PATCH /runs/:run_id/nodes/:node_id", () => {
  it("updates node status", async () => {
    const { app } = makeApp();
    const run = await (await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "test" }),
    })).json();

    const n = await (await app.request(`/runs/${run.run_id}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "code_gen", role: "developer" }),
    })).json();

    const res = await app.request(`/runs/${run.run_id}/nodes/${n.node_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");
  });

  it("returns 404 for unknown node", async () => {
    const { app } = makeApp();
    const run = await (await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "test" }),
    })).json();

    const res = await app.request(`/runs/${run.run_id}/nodes/node_bad`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /runs/:run_id/source
// ---------------------------------------------------------------------------

describe("GET /runs/:run_id/source", () => {
  it("returns null when no source attached", async () => {
    const { app } = makeApp();
    const run = await (await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "test" }),
    })).json();

    const res = await app.request(`/runs/${run.run_id}/source`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();
  });

  it("returns 404 for unknown run", async () => {
    const { app } = makeApp();
    const res = await app.request("/runs/run_ghost/source");
    expect(res.status).toBe(404);
  });
});
