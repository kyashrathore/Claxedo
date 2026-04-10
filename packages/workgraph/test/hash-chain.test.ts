import { describe, it, expect } from "vitest";
import type { EventEnvelope } from "../src/orchestrator/events/schema";
import { computeHash, verifyChain } from "../src/orchestrator/core/services/hash-chain-node";

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: "evt_1",
    run_id: "run_1",
    stream_id: "run_1",
    stream_seq: 1,
    logical_ts: 1,
    schema_version: 1,
    type: "run_created",
    payload_json: JSON.stringify({ goal: "test" }),
    actor_type: "user",
    actor_id: "user_1",
    op_id: "op_1",
    prev_hash: "00000000",
    hash: "",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("hash-chain", () => {
  it("should compute a deterministic SHA-256 hash", async () => {
    const event = makeEvent();
    const hash1 = await computeHash(event, "00000000");
    const hash2 = await computeHash(event, "00000000");
    expect(hash1).toBe(hash2);
    expect(typeof hash1).toBe("string");
    expect(hash1.length).toBe(64); // SHA-256 hex is 64 chars
  });

  it("should verify a valid chain", async () => {
    const evt1 = makeEvent({ id: "evt_1", stream_seq: 1, op_id: "op_1", prev_hash: "00000000" });
    evt1.hash = await computeHash(evt1, "00000000");

    const evt2 = makeEvent({ id: "evt_2", stream_seq: 2, op_id: "op_2", type: "run_planned", prev_hash: evt1.hash });
    evt2.hash = await computeHash(evt2, evt1.hash);

    const evt3 = makeEvent({ id: "evt_3", stream_seq: 3, op_id: "op_3", type: "node_created", prev_hash: evt2.hash });
    evt3.hash = await computeHash(evt3, evt2.hash);

    const result = await verifyChain([evt1, evt2, evt3]);
    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  });

  it("should detect a tampered chain", async () => {
    const evt1 = makeEvent({ id: "evt_1", stream_seq: 1, op_id: "op_1", prev_hash: "00000000" });
    evt1.hash = await computeHash(evt1, "00000000");

    const evt2 = makeEvent({ id: "evt_2", stream_seq: 2, op_id: "op_2", type: "run_planned", prev_hash: evt1.hash });
    evt2.hash = await computeHash(evt2, evt1.hash);

    // Tamper with evt1's hash after the chain was built
    evt1.hash = "tampered_hash";

    const result = await verifyChain([evt1, evt2]);
    expect(result.valid).toBe(false);
    // evt1 itself will fail since its hash was changed
    expect(result.brokenAt).toBe(0);
  });

  it("should detect tampering in the middle of the chain", async () => {
    const evt1 = makeEvent({ id: "evt_1", stream_seq: 1, op_id: "op_1", prev_hash: "00000000" });
    evt1.hash = await computeHash(evt1, "00000000");

    const evt2 = makeEvent({ id: "evt_2", stream_seq: 2, op_id: "op_2", type: "run_planned", prev_hash: evt1.hash });
    evt2.hash = await computeHash(evt2, evt1.hash);

    const evt3 = makeEvent({ id: "evt_3", stream_seq: 3, op_id: "op_3", type: "node_created", prev_hash: evt2.hash });
    evt3.hash = await computeHash(evt3, evt2.hash);

    // Tamper with evt2's payload after chain was built (hash won't match)
    evt2.payload_json = JSON.stringify({ goal: "tampered" });

    const result = await verifyChain([evt1, evt2, evt3]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });
});
