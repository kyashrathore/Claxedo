/**
 * Unit tests for src/db/helpers.ts
 *
 * Verifies the three helper functions against an in-memory db stub.
 * No real SQLite.
 */

import { describe, it, expect } from "bun:test";
import { generateHash, insertEvent, getNextSeq } from "../../src/db/helpers";
import type { EventEnvelope } from "../../src/orchestrator/events";

// ---------------------------------------------------------------------------
// generateHash
// ---------------------------------------------------------------------------

describe("generateHash", () => {
  it("returns a non-empty string", () => {
    for (let i = 0; i < 100; i++) {
      const h = generateHash();
      expect(h.length).toBeGreaterThan(0);
    }
  });

  it("returns different values on successive calls", () => {
    const seen = new Set(Array.from({ length: 20 }, () => generateHash()));
    // At least some variation — all 20 colliding is astronomically unlikely
    expect(seen.size).toBeGreaterThan(1);
  });

  it("returns only alphanumeric chars (base-36 output)", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateHash()).toMatch(/^[0-9a-z]+$/);
    }
  });

  it("length is at most 16 chars", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateHash().length).toBeLessThanOrEqual(16);
    }
  });
});

// ---------------------------------------------------------------------------
// insertEvent
// ---------------------------------------------------------------------------

describe("insertEvent", () => {
  function makeDb() {
    const calls: Array<{ sql: string; params: any[] }> = [];
    return {
      run: (sql: string, params: any[]) => calls.push({ sql, params }),
      calls,
    };
  }

  const envelope: EventEnvelope = {
    id: "evt_01",
    run_id: "run_01",
    stream_id: "run_01",
    stream_seq: 1,
    logical_ts: 1,
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

  it("calls db.run with INSERT INTO events", () => {
    const db = makeDb();
    insertEvent(db, envelope);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain("INSERT INTO events");
  });

  it("passes all 14 envelope fields as params in correct order", () => {
    const db = makeDb();
    insertEvent(db, envelope);
    const params = db.calls[0].params;
    expect(params).toHaveLength(14);
    expect(params[0]).toBe(envelope.id);
    expect(params[1]).toBe(envelope.run_id);
    expect(params[6]).toBe(envelope.type);
    expect(params[13]).toBe(envelope.created_at);
  });
});

// ---------------------------------------------------------------------------
// getNextSeq
// ---------------------------------------------------------------------------

describe("getNextSeq", () => {
  function makeDb(maxSeq: number | null) {
    return {
      query: (_sql: string) => ({
        get: (_runId: string) => ({ max_seq: maxSeq }),
      }),
    };
  }

  it("returns 1 when no events exist (null max_seq)", () => {
    expect(getNextSeq(makeDb(null), "run_01")).toBe(1);
  });

  it("returns max_seq + 1 when events already exist", () => {
    expect(getNextSeq(makeDb(5), "run_01")).toBe(6);
  });

  it("returns 1 when max_seq is 0", () => {
    expect(getNextSeq(makeDb(0), "run_01")).toBe(1);
  });

  it("queries the events table (not events_current)", () => {
    const seen: string[] = [];
    const db = {
      query: (sql: string) => {
        seen.push(sql);
        return { get: () => ({ max_seq: null }) };
      },
    };
    getNextSeq(db, "run_01");
    expect(seen[0]).toContain("FROM events ");
    expect(seen[0]).not.toContain("events_current");
  });
});
