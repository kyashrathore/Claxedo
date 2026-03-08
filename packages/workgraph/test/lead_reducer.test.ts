import { describe, it, expect } from "bun:test";
import type { EventEnvelope } from "@opencode-ai/orchestrator-events";
import { leadReducer, type LeadState } from "../src/reducers/lead";

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: "evt_1",
    run_id: "run_1",
    stream_id: "run_1",
    stream_seq: 1,
    logical_ts: 1,
    schema_version: 1,
    type: "lead_plan_created",
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

describe("leadReducer", () => {
  const initialState: LeadState = { leadPlans: {} };

  it("should initialize a lead plan on lead_plan_created", () => {
    const event = makeEvent({
      type: "lead_plan_created",
      payload_json: JSON.stringify({ plan_id: "lp_1" }),
    });
    const result = leadReducer(initialState, event);
    expect(result.leadPlans["lp_1"]).toBeDefined();
    expect(result.leadPlans["lp_1"].gaps).toEqual([]);
    expect(result.leadPlans["lp_1"].reroutes).toEqual([]);
  });

  it("should add gaps and reroutes", () => {
    let state = leadReducer(initialState, makeEvent({
      type: "lead_plan_created",
      payload_json: JSON.stringify({ plan_id: "lp_1" }),
    }));

    state = leadReducer(state, makeEvent({
      id: "evt_2",
      type: "lead_gap_detected",
      payload_json: JSON.stringify({ plan_id: "lp_1", gap: "Missing tests" }),
    }));
    expect(state.leadPlans["lp_1"].gaps).toEqual(["Missing tests"]);

    state = leadReducer(state, makeEvent({
      id: "evt_3",
      type: "lead_reroute_requested",
      payload_json: JSON.stringify({ plan_id: "lp_1", reroute: "Add testing team" }),
    }));
    expect(state.leadPlans["lp_1"].reroutes).toEqual(["Add testing team"]);
  });

  it("should return same reference for unhandled events", () => {
    const event = makeEvent({ type: "run_created", payload_json: "{}" });
    const result = leadReducer(initialState, event);
    expect(result).toBe(initialState);
  });
});
