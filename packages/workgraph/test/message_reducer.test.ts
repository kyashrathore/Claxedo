import { describe, it, expect } from "bun:test";
import type { EventEnvelope } from "@opencode-ai/orchestrator-events";
import { messageReducer, type MessageState } from "../src/reducers/message";

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: "evt_1",
    run_id: "run_1",
    stream_id: "run_1",
    stream_seq: 1,
    logical_ts: 1,
    schema_version: 1,
    type: "message_posted",
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

describe("messageReducer", () => {
  const initialState: MessageState = { messages: [] };

  it("should add a message on message_posted", () => {
    const event = makeEvent({
      type: "message_posted",
      payload_json: JSON.stringify({
        id: "msg_1",
        team_id: "team_1",
        sender_id: "agent_1",
        content: "Hello world",
        message_type: "chat",
      }),
    });
    const result = messageReducer(initialState, event);
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].id).toBe("msg_1");
    expect(result.messages[0].content).toBe("Hello world");
    expect(result.messages[0].type).toBe("chat");
  });

  it("should accumulate multiple messages", () => {
    const event1 = makeEvent({
      type: "message_posted",
      payload_json: JSON.stringify({ id: "msg_1", team_id: "team_1", sender_id: "agent_1", content: "First", message_type: "chat" }),
    });
    const state1 = messageReducer(initialState, event1);

    const event2 = makeEvent({
      id: "evt_2",
      type: "message_posted",
      payload_json: JSON.stringify({ id: "msg_2", team_id: "team_1", sender_id: "agent_2", content: "Second", message_type: "chat" }),
    });
    const state2 = messageReducer(state1, event2);
    expect(state2.messages.length).toBe(2);
  });

  it("should return same reference for unhandled events", () => {
    const event = makeEvent({ type: "run_created", payload_json: "{}" });
    const result = messageReducer(initialState, event);
    expect(result).toBe(initialState);
  });
});
