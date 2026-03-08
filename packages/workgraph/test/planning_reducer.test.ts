import { describe, it, expect } from "bun:test";
import type { EventEnvelope } from "@opencode-ai/orchestrator-events";
import { planningReducer, type PlanningState } from "../src/reducers/planning";

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: "evt_1",
    run_id: "run_1",
    stream_id: "run_1",
    stream_seq: 1,
    logical_ts: 1,
    schema_version: 1,
    type: "run_planned",
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

describe("planningReducer", () => {
  const initialState: PlanningState = { plans: {} };

  it("should initialize a plan on run_planned", () => {
    const event = makeEvent({
      type: "run_planned",
      payload_json: JSON.stringify({ plan_id: "plan_1" }),
    });
    const result = planningReducer(initialState, event);
    expect(result.plans["run_1"]).toBeDefined();
    expect(result.plans["run_1"].questions).toEqual([]);
    expect(result.plans["run_1"].routes).toEqual({});
    expect(result.plans["run_1"].dispatched).toBe(false);
  });

  it("should handle question_scoped, route_scored, and dispatch_requested", () => {
    let state = planningReducer(initialState, makeEvent({
      type: "run_planned",
      payload_json: JSON.stringify({}),
    }));

    state = planningReducer(state, makeEvent({
      id: "evt_2",
      type: "question_scoped",
      payload_json: JSON.stringify({ question: "What framework?" }),
    }));
    expect(state.plans["run_1"].questions).toEqual(["What framework?"]);

    state = planningReducer(state, makeEvent({
      id: "evt_3",
      type: "route_scored",
      payload_json: JSON.stringify({ route_id: "route_1", team_id: "team_1", confidence: 0.9 }),
    }));
    expect(state.plans["run_1"].routes["route_1"]).toEqual({ team_id: "team_1", confidence: 0.9 });

    state = planningReducer(state, makeEvent({
      id: "evt_4",
      type: "dispatch_requested",
      payload_json: JSON.stringify({}),
    }));
    expect(state.plans["run_1"].dispatched).toBe(true);
  });

  it("should return same reference for unhandled events", () => {
    const event = makeEvent({ type: "node_created", payload_json: "{}" });
    const result = planningReducer(initialState, event);
    expect(result).toBe(initialState);
  });
});
