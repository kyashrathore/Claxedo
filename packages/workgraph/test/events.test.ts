import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../src/app";
import type { Hono } from "hono";

describe("GET /runs/:run_id/events", () => {
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
      body: JSON.stringify({ goal: "Events test" }),
    });
    const body = await res.json();
    runId = body.run_id;
  });

  it("should return all events for a run", async () => {
    const res = await app.request(`/runs/${runId}/events`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1); // run_created event
    expect(body[0].type).toBe("run_created");
    expect(body[0].run_id).toBe(runId);
  });

  it("should support since_seq filter", async () => {
    // Create additional events by adding a node
    await app.request(`/runs/${runId}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "code_gen", role: "developer" }),
    });

    // Get all events
    const allRes = await app.request(`/runs/${runId}/events`);
    const allEvents = await allRes.json();
    expect(allEvents.length).toBe(2);

    // Get events since seq 1
    const filteredRes = await app.request(
      `/runs/${runId}/events?since_seq=1`
    );
    const filteredEvents = await filteredRes.json();
    expect(filteredEvents.length).toBe(1);
    expect(filteredEvents[0].type).toBe("node_created");
    expect(filteredEvents[0].stream_seq).toBeGreaterThan(1);
  });

  it("should return empty array for run with no events", async () => {
    const res = await app.request("/runs/run_nonexistent/events");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual([]);
  });
});

describe("GET /runs/:run_id/events/stream", () => {
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
      body: JSON.stringify({ goal: "SSE test" }),
    });
    const body = await res.json();
    runId = body.run_id;
  });

  it("should return text/event-stream content type", async () => {
    const res = await app.request(`/runs/${runId}/events/stream`);
    expect(res.status).toBe(200);

    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("text/event-stream");
  });

  it("should return existing events as SSE data", async () => {
    const res = await app.request(`/runs/${runId}/events/stream`);
    const text = await res.text();

    // SSE format: "data: {...}\n\n"
    expect(text).toContain("data: ");
    expect(text).toContain("run_created");
  });
});
