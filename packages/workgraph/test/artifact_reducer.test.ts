import { describe, it, expect } from "bun:test";
import type { EventEnvelope } from "@opencode-ai/orchestrator-events";
import { artifactReducer, type ArtifactState } from "../src/reducers/artifact";

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: "evt_1",
    run_id: "run_1",
    stream_id: "run_1",
    stream_seq: 1,
    logical_ts: 1,
    schema_version: 1,
    type: "artifact_created",
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

describe("artifactReducer", () => {
  const initialState: ArtifactState = { artifacts: {} };

  it("should create an artifact on artifact_created", () => {
    const event = makeEvent({
      type: "artifact_created",
      payload_json: JSON.stringify({ id: "art_1", node_id: "node_1", content: "code here", version: 1 }),
    });
    const result = artifactReducer(initialState, event);
    expect(result.artifacts["art_1"]).toBeDefined();
    expect(result.artifacts["art_1"].node_id).toBe("node_1");
    expect(result.artifacts["art_1"].content).toBe("code here");
    expect(result.artifacts["art_1"].version).toBe(1);
  });

  it("should create an artifact from scratchpad_promoted", () => {
    const event = makeEvent({
      type: "scratchpad_promoted",
      payload_json: JSON.stringify({ id: "art_2", node_id: "node_2", content: "promoted content", version: 1 }),
    });
    const result = artifactReducer(initialState, event);
    expect(result.artifacts["art_2"]).toBeDefined();
    expect(result.artifacts["art_2"].content).toBe("promoted content");
  });

  it("should return same reference for unhandled events", () => {
    const event = makeEvent({ type: "run_created", payload_json: "{}" });
    const result = artifactReducer(initialState, event);
    expect(result).toBe(initialState);
  });
});
