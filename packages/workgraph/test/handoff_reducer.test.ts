import { describe, it, expect } from "bun:test";
import type { EventEnvelope } from "@opencode-ai/orchestrator-events";
import { handoffReducer, type HandoffState } from "../src/reducers/handoff";

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: "evt_1",
    run_id: "run_1",
    stream_id: "run_1",
    stream_seq: 1,
    logical_ts: 1,
    schema_version: 1,
    type: "handoff_requested",
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

describe("handoffReducer", () => {
  const initialState: HandoffState = { handoffs: {} };

  it("should create a handoff on handoff_requested with pending status", () => {
    const event = makeEvent({
      type: "handoff_requested",
      payload_json: JSON.stringify({ id: "ho_1", from_team_id: "team_1", to_team_id: "team_2" }),
    });
    const result = handoffReducer(initialState, event);
    expect(result.handoffs["ho_1"]).toBeDefined();
    expect(result.handoffs["ho_1"].from_team).toBe("team_1");
    expect(result.handoffs["ho_1"].to_team).toBe("team_2");
    expect(result.handoffs["ho_1"].status).toBe("pending");
  });

  it("should update status to accepted on handoff_accepted", () => {
    const stateWithHandoff: HandoffState = {
      handoffs: { ho_1: { from_team: "team_1", to_team: "team_2", status: "pending" } }
    };
    const event = makeEvent({
      type: "handoff_accepted",
      payload_json: JSON.stringify({ id: "ho_1" }),
    });
    const result = handoffReducer(stateWithHandoff, event);
    expect(result.handoffs["ho_1"].status).toBe("accepted");
  });

  it("should update status to rejected on handoff_rejected", () => {
    const stateWithHandoff: HandoffState = {
      handoffs: { ho_1: { from_team: "team_1", to_team: "team_2", status: "pending" } }
    };
    const event = makeEvent({
      type: "handoff_rejected",
      payload_json: JSON.stringify({ id: "ho_1" }),
    });
    const result = handoffReducer(stateWithHandoff, event);
    expect(result.handoffs["ho_1"].status).toBe("rejected");
  });

  it("should return same reference for unhandled events", () => {
    const event = makeEvent({ type: "run_created", payload_json: "{}" });
    const result = handoffReducer(initialState, event);
    expect(result).toBe(initialState);
  });
});
