import { describe, it, expect, beforeEach } from "bun:test";
import { SyncEngine } from "../../src/sync";
import type { EventEnvelope } from "@opencode-ai/orchestrator-events";

describe("Sync Recovery Integration", () => {
  let engine: SyncEngine;
  let counter: number;

  beforeEach(() => {
    engine = new SyncEngine();
    counter = 1;
  });

  function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
    const seq = counter++;
    return {
      id: `evt_${seq}`,
      run_id: "run_1",
      stream_id: "run_1",
      stream_seq: seq,
      logical_ts: seq,
      schema_version: 1,
      type: "test_event",
      payload_json: JSON.stringify({ index: seq }),
      actor_type: "system",
      actor_id: "test",
      op_id: `op_${seq}`,
      prev_hash: "00000000",
      hash: `hash_${seq}`,
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  describe("Push and successful flush", () => {
    it("should push 10 events and flush successfully", async () => {
      for (let i = 0; i < 10; i++) {
        engine.push(makeEvent());
      }

      expect(engine.getPendingCount()).toBe(10);
      expect(engine.getCursor()).toBe(0);

      const flushedBatches: EventEnvelope[][] = [];
      // Flush all (default batch size is 50, so all 10 go in one batch)
      const success = await engine.flush(async (events) => {
        flushedBatches.push([...events]);
        return true;
      });

      expect(success).toBe(true);
      expect(engine.getPendingCount()).toBe(0);
      expect(engine.getCursor()).toBe(10);
      expect(flushedBatches).toHaveLength(1);
      expect(flushedBatches[0]).toHaveLength(10);
    });

    it("should clear buffer after successful flush", async () => {
      engine.push(makeEvent());
      engine.push(makeEvent());

      await engine.flush(async () => true);

      expect(engine.getPendingCount()).toBe(0);

      // Pushing more events starts fresh buffer
      engine.push(makeEvent());
      expect(engine.getPendingCount()).toBe(1);
    });

    it("should advance cursor correctly across multiple flushes", async () => {
      for (let i = 0; i < 5; i++) {
        engine.push(makeEvent());
      }

      await engine.flush(async () => true);
      expect(engine.getCursor()).toBe(5);

      for (let i = 0; i < 3; i++) {
        engine.push(makeEvent());
      }

      await engine.flush(async () => true);
      expect(engine.getCursor()).toBe(8);
    });
  });

  describe("Failed flush with backoff", () => {
    it("should retain buffer on flush failure", async () => {
      for (let i = 0; i < 5; i++) {
        engine.push(makeEvent());
      }

      const success = await engine.flush(async () => false);

      expect(success).toBe(false);
      expect(engine.getPendingCount()).toBe(5);
      expect(engine.getCursor()).toBe(0);
    });

    it("should increase backoff on consecutive failures", async () => {
      engine.push(makeEvent());

      expect(engine.getBackoffMs()).toBe(0);

      await engine.flush(async () => false);
      expect(engine.getBackoffMs()).toBe(1000);

      await engine.flush(async () => false);
      expect(engine.getBackoffMs()).toBe(2000);

      await engine.flush(async () => false);
      expect(engine.getBackoffMs()).toBe(4000);

      await engine.flush(async () => false);
      expect(engine.getBackoffMs()).toBe(8000);
    });

    it("should cap backoff at 60000ms", async () => {
      engine.push(makeEvent());

      for (let i = 0; i < 25; i++) {
        await engine.flush(async () => false);
      }

      expect(engine.getBackoffMs()).toBeLessThanOrEqual(60000);
      expect(engine.getBackoffMs()).toBe(60000);
    });
  });

  describe("Retry after backoff", () => {
    it("should reset backoff and clear buffer on successful retry", async () => {
      for (let i = 0; i < 3; i++) {
        engine.push(makeEvent());
      }

      // Fail twice
      await engine.flush(async () => false);
      await engine.flush(async () => false);
      expect(engine.getBackoffMs()).toBe(2000);
      expect(engine.getPendingCount()).toBe(3);

      // Succeed
      await engine.flush(async () => true);
      expect(engine.getBackoffMs()).toBe(0);
      expect(engine.getPendingCount()).toBe(0);
      expect(engine.getCursor()).toBe(3);
    });

    it("should restart backoff sequence after success followed by failure", async () => {
      engine.push(makeEvent());

      // Build up backoff
      await engine.flush(async () => false);
      await engine.flush(async () => false);
      expect(engine.getBackoffMs()).toBe(2000);

      // Succeed to reset
      await engine.flush(async () => true);
      expect(engine.getBackoffMs()).toBe(0);

      // Push more and fail again
      engine.push(makeEvent());
      await engine.flush(async () => false);
      expect(engine.getBackoffMs()).toBe(1000); // Back to base, not 4000
    });
  });

  describe("Cursor tracking", () => {
    it("should track cursor correctly throughout push/flush cycles", async () => {
      expect(engine.getCursor()).toBe(0);

      // Push 3, flush success
      for (let i = 0; i < 3; i++) engine.push(makeEvent());
      await engine.flush(async () => true);
      expect(engine.getCursor()).toBe(3);

      // Push 2, flush fail
      for (let i = 0; i < 2; i++) engine.push(makeEvent());
      await engine.flush(async () => false);
      expect(engine.getCursor()).toBe(3); // unchanged

      // Flush success
      await engine.flush(async () => true);
      expect(engine.getCursor()).toBe(5);

      // Push 4, flush success
      for (let i = 0; i < 4; i++) engine.push(makeEvent());
      await engine.flush(async () => true);
      expect(engine.getCursor()).toBe(9);
    });

    it("should return cursor 0 for never-flushed engine", () => {
      engine.push(makeEvent());
      engine.push(makeEvent());
      expect(engine.getCursor()).toBe(0);
    });
  });

  describe("Batch size limits", () => {
    it("should process events in batches of batchSize", async () => {
      engine.setBatchSize(50);

      // Push 100 events
      for (let i = 0; i < 100; i++) {
        engine.push(makeEvent());
      }
      expect(engine.getPendingCount()).toBe(100);

      const batchSizes: number[] = [];

      // First flush: processes 50
      await engine.flush(async (events) => {
        batchSizes.push(events.length);
        return true;
      });

      expect(batchSizes[0]).toBe(50);
      expect(engine.getPendingCount()).toBe(50);
      expect(engine.getCursor()).toBe(50);

      // Second flush: processes remaining 50
      await engine.flush(async (events) => {
        batchSizes.push(events.length);
        return true;
      });

      expect(batchSizes[1]).toBe(50);
      expect(engine.getPendingCount()).toBe(0);
      expect(engine.getCursor()).toBe(100);
    });

    it("should handle batch size larger than buffer", async () => {
      engine.setBatchSize(100);

      for (let i = 0; i < 10; i++) {
        engine.push(makeEvent());
      }

      let batchSize = 0;
      await engine.flush(async (events) => {
        batchSize = events.length;
        return true;
      });

      expect(batchSize).toBe(10);
      expect(engine.getPendingCount()).toBe(0);
    });

    it("should handle batch size of 1", async () => {
      engine.setBatchSize(1);

      for (let i = 0; i < 5; i++) {
        engine.push(makeEvent());
      }

      // Each flush processes exactly 1 event
      for (let i = 0; i < 5; i++) {
        await engine.flush(async (events) => {
          expect(events).toHaveLength(1);
          return true;
        });
        expect(engine.getPendingCount()).toBe(4 - i);
        expect(engine.getCursor()).toBe(i + 1);
      }
    });

    it("should handle mixed success/failure across batches", async () => {
      engine.setBatchSize(3);

      for (let i = 0; i < 9; i++) {
        engine.push(makeEvent());
      }

      // First batch: success
      await engine.flush(async () => true);
      expect(engine.getPendingCount()).toBe(6);
      expect(engine.getCursor()).toBe(3);

      // Second batch: fail
      await engine.flush(async () => false);
      expect(engine.getPendingCount()).toBe(6);
      expect(engine.getCursor()).toBe(3);

      // Third batch: success (retries same batch)
      await engine.flush(async () => true);
      expect(engine.getPendingCount()).toBe(3);
      expect(engine.getCursor()).toBe(6);

      // Fourth batch: success
      await engine.flush(async () => true);
      expect(engine.getPendingCount()).toBe(0);
      expect(engine.getCursor()).toBe(9);
    });
  });

  describe("Empty buffer edge cases", () => {
    it("should return true when flushing empty buffer", async () => {
      const result = await engine.flush(async () => false);
      expect(result).toBe(true);
      expect(engine.getCursor()).toBe(0);
      expect(engine.getBackoffMs()).toBe(0);
    });

    it("should not call handler when buffer is empty", async () => {
      let called = false;
      await engine.flush(async () => {
        called = true;
        return true;
      });
      expect(called).toBe(false);
    });
  });
});
