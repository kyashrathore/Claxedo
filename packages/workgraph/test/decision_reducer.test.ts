import { describe, it, expect } from "bun:test";
import type { EventEnvelope } from "@opencode-ai/orchestrator-events";
import { decisionReducer, type DecisionState } from "../src/reducers/decision";

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: "evt_1",
    run_id: "run_1",
    stream_id: "run_1",
    stream_seq: 1,
    logical_ts: 1,
    schema_version: 1,
    type: "decision_proposed",
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

describe("decisionReducer", () => {
  const initialState: DecisionState = { decisions: {} };

  it("should create a decision on decision_proposed", () => {
    const event = makeEvent({
      type: "decision_proposed",
      payload_json: JSON.stringify({ id: "dec_1", proposal: "Use React" }),
    });
    const result = decisionReducer(initialState, event);
    expect(result.decisions["dec_1"]).toBeDefined();
    expect(result.decisions["dec_1"].proposal).toBe("Use React");
    expect(result.decisions["dec_1"].status).toBe("proposed");
  });

  it("should transition through decision lifecycle", () => {
    let state = decisionReducer(initialState, makeEvent({
      type: "decision_proposed",
      payload_json: JSON.stringify({ id: "dec_1", proposal: "Use React" }),
    }));

    state = decisionReducer(state, makeEvent({
      id: "evt_2",
      type: "decision_challenged",
      payload_json: JSON.stringify({ id: "dec_1", challenger_id: "agent_2" }),
    }));
    expect(state.decisions["dec_1"].status).toBe("challenged");
    expect(state.decisions["dec_1"].challenger_id).toBe("agent_2");

    state = decisionReducer(state, makeEvent({
      id: "evt_3",
      type: "decision_accepted",
      payload_json: JSON.stringify({ id: "dec_1" }),
    }));
    expect(state.decisions["dec_1"].status).toBe("accepted");
  });

  it("should handle decision_rejected", () => {
    let state = decisionReducer(initialState, makeEvent({
      type: "decision_proposed",
      payload_json: JSON.stringify({ id: "dec_1", proposal: "Use Vue" }),
    }));

    state = decisionReducer(state, makeEvent({
      id: "evt_2",
      type: "decision_rejected",
      payload_json: JSON.stringify({ id: "dec_1" }),
    }));
    expect(state.decisions["dec_1"].status).toBe("rejected");
  });

  it("should return same reference for unhandled events", () => {
    const event = makeEvent({ type: "run_created", payload_json: "{}" });
    const result = decisionReducer(initialState, event);
    expect(result).toBe(initialState);
  });
});
