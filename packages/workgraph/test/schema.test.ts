import { describe, it, expect } from "bun:test";
import { EventEnvelopeSchema } from "../src/orchestrator/events/schema";

describe("EventEnvelopeSchema", () => {
  it("should validate a correct event envelope", () => {
    const validEvent = {
      id: "evt_123",
      run_id: "run_456",
      stream_id: "run_456",
      stream_seq: 1,
      logical_ts: 100,
      schema_version: 1,
      type: "node_created",
      payload_json: '{"node_id": "node_789"}',
      actor_type: "system",
      actor_id: "system",
      op_id: "op_001",
      prev_hash: "hash_000",
      hash: "hash_001",
      created_at: new Date().toISOString()
    };

    const result = EventEnvelopeSchema.safeParse(validEvent);
    expect(result.success).toBe(true);
  });

  it("should reject an envelope missing required fields", () => {
    const invalidEvent = {
      id: "evt_123",
      // missing run_id, etc.
      type: "node_created"
    };

    const result = EventEnvelopeSchema.safeParse(invalidEvent);
    expect(result.success).toBe(false);
  });
});
