import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../src/app";
import {
  startOrchestration,
  startExecution,
  onPlanningComplete,
  getOrchestration,
} from "../src/orchestrator/executor";
import {
  getTraceEvents,
  getTraceEventsByType,
  appendTraceEvent,
  createTraceEvent,
  TRACE_EVENT_TYPES,
} from "../src/orchestrator/trace";
import { MockAgent } from "./helpers/mock-agent";

function makeDb() {
  const db = new Database(":memory:");
  initializeDb(db);
  return db;
}

function makeRun(db: any, goal = "test") {
  const runId = `run_trace_${Math.random().toString(36).slice(2)}`;
  db.run(
    "INSERT INTO runs_current (run_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [runId, goal, "active", new Date().toISOString(), new Date().toISOString()],
  );
  return runId;
}

function waitForPhase(runId: string, phase: string, maxMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const state = getOrchestration(runId);
      if (state?.phase === phase) { resolve(); return; }
      if (Date.now() - start > maxMs) {
        reject(new Error(`Timed out waiting for "${phase}" (current: "${state?.phase}")`));
        return;
      }
      setTimeout(check, 20);
    };
    setTimeout(check, 5);
  });
}

// ---------------------------------------------------------------------------
// Unit: createTraceEvent + appendTraceEvent + getTraceEvents
// ---------------------------------------------------------------------------

