import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../src/app";
import type { Hono } from "hono";

describe("POST /repair/verify", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

  it("should verify an empty chain successfully", async () => {
    const res = await app.request("/repair/verify", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.action).toBe("verify");
    expect(body.success).toBe(true);
    expect(body.eventsProcessed).toBe(0);
  });

  it("should detect broken chain when hash is tampered", async () => {
    // Create a run to generate an event
    const runRes = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Verify test" }),
    });
    const run = await runRes.json();

    // Tamper with the event hash
    db.run("UPDATE events SET hash = 'tampered' WHERE run_id = ?", [run.run_id]);

    const res = await app.request("/repair/verify", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.action).toBe("verify");
    // The chain uses random hashes (not computed), so verifyChain will detect mismatch
    expect(body.success).toBe(false);
  });
});

describe("POST /repair/rebuild", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

  it("should rebuild state from zero events", async () => {
    const res = await app.request("/repair/rebuild", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.action).toBe("rebuild");
    expect(body.success).toBe(true);
    expect(body.eventsProcessed).toBe(0);
  });

  it("should rebuild state from existing events", async () => {
    // Create a run
    await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Rebuild test" }),
    });

    const res = await app.request("/repair/rebuild", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.action).toBe("rebuild");
    expect(body.success).toBe(true);
    expect(body.eventsProcessed).toBeGreaterThan(0);
  });
});

describe("POST /repair/replay", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

  it("should replay events and match current state", async () => {
    // Create some events
    await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Replay test" }),
    });

    const res = await app.request("/repair/replay", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.action).toBe("replay");
    expect(body.success).toBe(true);
    expect(body.details).toBe("Replay matches target state");
  });

  it("should match on empty event log", async () => {
    const res = await app.request("/repair/replay", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.action).toBe("replay");
    expect(body.success).toBe(true);
  });
});

describe("POST /repair/reconcile", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);
  });

  it("should find missing events from remote", async () => {
    const res = await app.request("/repair/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        remote_events: [
          {
            id: "evt_remote_1",
            run_id: "run_1",
            stream_id: "run_1",
            stream_seq: 1,
            logical_ts: 1,
            schema_version: 1,
            type: "run_created",
            payload_json: JSON.stringify({ goal: "remote" }),
            actor_type: "user",
            actor_id: "api",
            op_id: "op_remote_1",
            prev_hash: "00000000",
            hash: "abc123",
            created_at: new Date().toISOString(),
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.action).toBe("reconcile");
    expect(body.success).toBe(true);
    expect(body.eventsProcessed).toBe(1); // 1 missing event
  });

  it("should find zero missing events when remote is empty", async () => {
    const res = await app.request("/repair/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        remote_events: [],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.action).toBe("reconcile");
    expect(body.eventsProcessed).toBe(0);
  });

  it("should not count events already present locally", async () => {
    // Create a local event
    const runRes = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Reconcile test" }),
    });
    const run = await runRes.json();

    // Get the local event's op_id
    const localEvents = db
      .query("SELECT * FROM events WHERE run_id = ?")
      .all(run.run_id) as any[];

    const localOpId = localEvents[0].op_id;

    // Send the same event as remote
    const res = await app.request("/repair/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        remote_events: [
          {
            id: "evt_dup",
            run_id: run.run_id,
            stream_id: run.run_id,
            stream_seq: 1,
            logical_ts: 1,
            schema_version: 1,
            type: "run_created",
            payload_json: JSON.stringify({ goal: "Reconcile test" }),
            actor_type: "user",
            actor_id: "api",
            op_id: localOpId,
            prev_hash: "00000000",
            hash: "def456",
            created_at: new Date().toISOString(),
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.action).toBe("reconcile");
    expect(body.eventsProcessed).toBe(0); // already present locally
  });
});
