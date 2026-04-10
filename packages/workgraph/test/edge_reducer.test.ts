import { describe, it, expect } from "vitest";
import type { EventEnvelope } from "../src/orchestrator/events/schema";
import { edgeReducer, type EdgeState } from "../src/orchestrator/core/reducers/edge";

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: "evt_1",
    run_id: "run_1",
    stream_id: "run_1",
    stream_seq: 1,
    logical_ts: 1,
    schema_version: 1,
    type: "edge_added",
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

describe("edgeReducer", () => {
  const initialState: EdgeState = { edges: [] };

  it("should add an edge on edge_added", () => {
    const event = makeEvent({
      type: "edge_added",
      payload_json: JSON.stringify({ id: "edge_1", source_id: "node_1", target_id: "node_2", type: "dependency" }),
    });
    const result = edgeReducer(initialState, event);
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].id).toBe("edge_1");
    expect(result.edges[0].source_id).toBe("node_1");
    expect(result.edges[0].target_id).toBe("node_2");
  });

  it("should remove an edge on edge_removed", () => {
    const stateWithEdge: EdgeState = {
      edges: [{ id: "edge_1", source_id: "node_1", target_id: "node_2", type: "dependency" }]
    };
    const event = makeEvent({
      type: "edge_removed",
      payload_json: JSON.stringify({ id: "edge_1" }),
    });
    const result = edgeReducer(stateWithEdge, event);
    expect(result.edges.length).toBe(0);
  });

  it("should return same reference for unhandled events", () => {
    const event = makeEvent({ type: "run_created", payload_json: "{}" });
    const result = edgeReducer(initialState, event);
    expect(result).toBe(initialState);
  });
});
