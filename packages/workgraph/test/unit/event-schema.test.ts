import { describe, it, expect } from "vitest";
import { EventEnvelopeSchema } from "../../src/substrate/event-log";

// ---------------------------------------------------------------------------
// EventEnvelopeSchema
// ---------------------------------------------------------------------------

describe("EventEnvelopeSchema", () => {
  const valid = {
    id: "evt_01",
    run_id: "run_01",
    stream_id: "run_01",
    stream_seq: 0,
    logical_ts: 0,
    schema_version: 1,
    type: "run_created",
    payload_json: "{}",
    actor_type: "system",
    actor_id: "orchestrator",
    op_id: "op_01",
    prev_hash: "00000000",
    hash: "abcdef12",
    created_at: "2026-01-01T00:00:00.000Z",
  };

  it("accepts a valid envelope", () => {
    expect(EventEnvelopeSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts stream_seq of 0 (nonnegative boundary)", () => {
    expect(EventEnvelopeSchema.safeParse({ ...valid, stream_seq: 0 }).success).toBe(true);
  });

  it("rejects negative stream_seq", () => {
    expect(EventEnvelopeSchema.safeParse({ ...valid, stream_seq: -1 }).success).toBe(false);
  });

  it("rejects negative logical_ts", () => {
    expect(EventEnvelopeSchema.safeParse({ ...valid, logical_ts: -1 }).success).toBe(false);
  });

  it("rejects schema_version 0 (must be positive)", () => {
    expect(EventEnvelopeSchema.safeParse({ ...valid, schema_version: 0 }).success).toBe(false);
  });

  it("rejects non-integer schema_version", () => {
    expect(EventEnvelopeSchema.safeParse({ ...valid, schema_version: 1.5 }).success).toBe(false);
  });

  it("rejects invalid created_at datetime", () => {
    expect(EventEnvelopeSchema.safeParse({ ...valid, created_at: "not-a-date" }).success).toBe(false);
  });

  it("rejects missing id", () => {
    const { id, ...without } = valid;
    expect(EventEnvelopeSchema.safeParse(without).success).toBe(false);
  });

  it("rejects missing run_id", () => {
    const { run_id, ...without } = valid;
    expect(EventEnvelopeSchema.safeParse(without).success).toBe(false);
  });

  it("parse preserves created_at as string (no Date coercion)", () => {
    const result = EventEnvelopeSchema.parse(valid);
    expect(typeof result.created_at).toBe("string");
  });
});
