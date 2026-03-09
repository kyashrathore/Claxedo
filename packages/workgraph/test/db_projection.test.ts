import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  events,
  runs_current,
  nodes_current,
  dependency_edges_current,
  sync_outbox,
  sync_state,
  conflicts,
  snapshots,
  scratchpad_entries,
} from "../src/orchestrator/core/db/schema";
import { eq } from "drizzle-orm";

describe("Database Projections", () => {
  let db: ReturnType<typeof drizzle>;
  let sqlite: Database;

  beforeEach(() => {
    // Setup in-memory sqlite for fast testing
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);

    // Create tables
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

    sqlite.run(`
      CREATE TABLE runs_current (
        run_id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);

    sqlite.run(`
      CREATE TABLE nodes_current (
        node_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'developer',
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL
      );
    `);

    sqlite.run(`
      CREATE TABLE dependency_edges_current (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL
      );
    `);

    sqlite.run(`
      CREATE TABLE sync_outbox (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL,
        next_retry_at TEXT
      );
    `);

    sqlite.run(`
      CREATE TABLE sync_state (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        cursor TEXT NOT NULL,
        last_sync_at TEXT NOT NULL
      );
    `);

    sqlite.run(`
      CREATE TABLE conflicts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        strategy TEXT NOT NULL,
        resolution TEXT,
        resolved_at TEXT
      );
    `);

    sqlite.run(`
      CREATE TABLE snapshots (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        event_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    sqlite.run(`
      CREATE TABLE scratchpad_entries (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        size_bytes INTEGER NOT NULL
      );
    `);
  });

  it("should insert and retrieve an event correctly", async () => {
    const mockEvent = {
      id: "evt_db_1",
      run_id: "run_db_1",
      stream_id: "run_db_1",
      stream_seq: 1,
      logical_ts: 1,
      schema_version: 1,
      type: "node_created",
      payload_json: "{}",
      actor_type: "system",
      actor_id: "system",
      op_id: "op_db_1",
      prev_hash: "0000",
      hash: "1111",
      created_at: new Date().toISOString()
    };

    await db.insert(events).values(mockEvent);

    const result = await db.select().from(events).where(eq(events.id, "evt_db_1"));
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("evt_db_1");
    expect(result[0].op_id).toBe("op_db_1");
  });

  it("should insert and retrieve a current run state", async () => {
    await db.insert(runs_current).values({
      run_id: "run_db_1",
      goal: "Test projections",
      status: "active"
    });

    const result = await db.select().from(runs_current).where(eq(runs_current.run_id, "run_db_1"));
    expect(result.length).toBe(1);
    expect(result[0].goal).toBe("Test projections");
  });

  it("should insert and retrieve nodes_current", async () => {
    await db.insert(nodes_current).values({
      node_id: "node_1",
      run_id: "run_1",
      role: "developer",
      kind: "task",
      status: "pending",
      retry_count: 0,
    });
    const result = await db.select().from(nodes_current).where(eq(nodes_current.node_id, "node_1"));
    expect(result.length).toBe(1);
    expect(result[0].kind).toBe("task");
    expect(result[0].role).toBe("developer");
    expect(result[0].retry_count).toBe(0);
  });

  it("should insert and retrieve dependency_edges_current", async () => {
    await db.insert(dependency_edges_current).values({
      id: "edge_1",
      run_id: "run_1",
      source_id: "node_1",
      target_id: "node_2",
      type: "dependency",
    });
    const result = await db.select().from(dependency_edges_current).where(eq(dependency_edges_current.id, "edge_1"));
    expect(result.length).toBe(1);
    expect(result[0].source_id).toBe("node_1");
  });

  it("should insert and retrieve sync_outbox", async () => {
    await db.insert(sync_outbox).values({
      id: "so_1",
      run_id: "run_1",
      event_id: "evt_1",
      status: "pending",
      retry_count: 0,
      next_retry_at: null,
    });
    const result = await db.select().from(sync_outbox).where(eq(sync_outbox.id, "so_1"));
    expect(result.length).toBe(1);
    expect(result[0].retry_count).toBe(0);
  });

  it("should insert and retrieve sync_state", async () => {
    await db.insert(sync_state).values({
      id: "ss_1",
      provider: "github",
      cursor: "cursor_abc",
      last_sync_at: new Date().toISOString(),
    });
    const result = await db.select().from(sync_state).where(eq(sync_state.id, "ss_1"));
    expect(result.length).toBe(1);
    expect(result[0].provider).toBe("github");
  });

  it("should insert and retrieve conflicts", async () => {
    await db.insert(conflicts).values({
      id: "conf_1",
      run_id: "run_1",
      event_id: "evt_1",
      strategy: "last-write-wins",
      resolution: null,
      resolved_at: null,
    });
    const result = await db.select().from(conflicts).where(eq(conflicts.id, "conf_1"));
    expect(result.length).toBe(1);
    expect(result[0].strategy).toBe("last-write-wins");
  });

  it("should insert and retrieve snapshots", async () => {
    await db.insert(snapshots).values({
      id: "snap_1",
      run_id: "run_1",
      state_json: JSON.stringify({ run: {} }),
      event_seq: 10,
      created_at: new Date().toISOString(),
    });
    const result = await db.select().from(snapshots).where(eq(snapshots.id, "snap_1"));
    expect(result.length).toBe(1);
    expect(result[0].event_seq).toBe(10);
  });

  it("should insert and retrieve scratchpad_entries", async () => {
    await db.insert(scratchpad_entries).values({
      id: "sp_1",
      run_id: "run_1",
      node_id: "node_1",
      content: "scratch notes",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      size_bytes: 128,
    });
    const result = await db.select().from(scratchpad_entries).where(eq(scratchpad_entries.id, "sp_1"));
    expect(result.length).toBe(1);
    expect(result[0].size_bytes).toBe(128);
  });
});
