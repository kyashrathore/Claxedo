import { describe, it, expect } from "bun:test";
import type { EventEnvelope } from "@opencode-ai/orchestrator-events";
import { syncReducer, type SyncReducerState } from "../src/reducers/sync-reducer";

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: "evt_1",
    run_id: "run_1",
    stream_id: "run_1",
    stream_seq: 1,
    logical_ts: 1,
    schema_version: 1,
    type: "sync_push_acked",
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

describe("syncReducer", () => {
  const initialState: SyncReducerState = {
    pushes: [],
    pulls: [],
    conflicts: [],
    snapshots: [],
    repairs: [],
  };

  it("should track pushes, pulls, and snapshots", () => {
    let state = syncReducer(initialState, makeEvent({
      type: "sync_push_acked",
      payload_json: JSON.stringify({ id: "push_1" }),
    }));
    expect(state.pushes).toEqual(["push_1"]);

    state = syncReducer(state, makeEvent({
      id: "evt_2",
      type: "sync_pull_applied",
      payload_json: JSON.stringify({ id: "pull_1" }),
    }));
    expect(state.pulls).toEqual(["pull_1"]);

    state = syncReducer(state, makeEvent({
      id: "evt_3",
      type: "snapshot_created",
      payload_json: JSON.stringify({ id: "snap_1" }),
    }));
    expect(state.snapshots).toEqual(["snap_1"]);
  });

  it("should track conflicts and resolutions", () => {
    let state = syncReducer(initialState, makeEvent({
      type: "conflict_detected",
      payload_json: JSON.stringify({ id: "conf_1" }),
    }));
    expect(state.conflicts).toEqual(["conf_1"]);

    state = syncReducer(state, makeEvent({
      id: "evt_2",
      type: "conflict_resolved",
      payload_json: JSON.stringify({ id: "conf_1" }),
    }));
    expect(state.conflicts).toEqual(["conf_1:resolved"]);
  });

  it("should track repairs", () => {
    const state = syncReducer(initialState, makeEvent({
      type: "repair_rebuild_completed",
      payload_json: JSON.stringify({ id: "repair_1" }),
    }));
    expect(state.repairs).toEqual(["repair_1"]);
  });

  it("should return same reference for unhandled events", () => {
    const event = makeEvent({ type: "run_created", payload_json: "{}" });
    const result = syncReducer(initialState, event);
    expect(result).toBe(initialState);
  });
});
