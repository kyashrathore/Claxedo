import { describe, it, expect } from "bun:test";
import type { EventEnvelope } from "@opencode-ai/orchestrator-events";
import { nodeReducer, type NodeState } from "../src/reducers/node";

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: "evt_1",
    run_id: "run_1",
    stream_id: "run_1",
    stream_seq: 1,
    logical_ts: 1,
    schema_version: 1,
    type: "node_created",
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

describe("nodeReducer", () => {
  const initialState: NodeState = { nodes: {} };

  it("should create a node on node_created with pending status and retry_count 0", () => {
    const event = makeEvent({
      type: "node_created",
      payload_json: JSON.stringify({ node_id: "node_1", kind: "task", team_id: "team_1" }),
    });
    const result = nodeReducer(initialState, event);
    expect(result.nodes["node_1"]).toBeDefined();
    expect(result.nodes["node_1"].kind).toBe("task");
    expect(result.nodes["node_1"].status).toBe("pending");
    expect(result.nodes["node_1"].team_id).toBe("team_1");
    expect(result.nodes["node_1"].retry_count).toBe(0);
  });

  it("should update status on node_status_changed and increment retry_count for retryable", () => {
    const stateWithNode: NodeState = {
      nodes: { node_1: { kind: "task", status: "pending", team_id: "team_1", retry_count: 0 } }
    };
    const event = makeEvent({
      type: "node_status_changed",
      payload_json: JSON.stringify({ node_id: "node_1", status: "retryable" }),
    });
    const result = nodeReducer(stateWithNode, event);
    expect(result.nodes["node_1"].status).toBe("retryable");
    expect(result.nodes["node_1"].retry_count).toBe(1);
  });

  it("should not increment retry_count for non-retryable status changes", () => {
    const stateWithNode: NodeState = {
      nodes: { node_1: { kind: "task", status: "pending", team_id: "team_1", retry_count: 0 } }
    };
    const event = makeEvent({
      type: "node_status_changed",
      payload_json: JSON.stringify({ node_id: "node_1", status: "completed" }),
    });
    const result = nodeReducer(stateWithNode, event);
    expect(result.nodes["node_1"].status).toBe("completed");
    expect(result.nodes["node_1"].retry_count).toBe(0);
  });

  it("should return same reference for unhandled events", () => {
    const event = makeEvent({ type: "run_created", payload_json: "{}" });
    const result = nodeReducer(initialState, event);
    expect(result).toBe(initialState);
  });
});
