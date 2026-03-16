import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../src/app";
import type { Hono } from "hono";

describe("POST /features/hydrate", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

  it("should hydrate a feature slice with mock connector", async () => {
    const res = await app.request("/features/hydrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        feature_id: "feat_123",
        issue_params: [
          { id: "issue_1", title: "Fix bug", description: "A bug", status: "open" },
          { id: "issue_2", title: "Add feature", description: "New feature", status: "in_progress" },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.featureId).toBe("feat_123");
    expect(body.provider).toBe("github");
    expect(body.issues).toHaveLength(2);
    expect(body.issues[0].id).toBe("issue_1");
    expect(body.issues[0].title).toBe("Fix bug");
    expect(body.issues[1].id).toBe("issue_2");
  });

  it("should handle empty issue_params", async () => {
    const res = await app.request("/features/hydrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "jira",
        feature_id: "feat_empty",
        issue_params: [],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.featureId).toBe("feat_empty");
    expect(body.issues).toHaveLength(0);
  });

  it("should return 400 when required fields are missing", async () => {
    const res = await app.request("/features/hydrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "github" }),
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /features/:feature_id/pull", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

  it("should return null state when no events exist for feature", async () => {
    const res = await app.request("/features/feat_unknown/pull");

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.feature_id).toBe("feat_unknown");
    expect(body.state).toBeNull();
    expect(body.events).toBe(0);
  });
});

describe("POST /sync/rebuild", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

  it("should rebuild state from zero events", async () => {
    const res = await app.request("/sync/rebuild", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.eventsProcessed).toBe(0);
  });

  it("should rebuild state from existing events", async () => {
    // Create a run to generate events
    await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Rebuild test" }),
    });

    const res = await app.request("/sync/rebuild", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.eventsProcessed).toBeGreaterThan(0);
  });
});
