import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../src/app";
import type { Hono } from "hono";

describe("POST /runs/:run_id/reactions/evaluate", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Reaction test" }),
    });
    runId = (await res.json()).run_id;
  });

  it("should evaluate reaction rules and return matching actions", async () => {
    const res = await app.request(`/runs/${runId}/reactions/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: { type: "node_completed", payload: { node_id: "n1" } },
        rules: [
          { id: "rule_1", trigger: "node_completed", cooldownMs: 0 },
          { id: "rule_2", trigger: "node_failed", cooldownMs: 0 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.run_id).toBe(runId);
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0].ruleId).toBe("rule_1");
    expect(body.actions[0].action.type).toBe("node_completed_reaction");
  });

  it("should return empty actions when no rules match", async () => {
    const res = await app.request(`/runs/${runId}/reactions/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: { type: "node_started", payload: {} },
        rules: [
          { id: "rule_1", trigger: "node_completed", cooldownMs: 0 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.actions).toHaveLength(0);
  });

  it("should return 404 for unknown run_id", async () => {
    const res = await app.request("/runs/run_nonexistent/reactions/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: { type: "node_completed", payload: {} },
      }),
    });

    expect(res.status).toBe(404);
  });

  it("should accept event without rules and return empty actions", async () => {
    const res = await app.request(`/runs/${runId}/reactions/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: { type: "node_completed", payload: {} },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actions).toHaveLength(0);
  });
});

describe("GET /runs/:run_id/health", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;
  let runId: string;
  let teamId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);

    const runRes = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Health test" }),
    });
    runId = (await runRes.json()).run_id;

    const teamRes = await app.request(`/runs/${runId}/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Health Team" }),
    });
    teamId = (await teamRes.json()).team_id;
  });

  it("should return healthy when no nodes exist", async () => {
    const res = await app.request(`/runs/${runId}/health`);

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.healthy).toBe(true);
    expect(body.stalledNodes).toHaveLength(0);
  });

  it("should return healthy when nodes have recent activity", async () => {
    // Create a node (which creates an event with current timestamp)
    await app.request(`/runs/${runId}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "code_gen", team_id: teamId }),
    });

    const res = await app.request(`/runs/${runId}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.healthy).toBe(true);
    expect(body.stalledNodes).toHaveLength(0);
  });

  it("should return 404 for unknown run_id", async () => {
    const res = await app.request("/runs/run_nonexistent/health");
    expect(res.status).toBe(404);
  });
});
