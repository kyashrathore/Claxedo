import { describe, it, expect } from "vitest";
import type { EventEnvelope } from "../../src/substrate/event-log";
import { computeHash, verifyChain } from "../../src/substrate/hash-chain-node";

describe("Hash Chain Integrity Integration", () => {
  let counter: number;

  function makeEvent(
    overrides: Partial<EventEnvelope> & Pick<EventEnvelope, "type" | "payload_json">
  ): EventEnvelope {
    const seq = counter++;
    return {
      id: `evt_${seq}`,
      run_id: "run_1",
      stream_id: "run_1",
      stream_seq: seq,
      logical_ts: seq,
      schema_version: 1,
      actor_type: "system",
      actor_id: "test",
      op_id: `op_${seq}`,
      prev_hash: "00000000",
      hash: "",
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  async function buildChainedEvents(count: number): Promise<EventEnvelope[]> {
    counter = 1;
    const events: EventEnvelope[] = [];
    let prevHash = "00000000";

    const types = [
      "run_created", "team_created", "node_created", "edge_added",
      "message_posted", "handoff_requested", "artifact_created",
      "decision_proposed", "run_planned", "lead_plan_created",
    ];

    for (let i = 0; i < count; i++) {
      const evt = makeEvent({
        type: types[i % types.length],
        payload_json: JSON.stringify({ index: i, data: `payload_${i}` }),
        prev_hash: prevHash,
      });

      evt.hash = await computeHash(evt, prevHash);
      prevHash = evt.hash;
      events.push(evt);
    }

    return events;
  }

  it("should build 10 events with correct hash chain and verify successfully", async () => {
    const events = await buildChainedEvents(10);

    expect(events).toHaveLength(10);
    expect(events[0].prev_hash).toBe("00000000");

    // Each event's prev_hash should match the prior event's hash
    for (let i = 1; i < events.length; i++) {
      expect(events[i].prev_hash).toBe(events[i - 1].hash);
    }

    // All hashes should be 64-char hex strings (SHA-256)
    for (const evt of events) {
      expect(evt.hash).toHaveLength(64);
      expect(evt.hash).toMatch(/^[a-f0-9]{64}$/);
    }

    const result = await verifyChain(events);
    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  });

  it("should detect corruption when a middle event hash is tampered", async () => {
    const events = await buildChainedEvents(10);

    // Corrupt event at index 5 by changing its hash
    const originalHash = events[5].hash;
    events[5].hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const result = await verifyChain(events);
    expect(result.valid).toBe(false);
    // The tampered event itself fails because its hash no longer matches the computed hash
    expect(result.brokenAt).toBe(5);
  });

  it("should detect corruption when a middle event payload is modified", async () => {
    const events = await buildChainedEvents(10);

    // Modify payload of event at index 4 (but don't change its hash)
    events[4].payload_json = JSON.stringify({ tampered: true, evil: "data" });

    const result = await verifyChain(events);
    expect(result.valid).toBe(false);
    // The recomputed hash for index 4 won't match the stored hash
    expect(result.brokenAt).toBe(4);
  });

  it("should detect corruption when the first event's hash is tampered", async () => {
    const events = await buildChainedEvents(10);

    events[0].hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const result = await verifyChain(events);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(0);
  });

  it("should detect corruption when the last event's hash is tampered", async () => {
    const events = await buildChainedEvents(10);

    events[9].hash = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    const result = await verifyChain(events);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(9);
  });

  it("should verify an empty chain as valid", async () => {
    const result = await verifyChain([]);
    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  });

  it("should verify a single-event chain", async () => {
    const events = await buildChainedEvents(1);

    const result = await verifyChain(events);
    expect(result.valid).toBe(true);
  });

  it("should detect corruption when a single-event hash is wrong", async () => {
    const events = await buildChainedEvents(1);
    events[0].hash = "0000000000000000000000000000000000000000000000000000000000000000";

    const result = await verifyChain(events);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(0);
  });

  it("should detect payload corruption that does not alter the hash field", async () => {
    const events = await buildChainedEvents(5);

    // Modify the type of event 2 (payload is used in hash computation)
    events[2].type = "edge_removed";

    const result = await verifyChain(events);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it("should detect run_id corruption", async () => {
    const events = await buildChainedEvents(5);

    // Change run_id of event 3 - this is included in hash computation
    events[3].run_id = "run_tampered";

    const result = await verifyChain(events);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(3);
  });

  it("should detect stream_seq corruption", async () => {
    const events = await buildChainedEvents(5);

    // Change stream_seq of event 2 - included in hash input
    events[2].stream_seq = 999;

    const result = await verifyChain(events);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it("should produce different hashes for events with different types", async () => {
    counter = 1;
    const evt1 = makeEvent({
      type: "run_created",
      payload_json: JSON.stringify({ data: "same" }),
    });
    const hash1 = await computeHash(evt1, "00000000");

    counter = 1; // reset counter to get same seq
    const evt2 = makeEvent({
      type: "team_created",
      payload_json: JSON.stringify({ data: "same" }),
    });
    const hash2 = await computeHash(evt2, "00000000");

    expect(hash1).not.toBe(hash2);
  });

  it("should produce different hashes for different prev_hash values", async () => {
    counter = 1;
    const evt = makeEvent({
      type: "run_created",
      payload_json: JSON.stringify({ data: "test" }),
    });

    const hash1 = await computeHash(evt, "00000000");
    const hash2 = await computeHash(evt, "11111111");

    expect(hash1).not.toBe(hash2);
  });
});
