import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  events,
  runs_current,
  teams_current,
  team_members_current,
  nodes_current,
  dependency_edges_current,
  messages_current,
  handoffs_current,
  artifacts_current,
  decisions_current,
  sync_outbox,
  sync_state,
  conflicts,
  snapshots,
  scratchpad_entries,
} from "../src/db/schema";
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
      CREATE TABLE teams_current (
        team_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);

    sqlite.run(`
      CREATE TABLE team_members_current (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL
      );
    `);

    sqlite.run(`
      CREATE TABLE nodes_current (
        node_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
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
      CREATE TABLE messages_current (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        content TEXT NOT NULL,
        message_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    sqlite.run(`
      CREATE TABLE handoffs_current (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        from_team_id TEXT NOT NULL,
        to_team_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);

    sqlite.run(`
      CREATE TABLE artifacts_current (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        content TEXT NOT NULL,
        version INTEGER NOT NULL,
        provenance TEXT NOT NULL
      );
    `);

    sqlite.run(`
      CREATE TABLE decisions_current (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        proposal TEXT NOT NULL,
        status TEXT NOT NULL,
        challenger_id TEXT,
        evidence TEXT
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

  it("should insert and retrieve teams_current", async () => {
    await db.insert(teams_current).values({
      team_id: "team_1",
      run_id: "run_1",
      name: "Frontend",
      status: "active",
    });
    const result = await db.select().from(teams_current).where(eq(teams_current.team_id, "team_1"));
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("Frontend");
  });

  it("should insert and retrieve team_members_current", async () => {
    await db.insert(team_members_current).values({
      id: "tm_1",
      team_id: "team_1",
      agent_id: "agent_1",
      role: "developer",
    });
    const result = await db.select().from(team_members_current).where(eq(team_members_current.id, "tm_1"));
    expect(result.length).toBe(1);
    expect(result[0].agent_id).toBe("agent_1");
  });

  it("should insert and retrieve nodes_current", async () => {
    await db.insert(nodes_current).values({
      node_id: "node_1",
      run_id: "run_1",
      team_id: "team_1",
      kind: "task",
      status: "pending",
      retry_count: 0,
    });
    const result = await db.select().from(nodes_current).where(eq(nodes_current.node_id, "node_1"));
    expect(result.length).toBe(1);
    expect(result[0].kind).toBe("task");
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

  it("should insert and retrieve messages_current", async () => {
    await db.insert(messages_current).values({
      id: "msg_1",
      run_id: "run_1",
      team_id: "team_1",
      sender_id: "agent_1",
      content: "Hello",
      message_type: "chat",
      created_at: new Date().toISOString(),
    });
    const result = await db.select().from(messages_current).where(eq(messages_current.id, "msg_1"));
    expect(result.length).toBe(1);
    expect(result[0].content).toBe("Hello");
  });

  it("should insert and retrieve handoffs_current", async () => {
    await db.insert(handoffs_current).values({
      id: "ho_1",
      run_id: "run_1",
      from_team_id: "team_1",
      to_team_id: "team_2",
      status: "pending",
      payload: JSON.stringify({ task: "build UI" }),
    });
    const result = await db.select().from(handoffs_current).where(eq(handoffs_current.id, "ho_1"));
    expect(result.length).toBe(1);
    expect(result[0].from_team_id).toBe("team_1");
  });

  it("should insert and retrieve artifacts_current", async () => {
    await db.insert(artifacts_current).values({
      id: "art_1",
      run_id: "run_1",
      node_id: "node_1",
      content: "artifact content",
      version: 1,
      provenance: "agent_1",
    });
    const result = await db.select().from(artifacts_current).where(eq(artifacts_current.id, "art_1"));
    expect(result.length).toBe(1);
    expect(result[0].version).toBe(1);
  });

  it("should insert and retrieve decisions_current with nullable fields", async () => {
    await db.insert(decisions_current).values({
      id: "dec_1",
      run_id: "run_1",
      proposal: "Use React",
      status: "proposed",
      challenger_id: null,
      evidence: null,
    });
    const result = await db.select().from(decisions_current).where(eq(decisions_current.id, "dec_1"));
    expect(result.length).toBe(1);
    expect(result[0].proposal).toBe("Use React");
    expect(result[0].challenger_id).toBeNull();
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
