import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { openSqliteEventStore, type IEventStore } from "../../src/orchestrator/core/services/event-store-sqlite";
import { rootReducer, initialRootState, type RootState } from "../../src/orchestrator/core/reducers/index";
import { nodeDb } from "../helpers/node-db";

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

describe("Event Replay Integration", () => {
  let sqlite: Database;
  let store: IEventStore;
  let counter: number;

  beforeEach(() => {
    counter = 1;
    sqlite = new Database(":memory:");
    sqlite.run(CREATE_EVENTS_TABLE);
    store = openSqliteEventStore(sqlite);
  });

  function partial(type: string, payload: any, overrides: Record<string, any> = {}) {
    const seq = counter++;
    return {
      id: `evt_${seq}`,
      run_id: "run_1",
      stream_id: "run_1",
      schema_version: 1,
      type,
      payload_json: JSON.stringify(payload),
      actor_type: "system",
      actor_id: "test",
      op_id: `op_${seq}`,
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  async function buildMixedEvents(): Promise<void> {
    await store.append(partial("run_created", { goal: "Build full-stack auth system" }));
    await store.append(partial("node_created", { node_id: "node_lead", kind: "lead_task", role: "developer" }));
    await store.append(partial("node_created", { node_id: "node_team", kind: "code_gen", role: "developer" }));
    await store.append(partial("node_status_changed", { node_id: "node_lead", status: "active" }));
    await store.append(partial("edge_added", { id: "edge_1", source_id: "node_lead", target_id: "node_team", type: "hard" }));
    await store.append(partial("artifact_created", { id: "artifact_1", node_id: "node_lead", content: "Login component code", version: 1 }));
    await store.append(partial("run_planned", { plan_id: "plan_1" }));
  }

  it("replays mixed events and verifies every projection slice", async () => {
    await buildMixedEvents();
    const state = await store.replayEvents("run_1", rootReducer, { ...initialRootState });

    expect(state.run.runs["run_1"].goal).toBe("Build full-stack auth system");
    expect(state.run.runs["run_1"].status).toBe("planned");
    expect(state.node.nodes["node_lead"].kind).toBe("lead_task");
    expect(state.node.nodes["node_lead"].status).toBe("active");
    expect(state.node.nodes["node_team"].status).toBe("pending");
    expect(state.edge.edges).toHaveLength(1);
    expect(state.edge.edges[0].source_id).toBe("node_lead");
    expect(state.artifact.artifacts["artifact_1"].content).toBe("Login component code");
  });

  it("run_completed event transitions run status to completed", async () => {
    await store.append(partial("run_created", { goal: "Complete me" }));
    await store.append(partial("run_completed", {}));

    const state = await store.replayEvents("run_1", rootReducer, { ...initialRootState });
    expect(state.run.runs["run_1"].status).toBe("completed");
  });

  it("run_failed event transitions run status to failed", async () => {
    await store.append(partial("run_created", { goal: "Fail me" }));
    await store.append(partial("run_failed", { error: "timeout" }));

    const state = await store.replayEvents("run_1", rootReducer, { ...initialRootState });
    expect(state.run.runs["run_1"].status).toBe("failed");
  });

  it("run_completed on unknown run_id is a no-op", async () => {
    await store.append(partial("run_completed", {}));
    const state = await store.replayEvents("run_1", rootReducer, { ...initialRootState });
    expect(Object.keys(state.run.runs)).toHaveLength(0);
  });

  it("run_failed on unknown run_id is a no-op", async () => {
    await store.append(partial("run_failed", {}));
    const state = await store.replayEvents("run_1", rootReducer, { ...initialRootState });
    expect(Object.keys(state.run.runs)).toHaveLength(0);
  });

  it("run_created with malformed payload_json preserves existing state", async () => {
    await store.append(partial("run_created", { goal: "Good run" }));
    // Append a malformed run_created — should be ignored
    const bad = partial("run_created", null, { id: "evt_bad", op_id: "op_bad", run_id: "run_1" });
    bad.payload_json = "{ invalid json }";
    await store.append(bad);

    const state = await store.replayEvents("run_1", rootReducer, { ...initialRootState });
    // Good run_created is processed, bad one is skipped
    expect(state.run.runs["run_1"]?.goal).toBe("Good run");
  });

  it("produces deterministic state when replayed twice", async () => {
    await buildMixedEvents();
    const s1 = await store.replayEvents("run_1", rootReducer, { ...initialRootState });
    const s2 = await store.replayEvents("run_1", rootReducer, { ...initialRootState });
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
  });

  it("handles incremental replay using sinceSeq", async () => {
    await buildMixedEvents();

    // Replay first 4 events manually
    const all = await store.getEvents("run_1");
    let state: RootState = { ...initialRootState };
    for (let i = 0; i < 4; i++) state = rootReducer(state, all[i]);

    expect(state.run.runs["run_1"].status).toBe("active");
    expect(state.edge.edges).toHaveLength(0);

    // Replay remaining events from seq=4 onwards
    const remaining = await store.getEvents("run_1", 4);
    for (const evt of remaining) state = rootReducer(state, evt);

    expect(state.run.runs["run_1"].status).toBe("planned");
    expect(state.edge.edges).toHaveLength(1);
    expect(state.artifact.artifacts["artifact_1"]).toBeDefined();
  });

  it("ignores unknown event types without corrupting state", async () => {
    await store.append(partial("run_created", { goal: "Test" }));
    await store.append(partial("completely_unknown_event" as any, {}));

    const state = await store.replayEvents("run_1", rootReducer, { ...initialRootState });
    expect(state.run.runs["run_1"].goal).toBe("Test");
    expect(Object.keys(state.node.nodes)).toHaveLength(0);
  });

  it("two run_ids are isolated — each sees only its own events", async () => {
    await store.append(partial("run_created", { goal: "Goal 1" }));
    await store.append(partial("run_created", { goal: "Goal 2" }, { run_id: "run_2", stream_id: "run_2", id: "evt_r2", op_id: "op_r2" }));

    const s1 = await store.replayEvents("run_1", rootReducer, { ...initialRootState });
    const s2 = await store.replayEvents("run_2", rootReducer, { ...initialRootState });

    expect(s1.run.runs["run_1"].goal).toBe("Goal 1");
    expect(s1.run.runs["run_2"]).toBeUndefined();
    expect(s2.run.runs["run_2"].goal).toBe("Goal 2");
    expect(s2.run.runs["run_1"]).toBeUndefined();
  });

  it("replays correctly from a Node-style sqlite database", async () => {
    const db = nodeDb();
    db.exec(CREATE_EVENTS_TABLE);
    const store = openSqliteEventStore(db);

    await store.append({
      id: "evt_node",
      run_id: "run_node",
      stream_id: "run_node",
      schema_version: 1,
      type: "run_created",
      payload_json: JSON.stringify({ goal: "Node runtime" }),
      actor_type: "system",
      actor_id: "test",
      op_id: "op_node",
      created_at: new Date().toISOString(),
    });

    const state = await store.replayEvents("run_node", rootReducer, { ...initialRootState });
    expect(state.run.runs["run_node"].goal).toBe("Node runtime");
    db.close();
  });
});
