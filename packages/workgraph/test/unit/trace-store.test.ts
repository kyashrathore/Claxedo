import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createTraceEvent,
  appendTraceEvent,
  getTraceEvents,
  getTraceEventsByType,
  type TraceEvent,
} from "../../src/orchestrator/trace/trace-store";
import { TRACE_EVENT_TYPES } from "../../src/orchestrator/trace/trace-event-types";

const CREATE_TABLE = `
  CREATE TABLE trace_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    run_id TEXT NOT NULL,
    node_id TEXT,
    payload_json TEXT NOT NULL
  );
`;

describe("createTraceEvent", () => {
  it("generates a non-empty unique id", () => {
    const evt = createTraceEvent({
      event_type: TRACE_EVENT_TYPES.RUN_CREATED,
      run_id: "run_1",
      payload: {},
    });
    expect(evt.id).toBeTruthy();
    expect(typeof evt.id).toBe("string");
  });

  it("generates an ISO timestamp when not provided", () => {
    const evt = createTraceEvent({
      event_type: TRACE_EVENT_TYPES.RUN_CREATED,
      run_id: "run_1",
      payload: {},
    });
    expect(() => new Date(evt.timestamp)).not.toThrow();
    expect(evt.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("uses provided timestamp", () => {
    const ts = "2025-01-01T00:00:00.000Z";
    const evt = createTraceEvent({
      event_type: TRACE_EVENT_TYPES.NODE_STARTED,
      run_id: "run_1",
      timestamp: ts,
      payload: { node_id: "n1" },
    });
    expect(evt.timestamp).toBe(ts);
  });

  it("passes through event_type, run_id, node_id, payload", () => {
    const evt = createTraceEvent({
      event_type: TRACE_EVENT_TYPES.TOOL_USED,
      run_id: "run_42",
      node_id: "node_7",
      payload: { tool: "bash", args: [] },
    });
    expect(evt.event_type).toBe(TRACE_EVENT_TYPES.TOOL_USED);
    expect(evt.run_id).toBe("run_42");
    expect(evt.node_id).toBe("node_7");
    expect(evt.payload).toEqual({ tool: "bash", args: [] });
  });

  it("node_id is undefined when not provided", () => {
    const evt = createTraceEvent({
      event_type: TRACE_EVENT_TYPES.RUN_COMPLETED,
      run_id: "run_1",
      payload: {},
    });
    expect(evt.node_id).toBeUndefined();
  });

  it("generates distinct ids for consecutive calls", () => {
    const a = createTraceEvent({ event_type: TRACE_EVENT_TYPES.RUN_CREATED, run_id: "r", payload: {} });
    const b = createTraceEvent({ event_type: TRACE_EVENT_TYPES.RUN_CREATED, run_id: "r", payload: {} });
    expect(a.id).not.toBe(b.id);
  });
});

describe("appendTraceEvent + getTraceEvents", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run(CREATE_TABLE);
  });

  function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
    return createTraceEvent({
      event_type: TRACE_EVENT_TYPES.RUN_CREATED,
      run_id: "run_1",
      payload: {},
      ...overrides,
    });
  }

  it("appends and retrieves a single event", () => {
    const evt = makeEvent();
    appendTraceEvent(db, evt);
    const rows = getTraceEvents(db, "run_1");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(evt.id);
    expect(rows[0].event_type).toBe(TRACE_EVENT_TYPES.RUN_CREATED);
    expect(rows[0].run_id).toBe("run_1");
  });

  it("preserves payload round-trip", () => {
    const evt = makeEvent({ payload: { x: 1, tags: ["a", "b"] } });
    appendTraceEvent(db, evt);
    const rows = getTraceEvents(db, "run_1");
    expect(rows[0].payload).toEqual({ x: 1, tags: ["a", "b"] });
  });

  it("preserves node_id round-trip (present)", () => {
    const evt = createTraceEvent({
      event_type: TRACE_EVENT_TYPES.NODE_STARTED,
      run_id: "run_1",
      node_id: "node_abc",
      payload: {},
    });
    appendTraceEvent(db, evt);
    const rows = getTraceEvents(db, "run_1");
    expect(rows[0].node_id).toBe("node_abc");
  });

  it("preserves node_id round-trip (absent → undefined)", () => {
    const evt = makeEvent();
    appendTraceEvent(db, evt);
    const rows = getTraceEvents(db, "run_1");
    expect(rows[0].node_id).toBeUndefined();
  });

  it("returns events ordered by insertion order", () => {
    const e1 = makeEvent({ event_type: TRACE_EVENT_TYPES.PLANNING_START });
    const e2 = makeEvent({ event_type: TRACE_EVENT_TYPES.PLANNING_END });
    const e3 = makeEvent({ event_type: TRACE_EVENT_TYPES.RUN_COMPLETED });
    appendTraceEvent(db, e1);
    appendTraceEvent(db, e2);
    appendTraceEvent(db, e3);
    const rows = getTraceEvents(db, "run_1");
    expect(rows.map((r) => r.id)).toEqual([e1.id, e2.id, e3.id]);
  });

  it("returns empty array for unknown run_id", () => {
    const evt = makeEvent();
    appendTraceEvent(db, evt);
    expect(getTraceEvents(db, "run_999")).toHaveLength(0);
  });

  it("filters by node_id when provided", () => {
    const e1 = createTraceEvent({
      event_type: TRACE_EVENT_TYPES.NODE_STARTED,
      run_id: "run_1",
      node_id: "node_A",
      payload: {},
    });
    const e2 = createTraceEvent({
      event_type: TRACE_EVENT_TYPES.NODE_STARTED,
      run_id: "run_1",
      node_id: "node_B",
      payload: {},
    });
    const e3 = createTraceEvent({
      event_type: TRACE_EVENT_TYPES.NODE_COMPLETED,
      run_id: "run_1",
      node_id: "node_A",
      payload: {},
    });
    appendTraceEvent(db, e1);
    appendTraceEvent(db, e2);
    appendTraceEvent(db, e3);

    const forA = getTraceEvents(db, "run_1", "node_A");
    expect(forA).toHaveLength(2);
    expect(forA.every((r) => r.node_id === "node_A")).toBe(true);

    const forB = getTraceEvents(db, "run_1", "node_B");
    expect(forB).toHaveLength(1);
    expect(forB[0].id).toBe(e2.id);
  });

  it("node_id filter returns empty when no match", () => {
    const evt = createTraceEvent({
      event_type: TRACE_EVENT_TYPES.NODE_STARTED,
      run_id: "run_1",
      node_id: "node_A",
      payload: {},
    });
    appendTraceEvent(db, evt);
    expect(getTraceEvents(db, "run_1", "node_Z")).toHaveLength(0);
  });

  it("idempotent insert — duplicate id is silently ignored", () => {
    const evt = makeEvent();
    appendTraceEvent(db, evt);
    // second append with same id should not throw or duplicate
    appendTraceEvent(db, evt);
    expect(getTraceEvents(db, "run_1")).toHaveLength(1);
  });

  it("events for different run_ids are isolated", () => {
    const e1 = makeEvent({ run_id: "run_1" });
    const e2 = createTraceEvent({ event_type: TRACE_EVENT_TYPES.RUN_CREATED, run_id: "run_2", payload: {} });
    appendTraceEvent(db, e1);
    appendTraceEvent(db, e2);
    expect(getTraceEvents(db, "run_1")).toHaveLength(1);
    expect(getTraceEvents(db, "run_2")).toHaveLength(1);
    expect(getTraceEvents(db, "run_1")[0].run_id).toBe("run_1");
    expect(getTraceEvents(db, "run_2")[0].run_id).toBe("run_2");
  });
});

