import { describe, it, expect } from "bun:test";
import type { EventEnvelope } from "@opencode-ai/orchestrator-events";
import { teamReducer, type TeamState } from "../src/reducers/team";

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: "evt_1",
    run_id: "run_1",
    stream_id: "run_1",
    stream_seq: 1,
    logical_ts: 1,
    schema_version: 1,
    type: "team_created",
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

describe("teamReducer", () => {
  const initialState: TeamState = { teams: {} };

  it("should create a team on team_created", () => {
    const event = makeEvent({
      type: "team_created",
      payload_json: JSON.stringify({ team_id: "team_1", name: "Frontend" }),
    });
    const result = teamReducer(initialState, event);
    expect(result.teams["team_1"]).toBeDefined();
    expect(result.teams["team_1"].name).toBe("Frontend");
    expect(result.teams["team_1"].status).toBe("active");
    expect(result.teams["team_1"].members).toEqual([]);
  });

  it("should update team status on team_status_changed", () => {
    const stateWithTeam: TeamState = {
      teams: { team_1: { name: "Frontend", status: "active", members: [] } }
    };
    const event = makeEvent({
      type: "team_status_changed",
      payload_json: JSON.stringify({ team_id: "team_1", status: "paused" }),
    });
    const result = teamReducer(stateWithTeam, event);
    expect(result.teams["team_1"].status).toBe("paused");
  });

  it("should add a member on team_member_added", () => {
    const stateWithTeam: TeamState = {
      teams: { team_1: { name: "Frontend", status: "active", members: [] } }
    };
    const event = makeEvent({
      type: "team_member_added",
      payload_json: JSON.stringify({ team_id: "team_1", agent_id: "agent_1" }),
    });
    const result = teamReducer(stateWithTeam, event);
    expect(result.teams["team_1"].members).toEqual(["agent_1"]);
  });

  it("should return same reference for unhandled events", () => {
    const event = makeEvent({ type: "run_created", payload_json: "{}" });
    const result = teamReducer(initialState, event);
    expect(result).toBe(initialState);
  });
});
