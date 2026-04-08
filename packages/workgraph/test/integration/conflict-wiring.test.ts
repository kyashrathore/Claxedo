import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openSqliteEventStore, type IEventStore } from "../../src/orchestrator/core/services/event-store-sqlite";

const CREATE_EVENTS_TABLE = `
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
`;

function makePartial(overrides: Record<string, any> = {}) {
  return {
    id: "evt_1",
    run_id: "run_1",
    stream_id: "run_1",
    schema_version: 1,
    type: "node_created",
    payload_json: JSON.stringify({ node_id: "n1" }),
    actor_type: "system",
    actor_id: "test",
    op_id: "op_1",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const INSERT_EVENT = `
  INSERT INTO events
    (id, run_id, stream_id, stream_seq, logical_ts, schema_version, type, payload_json,
     actor_type, actor_id, op_id, prev_hash, hash, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

describe("Conflict Detection in event-store append()", () => {
  let sqlite: Database;
  let store: IEventStore;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.run(CREATE_EVENTS_TABLE);
    store = openSqliteEventStore(sqlite);
  });

  it("idempotent re-insert (same op_id) — no duplicate, no error", async () => {
    await store.append(makePartial({ id: "evt_1", op_id: "op_1" }));
    await store.append(makePartial({ id: "evt_1", op_id: "op_1" }));
    const events = await store.getEvents("run_1");
    expect(events.length).toBe(1);
  });

  it("LWW: local event with later created_at wins, replaces earlier remote", async () => {
    const sqlite2 = new Database(":memory:");
    sqlite2.run(CREATE_EVENTS_TABLE);
    const store2 = openSqliteEventStore(sqlite2);

    // Seed remote event at (stream_id="run_1", stream_seq=1) with an earlier timestamp.
    // run_id="remote_proc" keeps local seq computation (MAX WHERE run_id="run_1") independent.
    const remoteTime = "2024-01-01T00:00:00.000Z";
    sqlite2.run(INSERT_EVENT, [
      "remote_evt", "remote_proc", "run_1", 1, 1, 1,
      "node_created", JSON.stringify({ node_id: "remote" }),
      "system", "remote", "op_remote", "00000000", "abc123", remoteTime,
    ]);

    // Local event has a later timestamp — it wins and replaces the remote row
    const localTime = "2024-06-01T00:00:00.000Z";
    await store2.append(makePartial({ id: "local_evt", op_id: "op_local", created_at: localTime }));

    const events = await store2.getEvents("run_1");
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("local_evt");
  });

  it("LWW: remote event with later created_at wins, local is skipped", async () => {
    const sqlite2 = new Database(":memory:");
    sqlite2.run(CREATE_EVENTS_TABLE);
    const store2 = openSqliteEventStore(sqlite2);

    // Seed remote event at (stream_id="run_1", stream_seq=1) with a later timestamp.
    const remoteTime = "2024-12-01T00:00:00.000Z";
    sqlite2.run(INSERT_EVENT, [
      "remote_evt", "remote_proc", "run_1", 1, 1, 1,
      "node_created", JSON.stringify({ node_id: "remote" }),
      "system", "remote", "op_remote", "00000000", "abc123", remoteTime,
    ]);

    // Local event has an earlier timestamp — remote wins, local is rejected
    const localTime = "2024-01-01T00:00:00.000Z";
    await store2.append(makePartial({ id: "local_evt", op_id: "op_local", created_at: localTime }));

    const localEvents = await store2.getEvents("run_1");
    expect(localEvents).toHaveLength(0); // local was rejected

    const remoteEvents = await store2.getEvents("remote_proc");
    expect(remoteEvents).toHaveLength(1);
    expect(remoteEvents[0].id).toBe("remote_evt");
  });

  it("no conflict for events in same run with different stream_id", async () => {
    const sqlite2 = new Database(":memory:");
    sqlite2.run(CREATE_EVENTS_TABLE);
    const store2 = openSqliteEventStore(sqlite2);

    // Seed: run_1 / stream_A at seq=1
    sqlite2.run(INSERT_EVENT, [
      "evt_stream_a", "run_1", "stream_A", 1, 1, 1,
      "node_created", "{}",
      "system", "test", "op_stream_a", "00000000", "aaa", "2024-01-01T00:00:00.000Z",
    ]);

    // Append to run_1 / stream_id=run_1 — different stream_id → no conflict, both exist
    await store2.append(makePartial({ id: "evt_2", op_id: "op_2" }));

    const events = await store2.getEvents("run_1");
    expect(events).toHaveLength(2);
  });
});
