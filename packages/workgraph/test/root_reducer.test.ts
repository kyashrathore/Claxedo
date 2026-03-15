import { describe, it, expect } from "bun:test";
import type { EventEnvelope } from "../src/orchestrator/events/schema";
import { rootReducer, initialRootState, type RootState } from "../src/orchestrator/core/reducers/index";

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: "evt_1",
    run_id: "run_1",
    stream_id: "run_1",
    stream_seq: 1,
    logical_ts: 1,
    schema_version: 1,
    type: "run_created",
    payload_json: "{}",
    actor_type: "system",
    actor_id: "system",
    op_id: "op_1",
    prev_hash: "",
    hash: "hash_1",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("rootReducer", () => {
  it("should dispatch run_created to the run sub-reducer", () => {
    const event = makeEvent({
      type: "run_created",
      payload_json: JSON.stringify({ goal: "Build auth" }),
    });
    const result = rootReducer(initialRootState, event);
    expect(result.run.runs["run_1"]).toBeDefined();
    expect(result.run.runs["run_1"].goal).toBe("Build auth");
    expect(result.run.runs["run_1"].status).toBe("active");
    // Other sub-states should remain unchanged (reference equality)
    expect(result.node).toBe(initialRootState.node);
    expect(result.edge).toBe(initialRootState.edge);
    expect(result.artifact).toBe(initialRootState.artifact);
    expect(result.sync).toBe(initialRootState.sync);
  });

  it("should dispatch events to multiple relevant sub-reducers", () => {
    // First, create a run
    let state = rootReducer(initialRootState, makeEvent({
      type: "run_created",
      payload_json: JSON.stringify({ goal: "Build UI" }),
    }));

    // Then create a node
    state = rootReducer(state, makeEvent({
      id: "evt_3",
      type: "node_created",
      payload_json: JSON.stringify({ node_id: "node_1", kind: "task", role: "developer" }),
    }));
    expect(state.node.nodes["node_1"]).toBeDefined();
    expect(state.node.nodes["node_1"].status).toBe("pending");

    // Run state should still be present
    expect(state.run.runs["run_1"].goal).toBe("Build UI");
  });

  it("should handle a full event sequence across all remaining reducers", () => {
    let state = rootReducer(initialRootState, makeEvent({
      type: "run_created",
      payload_json: JSON.stringify({ goal: "Full integration" }),
    }));

    state = rootReducer(state, makeEvent({
      id: "evt_3", type: "node_created",
      payload_json: JSON.stringify({ node_id: "node_1", kind: "task", role: "developer" }),
    }));

    state = rootReducer(state, makeEvent({
      id: "evt_4", type: "edge_added",
      payload_json: JSON.stringify({ id: "edge_1", source_id: "node_1", target_id: "node_2", type: "dep" }),
    }));

    state = rootReducer(state, makeEvent({
      id: "evt_5", type: "artifact_created",
      payload_json: JSON.stringify({ id: "art_1", node_id: "node_1", content: "output", version: 1 }),
    }));

    // Verify all sub-states updated
    expect(state.run.runs["run_1"].status).toBe("active");
    expect(state.node.nodes["node_1"].kind).toBe("task");
    expect(state.edge.edges.length).toBe(1);
    expect(state.artifact.artifacts["art_1"]).toBeDefined();
    expect(state.artifact.artifacts["art_1"].content).toBe("output");
  });

  it("should return same reference for completely unhandled event types", () => {
    const event = makeEvent({
      type: "some_unknown_event_type",
      payload_json: "{}",
    });
    const result = rootReducer(initialRootState, event);
    expect(result).toBe(initialRootState);
  });
});