describe("getTraceEventsByType", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run(CREATE_TABLE);
  });

  it("returns empty array when eventTypes is empty", () => {
    appendTraceEvent(
      db,
      createTraceEvent({ event_type: TRACE_EVENT_TYPES.RUN_CREATED, run_id: "run_1", payload: {} }),
    );
    expect(getTraceEventsByType(db, "run_1", [])).toHaveLength(0);
  });

  it("returns only matching event types", () => {
    const e1 = createTraceEvent({ event_type: TRACE_EVENT_TYPES.NODE_STARTED, run_id: "run_1", payload: {} });
    const e2 = createTraceEvent({ event_type: TRACE_EVENT_TYPES.NODE_COMPLETED, run_id: "run_1", payload: {} });
    const e3 = createTraceEvent({ event_type: TRACE_EVENT_TYPES.TOOL_USED, run_id: "run_1", payload: {} });
    appendTraceEvent(db, e1);
    appendTraceEvent(db, e2);
    appendTraceEvent(db, e3);

    const rows = getTraceEventsByType(db, "run_1", [
      TRACE_EVENT_TYPES.NODE_STARTED,
      TRACE_EVENT_TYPES.NODE_COMPLETED,
    ]);
    expect(rows).toHaveLength(2);
    const types = rows.map((r) => r.event_type);
    expect(types).toContain(TRACE_EVENT_TYPES.NODE_STARTED);
    expect(types).toContain(TRACE_EVENT_TYPES.NODE_COMPLETED);
    expect(types).not.toContain(TRACE_EVENT_TYPES.TOOL_USED);
  });

  it("single type filter", () => {
    const e1 = createTraceEvent({ event_type: TRACE_EVENT_TYPES.ARTIFACT_PRODUCED, run_id: "run_1", payload: {} });
    const e2 = createTraceEvent({ event_type: TRACE_EVENT_TYPES.SOURCE_ATTACHED, run_id: "run_1", payload: {} });
    appendTraceEvent(db, e1);
    appendTraceEvent(db, e2);

    const rows = getTraceEventsByType(db, "run_1", [TRACE_EVENT_TYPES.ARTIFACT_PRODUCED]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe(TRACE_EVENT_TYPES.ARTIFACT_PRODUCED);
  });

  it("returns empty when no events match the filter", () => {
    appendTraceEvent(
      db,
      createTraceEvent({ event_type: TRACE_EVENT_TYPES.RUN_CREATED, run_id: "run_1", payload: {} }),
    );
    const rows = getTraceEventsByType(db, "run_1", [TRACE_EVENT_TYPES.RUN_FAILED]);
    expect(rows).toHaveLength(0);
  });

  it("returns events ordered by insertion order", () => {
    const types = [
      TRACE_EVENT_TYPES.NODE_STARTED,
      TRACE_EVENT_TYPES.TOOL_USED,
      TRACE_EVENT_TYPES.NODE_STARTED,
    ] as const;
    const evts = types.map((t) =>
      createTraceEvent({ event_type: t, run_id: "run_1", payload: {} }),
    );
    evts.forEach((e) => appendTraceEvent(db, e));

    const rows = getTraceEventsByType(db, "run_1", [TRACE_EVENT_TYPES.NODE_STARTED]);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(evts[0].id);
    expect(rows[1].id).toBe(evts[2].id);
  });

  it("does not cross run boundaries", () => {
    appendTraceEvent(
      db,
      createTraceEvent({ event_type: TRACE_EVENT_TYPES.RUN_COMPLETED, run_id: "run_1", payload: {} }),
    );
    appendTraceEvent(
      db,
      createTraceEvent({ event_type: TRACE_EVENT_TYPES.RUN_COMPLETED, run_id: "run_2", payload: {} }),
    );
    expect(getTraceEventsByType(db, "run_1", [TRACE_EVENT_TYPES.RUN_COMPLETED])).toHaveLength(1);
    expect(getTraceEventsByType(db, "run_2", [TRACE_EVENT_TYPES.RUN_COMPLETED])).toHaveLength(1);
  });
});
