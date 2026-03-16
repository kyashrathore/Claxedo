import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openSqliteEventStore, type IEventStore } from "../src/orchestrator/core/services/event-store";
import { runReducer, type RunState } from "../src/orchestrator/core/reducers/run";

describe("IEventStore (openSqliteEventStore)", () => {
  let sqlite: Database;
  let store: IEventStore;

  beforeEach(() => {
    sqlite = new Database(":memory:");
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
    store = openSqliteEventStore(sqlite);
  });

  function partial(overrides: Partial<Parameters<IEventStore["append"]>[0]> = {}) {
    return {
      id: "evt_1",
      run_id: "run_1",
      stream_id: "run_1",
      schema_version: 1,
      type: "run_created",
      payload_json: JSON.stringify({ goal: "Build auth" }),
      actor_type: "user",
      actor_id: "user_1",
      op_id: "op_1",
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it("fills in stream_seq, prev_hash, and hash", async () => {
    const evt = await store.append(partial());
    expect(evt.stream_seq).toBe(1);
    expect(evt.logical_ts).toBe(1);
    expect(evt.prev_hash).toBe("00000000");
    expect(evt.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("increments stream_seq for each event in the same run", async () => {
    const e1 = await store.append(partial({ id: "evt_1", op_id: "op_1" }));
    const e2 = await store.append(partial({ id: "evt_2", op_id: "op_2" }));
    const e3 = await store.append(partial({ id: "evt_3", op_id: "op_3" }));
    expect(e1.stream_seq).toBe(1);
    expect(e2.stream_seq).toBe(2);
    expect(e3.stream_seq).toBe(3);
  });

  it("chains prev_hash correctly", async () => {
    const e1 = await store.append(partial({ id: "evt_1", op_id: "op_1" }));
    const e2 = await store.append(partial({ id: "evt_2", op_id: "op_2" }));
    const e3 = await store.append(partial({ id: "evt_3", op_id: "op_3" }));
    expect(e1.prev_hash).toBe("00000000");
    expect(e2.prev_hash).toBe(e1.hash);
    expect(e3.prev_hash).toBe(e2.hash);
  });

  it("uses real SHA-256 — 64-char hex hashes", async () => {
    const e1 = await store.append(partial({ id: "evt_1", op_id: "op_1" }));
    const e2 = await store.append(partial({ id: "evt_2", op_id: "op_2" }));
    expect(e1.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(e2.hash).toMatch(/^[a-f0-9]{64}$/);
    // Hashes must differ
    expect(e1.hash).not.toBe(e2.hash);
  });

  it("is idempotent on duplicate op_id — no throw, no duplicate row", async () => {
    const e1 = await store.append(partial({ id: "evt_1", op_id: "op_1" }));
    // Same op_id, different event id — should silently return the existing row
    await expect(store.append(partial({ id: "evt_dup", op_id: "op_1" }))).resolves.toBeDefined();

    const events = await store.getEvents("run_1");
    expect(events.length).toBe(1);
    expect(events[0].id).toBe(e1.id);
  });

  it("sequences are independent per run_id", async () => {
    await store.append(partial({ id: "a1", run_id: "run_A", stream_id: "run_A", op_id: "opA1" }));
    await store.append(partial({ id: "a2", run_id: "run_A", stream_id: "run_A", op_id: "opA2" }));
    const b1 = await store.append(partial({ id: "b1", run_id: "run_B", stream_id: "run_B", op_id: "opB1" }));
    expect(b1.stream_seq).toBe(1);
    expect(b1.prev_hash).toBe("00000000");
  });

  it("getEvents returns rows ordered by stream_seq ascending", async () => {
    await store.append(partial({ id: "evt_1", op_id: "op_1" }));
    await store.append(partial({ id: "evt_2", op_id: "op_2" }));
    await store.append(partial({ id: "evt_3", op_id: "op_3" }));

    const events = await store.getEvents("run_1");
    expect(events.length).toBe(3);
    expect(events[0].stream_seq).toBe(1);
    expect(events[1].stream_seq).toBe(2);
    expect(events[2].stream_seq).toBe(3);
  });

  it("getEvents with sinceSeq returns only events after that seq", async () => {
    await store.append(partial({ id: "evt_1", op_id: "op_1" }));
    await store.append(partial({ id: "evt_2", op_id: "op_2" }));
    await store.append(partial({ id: "evt_3", op_id: "op_3" }));

    const events = await store.getEvents("run_1", 1);
    expect(events.length).toBe(2);
    expect(events[0].id).toBe("evt_2");
    expect(events[1].id).toBe("evt_3");
  });

  it("replayEvents produces deterministic state", async () => {
    await store.append(partial({
      id: "evt_1", op_id: "op_1",
      type: "run_created",
      payload_json: JSON.stringify({ goal: "Build auth" }),
    }));

    const initial: RunState = { runs: {} };
    const result = await store.replayEvents("run_1", runReducer, initial);
    expect(result.runs["run_1"]).toBeDefined();
    expect(result.runs["run_1"].goal).toBe("Build auth");
    expect(result.runs["run_1"].status).toBe("active");
  });

  it("replayEvents is deterministic on re-replay", async () => {
    await store.append(partial({ id: "evt_1", op_id: "op_1", type: "run_created", payload_json: JSON.stringify({ goal: "Test" }) }));
    await store.append(partial({ id: "evt_2", op_id: "op_2", type: "node_status_changed", payload_json: JSON.stringify({ node_id: "n1", status: "active" }) }));

    const initial: RunState = { runs: {} };
    const s1 = await store.replayEvents("run_1", runReducer, initial);
    const s2 = await store.replayEvents("run_1", runReducer, initial);
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
  });
});