describe("trace storage", () => {
  let db: any;

  beforeEach(() => { db = makeDb(); });

  it("appends and retrieves a trace event", () => {
    const runId = "run_unit_1";
    const event = createTraceEvent({
      event_type: "run_created",
      run_id: runId,
      payload: { goal: "hello" },
    });

    appendTraceEvent(db, event);

    const events = getTraceEvents(db, runId);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("run_created");
    expect(events[0].run_id).toBe(runId);
    expect(events[0].payload).toEqual({ goal: "hello" });
    expect(events[0].id).toMatch(/^tev_/);
    expect(events[0].timestamp).toBeDefined();
  });

  it("is idempotent on duplicate id", () => {
    const runId = "run_unit_2";
    const event = createTraceEvent({ event_type: "run_created", run_id: runId, payload: {} });
    appendTraceEvent(db, event);
    appendTraceEvent(db, event); // duplicate — should not throw

    expect(getTraceEvents(db, runId)).toHaveLength(1);
  });

  it("filters by node_id", () => {
    const runId = "run_unit_3";
    appendTraceEvent(db, createTraceEvent({ event_type: "node_started", run_id: runId, node_id: "node_a", payload: {} }));
    appendTraceEvent(db, createTraceEvent({ event_type: "node_started", run_id: runId, node_id: "node_b", payload: {} }));
    appendTraceEvent(db, createTraceEvent({ event_type: "node_completed", run_id: runId, node_id: "node_a", payload: {} }));

    const nodeA = getTraceEvents(db, runId, "node_a");
    expect(nodeA).toHaveLength(2);
    expect(nodeA.every((e) => e.node_id === "node_a")).toBe(true);
  });

  it("filters by event type", () => {
    const runId = "run_unit_4";
    appendTraceEvent(db, createTraceEvent({ event_type: "run_created", run_id: runId, payload: {} }));
    appendTraceEvent(db, createTraceEvent({ event_type: "node_started", run_id: runId, node_id: "n1", payload: {} }));
    appendTraceEvent(db, createTraceEvent({ event_type: "node_completed", run_id: runId, node_id: "n1", payload: {} }));
    appendTraceEvent(db, createTraceEvent({ event_type: "run_completed", run_id: runId, payload: {} }));

    const nodeEvents = getTraceEventsByType(db, runId, ["node_started", "node_completed"]);
    expect(nodeEvents).toHaveLength(2);
    expect(nodeEvents.map((e) => e.event_type)).toEqual(["node_started", "node_completed"]);
  });

  it("returns empty array for unknown run", () => {
    const db2 = makeDb();
    expect(getTraceEvents(db2, "nonexistent")).toHaveLength(0);
  });

  it("getTraceEventsByType with empty types returns nothing", () => {
    expect(getTraceEventsByType(db, "any_run", [])).toHaveLength(0);
  });

  it("isolates events by run_id", () => {
    appendTraceEvent(db, createTraceEvent({ event_type: "run_created", run_id: "run_a", payload: {} }));
    appendTraceEvent(db, createTraceEvent({ event_type: "run_created", run_id: "run_b", payload: {} }));

    expect(getTraceEvents(db, "run_a")).toHaveLength(1);
    expect(getTraceEvents(db, "run_b")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: executor emits trace events
// ---------------------------------------------------------------------------

describe("executor trace emission", () => {
  let db: any;

  beforeEach(() => { db = makeDb(); });

  it("emits run_created and run_completed for a simple execution", async () => {
    const runId = makeRun(db, "trace test");
    db.run(
      "INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count, node_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["node_t1", runId, "developer", "research", "Task", "pending", 0, "task"],
    );
    db.run(
      "INSERT INTO scratchpad_entries (id, run_id, node_id, content, created_at, expires_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["sp_t1", runId, "node_t1", "do it", new Date().toISOString(), new Date(Date.now() + 86400000).toISOString(), 5],
    );

    const agent = new MockAgent(db);
    agent.addScript({ match: {}, status: "completed" });

    await startExecution(db, runId, "trace test", agent.spawnFn());
    await waitForPhase(runId, "completed");

    const events = getTraceEvents(db, runId);
    const types = events.map((e) => e.event_type);

    expect(types).toContain("run_created");
    expect(types).toContain("node_started");
    expect(types).toContain("node_completed");
    expect(types).toContain("run_completed");
  });

  it("emits node_failed and run_failed when all nodes exhaust retries", async () => {
    const runId = makeRun(db, "fail test");
    db.run(
      "INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count, node_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["node_f1", runId, "developer", "research", "Fail Task", "pending", 2, "task"],
    );
    db.run(
      "INSERT INTO scratchpad_entries (id, run_id, node_id, content, created_at, expires_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["sp_f1", runId, "node_f1", "will fail", new Date().toISOString(), new Date(Date.now() + 86400000).toISOString(), 9],
    );

    const agent = new MockAgent(db);
    agent.addScript({ match: {}, status: "failed" });

    await startExecution(db, runId, "fail test", agent.spawnFn());
    await waitForPhase(runId, "failed");

    const events = getTraceEvents(db, runId);
    const types = events.map((e) => e.event_type);

    expect(types).toContain("node_failed");
    expect(types).toContain("run_failed");

    const failedEvent = events.find((e) => e.event_type === "node_failed")!;
    expect(failedEvent.node_id).toBe("node_f1");
    expect(failedEvent.payload).toHaveProperty("retries");
  });

  it("emits node_retried when retry count is below max", async () => {
    const runId = makeRun(db, "retry test");
    db.run(
      "INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count, node_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["node_r1", runId, "developer", "research", "Retry Task", "pending", 0, "task"],
    );
    db.run(
      "INSERT INTO scratchpad_entries (id, run_id, node_id, content, created_at, expires_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["sp_r1", runId, "node_r1", "retry me", new Date().toISOString(), new Date(Date.now() + 86400000).toISOString(), 8],
    );

    const agent = new MockAgent(db);
    // Fail once, then succeed
    agent.addScript({ match: {}, status: "failed", once: true });
    agent.addScript({ match: {}, status: "completed" });

    await startExecution(db, runId, "retry test", agent.spawnFn());
    await waitForPhase(runId, "completed");

    const types = getTraceEvents(db, runId).map((e) => e.event_type);
    expect(types).toContain("node_retried");
    expect(types).toContain("node_completed");
    expect(types).toContain("run_completed");
  });

  it("emits planning_start and planning_end", async () => {
    const app = createApp(db);
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "plan this" }),
    });
    const { run_id: runId } = await res.json();

    const agent = new MockAgent(db);
    agent.addScript({ match: {}, status: "completed" });

    await startOrchestration(db, runId, "plan this", agent.spawnFn(), { auto_execute: false });

    await onPlanningComplete(db, runId, "plan done", agent.spawnFn());

    const types = getTraceEvents(db, runId).map((e) => e.event_type);
    expect(types).toContain("run_created");
    expect(types).toContain("planning_start");
    expect(types).toContain("planning_end");
  });
});

// ---------------------------------------------------------------------------
// HTTP: GET /runs/:run_id/trace
// ---------------------------------------------------------------------------

describe("GET /runs/:run_id/trace", () => {
  let db: any;
  let app: any;

  beforeEach(() => {
    db = makeDb();
    app = createApp(db);
  });

  it("returns events for a run", async () => {
    const runId = "run_http_1";
    appendTraceEvent(db, createTraceEvent({ event_type: "run_created", run_id: runId, payload: { goal: "x" } }));
    appendTraceEvent(db, createTraceEvent({ event_type: "run_completed", run_id: runId, payload: {} }));

    const res = await app.request(`/runs/${runId}/trace`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run_id).toBe(runId);
    expect(body.events).toHaveLength(2);
  });

  it("filters by ?node_id=", async () => {
    const runId = "run_http_2";
    appendTraceEvent(db, createTraceEvent({ event_type: "node_started", run_id: runId, node_id: "n1", payload: {} }));
    appendTraceEvent(db, createTraceEvent({ event_type: "node_started", run_id: runId, node_id: "n2", payload: {} }));

    const res = await app.request(`/runs/${runId}/trace?node_id=n1`);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].node_id).toBe("n1");
  });

  it("filters by ?types=", async () => {
    const runId = "run_http_3";
    appendTraceEvent(db, createTraceEvent({ event_type: "run_created", run_id: runId, payload: {} }));
    appendTraceEvent(db, createTraceEvent({ event_type: "node_started", run_id: runId, node_id: "n1", payload: {} }));
    appendTraceEvent(db, createTraceEvent({ event_type: "run_completed", run_id: runId, payload: {} }));

    const res = await app.request(`/runs/${runId}/trace?types=run_created,run_completed`);
    const body = await res.json();
    expect(body.events).toHaveLength(2);
    expect(body.events.map((e: any) => e.event_type)).toEqual(["run_created", "run_completed"]);
  });

  it("returns empty events for unknown run", async () => {
    const res = await app.request("/runs/nonexistent/trace");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TRACE_EVENT_TYPES constant
// ---------------------------------------------------------------------------

describe("TRACE_EVENT_TYPES", () => {
  it("covers all lifecycle phases", () => {
    expect(TRACE_EVENT_TYPES.RUN_CREATED).toBe("run_created");
    expect(TRACE_EVENT_TYPES.PLANNING_START).toBe("planning_start");
    expect(TRACE_EVENT_TYPES.PLANNING_END).toBe("planning_end");
    expect(TRACE_EVENT_TYPES.NODE_STARTED).toBe("node_started");
    expect(TRACE_EVENT_TYPES.NODE_COMPLETED).toBe("node_completed");
    expect(TRACE_EVENT_TYPES.NODE_FAILED).toBe("node_failed");
    expect(TRACE_EVENT_TYPES.NODE_RETRIED).toBe("node_retried");
    expect(TRACE_EVENT_TYPES.RUN_COMPLETED).toBe("run_completed");
    expect(TRACE_EVENT_TYPES.RUN_FAILED).toBe("run_failed");
  });
});
