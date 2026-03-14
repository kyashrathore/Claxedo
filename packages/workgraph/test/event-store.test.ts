import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { EventEnvelope } from "../src/orchestrator/events/schema";
import { appendEvent, getEvents, replayEvents } from "../src/orchestrator/core/services/event-store";
import { runReducer, type RunState } from "../src/orchestrator/core/reducers/run";

describe("event-store", () => {
  let db: ReturnType<typeof drizzle>;
  let sqlite: Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);

    sqlite.run(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_seq INTEGER NOT NULL,
        logical_ts INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        op_id TEXT NOT NULL UNIQUE,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  });

  function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
    return {
      id: "evt_1",
      run_id: "run_1",
      stream_id: "run_1",
      stream_seq: 1,
      logical_ts: 1,
      schema_version: 1,
      type: "run_created",
      payload_json: JSON.stringify({ goal: "Build auth" }),
      actor_type: "user",
      actor_id: "user_1",
      op_id: "op_1",
      prev_hash: "0000",
      hash: "1111",
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it("should append an event and retrieve it", async () => {
    const event = makeEvent();
    await appendEvent(db, event);

    const result = await getEvents(db, "run_1");
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("evt_1");
    expect(result[0].type).toBe("run_created");
  });

  it("should silently deduplicate events with the same op_id", async () => {
    const event = makeEvent();
    await appendEvent(db, event);
    // Second append with same op_id should not throw
    await appendEvent(db, { ...event, id: "evt_1_dup" });

    const result = await getEvents(db, "run_1");
    expect(result.length).toBe(1);
  });

  it("should filter events by sinceSeq", async () => {
    await appendEvent(db, makeEvent({ id: "evt_1", stream_seq: 1, op_id: "op_1" }));
    await appendEvent(db, makeEvent({ id: "evt_2", stream_seq: 2, op_id: "op_2" }));
    await appendEvent(db, makeEvent({ id: "evt_3", stream_seq: 3, op_id: "op_3" }));

    const result = await getEvents(db, "run_1", 1);
    expect(result.length).toBe(2);
    expect(result[0].id).toBe("evt_2");
    expect(result[1].id).toBe("evt_3");
  });

  it("should replay events through a reducer", async () => {
    await appendEvent(db, makeEvent({
      id: "evt_1",
      stream_seq: 1,
      op_id: "op_1",
      type: "run_created",
      payload_json: JSON.stringify({ goal: "Build auth" }),
    }));

    const initialState: RunState = { runs: {} };
    const result = await replayEvents(db, "run_1", runReducer, initialState);
    expect(result.runs["run_1"]).toBeDefined();
    expect(result.runs["run_1"].goal).toBe("Build auth");
    expect(result.runs["run_1"].status).toBe("active");
  });
});
