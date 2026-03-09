import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { EventEnvelope } from "../../src/orchestrator/events/schema";
import { appendEvent, getEvents, replayEvents } from "../../src/orchestrator/core/services/event-store";
import { rootReducer, initialRootState, type RootState } from "../../src/orchestrator/core/reducers/index";

describe("Event Replay Integration", () => {
  let db: ReturnType<typeof drizzle>;
  let sqlite: Database;
  let counter: number;

  beforeEach(() => {
    counter = 1;
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

  function makeEvent(
    overrides: Partial<EventEnvelope> & Pick<EventEnvelope, "type" | "payload_json">
  ): EventEnvelope {
    const seq = counter++;
    return {
      id: `evt_${seq}`,
      run_id: "run_1",
      stream_id: "run_1",
      stream_seq: seq,
      logical_ts: seq,
      schema_version: 1,
      actor_type: "system",
      actor_id: "test",
      op_id: `op_${seq}`,
      prev_hash: "00000000",
      hash: `hash_${seq}`,
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  function buildMixedEvents(): EventEnvelope[] {
    return [
      // 1. run_created
      makeEvent({
        type: "run_created",
        payload_json: JSON.stringify({ goal: "Build full-stack auth system" }),
      }),
      // 2. node_created: lead task
      makeEvent({
        type: "node_created",
        payload_json: JSON.stringify({ node_id: "node_lead", kind: "lead_task", role: "developer" }),
      }),
      // 3. node_created: team task
      makeEvent({
        type: "node_created",
        payload_json: JSON.stringify({ node_id: "node_team", kind: "code_gen", role: "developer" }),
      }),
      // 4. node_status_changed
      makeEvent({
        type: "node_status_changed",
        payload_json: JSON.stringify({ node_id: "node_lead", status: "active" }),
      }),
      // 5. edge_added
      makeEvent({
        type: "edge_added",
        payload_json: JSON.stringify({ id: "edge_1", source_id: "node_lead", target_id: "node_team", type: "hard" }),
      }),
      // 6. artifact_created
      makeEvent({
        type: "artifact_created",
        payload_json: JSON.stringify({
          id: "artifact_1",
          node_id: "node_lead",
          content: "Login component code",
          version: 1,
        }),
      }),
      // 7. run_planned
      makeEvent({
        type: "run_planned",
        payload_json: JSON.stringify({ plan_id: "plan_1" }),
      }),
    ];
  }

  it("should replay mixed events and verify every projection slice", async () => {
    const events = buildMixedEvents();

    // Insert all events into the DB
    for (const evt of events) {
      await appendEvent(db, evt);
    }

    // Replay through rootReducer
    const state = await replayEvents(db, "run_1", rootReducer, { ...initialRootState });

    // -- Runs --
    expect(state.run.runs["run_1"]).toBeDefined();
    expect(state.run.runs["run_1"].goal).toBe("Build full-stack auth system");
    expect(state.run.runs["run_1"].status).toBe("planned"); // run_planned changes status to planned

    // -- Nodes --
    expect(state.node.nodes["node_lead"]).toBeDefined();
    expect(state.node.nodes["node_lead"].kind).toBe("lead_task"); // preserved from payload
    expect(state.node.nodes["node_lead"].status).toBe("active");

    expect(state.node.nodes["node_team"]).toBeDefined();
    expect(state.node.nodes["node_team"].kind).toBe("code_gen");
    expect(state.node.nodes["node_team"].status).toBe("pending");

    // -- Edges --
    expect(state.edge.edges).toHaveLength(1);
    expect(state.edge.edges[0].id).toBe("edge_1");
    expect(state.edge.edges[0].source_id).toBe("node_lead");
    expect(state.edge.edges[0].target_id).toBe("node_team");
    expect(state.edge.edges[0].type).toBe("hard");

    // -- Artifacts --
    expect(state.artifact.artifacts["artifact_1"]).toBeDefined();
    expect(state.artifact.artifacts["artifact_1"].node_id).toBe("node_lead");
    expect(state.artifact.artifacts["artifact_1"].content).toBe("Login component code");
    expect(state.artifact.artifacts["artifact_1"].version).toBe(1);
  });

  it("should produce deterministic state when replayed twice", async () => {
    const events = buildMixedEvents();

    for (const evt of events) {
      await appendEvent(db, evt);
    }

    const state1 = await replayEvents(db, "run_1", rootReducer, { ...initialRootState });
    const state2 = await replayEvents(db, "run_1", rootReducer, { ...initialRootState });

    expect(JSON.stringify(state1)).toBe(JSON.stringify(state2));
  });

  it("should handle incremental replay using sinceSeq", async () => {
    const events = buildMixedEvents();
    for (const evt of events) {
      await appendEvent(db, evt);
    }

    // Replay first 4 events (run_created, 2x node_created, node_status_changed)
    const allEvents = await getEvents(db, "run_1");
    let state: RootState = { ...initialRootState };
    for (let i = 0; i < 4; i++) {
      state = rootReducer(state, allEvents[i]);
    }

    // At this point, run should be active (not yet planned)
    expect(state.run.runs["run_1"].status).toBe("active");
    expect(state.edge.edges).toHaveLength(0);
    expect(Object.keys(state.node.nodes)).toHaveLength(2);

    // Now replay remaining events
    const remaining = await getEvents(db, "run_1", 4);
    for (const evt of remaining) {
      state = rootReducer(state, evt);
    }

    // Should match full replay
    expect(state.run.runs["run_1"].status).toBe("planned");
    expect(state.edge.edges).toHaveLength(1);
    expect(state.artifact.artifacts["artifact_1"]).toBeDefined();
  });

  it("should maintain correct counts across all projection slices", async () => {
    const events = buildMixedEvents();
    for (const evt of events) {
      await appendEvent(db, evt);
    }

    const state = await replayEvents(db, "run_1", rootReducer, { ...initialRootState });

    expect(Object.keys(state.run.runs)).toHaveLength(1);
    expect(Object.keys(state.node.nodes)).toHaveLength(2);
    expect(state.edge.edges).toHaveLength(1);
    expect(Object.keys(state.artifact.artifacts)).toHaveLength(1);
  });

  it("should ignore unknown event types without corrupting state", async () => {
    const events = [
      makeEvent({
        type: "run_created",
        payload_json: JSON.stringify({ goal: "Test" }),
      }),
      makeEvent({
        type: "completely_unknown_event_type" as any,
        payload_json: JSON.stringify({ foo: "bar" }),
      }),
    ];

    for (const evt of events) {
      await appendEvent(db, evt);
    }

    const state = await replayEvents(db, "run_1", rootReducer, { ...initialRootState });
    expect(state.run.runs["run_1"]).toBeDefined();
    expect(state.run.runs["run_1"].goal).toBe("Test");
    // All other slices should remain at initial state
    expect(Object.keys(state.node.nodes)).toHaveLength(0);
    expect(state.edge.edges).toHaveLength(0);
    expect(Object.keys(state.artifact.artifacts)).toHaveLength(0);
  });

  it("should handle second run_id independently", async () => {
    // Insert events for run_1
    await appendEvent(db, makeEvent({
      type: "run_created",
      run_id: "run_1",
      payload_json: JSON.stringify({ goal: "Goal 1" }),
    }));

    // Insert events for run_2
    await appendEvent(db, makeEvent({
      type: "run_created",
      run_id: "run_2",
      payload_json: JSON.stringify({ goal: "Goal 2" }),
    }));

    const state1 = await replayEvents(db, "run_1", rootReducer, { ...initialRootState });
    const state2 = await replayEvents(db, "run_2", rootReducer, { ...initialRootState });

    expect(state1.run.runs["run_1"].goal).toBe("Goal 1");
    expect(state1.run.runs["run_2"]).toBeUndefined();

    expect(state2.run.runs["run_2"].goal).toBe("Goal 2");
    expect(state2.run.runs["run_1"]).toBeUndefined();
  });

});
