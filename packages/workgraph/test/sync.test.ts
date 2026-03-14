import { describe, it, expect } from "bun:test";
import { SyncEngine } from "../src/orchestrator/sync/sync";
import type { EventEnvelope } from "../src/orchestrator/events/schema";

function createMockEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: "evt_1",
    run_id: "run_1",
    stream_id: "stream_1",
    stream_seq: 1,
    logical_ts: Date.now(),
    schema_version: 1,
    type: "test_event",
    payload_json: "{}",
    actor_type: "agent",
    actor_id: "agent_1",
    op_id: "op_1",
    prev_hash: "",
    hash: "abc",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("SyncEngine", () => {
  it("should buffer events when offline", () => {
    const engine = new SyncEngine();

    const mockEvent = createMockEvent();
    engine.push(mockEvent);
    expect(engine.getPendingCount()).toBe(1);
  });

  it("should flush events on reconnect", async () => {
    const engine = new SyncEngine();

    const mockEvent = createMockEvent({
      id: "evt_2",
      stream_seq: 2,
      op_id: "op_2",
      prev_hash: "abc",
      hash: "def",
    });

    engine.push(mockEvent);

    // Simulate a successful flush to a remote server
    const flushed = await engine.flush(async (events) => {
      return events.length > 0;
    });

    expect(flushed).toBe(true);
    expect(engine.getPendingCount()).toBe(0);
  });

  it("should track cursor position after successful flush", async () => {
    const engine = new SyncEngine();
    expect(engine.getCursor()).toBe(0);

    engine.push(createMockEvent({ id: "evt_1", op_id: "op_1" }));
    engine.push(createMockEvent({ id: "evt_2", op_id: "op_2" }));
    engine.push(createMockEvent({ id: "evt_3", op_id: "op_3" }));

    await engine.flush(async () => true);
    expect(engine.getCursor()).toBe(3);
    expect(engine.getPendingCount()).toBe(0);
  });

  it("should not advance cursor on failed flush", async () => {
    const engine = new SyncEngine();

    engine.push(createMockEvent());
    await engine.flush(async () => false);

    expect(engine.getCursor()).toBe(0);
    expect(engine.getPendingCount()).toBe(1);
  });

  it("should respect batch size", async () => {
    const engine = new SyncEngine();
    engine.setBatchSize(2);

    engine.push(createMockEvent({ id: "evt_1", op_id: "op_1" }));
    engine.push(createMockEvent({ id: "evt_2", op_id: "op_2" }));
    engine.push(createMockEvent({ id: "evt_3", op_id: "op_3" }));
    engine.push(createMockEvent({ id: "evt_4", op_id: "op_4" }));

    let batchCount = 0;
    await engine.flush(async (events) => {
      batchCount = events.length;
      return true;
    });

    expect(batchCount).toBe(2);
    expect(engine.getPendingCount()).toBe(2);
    expect(engine.getCursor()).toBe(2);

    // Flush remaining
    await engine.flush(async (events) => {
      batchCount = events.length;
      return true;
    });

    expect(batchCount).toBe(2);
    expect(engine.getPendingCount()).toBe(0);
    expect(engine.getCursor()).toBe(4);
  });

  it("should apply exponential backoff on failure", async () => {
    const engine = new SyncEngine();
    engine.push(createMockEvent());

    expect(engine.getBackoffMs()).toBe(0);

    // First failure: backoff = 1000
    await engine.flush(async () => false);
    expect(engine.getBackoffMs()).toBe(1000);

    // Second failure: backoff = 2000
    await engine.flush(async () => false);
    expect(engine.getBackoffMs()).toBe(2000);

    // Third failure: backoff = 4000
    await engine.flush(async () => false);
    expect(engine.getBackoffMs()).toBe(4000);
  });

  it("should cap backoff at max value", async () => {
    const engine = new SyncEngine();
    engine.push(createMockEvent());

    // Simulate many failures to exceed max
    for (let i = 0; i < 20; i++) {
      await engine.flush(async () => false);
    }

    expect(engine.getBackoffMs()).toBeLessThanOrEqual(60000);
  });

  it("should reset backoff on successful flush", async () => {
    const engine = new SyncEngine();
    engine.push(createMockEvent({ id: "evt_1", op_id: "op_1" }));

    // Fail a few times to build up backoff
    await engine.flush(async () => false);
    await engine.flush(async () => false);
    expect(engine.getBackoffMs()).toBe(2000);

    // Successful flush resets backoff
    await engine.flush(async () => true);
    expect(engine.getBackoffMs()).toBe(0);
  });

  it("should return true when flushing empty buffer", async () => {
    const engine = new SyncEngine();
    const result = await engine.flush(async () => false);
    expect(result).toBe(true);
  });
});
