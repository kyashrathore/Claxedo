import { describe, it, expect } from "vitest";
import type { EventEnvelope } from "../src/orchestrator/events/schema";
import { runReducer, type RunState } from "../src/orchestrator/core/reducers/run";

describe("runReducer", () => {
  it("should initialize a new run state on run_created event", () => {
    const initialState: RunState = {
      runs: {}
    };

    const event: EventEnvelope = {
      id: "evt_1",
      run_id: "run_1",
      stream_id: "run_1",
      stream_seq: 1,
      logical_ts: 1,
      schema_version: 1,
      type: "run_created",
      payload_json: JSON.stringify({ goal: "Build an auth system" }),
      actor_type: "user",
      actor_id: "user_1",
      op_id: "op_1",
      prev_hash: "",
      hash: "hash_1",
      created_at: new Date().toISOString()
    };

    const newState = runReducer(initialState, event);

    expect(newState.runs["run_1"]).toBeDefined();
    expect(newState.runs["run_1"].goal).toBe("Build an auth system");
    expect(newState.runs["run_1"].status).toBe("active");
  });

  it("should ignore events that are not run-related or unknown types", () => {
    const initialState: RunState = {
      runs: {
        "run_1": { goal: "existing", status: "active" }
      }
    };

    const event: EventEnvelope = {
      id: "evt_2",
      run_id: "run_1",
      stream_id: "run_1",
      stream_seq: 2,
      logical_ts: 2,
      schema_version: 1,
      type: "node_created", // Not handled by RunReducer
      payload_json: "{}",
      actor_type: "system",
      actor_id: "system",
      op_id: "op_2",
      prev_hash: "hash_1",
      hash: "hash_2",
      created_at: new Date().toISOString()
    };

    const newState = runReducer(initialState, event);
    expect(newState).toBe(initialState); // Reference equality for unmodified state
  });
});
